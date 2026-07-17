// ROUND-17 — fast RDP provisioning without weakening the READY gate.
// Verifies that the default path no longer downloads the 4–6 GB ISO twice,
// staging/reboot/install have bounded deadlines, and slow phase timeouts do
// not multiply across every configured provider.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { NodeSSH } = require('node-ssh');

const ROOT = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

async function testFastPreflightSkipsDuplicateIsoDownload() {
  const previous = process.env.RDP_PREFLIGHT_FULL_ISO_CHECKSUM;
  delete process.env.RDP_PREFLIGHT_FULL_ISO_CHECKSUM;
  delete require.cache[require.resolve('../src/provision/rdp/windowsInstaller.js')];
  const wi = require('../src/provision/rdp/windowsInstaller.js');
  assert.strictEqual(wi.PREFLIGHT_FULL_ISO_CHECKSUM, false);

  const original = {
    connect: NodeSSH.prototype.connect,
    execCommand: NodeSSH.prototype.execCommand,
    dispose: NodeSSH.prototype.dispose,
  };
  const calls = [];
  NodeSSH.prototype.connect = async function () { return this; };
  NodeSSH.prototype.dispose = function () {};
  NodeSSH.prototype.execCommand = async function (cmd) {
    calls.push(cmd);
    if (/1\.1\.1\.1\/cdn-cgi\/trace/.test(cmd)) return { stdout: '200', stderr: '', code: 0 };
    if (/getent hosts|nslookup/.test(cmd)) return { stdout: '1.2.3.4 host\n', stderr: '', code: 0 };
    if (/reinstall\.sh"/.test(cmd) && /__SIZE__/.test(cmd)) {
      return { stdout: '#!/usr/bin/env bash fake\n__SIZE__=60000', stderr: '', code: 0 };
    }
    if (/__EXIT__=\$code/.test(cmd)) {
      return {
        stdout: '__EXIT__=0\nHTTP/1.1 200 OK\ncontent-length: 4831838208\ncontent-type: application/octet-stream',
        stderr: '', code: 0,
      };
    }
    if (/__ISO_SPEED__/.test(cmd)) {
      return { stdout: '__ISO_SPEED__=8388608:1000:8388608', stderr: '', code: 0 };
    }
    if (/df -BM/.test(cmd)) return { stdout: '20000', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  };

  try {
    const result = await wi.precheckOnVps('192.0.2.10', { password: 'x' }, {
      imageName: 'Windows Server 2022 SERVERSTANDARD',
      displayName: 'Windows Server 2022 Standard',
      isoUrl: 'https://archive.org/download/fake/windows.iso',
      filename: 'windows.iso',
      sizeBytes: 4.5 * 1024 * 1024 * 1024,
      checksum: { type: 'sha1', value: 'a'.repeat(40), source: 'archive.org-fixity' },
    }, {});
    const checksum = result.results.find(r => r.name === 'iso_checksum');
    assert.ok(checksum && checksum.skipped, 'full ISO checksum must be explicitly marked skipped in fast mode');
    assert.match(checksum.detail, /tidak diunduh dua kali/i);
    assert.strictEqual(result.localIsoPath, null);
    assert.strictEqual(calls.some(cmd => /max-time 2700.*\.iso/.test(cmd)), false,
      'fast preflight must not download the complete ISO on Ubuntu');
  } finally {
    NodeSSH.prototype.connect = original.connect;
    NodeSSH.prototype.execCommand = original.execCommand;
    NodeSSH.prototype.dispose = original.dispose;
    if (previous === undefined) delete process.env.RDP_PREFLIGHT_FULL_ISO_CHECKSUM;
    else process.env.RDP_PREFLIGHT_FULL_ISO_CHECKSUM = previous;
    delete require.cache[require.resolve('../src/provision/rdp/windowsInstaller.js')];
  }
  console.log('✅ R17.1: fast preflight avoids the duplicate 4–6 GB ISO download');
}

function testBoundedPhaseTimeouts() {
  const cfg = require('../src/provision/rdp/rdpConfig.js');
  assert.strictEqual(cfg.REINSTALL_DISPATCH_TIMEOUT_MS, 4 * 60 * 1000);
  assert.strictEqual(cfg.REINSTALL_MAX_TIMEOUT_MS, 20 * 60 * 1000);
  assert.strictEqual(cfg.REBOOT_HARD_LIMIT_MS, 3 * 60 * 1000);
  assert.strictEqual(cfg.REBOOT_ESCALATION_GRACE_MS, 30 * 1000);

  const cmd = cfg.buildReinstallCommand({
    sub: 'windows', imageName: 'Windows Server 2022 SERVERSTANDARD',
    password: 'Aa1!Aa1!Aa1!', rdpPort: 3389, username: 'administrator',
    isoUrl: 'https://example.com/windows.iso',
  });
  assert.ok(cmd.includes('timeout --foreground 240s bash /tmp/reinstall.sh'));
  assert.ok(cmd.includes('REINSTALL DISPATCH TIMEOUT after 240s'));
  assert.ok(cmd.includes('exit 124'));
  console.log('✅ R17.2/R18: Ubuntu staging has a 4-minute watchdog and install target is 20 minutes');
}

function testInvalidTimeoutEnvFallsBackSafely() {
  const previous = process.env.RDP_REINSTALL_DISPATCH_TIMEOUT_MS;
  process.env.RDP_REINSTALL_DISPATCH_TIMEOUT_MS = 'bukan-angka';
  delete require.cache[require.resolve('../src/provision/rdp/rdpConfig.js')];
  const cfg = require('../src/provision/rdp/rdpConfig.js');
  try {
    assert.strictEqual(cfg.REINSTALL_DISPATCH_TIMEOUT_MS, 4 * 60 * 1000);
    const cmd = cfg.buildReinstallCommand({
      sub: 'windows', imageName: 'Windows Server 2022 SERVERSTANDARD',
      password: 'Aa1!Aa1!Aa1!', rdpPort: 3389, username: 'administrator',
      isoUrl: 'https://example.com/windows.iso',
    });
    assert.ok(cmd.includes('timeout --foreground 240s'));
    assert.ok(!cmd.includes('NaN'));
  } finally {
    if (previous === undefined) delete process.env.RDP_REINSTALL_DISPATCH_TIMEOUT_MS;
    else process.env.RDP_REINSTALL_DISPATCH_TIMEOUT_MS = previous;
    delete require.cache[require.resolve('../src/provision/rdp/rdpConfig.js')];
  }
  console.log('✅ R17.3: invalid timeout ENV safely falls back instead of producing NaN');
}

function testOrchestratorUsesOneTotalDeadline() {
  const source = read('src/provision/rdp/rdpOrchestrator.js');
  assert.ok(source.includes('reinstallStart + cfg.REINSTALL_MAX_TIMEOUT_MS'),
    'total deadline must begin at dispatch, not after runReinstall returns');
  assert.ok(!source.includes('Date.now() + cfg.REINSTALL_MAX_TIMEOUT_MS'),
    'must not restart the full install timeout after staging');
  for (const code of [
    'RDP_REINSTALL_DISPATCH_TIMEOUT', 'RDP_REBOOT_TIMEOUT', 'RDP_INSTALL_TIMEOUT',
  ]) {
    assert.ok(source.includes(`'${code}'`), `${code} must be classified`);
  }

  const progress = read('src/provision/rdp/rdpProgress.js');
  assert.ok(progress.includes('if (curr === state)'), 'same-state evidence must not reset ETA');
  assert.ok(progress.includes('Estimasi tahap'), 'UI must label ETA as per-phase');

  const machine = read('src/provision/rdp/rdpStateMachine.js');
  assert.ok(machine.includes("label: 'Menyiapkan Boot Installer'"));
  assert.match(machine, /REINSTALL_STARTING:[^\n]+etaMin:\s+4/);
  console.log('✅ R17.4: one total deadline, terminal timeout classification, and non-resetting phase ETA');
}

(async () => {
  await testFastPreflightSkipsDuplicateIsoDownload();
  testBoundedPhaseTimeouts();
  testInvalidTimeoutEnvFallsBackSafely();
  testOrchestratorUsesOneTotalDeadline();
  console.log('\n🎉 ROUND-17 RDP speed regression tests PASSED');
})().catch((error) => {
  console.error('❌ ROUND-17 TEST FAILED:', error && error.stack || error);
  process.exitCode = 1;
});
