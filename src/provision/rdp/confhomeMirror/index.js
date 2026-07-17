// ============================================================================
// confhomeMirror — minimal, no-fork "live patch" mirror of bin456789/reinstall
// ----------------------------------------------------------------------------
// Goal (see AUDIT-CONFHOME-MIRROR-RDP-COMPAT.md for full rationale):
//   • Always track upstream bin456789/reinstall `main` — no static fork to
//     maintain, no manual re-sync when upstream changes.
//   • The ONLY behavioural difference from upstream is: modify_windows() in
//     trans.sh also runs windows-fix-rdp-compat.bat, using the exact same
//     mechanism upstream already uses for windows-allow-ping.bat.
//   • Every other file (reinstall.sh minus its confhome line, trans.sh minus
//     the one inserted block, fix-eth-name.sh, logviewer.html, ttys.sh, ...)
//     is served byte-for-byte as upstream returns it.
//
// How the installer uses this mirror:
//   • rdpConfig.js honours an explicit REINSTALL_SCRIPT_URL. Without one it
//     derives the mirror URL from CONFHOME_MIRROR_PUBLIC_URL or WEBHOOK_URL.
//   • The mirror changes only reinstall.sh's confhome assignments and adds
//     one first-boot .bat to trans.sh's existing `bats` mechanism.
//   • reinstall.sh's own control flow is never modified — only its confhome
//     line, which upstream's README explicitly documents as the sanctioned
//     customisation point.
//
// Normal webhook deployment: WEBHOOK_URL is enough. Optional overrides:
//   CONFHOME_MIRROR_PUBLIC_URL = https://<your-bot-host>  (no path)
//   CONFHOME_MIRROR_PATH       = /reinstall-mirror         (default)
//   REINSTALL_SCRIPT_URL       = any explicitly managed installer URL
// ============================================================================

'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const { applyRdpCompatPatch, BAT_FILENAME } = require('./transShPatch');
const { rewriteConfhome } = require('./reinstallShPatch');

const UPSTREAM_CONFHOME = (process.env.RDP_MIRROR_UPSTREAM_CONFHOME
  || 'https://raw.githubusercontent.com/bin456789/reinstall/main').replace(/\/+$/, '');

const MOUNT_PATH = (process.env.CONFHOME_MIRROR_PATH || '/reinstall-mirror').replace(/\/+$/, '') || '/reinstall-mirror';

// No trailing path — just scheme+host(:port), e.g. https://bot.example.com.
// WEBHOOK_URL is already required for normal Render webhook deployments, so
// use it automatically instead of leaving the compatibility mirror disabled.
const PUBLIC_URL = (process.env.CONFHOME_MIRROR_PUBLIC_URL
  || process.env.WEBHOOK_URL || '').replace(/\/+$/, '');

// Short TTL cache: reduces load on GitHub raw + our own upstream latency
// without risking staleness — upstream trans.sh/reinstall.sh change rarely,
// and every install re-fetches within this window at most once.
const CACHE_TTL_MS = Number(process.env.CONFHOME_MIRROR_CACHE_TTL_MS || 3 * 60 * 1000);
const cache = new Map(); // upstream path -> { body, ts }

const WINDOWS_FIX_RDP_COMPAT_BAT_RAW = fs.readFileSync(
  path.join(__dirname, 'assets', BAT_FILENAME),
  'utf8'
);
// Windows batch files are conventionally CRLF. Normalise regardless of how
// this file is checked out (git autocrlf, editor, etc.) — idempotent either
// way (LF-only source or already-CRLF source both end up CRLF once).
const WINDOWS_FIX_RDP_COMPAT_BAT = WINDOWS_FIX_RDP_COMPAT_BAT_RAW.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');

let lastStatus = { transSh: null, reinstallSh: null };

async function fetchUpstream(upstreamPath) {
  const cached = cache.get(upstreamPath);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
    return cached.body;
  }
  const url = `${UPSTREAM_CONFHOME}/${upstreamPath.replace(/^\/+/, '')}`;
  const res = await axios.get(url, { responseType: 'text', timeout: 20000, transformResponse: [(d) => d] });
  const body = res.data;
  cache.set(upstreamPath, { body, ts: Date.now() });
  return body;
}

function router() {
  const r = express.Router();

  // reinstall.sh — pass-through EXCEPT the confhome/confhome_cn lines.
  r.get('/reinstall.sh', async (_req, res) => {
    try {
      const upstream = await fetchUpstream('reinstall.sh');
      const mirrorBase = PUBLIC_URL ? `${PUBLIC_URL}${MOUNT_PATH}` : '';
      const { patched, applied, reason } = rewriteConfhome(upstream, mirrorBase);
      lastStatus.reinstallSh = { applied, reason, at: new Date().toISOString() };
      res.set('Content-Type', 'text/x-sh; charset=utf-8');
      res.send(patched);
    } catch (e) {
      lastStatus.reinstallSh = { applied: false, reason: `fetch error: ${e.message}`, at: new Date().toISOString() };
      res.status(502).send(`# confhome mirror: failed to fetch upstream reinstall.sh: ${e.message}\n`);
    }
  });

  // trans.sh — pass-through EXCEPT one inserted block inside modify_windows().
  r.get('/trans.sh', async (_req, res) => {
    try {
      const upstream = await fetchUpstream('trans.sh');
      const { patched, applied, reason } = applyRdpCompatPatch(upstream);
      lastStatus.transSh = { applied, reason, at: new Date().toISOString() };
      res.set('Content-Type', 'text/x-sh; charset=utf-8');
      res.send(patched);
    } catch (e) {
      lastStatus.transSh = { applied: false, reason: `fetch error: ${e.message}`, at: new Date().toISOString() };
      res.status(502).send(`# confhome mirror: failed to fetch upstream trans.sh: ${e.message}\n`);
    }
  });

  // Our own asset — not proxied, served directly.
  r.get(`/${BAT_FILENAME}`, (_req, res) => {
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(WINDOWS_FIX_RDP_COMPAT_BAT);
  });

  // Diagnostics MUST be declared before the catch-all proxy below. The old
  // order caused /_status to be swallowed as an upstream filename and return
  // 502, making it impossible to verify whether the patch was active.
  r.get('/_status', (_req, res) => {
    res.json({
      ok: true,
      upstreamConfhome: UPSTREAM_CONFHOME,
      mountPath: MOUNT_PATH,
      publicUrlConfigured: Boolean(PUBLIC_URL),
      publicUrlSource: process.env.CONFHOME_MIRROR_PUBLIC_URL
        ? 'CONFHOME_MIRROR_PUBLIC_URL'
        : (process.env.WEBHOOK_URL ? 'WEBHOOK_URL' : 'none'),
      cacheTtlMs: CACHE_TTL_MS,
      lastTransShPatch: lastStatus.transSh,
      lastReinstallShPatch: lastStatus.reinstallSh,
    });
  });

  // Everything else (fix-eth-name.sh, logviewer.html, ttys.sh, windows-*.bat
  // that we don't own, etc.) — unmodified pass-through so the bot keeps
  // tracking upstream `main` for every file we don't explicitly patch above.
  r.get(/^\/(.+)$/, async (req, res) => {
    const upstreamPath = req.params[0];
    try {
      const upstream = await fetchUpstream(upstreamPath);
      res.set('Content-Type', 'text/plain; charset=utf-8');
      res.send(upstream);
    } catch (e) {
      res.status(502).send(`# confhome mirror: failed to fetch upstream ${upstreamPath}: ${e.message}\n`);
    }
  });

  return r;
}

module.exports = { router, MOUNT_PATH, UPSTREAM_CONFHOME, PUBLIC_URL };
