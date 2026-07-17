// CONFHOME MIRROR — RDP COMPAT PATCH TESTS
// Verifies:
//   1. The trans.sh patch inserts windows-fix-rdp-compat.bat right after the
//      existing windows-allow-ping.bat block, using the same mechanism.
//   2. Applying the patch twice is idempotent (no duplicate insertion).
//   3. If upstream restructures modify_windows() so the anchor can't be
//      found, the patch fails OPEN (returns unmodified text, applied=false)
//      instead of throwing or corrupting the script.
//   4. reinstall.sh confhome/confhome_cn rewrite only touches those two
//      lines and is idempotent.
//   5. windows-fix-rdp-compat.bat itself audits before writing (reg query
//      before every reg add) for each registry value it touches.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { applyRdpCompatPatch, BAT_FILENAME, PATCH_MARKER } = require('../src/provision/rdp/confhomeMirror/transShPatch');
const { rewriteConfhome } = require('../src/provision/rdp/confhomeMirror/reinstallShPatch');

// ---- Fixture: minimal slice of trans.sh's modify_windows(), matching the
// real upstream structure closely enough to anchor on. ----
const FIXTURE_TRANS_SH = `
modify_windows() {
    local os_dir=$1
    info "Modify Windows"

    bats=

    # 1. rdp 端口
    if is_need_change_rdp_port; then
        create_win_change_rdp_port_script $os_dir/windows-change-rdp-port.bat "$rdp_port"
        bats="$bats windows-change-rdp-port.bat"
    fi

    # 2. 允许 ping
    if is_allow_ping; then
        download $confhome/windows-allow-ping.bat $os_dir/windows-allow-ping.bat
        bats="$bats windows-allow-ping.bat"
    fi

    # 3. 合并分区
    download $confhome/windows-resize.bat $os_dir/windows-resize.bat
    bats="$bats windows-resize.bat"
}
`;

// ---- 1. Patch inserts right after the allow-ping block ----
const result1 = applyRdpCompatPatch(FIXTURE_TRANS_SH);
assert.strictEqual(result1.applied, true, 'patch should apply on the fixture');
assert.ok(result1.patched.includes(`download $confhome/${BAT_FILENAME} $os_dir/${BAT_FILENAME}`),
  'patched trans.sh must download windows-fix-rdp-compat.bat exactly like windows-allow-ping.bat');
assert.ok(result1.patched.includes(`bats="$bats ${BAT_FILENAME}"`),
  'patched trans.sh must append the new bat to the bats list');

// inserted block must come AFTER windows-allow-ping.bat and BEFORE windows-resize.bat
const idxAllowPing = result1.patched.indexOf('windows-allow-ping.bat');
const idxOurBat = result1.patched.indexOf(BAT_FILENAME, idxAllowPing + 1);
const idxResize = result1.patched.indexOf('windows-resize.bat');
assert.ok(idxAllowPing < idxOurBat && idxOurBat < idxResize,
  'inserted block must sit between the allow-ping block and the resize step');
console.log('✅ 1. RDP-compat bat inserted using the same mechanism as windows-allow-ping.bat');

// ---- 2. Idempotent: patching already-patched text is a no-op re-insert ----
const result2 = applyRdpCompatPatch(result1.patched);
assert.strictEqual(result2.applied, true);
const occurrences = (result2.patched.match(new RegExp(BAT_FILENAME, 'g')) || []).length;
const occurrencesFirstPass = (result1.patched.match(new RegExp(BAT_FILENAME, 'g')) || []).length;
assert.strictEqual(occurrences, occurrencesFirstPass,
  'applying the patch to already-patched text must not duplicate the block');
assert.ok(result2.patched.includes(PATCH_MARKER));
console.log('✅ 2. Patch is idempotent — re-applying does not duplicate the inserted block');

// ---- 3. Fails open if upstream restructures modify_windows() ----
const RESTRUCTURED_FIXTURE = `
modify_windows() {
    local os_dir=$1
    # upstream rewrote this entire function and no longer has is_allow_ping
    echo "totally different implementation"
}
`;
const result3 = applyRdpCompatPatch(RESTRUCTURED_FIXTURE);
assert.strictEqual(result3.applied, false, 'must not claim success when anchor is missing');
assert.strictEqual(result3.patched, RESTRUCTURED_FIXTURE, 'must return upstream text UNMODIFIED when anchor is missing');
assert.ok(/anchor block/i.test(result3.reason), 'reason should explain the anchor mismatch');
console.log('✅ 3. Fails open (serves unmodified upstream) if modify_windows() is restructured');

// ---- 4. confhome rewrite touches only those two lines, idempotent ----
const FIXTURE_REINSTALL_SH = `#!/usr/bin/env bash
set -eE
confhome=https://raw.githubusercontent.com/bin456789/reinstall/main
confhome_cn=https://cnb.cool/bin456789/reinstall/-/git/raw/main
SCRIPT_VERSION=4BACD833-A585-23BA-6CBB-9AA4E08E0004
echo "rest of the script is untouched"
`;
const mirrorBase = 'https://bot.example.com/reinstall-mirror';
const r4a = rewriteConfhome(FIXTURE_REINSTALL_SH, mirrorBase);
assert.strictEqual(r4a.applied, true);
assert.ok(r4a.patched.includes(`confhome=${mirrorBase}`));
assert.ok(r4a.patched.includes(`confhome_cn=${mirrorBase}`));
assert.ok(r4a.patched.includes('SCRIPT_VERSION=4BACD833-A585-23BA-6CBB-9AA4E08E0004'),
  'SCRIPT_VERSION (reinstall.sh<->trans.sh compat marker) must be untouched');
assert.ok(r4a.patched.includes('echo "rest of the script is untouched"'),
  'every other line must be byte-for-byte unmodified');

// idempotent: re-running on already-rewritten text yields the same result
const r4b = rewriteConfhome(r4a.patched, mirrorBase);
assert.strictEqual(r4b.patched, r4a.patched, 'rewriting confhome twice must be idempotent');
console.log('✅ 4. confhome/confhome_cn rewrite is scoped + idempotent; SCRIPT_VERSION untouched');

// ---- 4b. Without a configured mirror base URL, fails open (no rewrite) ----
const r4c = rewriteConfhome(FIXTURE_REINSTALL_SH, '');
assert.strictEqual(r4c.applied, false);
assert.strictEqual(r4c.patched, FIXTURE_REINSTALL_SH);
console.log('✅ 4b. Without CONFHOME_MIRROR_PUBLIC_URL configured, reinstall.sh is served unmodified');

// ---- 5. windows-fix-rdp-compat.bat audits before writing ----
const batContent = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'provision', 'rdp', 'confhomeMirror', 'assets', 'windows-fix-rdp-compat.bat'),
  'utf8'
);
for (const valueName of ['AllowEncryptionOracle', 'SecurityLayer', 'fDenyTSConnections']) {
  assert.ok(batContent.includes(`reg query`) && batContent.includes(valueName),
    `${valueName} must be audited via reg query`);
}
// Every reg add must be guarded by an `if /i not "...CUR..."=="..."` comparison,
// i.e. count of "reg add" occurrences should not exceed count of comparison guards.
const codeLines = batContent.split(/\r?\n/).filter((l) => !/^\s*rem\b/i.test(l));
const regAddCount = codeLines.filter((l) => /^\s*reg add/i.test(l)).length;
// Count only registry audit comparisons. The script also has lifecycle guards
// for the persistent watchdog, which are unrelated to `reg add` safety.
const guardCount = codeLines.filter((l) => /^\s*if \/i not .*_CUR%/i.test(l)).length;
assert.strictEqual(regAddCount, guardCount, 'every reg add must be gated by a prior audit comparison');
assert.ok(batContent.includes('del "%~f0"'), 'script should clean up after itself like the other generated bats');
console.log('✅ 5. windows-fix-rdp-compat.bat audits every registry value before writing (idempotent)');

console.log('\nAll confhome-mirror RDP-compat tests passed.');
