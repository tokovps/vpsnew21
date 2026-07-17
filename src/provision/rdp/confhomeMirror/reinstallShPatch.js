// ============================================================================
// reinstallShPatch.js
// ----------------------------------------------------------------------------
// Rewrites ONLY the `confhome=` / `confhome_cn=` assignment lines at the top
// of upstream reinstall.sh, pointing them at our own confhome mirror instead
// of raw.githubusercontent.com / cnb.cool. Nothing else in reinstall.sh is
// touched — its control flow, arguments, and every other line are byte-for-
// byte upstream.
//
// This is exactly the mechanism upstream's own README documents as the
// sanctioned way to customise behaviour ("Fork this repository. Modify the
// confhome and confhome_cn at the beginning of reinstall.sh and
// reinstall.bat."). We apply it dynamically on every fetch instead of
// maintaining a static fork, so reinstall.sh itself always tracks upstream
// `main` with zero manual sync work.
//
// Once confhome points at our mirror, reinstall.sh's own
// `wget $confhome/trans.sh` (and everything trans.sh subsequently downloads,
// including the .bat files) transparently goes through
// confhomeMirror/index.js, which is where the actual RDP-compat patch is
// applied (see transShPatch.js).
// ============================================================================

'use strict';

const CONFHOME_LINE_RE = /^confhome=.*$/m;
const CONFHOME_CN_LINE_RE = /^confhome_cn=.*$/m;

/**
 * @param {string} reinstallShText - raw upstream reinstall.sh content
 * @param {string} mirrorBaseUrl - fully-qualified public URL of our mirror
 *   mount point, e.g. "https://bot.example.com/reinstall-mirror" (no
 *   trailing slash).
 * @returns {{ patched: string, applied: boolean, reason: string }}
 */
function rewriteConfhome(reinstallShText, mirrorBaseUrl) {
  if (typeof reinstallShText !== 'string' || !CONFHOME_LINE_RE.test(reinstallShText)) {
    return { patched: reinstallShText, applied: false, reason: 'confhome= line not found in upstream reinstall.sh' };
  }
  if (!mirrorBaseUrl || !/^https?:\/\//i.test(mirrorBaseUrl)) {
    return { patched: reinstallShText, applied: false, reason: 'no valid public mirror base configured (WEBHOOK_URL / CONFHOME_MIRROR_PUBLIC_URL) — serving unmodified upstream reinstall.sh (RDP-compat fix will NOT be applied)' };
  }

  const base = mirrorBaseUrl.replace(/\/+$/, '');
  let patched = reinstallShText.replace(CONFHOME_LINE_RE, `confhome=${base}`);
  // confhome_cn is only used when the VPS itself detects it is in China
  // (is_in_china); point it at the same mirror so behaviour stays identical
  // either way instead of silently falling back to the real upstream there.
  patched = patched.replace(CONFHOME_CN_LINE_RE, `confhome_cn=${base}`);

  return { patched, applied: true, reason: `confhome rewritten to ${base}` };
}

module.exports = { rewriteConfhome };
