// Round-3 static verification: username prompt blocker, password policy,
// unsupported OS preflight, timeout bump, buildReinstallCommand assembly.
// No network, no MongoDB.
const assert = require('assert');
const path = require('path');
const cfg = require(path.join(__dirname, '..', 'src', 'provision', 'rdp', 'rdpConfig.js'));

// ─── BLOCKER 1: username prompt bypass + stdin pipe ─────────────────────
function testUsernameAndStdinPipe() {
  const cmd = cfg.buildReinstallCommand({
    sub: 'windows',
    imageName: 'Windows Server 2022 SERVERSTANDARD',
    password: 'MyStr0ng!Pass',
    rdpPort: 3389,
    username: 'administrator',
    isoUrl: 'https://example.com/w2022.iso',
  });

  // 1. --username flag present with 'administrator'
  assert.ok(cmd.includes('--username administrator'),
    'MUST pass --username administrator to bypass upstream read prompt');
  // 2. stdin pipe present so `read` never gets EOF (belt-and-braces)
  assert.ok(cmd.includes("printf '\\n\\n\\n\\n\\n' | bash /tmp/reinstall.sh"),
    'MUST pipe newlines into bash so any future read prompt gets a newline instead of EOF');
  // 3. NO redirect from /dev/null (that would produce EOF, defeating the pipe)
  assert.ok(!cmd.includes('< /dev/null'),
    "MUST NOT use `< /dev/null` (that gives EOF → same bug returns)");
  // 4. Other flags still correct
  assert.ok(cmd.includes(' windows --image-name "Windows Server 2022 SERVERSTANDARD"'));
  assert.ok(cmd.includes('--lang en-us'));
  assert.ok(cmd.includes('--rdp-port 3389'));
  assert.ok(cmd.includes('--password "MyStr0ng!Pass"'));
  // 5. No blind reboot fallback
  assert.ok(!cmd.includes('reboot -f'));
  // 6. Exit code hard-gate still present
  assert.ok(cmd.includes('if [ $RC -ne 0 ]'));
  console.log('✅ FIX B1: --username administrator explicit (bypasses upstream Username: prompt)');
  console.log('✅ FIX B1: printf-pipe stdin (never EOF for future read prompts)');
}

// Username override is safe — invalid chars filtered
function testUsernameSanitisation() {
  const cmd = cfg.buildReinstallCommand({
    sub: 'windows', imageName: 'Windows 11 Pro',
    password: 'P@ss1', rdpPort: 3389,
    username: 'admin;rm -rf /',   // hostile
    isoUrl: 'https://example.com/win11.iso',
  });
  assert.ok(!cmd.includes('rm -rf'), 'hostile characters must be stripped from --username');
  assert.ok(/--username admin[^ ]* /.test(cmd), 'sanitised username still passed as flag');
  console.log('✅ FIX B1: --username sanitisation filters shell-hostile chars');
}

// ─── POTENSI A: Password policy validator ────────────────────────────────
function testPasswordPolicy() {
  // Good password: passes all checks
  const good = cfg.validateWindowsPassword('Aa1!Aa1!Aa1!Aa1!', 'administrator');
  assert.ok(good.ok, 'Aa1!Aa1!Aa1!Aa1! should be valid');
  // Too short
  const short = cfg.validateWindowsPassword('Aa1!Aa1!', 'administrator');
  assert.ok(!short.ok && short.errors.includes('length<12'));
  // No uppercase
  const noUpper = cfg.validateWindowsPassword('aaaaaaa1!aaaa', 'administrator');
  assert.ok(!noUpper.ok && noUpper.errors.includes('no-uppercase'));
  // No digit
  const noDigit = cfg.validateWindowsPassword('Aaaaaaaaa!aaa', 'administrator');
  assert.ok(!noDigit.ok && noDigit.errors.includes('no-digit'));
  // No symbol
  const noSym = cfg.validateWindowsPassword('Aaaaaaaaa1aaa', 'administrator');
  assert.ok(!noSym.ok && noSym.errors.includes('no-symbol'));
  // Contains username
  const hasUser = cfg.validateWindowsPassword('Administrator1!x', 'administrator');
  assert.ok(!hasUser.ok && hasUser.errors.includes('contains-username'));
  // Shell-hostile char
  const shellBad = cfg.validateWindowsPassword('Aa1!Aa1!Aa1! ', 'administrator');
  assert.ok(!shellBad.ok && shellBad.errors.includes('contains-shell-hostile-char'));
  console.log('✅ FIX A: Windows password policy validator (upper/lower/digit/symbol/length/username/shell-safe)');
}

// Actual generator produces passwords that pass the validator
function testGeneratorMeetsPolicy() {
  const { generateAdminPassword } = require(path.join(__dirname, '..', 'src', 'utils', 'passwordGen.js'));
  for (let i = 0; i < 200; i++) {
    const p = generateAdminPassword(18);
    const v = cfg.validateWindowsPassword(p, 'administrator');
    assert.ok(v.ok, `generator produced invalid pwd: "${p}" — ${v.errors.join(',')}`);
  }
  console.log('✅ FIX A: generateAdminPassword() output ALWAYS satisfies Windows policy (200/200 samples)');
}

// ─── POTENSI B: --rdp-port supported by upstream (confirmed by crawl) ────
function testRdpPortFlag() {
  const cmd = cfg.buildReinstallCommand({
    sub: 'windows', imageName: 'Windows 11 Pro',
    password: 'Aa1!Aa1!Aa1!', rdpPort: 33890, username: 'administrator',
    isoUrl: 'https://example.com/win11.iso',
  });
  assert.ok(cmd.includes('--rdp-port 33890'), 'custom rdp-port must be passed');
  console.log('✅ FIX B: --rdp-port supported (verified against upstream long-opts list)');
}

// ─── POTENSI C: OS unsupported preflight ────────────────────────────────
// Round-4 note: `isAutoInstallSupported` sekarang always-true karena kita
// selalu pass `--iso` explicit. Gate versi Windows sekarang ada di
// `windowsInstaller.resolveWindowsTarget()` (WIN_ISO_* ENV).
function testUnsupportedOsPreflight() {
  // Supported versions
  assert.strictEqual(cfg.isAutoInstallSupported('Windows Server 2019'), true);
  assert.strictEqual(cfg.isAutoInstallSupported('Windows Server 2022'), true);
  assert.strictEqual(cfg.isAutoInstallSupported('Windows Server 2025'), true);
  assert.strictEqual(cfg.isAutoInstallSupported('Windows 10 Original'), true);
  assert.strictEqual(cfg.isAutoInstallSupported('Windows 11 Original'), true);
  assert.strictEqual(cfg.isAutoInstallSupported(''), true);
  console.log('✅ FIX C: isAutoInstallSupported → always-true (gate moved to windowsInstaller.resolveWindowsTarget)');
}

// ─── POTENSI D: Timeout 60 min ──────────────────────────────────────────
function testTimeout() {
  assert.strictEqual(cfg.REINSTALL_MAX_TIMEOUT_MS, 90 * 60 * 1000,
    `REINSTALL_MAX_TIMEOUT_MS should be 90 min (R7 hardening); got ${cfg.REINSTALL_MAX_TIMEOUT_MS / 60000} min`);
  // Stall timeout also bumped to accommodate slow first-boot Windows
  assert.ok(cfg.STALL_TIMEOUT_MS >= 15 * 60 * 1000);
  console.log(`✅ FIX D: REINSTALL_MAX_TIMEOUT_MS = ${cfg.REINSTALL_MAX_TIMEOUT_MS / 60000} min (was 45)`);
}

// ─── POTENSI E: buildReinstallCommand structural review ─────────────────
function testCommandStructure() {
  const cmd = cfg.buildReinstallCommand({
    sub: 'windows',
    imageName: 'Windows Server 2022 SERVERSTANDARD',
    password: 'Aa1!Aa1!Aa1!',
    rdpPort: 3389,
    username: 'administrator',
    isoUrl: 'https://example.com/w2022.iso',
  });
  // Structural expectations, in order (round-4 updated):
  const mustAppearInOrder = [
    'set -o pipefail',
    'export DEBIAN_FRONTEND=noninteractive',
    'curl -fsSL --max-time 30 -o /tmp/reinstall.sh',
    'chmod +x /tmp/reinstall.sh',
    "printf '\\n\\n\\n\\n\\n' | bash /tmp/reinstall.sh windows --image-name",
    '--iso "https://example.com/w2022.iso"',
    'RC=$?',
    'if [ $RC -ne 0 ]',
    'REINSTALL SCRIPT FAILED',
    'reinstall staged OK',
  ];
  let cursor = 0;
  for (const needle of mustAppearInOrder) {
    const idx = cmd.indexOf(needle, cursor);
    assert.ok(idx >= 0, `command missing expected step: "${needle}"`);
    cursor = idx + needle.length;
  }
  assert.ok(cmd.split(' ; ').length >= 8, 'steps must be chained with ; separator');
  console.log('✅ FIX E: buildReinstallCommand structure verified end-to-end (round-4: --iso mandatory)');
}

(async () => {
  try { testUsernameAndStdinPipe(); } catch (e) { console.error('FAIL B1:', e.message); process.exit(1); }
  try { testUsernameSanitisation(); } catch (e) { console.error('FAIL B1b:', e.message); process.exit(1); }
  try { testPasswordPolicy(); } catch (e) { console.error('FAIL A:', e.message); process.exit(1); }
  try { testGeneratorMeetsPolicy(); } catch (e) { console.error('FAIL A2:', e.message); process.exit(1); }
  try { testRdpPortFlag(); } catch (e) { console.error('FAIL B:', e.message); process.exit(1); }
  try { testUnsupportedOsPreflight(); } catch (e) { console.error('FAIL C:', e.message); process.exit(1); }
  try { testTimeout(); } catch (e) { console.error('FAIL D:', e.message); process.exit(1); }
  try { testCommandStructure(); } catch (e) { console.error('FAIL E:', e.message); process.exit(1); }
  console.log('\n════════════════════════════════════════════════');
  console.log('Round-3 fixes: 8/8 static assertions PASSED');
  console.log('════════════════════════════════════════════════');
})();
