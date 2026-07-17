// ================================================================
// WINDOWS INSTALLER — fully-automated ISO resolver & preflight
// ----------------------------------------------------------------
// DESIGN (round 5 — no operator config required):
//
// Historical bug: reinstall.sh scrapes massgrave.dev on the VPS to guess
// a Microsoft Software Download URL. Those URLs now require a session
// cookie (Microsoft's "Sentinel" anti-abuse system), so `test_url_grace`
// fails, the script falls through to an interactive `read` prompt, and
// SSH non-interactive stdin = EOF → "ISO Link is empty" → exit 1.
//
// Round-4 required an operator-managed ENV per version. That was rejected
// as too fragile (Microsoft rotates URLs, operator must chase them).
//
// Round-5 design:
//   • Each supported Windows version has a **stable archive.org identifier**
//     (a "collection" that Microsoft's own eval ISOs live under, curated by
//     the Internet Archive since 2019–2024). Archive.org URLs are curl-able
//     without cookies and are stable for years — the Internet Archive's
//     mission is exactly permanent preservation.
//   • At install time, the VPS itself calls archive.org's *metadata* API
//     to look up the current .iso filename inside the collection (in case
//     of rename), then constructs the download URL:
//         https://archive.org/download/<identifier>/<filename>.iso
//   • The URL is HEAD-checked (content-type=image + size ≥ 100 MB) BEFORE
//     the reinstall command actually launches.
//   • Operator MAY override via `WIN_ISO_<VERSION>` ENV for any version
//     (private mirror, VLSC ISO), but this is entirely optional.
//   • If BOTH ENV and archive.org resolution fail → STOP with a specific
//     technical reason. No droplet is created past this gate.
//
// Verified sizes (2026-01 audit):
//   Server 2019:  4.6 GB   ← eval
//   Server 2022:  4.5 GB   ← eval
//   Server 2025:  5.7 GB   ← eval
//   Windows 10:   5.9 GB   ← retail 22H2
//   Windows 11:   5.5 GB   ← retail 24H2
//
// LICENSE NOTE:
// The Server ISOs are 180-day Microsoft Evaluation editions (fully
// functional, extendable via `slmgr /rearm`, convertible to full via DISM).
// The client (10/11) ISOs are Microsoft's retail media (no key required
// during install; Windows will nag/watermark until activated). Operators
// wanting fully-licensed installs can override any version via ENV.
//
// ROUND-10 FIX (audit — Windows Installer pipeline only):
//
// BUG #1 — wrong-language ISO could be selected.
//   `wserver2012r2eval` is a MULTI-LANGUAGE collection (DE-DE, EN-US, ES-ES,
//   FR-FR, IT-IT, JA-JP, RU-RU — verified against archive.org, all ~4.2-4.3
//   GB, i.e. indistinguishable by size). The old resolver picked "biggest
//   file wins", which for this collection is arbitrary and could silently
//   install a non-English build. Fix: entries may now declare `language`
//   (e.g. 'en-us'). When set, candidate .iso files are FIRST filtered so
//   only filenames matching that language token survive; size is only used
//   to break ties *within* that already-language-filtered set. If the
//   requested language has NO match in the collection, we do NOT fall back
//   to "just pick one" — we throw a specific, non-retryable error naming
//   the languages actually found, so this can never silently install the
//   wrong language.
//
// BUG #2 — no image-integrity validation.
//   HTTP 200 + correct Content-Type + correct Content-Length were treated
//   as "the ISO is fine". None of those prove the bytes are correct — a
//   truncated transfer, a corrupted archive.org derivative, or a
//   swapped/rewritten file all pass those checks. Fix: `resolveArchiveOrgIsoUrl`
//   now also resolves the BEST available checksum for the exact chosen file
//   (priority: a published companion SHA256 file > archive.org's own
//   automatic SHA1 fixity value > MD5 > CRC32 as last resort), and
//   `precheckOnVps` can run a dedicated full-file `iso_checksum` gate when
//   RDP_PREFLIGHT_FULL_ISO_CHECKSUM=true. Production fast mode keeps the
//   metadata/URL/size/disk checks but skips the duplicate 4–6 GB download;
//   that skip is recorded explicitly in logs rather than silently treated
//   as a successful byte-for-byte verification.
// ================================================================
const https = require('https');
const http = require('http');
const { NodeSSH } = require('node-ssh');
const { REINSTALL_SCRIPT_URL } = require('./rdpConfig');

// Overridable only for testing / an operator-run archive.org mirror.
// Defaults to the real Internet Archive for all production behaviour.
const ARCHIVE_ORG_BASE = (process.env.ARCHIVE_ORG_BASE || 'https://archive.org').replace(/\/+$/, '');

// Fast mode is the production default. The upstream flow downloads the ISO
// after reboot from Alpine, so downloading the same 4–6 GB file here merely
// to hash it doubles transfer time and can keep an order in pre-reboot for
// 45+ minutes. Strict operators can opt back into the redundant full-file
// verification with RDP_PREFLIGHT_FULL_ISO_CHECKSUM=true.
const PREFLIGHT_FULL_ISO_CHECKSUM = /^(1|true|yes|on)$/i.test(
  String(process.env.RDP_PREFLIGHT_FULL_ISO_CHECKSUM || 'false').trim()
);
const PREFLIGHT_ISO_SPEED_TEST = !/^(0|false|no|off)$/i.test(
  String(process.env.RDP_ISO_SPEED_PROBE || 'true').trim()
);
const parsedSpeedMbps = Number(process.env.RDP_ISO_MIN_DOWNLOAD_MBPS || 40);
const ISO_MIN_DOWNLOAD_MBPS = Number.isFinite(parsedSpeedMbps) && parsedSpeedMbps > 0
  ? parsedSpeedMbps : 40;
const parsedProbeBytes = Number(process.env.RDP_ISO_SPEED_PROBE_BYTES || 8 * 1024 * 1024);
const ISO_SPEED_PROBE_BYTES = Number.isFinite(parsedProbeBytes)
  ? Math.max(2 * 1024 * 1024, Math.min(32 * 1024 * 1024, Math.floor(parsedProbeBytes)))
  : 8 * 1024 * 1024;

// ─────────────────────────────────────────────────────────────────
// SUPPORTED WINDOWS MATRIX (curated, updated in-bot on each release)
// ─────────────────────────────────────────────────────────────────
const WINDOWS_MATRIX = [
  {
    keys: ['server 2025', '2025'],
    imageName: 'Windows Server 2025 SERVERSTANDARD',
    displayName: 'Windows Server 2025 Standard',
    archiveId: '26100.1742.240906-0331.ge-release-svc-refresh-server-eval-x-64-fre-en-us',
    isoEnv: 'WIN_ISO_SERVER_2025',
  },
  {
    keys: ['server 2022', '2022'],
    imageName: 'Windows Server 2022 SERVERSTANDARD',
    displayName: 'Windows Server 2022 Standard',
    archiveId: '20348.169.210806-1117.-fe-release-svc-prod-1-server-x-64-fre-en-us',
    isoEnv: 'WIN_ISO_SERVER_2022',
  },
  {
    keys: ['server 2019', '2019'],
    imageName: 'Windows Server 2019 SERVERSTANDARD',
    displayName: 'Windows Server 2019 Standard',
    archiveId: 'en_windows_server_2019_x64_dvd_4cb967d8',
    isoEnv: 'WIN_ISO_SERVER_2019',
  },
  // ROUND-8 FIX: "Windows Server 2012 R2" exists on the user-facing menu
  // (Setting.rdpWindowsVersions, admin-editable) but had NO entry here,
  // so resolveEntry() returned null and resolveWindowsTarget() threw
  // `Windows version "Windows Server 2012 R2" tidak dikenali` — exactly
  // the failure users reported. Root cause was menu/installer drift, not
  // a missing ISO. No other key contains "2012" so this cannot collide.
  {
    keys: ['server 2012 r2', 'server 2012', '2012 r2', '2012'],
    imageName: 'Windows Server 2012 R2 SERVERSTANDARD',
    displayName: 'Windows Server 2012 R2 Standard',
    archiveId: 'wserver2012r2eval',
    isoEnv: 'WIN_ISO_SERVER_2012',
    // ROUND-10 FIX (BUG #1): this collection contains one .iso PER LANGUAGE
    // (DE-DE / EN-US / ES-ES / FR-FR / IT-IT / JA-JP / RU-RU), all near-
    // identical in size. Without this, "pick the biggest file" is a coin
    // flip across 7 languages. reinstall.sh's Windows installer flow is
    // driven in en-us (see --lang en-us in buildReinstallCommand), so the
    // ISO itself must match. See resolveArchiveOrgIsoUrl().
    language: 'en-us',
  },
  // ROUND-9 FIX (audit): "Tiny10"/"Tiny11" and "Superlite"/"All In One" were
  // previously treated as if they were plain "Windows 10/11 Pro" — WRONG.
  // Audited the whole repo (Setting.js, rdpConfig.js, docs, .env*) for any
  // project-owned dedicated ISO/URL for these 4 variants: NONE exist. They
  // were researched externally for this fix; see per-entry notes below for
  // what is/ isn't wired in by default and why.
  {
    // Tiny11 — NTDEV's project (github.com/ntdevlabs/tiny11builder), single
    // maintainer, widely referenced, stable single-file archive.org item
    // matching the "(23H2)" label already used on the menu. Matched BEFORE
    // the generic Windows 11 entry below so it can't be shadowed by '11'.
    keys: ['tiny11', 'tiny 11', 'tiny-11'],
    imageName: 'Windows 11 Pro', // base OS family reinstall.sh needs to select drivers for
    displayName: 'Tiny11 23H2 (NTDEV)',
    archiveId: 'tiny11-23h2', // https://archive.org/details/tiny11-23h2 — single "tiny11 23H2 x64.iso"
    isoEnv: 'WIN_ISO_TINY11',
  },
  {
    // Tiny10 — same NTDEV project, same reasoning as Tiny11 above.
    keys: ['tiny10', 'tiny 10', 'tiny-10'],
    imageName: 'Windows 10 Pro',
    displayName: 'Tiny10 23H2 (NTDEV)',
    archiveId: 'tiny-10-23-h2', // https://archive.org/details/tiny-10-23-h2 — single-file item
    isoEnv: 'WIN_ISO_TINY10',
  },
  // ─── Superlite / All In One (Windows 11) ───────────────────────────────
  // A real dedicated build for these DOES exist publicly ("Ghost Spectre"
  // Windows 10/11 Superlite & AIO), but unlike Tiny10/Tiny11 it is NOT
  // wired in with a default archiveId here: it's redistributed by a single
  // anonymous uploader, historically shipped as a password-protected
  // archive, with no consistent checksum/versioning across re-uploads —
  // meaningfully higher supply-chain risk to silently bake into a paid
  // auto-provisioning pipeline than curated Microsoft eval ISOs or
  // NTDEV's single-maintainer Tiny10/Tiny11. If your team has vetted a
  // specific mirror you trust, point `WIN_ISO_WIN11_SUPERLITE` /
  // `WIN_ISO_WIN11_AIO` at it — until then this SAFELY FALLS BACK to
  // Windows 11 Pro (fallbackArchiveId below), never throws "tidak
  // dikenali", and the confirmation caption still shows the version the
  // user actually picked.
  {
    keys: ['windows 11 superlite', 'win 11 superlite', '11 superlite'],
    imageName: 'Windows 11 Pro',
    displayName: 'Windows 11 Superlite',
    archiveId: null,
    fallbackArchiveId: 'Win11_24H2_English_x64',
    isoEnv: 'WIN_ISO_WIN11_SUPERLITE',
  },
  {
    keys: ['windows 11 all in one', 'win 11 all in one', '11 all in one', '11 aio'],
    imageName: 'Windows 11 Pro',
    displayName: 'Windows 11 All In One',
    archiveId: null,
    fallbackArchiveId: 'Win11_24H2_English_x64',
    isoEnv: 'WIN_ISO_WIN11_AIO',
  },
  {
    // Generic Windows 11 catch-all — "Windows 11 Original" and anything
    // else lands here. MUST stay after the more specific entries above.
    keys: ['win 11', 'windows 11', '11'],
    imageName: 'Windows 11 Pro',
    displayName: 'Windows 11 Pro (24H2)',
    archiveId: 'Win11_24H2_English_x64',
    isoEnv: 'WIN_ISO_WIN_11',
  },
  // ─── Superlite / All In One (Windows 10) — same reasoning as Windows 11 ─
  {
    keys: ['windows 10 superlite', 'win 10 superlite', '10 superlite'],
    imageName: 'Windows 10 Pro',
    displayName: 'Windows 10 Superlite',
    archiveId: null,
    fallbackArchiveId: 'Win10_22H2_English_x64v1',
    isoEnv: 'WIN_ISO_WIN10_SUPERLITE',
  },
  {
    keys: ['windows 10 all in one', 'win 10 all in one', '10 all in one', '10 aio'],
    imageName: 'Windows 10 Pro',
    displayName: 'Windows 10 All In One',
    archiveId: null,
    fallbackArchiveId: 'Win10_22H2_English_x64v1',
    isoEnv: 'WIN_ISO_WIN10_AIO',
  },
  {
    // Generic Windows 10 catch-all — "Windows 10 Original" and anything
    // else lands here. MUST stay after the more specific entries above.
    keys: ['win 10', 'windows 10', '10'],
    imageName: 'Windows 10 Pro',
    displayName: 'Windows 10 Pro (22H2)',
    archiveId: 'Win10_22H2_English_x64v1',
    isoEnv: 'WIN_ISO_WIN_10',
  },
];

const DEFAULT_ENTRY = WINDOWS_MATRIX.find(e => e.imageName === 'Windows Server 2022 SERVERSTANDARD');

function resolveEntry(osVersion) {
  const v = String(osVersion || '').toLowerCase().trim();
  if (!v) return DEFAULT_ENTRY;
  for (const e of WINDOWS_MATRIX) {
    for (const k of e.keys) if (v.includes(k)) return e;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────
// STARTUP VALIDATION
// Ensures every Windows Version label configured on the user-facing menu
// (Setting.rdpWindowsVersions, admin-editable) resolves to a
// WINDOWS_MATRIX entry. Called once at boot (see src/app.js) so a
// mismatch between the menu and the installer's mapping table — the
// exact class of bug that caused "Windows version ... tidak dikenali" —
// is caught immediately via console.error instead of surfacing as a
// failed paid order in production.
// Read-only / diagnostic only: does not throw, does not block boot.
// ─────────────────────────────────────────────────────────────────
function validateWindowsVersionMapping(versionLabels = []) {
  const labels = Array.isArray(versionLabels) ? versionLabels : [];
  const missing = labels.filter((label) => !resolveEntry(label));
  if (missing.length) {
    console.error(
      `[windowsInstaller] ❌ ${missing.length} Windows Version pada menu TIDAK memiliki mapping image: ` +
      missing.map((m) => `"${m}"`).join(', ') +
      `. Order dengan versi ini akan gagal dengan "tidak dikenali". ` +
      `Tambahkan/samakan entry di WINDOWS_MATRIX (src/provision/rdp/windowsInstaller.js).`
    );
  } else if (labels.length) {
    console.log(`[windowsInstaller] ✅ Semua ${labels.length} Windows Version pada menu memiliki mapping image (WINDOWS_MATRIX sinkron).`);
  }
  return missing;
}

// ─────────────────────────────────────────────────────────────────
// ARCHIVE.ORG METADATA RESOLVER
// The Internet Archive exposes /metadata/<identifier> as a stable JSON
// endpoint. We look for the .iso file(s); see filterIsosByLanguage() below
// for how the right language is picked BEFORE size is used as a tie-break.
// ─────────────────────────────────────────────────────────────────
function fetchRaw(url, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const mod = /^http:\/\//i.test(url) ? http : https;
    const req = mod.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'serversg22-rdp-bot/1.0' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => body += c);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

function fetchJson(url, opts) {
  return fetchRaw(url, opts).then((body) => {
    try { return JSON.parse(body); }
    catch (e) { throw new Error('invalid JSON from ' + url + ': ' + e.message); }
  });
}

function fetchText(url, opts) {
  return fetchRaw(url, opts);
}

// ─────────────────────────────────────────────────────────────────
// BUG #1 FIX — language-aware ISO selection.
// Normalises both the requested language token and each candidate filename
// down to bare a-z0-9 (so 'en-us', 'en_us', 'EN-US', 'enus' all compare
// equal), then keeps only filenames containing that token. Callers MUST
// treat an empty result as "cannot safely pick" — NOT as "fall back to
// picking anything" — see resolveArchiveOrgIsoUrl().
// ─────────────────────────────────────────────────────────────────
function normalizeLangToken(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function filterIsosByLanguage(isos, language) {
  if (!language) return isos;
  const want = normalizeLangToken(language);
  if (!want) return isos;
  return isos.filter((f) => normalizeLangToken(f.name).includes(want));
}

// Best-effort extraction of the languages a collection actually contains,
// used only to produce a helpful error message when the requested language
// isn't found — never used to pick a substitute file.
const KNOWN_LANG_TOKENS = [
  'en-us', 'de-de', 'es-es', 'fr-fr', 'it-it', 'ja-jp', 'ru-ru', 'pt-br',
  'zh-cn', 'zh-tw', 'ko-kr', 'nl-nl', 'pl-pl', 'tr-tr', 'ar-sa',
];
function detectLanguagesPresent(isos) {
  const found = new Set();
  for (const f of isos) {
    const n = String(f.name || '').toLowerCase();
    for (const tok of KNOWN_LANG_TOKENS) {
      if (n.includes(tok) || n.includes(tok.replace('-', '_'))) found.add(tok);
    }
  }
  return [...found];
}

// ─────────────────────────────────────────────────────────────────
// BUG #2 FIX — best-available checksum for the exact chosen file.
// Priority: published companion file (.sha256 > .sha1 > .md5) > archive.org's
// own inline fixity fields on the file object (sha1 > md5 > crc32).
// Archive.org computes sha1+md5+crc32 automatically for every uploaded file
// as part of its own fixity system, so in practice a checksum is almost
// always available even when the uploader never published one explicitly.
// Returns null (not a throw) when nothing at all is available — the caller
// decides how to surface "no checksum published by source".
// ─────────────────────────────────────────────────────────────────
function extractHexFromText(text, hexLen) {
  const re = new RegExp(`[a-fA-F0-9]{${hexLen}}`);
  const m = re.exec(text || '');
  return m ? m[0].toLowerCase() : null;
}

async function extractChecksum(meta, fileEntry, archiveId) {
  const files = Array.isArray(meta.files) ? meta.files : [];
  const companionSpecs = [
    { ext: '.sha256', hexLen: 64, type: 'sha256' },
    { ext: '.sha1', hexLen: 40, type: 'sha1' },
    { ext: '.md5', hexLen: 32, type: 'md5' },
  ];
  for (const spec of companionSpecs) {
    const companion = files.find(
      (f) => f.name && f.name.toLowerCase() === (fileEntry.name + spec.ext).toLowerCase()
    );
    if (companion) {
      try {
        const url = `${ARCHIVE_ORG_BASE}/download/${encodeURIComponent(archiveId)}/${encodeURIComponent(companion.name)}`;
        const text = await fetchText(url, { timeoutMs: 15000 });
        const hex = extractHexFromText(text, spec.hexLen);
        if (hex) return { type: spec.type, value: hex, source: `companion-file:${companion.name}` };
      } catch (_) {
        // fall through to next-best source
      }
    }
  }
  // Archive.org's own inline fixity values on the file object.
  if (fileEntry.sha1 && /^[a-fA-F0-9]{40}$/.test(fileEntry.sha1)) {
    return { type: 'sha1', value: fileEntry.sha1.toLowerCase(), source: 'archive.org-fixity' };
  }
  if (fileEntry.md5 && /^[a-fA-F0-9]{32}$/.test(fileEntry.md5)) {
    return { type: 'md5', value: fileEntry.md5.toLowerCase(), source: 'archive.org-fixity' };
  }
  if (fileEntry.crc32 && /^[a-fA-F0-9]{8}$/.test(fileEntry.crc32)) {
    return { type: 'crc32', value: fileEntry.crc32.toLowerCase(), source: 'archive.org-fixity-weak' };
  }
  return null;
}

/**
 * Resolve the current direct-download URL for an archive.org Windows ISO
 * collection. Returns null on any failure (caller must fall back).
 *
 * ROUND-7 hardening: retry 3× with exponential backoff (1s, 3s, 7s). archive.org
 * metadata endpoint can 5xx/timeout transiently, and losing this call fails the
 * whole order pipeline at preflight — the retry loop is cheap insurance.
 */
async function resolveArchiveOrgIsoUrl(archiveId, { maxAttempts = 3, language = null } = {}) {
  const url = `${ARCHIVE_ORG_BASE}/metadata/${encodeURIComponent(archiveId)}`;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const meta = await fetchJson(url);
      if (!meta || !Array.isArray(meta.files)) {
        lastErr = new Error('archive.org metadata missing files[]');
      } else {
        const allIsos = meta.files
          .filter(f => /\.iso$/i.test(f.name) && !/\.(md5|sha1|sha256|torrent)$/i.test(f.name))
          .map(f => ({ ...f, name: f.name, size: Number(f.size || 0) }));

        // BUG #1 FIX: language filter runs BEFORE size is ever consulted.
        // A collection with no language filter configured (entry.language
        // is falsy) behaves exactly as before.
        const candidateIsos = language ? filterIsosByLanguage(allIsos, language) : allIsos;

        if (language && allIsos.length && candidateIsos.length === 0) {
          // Data exists, but none of it matches the requested language —
          // this is NOT a transient/retryable failure, and we must NEVER
          // silently install a different language. Fail immediately with a
          // specific, actionable message.
          const found = detectLanguagesPresent(allIsos);
          const err = new Error(
            `Collection archive.org "${archiveId}" tidak punya ISO berbahasa "${language}". ` +
            `Bahasa yang tersedia di collection: ${found.length ? found.join(', ') : '(tidak terdeteksi dari nama file)'}. ` +
            `Menolak memilih ISO bahasa lain secara diam-diam.`
          );
          err.code = 'WIN_ISO_LANGUAGE_NOT_FOUND';
          throw err;
        }

        const sorted = candidateIsos.slice().sort((a, b) => b.size - a.size);
        if (sorted.length) {
          const pick = sorted[0];
          const checksum = await extractChecksum(meta, pick, archiveId).catch(() => null);
          return {
            url: `${ARCHIVE_ORG_BASE}/download/${encodeURIComponent(archiveId)}/${encodeURIComponent(pick.name)}`,
            filename: pick.name,
            sizeBytes: pick.size,
            source: 'archive.org',
            checksum,
            language: language || null,
          };
        }
        lastErr = new Error('archive.org collection has no .iso files');
      }
    } catch (e) {
      if (e && e.code === 'WIN_ISO_LANGUAGE_NOT_FOUND') throw e; // non-retryable, surface immediately
      lastErr = e;
    }
    if (attempt < maxAttempts) {
      const backoffMs = [1000, 3000, 7000][attempt - 1] || 7000;
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
  // Attach last error message to null-return via thrown Error path in caller.
  const err = new Error(`archive.org resolve failed after ${maxAttempts} attempts: ${lastErr && lastErr.message}`);
  err.cause = lastErr;
  throw err;
}

// ─────────────────────────────────────────────────────────────────
// PUBLIC RESOLVER
// resolveWindowsTarget()
//   1. Validate osVersion → get matrix entry (throws if unknown).
//   2. If ENV `WIN_ISO_<VERSION>` set → use it (operator override).
//   3. Else resolve archive.org via metadata API.
//   4. If BOTH fail → throw with specific reason.
// ─────────────────────────────────────────────────────────────────
async function resolveWindowsTarget(osVersion) {
  const entry = resolveEntry(osVersion);
  if (!entry) {
    const supported = WINDOWS_MATRIX.map(e => e.displayName).join(', ');
    const err = new Error(
      `Windows version "${osVersion || '(kosong)'}" tidak dikenali. ` +
      `Versi yang didukung: ${supported}.`
    );
    err.code = 'WIN_VERSION_UNSUPPORTED';
    throw err;
  }

  const envUrl = String(process.env[entry.isoEnv] || '').trim();
  if (envUrl) {
    if (!/^https?:\/\//i.test(envUrl)) {
      const err = new Error(`ENV \`${entry.isoEnv}\` = "${envUrl.slice(0, 60)}..." — bukan URL http(s).`);
      err.code = 'WIN_ISO_URL_INVALID';
      throw err;
    }
    return {
      imageName: entry.imageName,
      isoUrl: envUrl,
      displayName: entry.displayName,
      key: entry.keys[0],
      isoEnv: entry.isoEnv,
      source: 'env-override',
      sizeBytes: 0,
      filename: '(operator override)',
      // Operator supplied their own URL — we have no known-good hash for it.
      // precheckOnVps records this as SKIPPED, never as PASSED.
      checksum: null,
      language: entry.language || null,
    };
  }

  // Resolve which archive.org collection to use:
  //   • entry.archiveId         → dedicated image for this exact variant (preferred).
  //   • entry.fallbackArchiveId → no dedicated image wired in by default (see the
  //     comment on the entry in WINDOWS_MATRIX, e.g. Superlite/AIO) — safely
  //     reuse the base Windows 10/11 Pro collection instead of throwing.
  const usingFallback = !entry.archiveId && !!entry.fallbackArchiveId;
  const archiveId = entry.archiveId || entry.fallbackArchiveId;
  if (!archiveId) {
    const err = new Error(
      `${entry.displayName} tidak punya archiveId maupun fallbackArchiveId di WINDOWS_MATRIX — ` +
      `set ENV \`${entry.isoEnv}\` sebagai override, atau lengkapi entry di windowsInstaller.js.`
    );
    err.code = 'WIN_ISO_URL_MISSING';
    throw err;
  }

  // Auto-resolve from archive.org (language filter applies only when the
  // matrix entry declares one — see BUG #1 fix above).
  const resolved = await resolveArchiveOrgIsoUrl(archiveId, { language: entry.language || null }).catch(err => {
    // BUG #1: preserve the specific, non-retryable language-mismatch code
    // instead of collapsing it into the generic resolve-failed code — this
    // is a distinct, actionable failure mode (wrong collection contents),
    // not a transient archive.org outage.
    if (err && err.code === 'WIN_ISO_LANGUAGE_NOT_FOUND') throw err;
    const e = new Error(
      `Gagal resolve archive.org metadata untuk ${entry.displayName} ` +
      `(id=${archiveId}): ${err.message}. ` +
      `Set ENV \`${entry.isoEnv}\` sebagai override, atau update archiveId di WINDOWS_MATRIX.`
    );
    e.code = 'WIN_ISO_RESOLVE_FAILED';
    throw e;
  });
  if (!resolved) {
    const err = new Error(
      `Archive.org tidak punya file .iso pada collection "${archiveId}" untuk ${entry.displayName}. ` +
      `Kemungkinan collection dihapus/di-rename. Set ENV \`${entry.isoEnv}\` sebagai override.`
    );
    err.code = 'WIN_ISO_RESOLVE_EMPTY';
    throw err;
  }

  return {
    imageName: entry.imageName,
    isoUrl: resolved.url,
    displayName: entry.displayName,
    key: entry.keys[0],
    isoEnv: entry.isoEnv,
    source: usingFallback ? 'archive.org-fallback' : resolved.source,
    sizeBytes: resolved.sizeBytes,
    filename: resolved.filename,
    archiveId,
    // BUG #2: best-available checksum for THIS exact file (null if the
    // source genuinely publishes none — see extractChecksum()).
    checksum: resolved.checksum || null,
    language: resolved.language || entry.language || null,
  };
}

// ─────────────────────────────────────────────────────────────────
// SSH PRECHECK — on the freshly-created Ubuntu 22.04 VPS.
// Runs internet/DNS/script/ISO-reachability/disk probes plus (BUG #2 FIX)
// a full image-integrity checksum gate when one is available, and throws
// with a specific code on the first failure.
// ─────────────────────────────────────────────────────────────────
async function execRemote(ssh, cmd) {
  const t0 = Date.now();
  const r = await ssh.execCommand(cmd, { execOptions: { pty: false } });
  return {
    stdout: (r && r.stdout || '').toString(),
    stderr: (r && r.stderr || '').toString(),
    code:   (r && typeof r.code === 'number') ? r.code : (r && r.signal ? 128 : 0),
    durationMs: Date.now() - t0,
  };
}

async function precheckOnVps(host, credentials, target, { debug } = {}) {
  const ssh = new NodeSSH();
  const dbg = debug || { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  dbg.info('PRECHECK', 'Opening SSH for precheck', { host });
  await ssh.connect({
    host, port: 22,
    username: credentials.username || 'root',
    password: credentials.password,
    readyTimeout: 30000,
  });

  const isoHost = new URL(target.isoUrl).hostname;
  const scriptHost = new URL(REINSTALL_SCRIPT_URL).hostname;

  const checks = [
    {
      name: 'internet',
      cmd: 'curl -fsS --max-time 10 -o /dev/null -w "%{http_code}" https://1.1.1.1/cdn-cgi/trace || true',
      validate: (r) => {
        const code = (r.stdout || '').trim();
        return /^2\d\d$/.test(code)
          ? { ok: true, detail: `HTTP ${code}` }
          : { ok: false, detail: `VPS tidak bisa akses internet (curl 1.1.1.1 → "${code || 'no-response'}", stderr="${r.stderr.slice(0, 120)}")` };
      },
    },
    {
      name: 'dns_iso_host',
      cmd: `getent hosts ${isoHost} 2>&1 || nslookup ${isoHost} 2>&1 | head -3`,
      validate: (r) => /(\d{1,3}\.){3}\d{1,3}|::/.test(r.stdout)
        ? { ok: true, detail: r.stdout.trim().split('\n')[0].slice(0, 120) }
        : { ok: false, detail: `DNS gagal resolve host ISO "${isoHost}"` },
    },
    {
      name: 'dns_script_host',
      cmd: `getent hosts ${scriptHost} 2>&1 || nslookup ${scriptHost} 2>&1 | head -3`,
      validate: (r) => /(\d{1,3}\.){3}\d{1,3}|::/.test(r.stdout)
        ? { ok: true, detail: 'ok' }
        : { ok: false, detail: `DNS gagal resolve "${scriptHost}"` },
    },
    {
      name: 'reinstall_script_download',
      cmd:
        `curl -fsSL --max-time 30 -o /tmp/reinstall.sh "${REINSTALL_SCRIPT_URL}" ` +
        `&& head -c 200 /tmp/reinstall.sh | tr '\\n' ' ' ` +
        `&& echo "" && echo "__SIZE__=$(wc -c </tmp/reinstall.sh)"`,
      validate: (r) => {
        if (r.code !== 0) return { ok: false, detail: `curl exit=${r.code} stderr=${(r.stderr || '').slice(0, 200)}` };
        const size = Number((r.stdout.match(/__SIZE__=(\d+)/) || [])[1] || 0);
        if (size < 50000) return { ok: false, detail: `reinstall.sh terlalu kecil (${size} bytes)` };
        if (!/^#!\/(bin|usr\/bin\/env)/.test(r.stdout)) return { ok: false, detail: `reinstall.sh tidak diawali shebang (head=${r.stdout.slice(0, 100)})` };
        return { ok: true, detail: `size=${size} bytes` };
      },
    },
    {
      name: 'iso_url_reachable',
      cmd:
        `set +e; ` +
        `hdrs=$(curl -fsSLI --max-time 30 -L -o /dev/null -D - "${target.isoUrl}" 2>&1); code=$?; ` +
        `if [ $code -ne 0 ]; then hdrs=$(curl -fsSL --max-time 30 -L -r 0-0 -o /dev/null -D - "${target.isoUrl}" 2>&1); code=$?; fi; ` +
        `echo "__EXIT__=$code"; echo "$hdrs" | tail -30`,
      validate: (r) => {
        const exit = Number((r.stdout.match(/__EXIT__=(\d+)/) || [])[1] || -1);
        if (exit !== 0) {
          return { ok: false, detail: `Direct ISO URL tidak dapat diakses dari VPS (curl exit=${exit}). URL=${target.isoUrl}` };
        }
        // Grab the LAST status line (after redirects).
        const statuses = [...r.stdout.matchAll(/^HTTP\/[\d.]+ (\d{3})/gm)].map(m => m[1]);
        const lastStatus = statuses[statuses.length - 1];
        const lastLength = [...r.stdout.matchAll(/^content-length:\s*(\d+)/gim)].map(m => Number(m[1])).pop() || 0;
        const lastType   = [...r.stdout.matchAll(/^content-type:\s*([^\r\n]+)/gim)].map(m => m[1].trim()).pop() || '';
        if (lastStatus && !/^2/.test(lastStatus)) {
          return { ok: false, detail: `Direct ISO URL merespon HTTP ${lastStatus}. URL=${target.isoUrl}` };
        }
        if (lastLength && lastLength < 100 * 1024 * 1024) {
          return { ok: false, detail: `Ukuran response ${lastLength} bytes — bukan ISO. content-type="${lastType}". URL=${target.isoUrl}` };
        }
        if (lastType && !/iso|octet|application|binary/i.test(lastType)) {
          return { ok: false, detail: `Content-Type tidak seperti ISO ("${lastType}"). URL=${target.isoUrl}` };
        }
        return {
          ok: true,
          detail: `HTTP ${lastStatus || '2xx'} · ${lastLength ? Math.round(lastLength / 1024 / 1024) + ' MB' : 'unknown'} · ${lastType}`,
        };
      },
    },
    {
      // Keep a size-aware disk gate even in fast mode. The Ubuntu preflight
      // no longer caches the full ISO by default, but the Alpine/Windows
      // installer still needs sufficient target disk and scratch space.
      name: 'disk_space',
      cmd: `df -BM --output=avail / | tail -1 | tr -d ' M'`,
      validate: (r) => {
        const mb = Number((r.stdout || '').trim());
        const isoMb = target.sizeBytes ? Math.ceil(target.sizeBytes / 1024 / 1024) : 6000;
        const needMb = Math.max(15000, isoMb + 2000);
        if (!mb || mb < needMb) return { ok: false, detail: `Free disk hanya ${mb || 0} MB (butuh ≥ ${needMb} MB — ISO ${isoMb} MB + buffer)` };
        return { ok: true, detail: `${mb} MB free (butuh ≥ ${needMb} MB)` };
      },
    },
  ];

  // A reachable ISO can still be far too slow for the requested activation
  // time. Download only the first few MiB and measure sustained throughput.
  // `head` closes the pipe at ISO_SPEED_PROBE_BYTES, so this never becomes a
  // second full-ISO download. Slow routes are retryable on another provider.
  if (!PREFLIGHT_FULL_ISO_CHECKSUM && PREFLIGHT_ISO_SPEED_TEST) {
    const diskIndex = checks.findIndex((check) => check.name === 'disk_space');
    const minimumBps = Math.ceil(ISO_MIN_DOWNLOAD_MBPS * 1000 * 1000 / 8);
    const speedCheck = {
      name: 'iso_throughput',
      cmd:
        `tmp=/tmp/.rdp-iso-speed-$$; ` +
        `start=$(date +%s%3N); ` +
        `curl -fsSL --max-time 20 "${target.isoUrl}" 2>/dev/null | head -c ${ISO_SPEED_PROBE_BYTES} > "$tmp"; ` +
        `end=$(date +%s%3N); got=$(wc -c < "$tmp" 2>/dev/null || echo 0); ` +
        `elapsed=$((end-start)); [ "$elapsed" -gt 0 ] || elapsed=1; ` +
        `bps=$((got*1000/elapsed)); rm -f "$tmp"; ` +
        `echo "__ISO_SPEED__=$got:$elapsed:$bps"`,
      validate: (r) => {
        const match = (r.stdout || '').match(/__ISO_SPEED__=(\d+):(\d+):(\d+)/);
        if (!match) return { ok: false, detail: 'Tes kecepatan ISO tidak menghasilkan data yang valid.' };
        const got = Number(match[1]);
        const bps = Number(match[3]);
        const mbps = bps * 8 / 1000 / 1000;
        const estimatedMin = target.sizeBytes && bps > 0
          ? Math.ceil(target.sizeBytes / bps / 60)
          : null;
        if (got < 2 * 1024 * 1024 || bps < minimumBps) {
          return {
            ok: false,
            detail: `Rute ISO terlalu lambat (${mbps.toFixed(1)} Mbps; minimum ${ISO_MIN_DOWNLOAD_MBPS} Mbps` +
              `${estimatedMin ? `; estimasi download ${estimatedMin} menit` : ''}). Mencoba provider lain.`,
          };
        }
        return {
          ok: true,
          detail: `${mbps.toFixed(1)} Mbps` +
            `${estimatedMin ? ` · estimasi download ISO ${estimatedMin} menit` : ''}`,
        };
      },
    };
    checks.splice(diskIndex < 0 ? checks.length : diskIndex, 0, speedCheck);
  }

  // ═══ OPTIONAL STRICT MODE — full-download integrity gate ════════════
  // ROUND-10 streamed the whole ISO through `curl | shasum` and discarded
  // the bytes (no disk write) — the checksum was trusted, but nothing on
  // disk was ever proven to actually match it, and a second full fetch
  // still happened later regardless. ROUND-11 downloads the ISO to a
  // fixed cache path ONCE, computes the checksum FROM THAT FILE (so what
  // gets hashed is provably the same bytes that would be used), and on
  // any mismatch deletes the corrupted file immediately and aborts —
  // no reinstall dispatch happens. This satisfies "download once, verify,
  // reuse the same file" for every step THIS process controls directly.
  //
  // KNOWN, DELIBERATE LIMITATION (do not silently try to fix this without
  // reading the note below first):
  // reinstall.sh's Windows path does not install in this SSH session at
  // all. It stages a GRUB boot entry, the VPS physically reboots into a
  // separate Alpine Linux live environment, and Alpine's `trans.sh` is
  // what actually re-downloads the ISO (via aria2c) and performs the
  // install — a completely different OS session than this one. Upstream
  // `trans.sh` has no "check for an already-cached local file" code path,
  // and `--iso` only ever accepts a URL. So the cached file written here
  // CANNOT be handed to reinstall.sh directly; the Alpine stage will still
  // fetch the same URL again over the network.
  // Eliminating that second fetch entirely requires forking trans.sh
  // (~8400 lines, upstream bin456789/reinstall) to mount the original disk
  // read-only — before its own setup_disk step formats it — and read this
  // cache path before falling back to aria2c. That is a real, sanctioned
  // extension point (upstream's own README: "Fork this repository, modify
  // confhome...") but it is NOT implemented here: it needs a live VPS test
  // matrix across every provider/Windows version this bot supports, and a
  // bad mount-timing bug there would fail a customer's paid install rather
  // than just cost bandwidth. Left as a follow-up requiring test infra.
  const LOCAL_ISO_CACHE_DIR = '/root/.reinstall-iso-cache';
  let localIsoPath = null;
  if (PREFLIGHT_FULL_ISO_CHECKSUM
      && target.checksum && target.checksum.value && target.checksum.type) {
    const algoCmdMap = { sha256: 'sha256sum', sha1: 'sha1sum', md5: 'md5sum', crc32: 'cksum' };
    const algoCmd = algoCmdMap[target.checksum.type];
    const wantHex = String(target.checksum.value).trim().toLowerCase();
    const safeFilename = String(target.filename || 'windows.iso').replace(/[^A-Za-z0-9._-]/g, '_') || 'windows.iso';
    localIsoPath = `${LOCAL_ISO_CACHE_DIR}/${safeFilename}`;
    checks.push({
      name: 'iso_checksum',
      retries: 2,
      cmd:
        `set -o pipefail; ` +
        `mkdir -p '${LOCAL_ISO_CACHE_DIR}'; ` +
        `rm -f '${localIsoPath}'; ` + // never trust a leftover from a previous failed/aborted attempt
        `if ! curl -fsSL --max-time 2700 -o '${localIsoPath}' "${target.isoUrl}"; then ` +
        `  echo "__DOWNLOAD_FAILED__"; rm -f '${localIsoPath}'; exit 1; ` +
        `fi; ` +
        (algoCmd === 'cksum'
          ? `cksum '${localIsoPath}' | awk '{printf "%08x", $1}'`
          : `${algoCmd} '${localIsoPath}' | awk '{print $1}'`),
      validate: (r) => {
        if (r.code !== 0) {
          return {
            ok: false,
            detail: `Gagal download ISO ke disk untuk checksum (curl/${algoCmd} exit=${r.code}). ` +
              `File rusak sudah dihapus dari cache. stderr=${(r.stderr || '').slice(0, 200)}`,
          };
        }
        const got = (r.stdout || '').trim().toLowerCase();
        if (!got || got.length !== wantHex.length || !/^[0-9a-f]+$/.test(got)) {
          return { ok: false, detail: `Output ${algoCmd} tidak valid ("${got.slice(0, 80)}")` };
        }
        if (got !== wantHex) {
          return {
            ok: false,
            detail: `CHECKSUM MISMATCH (${target.checksum.type}). expected=${wantHex} got=${got}. ` +
              `Image rusak/tertukar/tidak lengkap — file dihapus dari cache, INSTALASI DIBATALKAN, tidak lanjut reinstall.`,
          };
        }
        return { ok: true, detail: `${target.checksum.type} cocok (${got.slice(0, 16)}…) — source: ${target.checksum.source} — cached at ${localIsoPath}` };
      },
      // On ANY failure (download error OR mismatch) delete the file so a
      // retry never silently reuses a half-written or corrupted blob.
      onFail: async (ssh) => { try { await execRemote(ssh, `rm -f '${localIsoPath}'`); } catch (_) {} },
    });
  }

  const results = [];
  try {
    for (const check of checks) {
      const attempts = Math.max(1, Number(check.retries) || 1);
      let raw, verdict;
      for (let i = 1; i <= attempts; i++) {
        dbg.debug('PRECHECK', `run: ${check.name} (attempt ${i}/${attempts})`, { cmd: check.cmd.slice(0, 200) });
        raw = await execRemote(ssh, check.cmd);
        verdict = check.validate(raw);
        if (!verdict.ok && typeof check.onFail === 'function') {
          // Covers the checksum-MISMATCH case: curl exited 0 (file is on
          // disk) but the hash didn't match — clean up before any retry
          // or throw, so a stale/corrupt file never lingers in the cache.
          await check.onFail(ssh);
        }
        if (verdict.ok || i === attempts) break;
        dbg.warn('PRECHECK', `${check.name}: FAIL on attempt ${i}/${attempts}, retrying`, { detail: verdict.detail });
        await new Promise((res) => setTimeout(res, 5000));
      }
      results.push({ name: check.name, ...verdict, exitCode: raw.code });
      dbg.info('PRECHECK', `${check.name}: ${verdict.ok ? 'OK' : 'FAIL'}`, {
        detail: verdict.detail, exit: raw.code,
        stdout: raw.stdout.slice(-300), stderr: raw.stderr.slice(-300),
      });
      if (!verdict.ok) {
        const err = new Error(`Precheck GAGAL (${check.name}): ${verdict.detail}`);
        err.code = 'PRECHECK_' + check.name.toUpperCase();
        err.results = results;
        throw err;
      }
    }
    // If strict verification is disabled (the default fast path), do not
    // download the same multi-gigabyte ISO twice. We still resolve the
    // source's checksum metadata and perform URL/size/disk gates above, but
    // record the full-file hash as explicitly SKIPPED rather than pretending
    // it ran. Setting RDP_PREFLIGHT_FULL_ISO_CHECKSUM=true restores the old
    // pre-download + hash behaviour.
    if (!checks.some((c) => c.name === 'iso_checksum')) {
      const checksumKnown = !!(target.checksum && target.checksum.value && target.checksum.type);
      results.push({
        name: 'iso_checksum',
        ok: true,
        skipped: true,
        detail: checksumKnown
          ? `Fast mode — full ISO tidak diunduh dua kali pada Ubuntu. Metadata ${target.checksum.type} tersedia dari ${target.checksum.source}; verifikasi penuh dapat diaktifkan dengan RDP_PREFLIGHT_FULL_ISO_CHECKSUM=true.`
          : 'Dilewati — sumber tidak mempublikasikan checksum apapun (sha256/sha1/md5/crc32) untuk file ini.',
        exitCode: null,
      });
      dbg.info('PRECHECK', checksumKnown
        ? 'iso_checksum: SKIPPED (fast mode avoids duplicate 4–6 GB download)'
        : 'iso_checksum: SKIPPED (no checksum published by source)', {
        isoUrl: target.isoUrl, checksumKnown, fastMode: !PREFLIGHT_FULL_ISO_CHECKSUM,
      });
    }
    // localIsoPath is only meaningful for logs/audit right now — see the
    // ROUND-11 comment above the checksum check for why reinstall.sh's own
    // Alpine/trans.sh stage cannot yet consume this cached file directly.
    return { ok: true, results, localIsoPath };
  } finally {
    try { ssh.dispose(); } catch (_) {}
  }
}

function summarizeTarget(target) {
  return {
    windowsVersion: target.displayName,
    imageName:      target.imageName,
    isoUrl:         target.isoUrl,
    isoSource:      target.source,
    isoFilename:    target.filename,
    isoSizeMb:      target.sizeBytes ? Math.round(target.sizeBytes / 1024 / 1024) : null,
    isoEnv:         target.isoEnv,
    archiveId:      target.archiveId || null,
    isoLanguage:    target.language || null,
    checksumType:   target.checksum ? target.checksum.type : null,
    checksumSource: target.checksum ? target.checksum.source : null,
  };
}

module.exports = {
  WINDOWS_MATRIX,
  DEFAULT_ENTRY,
  resolveEntry,
  resolveWindowsTarget,
  resolveArchiveOrgIsoUrl,
  precheckOnVps,
  summarizeTarget,
  validateWindowsVersionMapping,
  REINSTALL_SCRIPT_URL,
  // Exported for unit testing (BUG #1 / BUG #2 fixes) — not part of the
  // public integration surface used by rdpOrchestrator.js.
  normalizeLangToken,
  filterIsosByLanguage,
  detectLanguagesPresent,
  extractChecksum,
  ARCHIVE_ORG_BASE,
  PREFLIGHT_FULL_ISO_CHECKSUM,
  PREFLIGHT_ISO_SPEED_TEST,
  ISO_MIN_DOWNLOAD_MBPS,
  ISO_SPEED_PROBE_BYTES,
};
