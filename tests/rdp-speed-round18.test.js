// ROUND-18 — 20-minute RDP target and non-blocking provider capacity.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { NodeSSH } = require('node-ssh');

const ROOT = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

function scriptedSsh(speedLine) {
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
    if (/__ISO_SPEED__/.test(cmd)) return { stdout: speedLine, stderr: '', code: 0 };
    if (/df -BM/.test(cmd)) return { stdout: '20000', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  };
  return {
    calls,
    restore() {
      NodeSSH.prototype.connect = original.connect;
      NodeSSH.prototype.execCommand = original.execCommand;
      NodeSSH.prototype.dispose = original.dispose;
    },
  };
}

function freshInstaller() {
  delete process.env.RDP_PREFLIGHT_FULL_ISO_CHECKSUM;
  delete process.env.RDP_ISO_SPEED_PROBE;
  delete process.env.RDP_ISO_MIN_DOWNLOAD_MBPS;
  delete require.cache[require.resolve('../src/provision/rdp/windowsInstaller.js')];
  return require('../src/provision/rdp/windowsInstaller.js');
}

const target = {
  imageName: 'Windows Server 2022 SERVERSTANDARD',
  displayName: 'Windows Server 2022 Standard',
  isoUrl: 'https://archive.org/download/fake/windows.iso',
  filename: 'windows.iso',
  sizeBytes: 4.5 * 1024 * 1024 * 1024,
  checksum: { type: 'sha1', value: 'a'.repeat(40), source: 'archive.org-fixity' },
};

async function testThroughputGate() {
  const wi = freshInstaller();
  assert.strictEqual(wi.PREFLIGHT_ISO_SPEED_TEST, true);
  assert.strictEqual(wi.ISO_MIN_DOWNLOAD_MBPS, 40);
  assert.strictEqual(wi.ISO_SPEED_PROBE_BYTES, 8 * 1024 * 1024);

  const fast = scriptedSsh('__ISO_SPEED__=8388608:1000:8388608'); // ~67 Mbps
  try {
    const result = await wi.precheckOnVps('192.0.2.10', { password: 'x' }, target, {});
    const speed = result.results.find(r => r.name === 'iso_throughput');
    assert.ok(speed && speed.ok);
    assert.match(speed.detail, /67\.1 Mbps/);
    const command = fast.calls.find(cmd => /__ISO_SPEED__/.test(cmd));
    assert.ok(command && command.includes('head -c 8388608'));
    assert.ok(!command.includes('2700'), 'speed sample must never become a full ISO download');
  } finally {
    fast.restore();
  }

  const slow = scriptedSsh('__ISO_SPEED__=4194304:20000:209715'); // ~1.7 Mbps
  try {
    await assert.rejects(
      () => wi.precheckOnVps('192.0.2.11', { password: 'x' }, target, {}),
      err => err.code === 'PRECHECK_ISO_THROUGHPUT' && /terlalu lambat/i.test(err.message),
    );
  } finally {
    slow.restore();
  }
  console.log('✅ R18.1: bounded 8 MiB probe accepts fast ISO routes and rejects slow ones');
}

function testTwentyMinuteAndParallelDefaults() {
  const cfg = require('../src/provision/rdp/rdpConfig.js');
  assert.strictEqual(cfg.REINSTALL_DISPATCH_TIMEOUT_MS, 4 * 60 * 1000);
  assert.strictEqual(cfg.REINSTALL_MAX_TIMEOUT_MS, 20 * 60 * 1000);
  assert.strictEqual(cfg.REBOOT_HARD_LIMIT_MS, 3 * 60 * 1000);
  assert.strictEqual(cfg.ALPINE_STUCK_TIMEOUT_MS, 12 * 60 * 1000);
  assert.strictEqual(cfg.PORT_POLL_INTERVAL_MS, 5 * 1000);

  const queue = read('src/queues/provisionQueue.js');
  assert.ok(queue.includes("readConcurrency('RDP_PROVISION_CONCURRENCY', 3)"));
  const render = read('render.yaml');
  assert.match(render, /RDP_REINSTALL_MAX_TIMEOUT_MS\s+value: "1200000"/);
  assert.match(render, /RDP_PROVISION_CONCURRENCY\s+value: "3"/);
  console.log('✅ R18.2: 20-minute install target, 5-second polling, and three RDP workers');
}

function testProviderReleasedBeforeLongInstall() {
  const source = read('src/provision/rdp/rdpOrchestrator.js');
  const precheck = source.indexOf('await winInstaller.precheckOnVps');
  const commit = source.indexOf('const capacity = await providerService.markUsed');
  const reinstall = source.indexOf('const rr = await runReinstall');
  assert.ok(precheck >= 0 && commit > precheck && reinstall > commit,
    'quota must be committed and token released after preflight but before long install');
  assert.ok(source.includes('if (!providerCapacityCommitted)'));
  assert.ok(source.includes('isPermanentProviderFailure(err)'));
  assert.ok(source.includes("require('../../health/providerHealth').checkOne"));
  console.log('✅ R18.3: provider token is released before Windows install without double quota use');
}

(async () => {
  await testThroughputGate();
  testTwentyMinuteAndParallelDefaults();
  testProviderReleasedBeforeLongInstall();
  console.log('\n🎉 ROUND-18 RDP speed tests PASSED');
})().catch((error) => {
  console.error('❌ ROUND-18 TEST FAILED:', error && error.stack || error);
  process.exitCode = 1;
});
