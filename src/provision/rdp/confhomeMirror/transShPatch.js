// ============================================================================
// transShPatch.js
// ----------------------------------------------------------------------------
// Applies ONE minimal, idempotent patch to upstream bin456789/reinstall's
// trans.sh: it adds a call to `windows-fix-rdp-compat.bat` inside
// modify_windows(), using EXACTLY the same mechanism upstream already uses
// for windows-allow-ping.bat (`download $confhome/<file> $os_dir/<file>` then
// appended to the `bats` list that modify_windows() later wires into either
// SetupComplete.cmd or the GPO startup script, depending on image state).
//
// WHY A LIVE PATCH INSTEAD OF A FORK:
//   Upstream's own README explicitly documents "fork this repo, modify
//   confhome" as the sanctioned extension point. A static fork would still
//   need manual re-sync every time bin456789/reinstall changes trans.sh. This
//   module instead re-fetches upstream trans.sh on every request (see
//   confhomeMirror/index.js) and applies this same patch on the fly, so the
//   bot is always running the CURRENT upstream trans.sh plus one small diff.
//
// SAFETY / FAIL-OPEN:
//   The patch only fires if the anchor block (the existing windows-allow-ping
//   handling) is found byte-for-byte-ish (whitespace-tolerant). If upstream
//   ever refactors modify_windows() enough that the anchor no longer matches,
//   `applyRdpCompatPatch` returns the ORIGINAL, unmodified trans.sh with
//   `applied: false` — we never throw, and we never risk corrupting a script
//   that is about to run unattended on a customer's VPS. The mismatch is
//   surfaced via the `/reinstall-mirror/_status` diagnostic endpoint instead.
// ============================================================================

'use strict';

const BAT_FILENAME = 'windows-fix-rdp-compat.bat';

// Bumped only if the INSERTED block's contents change; used purely so we can
// detect "already patched" text defensively (see below). Not a security
// boundary — just avoids a theoretical double-insert if this module is ever
// called twice on already-patched text.
const PATCH_MARKER = 'PATCH-MARKER:windows-fix-rdp-compat-v1';

// Matches the existing "# 2. 允许 ping" / is_allow_ping block in
// modify_windows(), from the comment line through the closing `fi` of that
// `if is_allow_ping; then ... fi` statement. Whitespace-tolerant so trivial
// upstream reformatting (tabs vs spaces, comment wording) doesn't break the
// match; the invariant parts we key on are the function names
// (`is_allow_ping`, `windows-allow-ping.bat`) which are stable public
// behaviour, not incidental formatting.
const ANCHOR_RE = /([ \t]*#[^\n]*ping[^\n]*\n[ \t]*if\s+is_allow_ping;\s*then\b[\s\S]*?windows-allow-ping\.bat[\s\S]*?\n[ \t]*fi\n)/;

function buildInsertedBlock(indent) {
  return (
    `\n${indent}# RDP client-compatibility fix (patched in by local confhome mirror)\n` +
    `${indent}# ${PATCH_MARKER}\n` +
    `${indent}download $confhome/${BAT_FILENAME} $os_dir/${BAT_FILENAME}\n` +
    `${indent}bats="$bats ${BAT_FILENAME}"\n`
  );
}

/**
 * @param {string} transShText - raw upstream trans.sh content
 * @returns {{ patched: string, applied: boolean, reason: string }}
 */
function applyRdpCompatPatch(transShText) {
  if (typeof transShText !== 'string' || !transShText.includes('modify_windows()')) {
    return { patched: transShText, applied: false, reason: 'modify_windows() not found in upstream trans.sh' };
  }

  if (transShText.includes(PATCH_MARKER)) {
    // Already patched (defensive — normally we always start from a pristine
    // upstream fetch, see confhomeMirror/index.js's no-cache upstream fetch).
    return { patched: transShText, applied: true, reason: 'already patched (marker present)' };
  }

  const match = ANCHOR_RE.exec(transShText);
  if (!match) {
    return {
      patched: transShText,
      applied: false,
      reason: 'anchor block (is_allow_ping / windows-allow-ping.bat) not found — upstream modify_windows() likely restructured; serving unmodified upstream trans.sh',
    };
  }

  const anchorBlock = match[1];
  const indentMatch = /^([ \t]*)#/.exec(anchorBlock);
  const indent = indentMatch ? indentMatch[1] : '    ';

  const patched = transShText.slice(0, match.index + anchorBlock.length) +
    buildInsertedBlock(indent) +
    transShText.slice(match.index + anchorBlock.length);

  return { patched, applied: true, reason: 'inserted after windows-allow-ping.bat block' };
}

module.exports = {
  BAT_FILENAME,
  PATCH_MARKER,
  applyRdpCompatPatch,
};
