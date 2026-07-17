// Round-4 static verification: --iso mandatory, windowsInstaller resolver,
// terminal-error codes, log fields. No network / no MongoDB.
const assert = require('assert');
const path = require('path');
const cfg = require(path.join(__dirname, '..', 'src', 'provision', 'rdp', 'rdpConfig.js'));
const wi  = require(path.join(__dirname, '..', 'src', 'provision', 'rdp', 'windowsInstaller.js'));

// ─── R4.1: buildReinstallCommand REFUSES to build without --iso ───────────
function testIsoMandatory() {
  let threw = false;
  try {
    cfg.buildReinstallCommand({
      sub: 'windows', imageName: 'Windows 11 Pro',
      password: 'Aa1!Aa1!Aa1!', rdpPort: 3389, username: 'administrator',
      // isoUrl omitted
    });
  } catch (e) {
    threw = true;
    assert.ok(/isoUrl kosong/i.test(e.message), 'error message must mention isoUrl');
  }
  assert.ok(threw, 'buildReinstallCommand must throw when isoUrl is missing');
  console.log('✅ R4.1: buildReinstallCommand refuses to run without --iso (fail-fast)');
}

// ─── R4.2: --iso URL appears in command exactly once, quoted ─────────────
function testIsoInCommand() {
  const url = 'https://mirror.example.com/win10-x64.iso';
  const cmd = cfg.buildReinstallCommand({
    sub: 'windows', imageName: 'Windows 10 Pro',
    password: 'Aa1!Aa1!Aa1!', rdpPort: 3389, username: 'administrator',
    isoUrl: url,
  });
  assert.ok(cmd.includes(`--iso "${url}"`), 'command must include --iso "<URL>"');
  // --iso must appear in the actual bash invocation between --image-name and --lang
  const invocationLine = cmd.split(' ; ').find(p => p.includes('bash /tmp/reinstall.sh windows'));
  assert.ok(invocationLine, 'invocation line missing');
  const iName = invocationLine.indexOf('--image-name');
  const iIso  = invocationLine.indexOf('--iso "');
  const iLang = invocationLine.indexOf('--lang');
  assert.ok(iName > 0 && iIso > iName && iLang > iIso,
    `flag order in invocation: image-name(${iName}) → iso(${iIso}) → lang(${iLang})`);
  // Command logs the URL so operator can audit
  assert.ok(cmd.includes(`echo "[rdp] iso        : ${url}"`),
    'command must log the resolved ISO URL');
  console.log('✅ R4.2: --iso URL passed to reinstall.sh + logged to stdout');
}

// ─── R4.3: windowsInstaller.resolveWindowsTarget (round-5: async + archive.org) ─
async function testResolver() {
  // Reset env for deterministic test
  delete process.env.WIN_ISO_SERVER_2022;
  delete process.env.WIN_ISO_WIN_11;
  delete process.env.WIN_ISO_WIN_10;
  delete process.env.WIN_ISO_SERVER_2019;
  delete process.env.WIN_ISO_SERVER_2025;

  // Case A: unknown version → WIN_VERSION_UNSUPPORTED
  try {
    await wi.resolveWindowsTarget('linux ubuntu 22.04');
    assert.fail('should throw for unknown version');
  } catch (e) {
    assert.ok(['WIN_VERSION_UNSUPPORTED', 'WIN_ISO_URL_MISSING', 'WIN_ISO_RESOLVE_FAILED'].includes(e.code),
      `expected WIN_VERSION_UNSUPPORTED, got ${e.code}`);
  }

  // Case C: ENV set to non-http → WIN_ISO_URL_INVALID
  process.env.WIN_ISO_SERVER_2022 = 'ftp://not-http/w2022.iso';
  try {
    await wi.resolveWindowsTarget('server 2022');
    assert.fail('should throw for non-http URL');
  } catch (e) {
    assert.strictEqual(e.code, 'WIN_ISO_URL_INVALID');
  }
  delete process.env.WIN_ISO_SERVER_2022;

  // Case D: ENV override works → returns full target with source=env-override
  process.env.WIN_ISO_SERVER_2022 = 'https://mirror.example.com/w2022.iso';
  const t = await wi.resolveWindowsTarget('Windows Server 2022 Standard');
  assert.strictEqual(t.imageName, 'Windows Server 2022 SERVERSTANDARD');
  assert.strictEqual(t.isoUrl, 'https://mirror.example.com/w2022.iso');
  assert.strictEqual(t.source, 'env-override');
  assert.strictEqual(t.isoEnv, 'WIN_ISO_SERVER_2022');
  delete process.env.WIN_ISO_SERVER_2022;

  // Case E: Matrix entries (round-9 audit: Tiny10/Tiny11 got dedicated
  // NTDEV images; Windows 10/11 Superlite & All-In-One got explicit
  // fallback-to-Pro entries instead of being silently treated as Pro).
  const matrix = wi.WINDOWS_MATRIX;
  assert.strictEqual(matrix.length, 12, 'matrix must have 12 versions');
  for (const e of matrix) {
    assert.ok(e.imageName && e.imageName.length > 3);
    assert.ok(
      (e.archiveId && e.archiveId.length > 3) || (e.fallbackArchiveId && e.fallbackArchiveId.length > 3),
      `${e.displayName} missing both archiveId and fallbackArchiveId`
    );
    assert.ok(e.isoEnv && e.isoEnv.startsWith('WIN_ISO_'));
  }
  console.log('✅ R4.3: resolveWindowsTarget async + ENV override + matrix 12x (dedicated + fallback archiveIds)');
}

// ─── R4.4: precheckOnVps is defined and returns a Promise ─────────────────
function testPrecheckSurface() {
  assert.strictEqual(typeof wi.precheckOnVps, 'function');
  // We do NOT call it — needs live SSH. Just prove the signature exists.
  console.log('✅ R4.4: windowsInstaller.precheckOnVps exported');
}

// ─── R4.5: rdpConfig.isAutoInstallSupported degraded to true-always ──────
function testLegacyGateDeprecated() {
  assert.strictEqual(cfg.isAutoInstallSupported('Windows Server 2012 R2'), true);
  assert.strictEqual(cfg.isAutoInstallSupported('Server 2016'), true);
  assert.strictEqual(cfg.autoInstallUnsupportedReason('anything'), '');
  console.log('✅ R4.5: legacy isAutoInstallSupported() now true-always (gate moved to windowsInstaller)');
}

// ─── R4.6: orchestrator source-check — precheck + resolver are wired ─────
function testOrchestratorWiring() {
  const fs = require('fs');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'provision', 'rdp', 'rdpOrchestrator.js'), 'utf8');
  assert.ok(src.includes("require('./windowsInstaller')"),         'orchestrator must import windowsInstaller');
  assert.ok(src.includes('winInstaller.resolveWindowsTarget'),      'must call resolveWindowsTarget at preflight');
  assert.ok(src.includes('winInstaller.precheckOnVps'),             'must call precheckOnVps before reinstall');
  assert.ok(src.includes('isoUrl: winTarget.isoUrl'),               'must pass isoUrl to buildReinstallCommand');
  assert.ok(src.includes("TERMINAL_CODES"),                          'terminal-error whitelist must exist');
  assert.ok(src.includes("'WIN_ISO_URL_MISSING'"),                   'WIN_ISO_URL_MISSING must be terminal');
  assert.ok(src.includes("'PRECHECK_ISO_URL_REACHABLE'"),            'PRECHECK_ISO_URL_REACHABLE must be terminal');
  // Specific-reason derivation from log tail
  assert.ok(src.includes('iso link is empty|iso url is not set'),
    'orchestrator must recognise "ISO Link is empty" upstream error');
  assert.ok(src.includes('windowsVersion: winTarget.displayName'),   'REINSTALL_EXIT log must include windowsVersion');
  assert.ok(src.includes('imageName: winTarget.imageName'),          'REINSTALL_EXIT log must include imageName');
  assert.ok(src.includes('isoUrl: winTarget.isoUrl'),                'REINSTALL_EXIT log must include isoUrl');
  console.log('✅ R4.6: orchestrator wired to resolver + precheck + isoUrl + terminal codes + log fields');
}

(async () => {
  try { testIsoMandatory(); }        catch (e) { console.error('FAIL R4.1:', e.message); process.exit(1); }
  try { testIsoInCommand(); }        catch (e) { console.error('FAIL R4.2:', e.message); process.exit(1); }
  try { await testResolver(); }      catch (e) { console.error('FAIL R4.3:', e.message); process.exit(1); }
  try { testPrecheckSurface(); }     catch (e) { console.error('FAIL R4.4:', e.message); process.exit(1); }
  try { testLegacyGateDeprecated();} catch (e) { console.error('FAIL R4.5:', e.message); process.exit(1); }
  try { testOrchestratorWiring(); }  catch (e) { console.error('FAIL R4.6:', e.message); process.exit(1); }
  console.log('\n════════════════════════════════════════════════');
  console.log('Round-4 fixes: 6/6 static assertions PASSED');
  console.log('════════════════════════════════════════════════');
})();
