// ROUND-11 AUDIT TESTS — Windows Installer pipeline: single ISO download
//
// GOAL: ISO is downloaded to disk exactly ONCE by precheckOnVps, the
// checksum is computed FROM THE DOWNLOADED FILE (not a discarded stream),
// a checksum mismatch deletes the corrupted file and aborts (no reinstall
// dispatch), and the disk_space gate accounts for the ISO now actually
// living on disk instead of being streamed straight to a hash tool.
//
// precheckOnVps opens its own `new NodeSSH()` internally, so these tests
// monkey-patch NodeSSH.prototype.execCommand to script fake command
// results by matching against the command string precheckOnVps builds —
// no live network or live VPS required.
const assert = require('assert');
const { NodeSSH } = require('node-ssh');

// ROUND-17 makes the non-duplicating fast path the production default.
// This legacy suite intentionally exercises the optional strict full-file
// checksum path, so opt in before windowsInstaller.js is loaded.
process.env.RDP_PREFLIGHT_FULL_ISO_CHECKSUM = 'true';

function withScriptedSSH(handlers, fn) {
  const orig = {
    connect: NodeSSH.prototype.connect,
    execCommand: NodeSSH.prototype.execCommand,
    dispose: NodeSSH.prototype.dispose,
  };
  NodeSSH.prototype.connect = async function () { return this; };
  NodeSSH.prototype.dispose = function () {};
  const calls = [];
  NodeSSH.prototype.execCommand = async function (cmd) {
    calls.push(cmd);
    for (const h of handlers) {
      if (h.match.test(cmd)) return h.result(cmd);
    }
    // Default: make every OTHER precheck step (internet/dns/script
    // download/iso_url_reachable — not under test here) pass cleanly, so
    // each test only has to script the steps it actually cares about.
    if (/1\.1\.1\.1\/cdn-cgi\/trace/.test(cmd)) return { stdout: '200', stderr: '', code: 0 };
    if (/getent hosts|nslookup/.test(cmd)) return { stdout: '1.2.3.4 fakehost\n', stderr: '', code: 0 };
    if (/reinstall\.sh"/.test(cmd) && /__SIZE__/.test(cmd)) {
      return { stdout: `#!/usr/bin/env bash fake\n__SIZE__=60000`, stderr: '', code: 0 };
    }
    if (/__EXIT__=\$code/.test(cmd)) {
      return {
        stdout: '__EXIT__=0\nHTTP/1.1 200 OK\ncontent-length: 4294967296\ncontent-type: application/octet-stream',
        stderr: '', code: 0,
      };
    }
    if (/df -BM/.test(cmd)) return { stdout: '99999', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  };
  return Promise.resolve()
    .then(() => fn(calls))
    .finally(() => {
      NodeSSH.prototype.connect = orig.connect;
      NodeSSH.prototype.execCommand = orig.execCommand;
      NodeSSH.prototype.dispose = orig.dispose;
    });
}

async function testChecksumComputedFromDownloadedFile() {
  const wi = require('../src/provision/rdp/windowsInstaller.js');
  const target = {
    imageName: 'Windows Server 2022 SERVERSTANDARD',
    displayName: 'Windows Server 2022 Standard',
    isoUrl: 'https://archive.org/download/fake/fake.iso',
    filename: 'fake.iso',
    sizeBytes: 4 * 1024 * 1024 * 1024,
    checksum: { type: 'sha256', value: 'a'.repeat(64), source: 'test' },
  };
  const wantHex = target.checksum.value;

  await withScriptedSSH(
    [
      {
        // precheckOnVps issues the iso_checksum gate as ONE combined shell
        // command (mkdir cache dir; rm stale leftovers; curl -o local path;
        // then hash THAT file). Assert the command actually downloads to a
        // fixed local path via `curl -o` — NOT piping straight into
        // sha256sum (the old ROUND-10 behaviour) — and reads the file back
        // to hash it, then hand back the matching hash as the "result".
        match: /mkdir -p '\/root\/\.reinstall-iso-cache'.*curl -fsSL --max-time 2700 -o '.+fake\.iso' "https:\/\/archive\.org\/download\/fake\/fake\.iso".*sha256sum '.+fake\.iso'/s,
        result: () => ({ stdout: `${wantHex}\n`, stderr: '', code: 0 }),
      },
      {
        match: /df -BM/,
        result: () => ({ stdout: '99999', stderr: '', code: 0 }),
      },
    ],
    async (calls) => {
      const res = await wi.precheckOnVps('1.2.3.4', { password: 'x' }, target, {});
      assert.strictEqual(res.ok, true);
      const csResult = res.results.find((r) => r.name === 'iso_checksum');
      assert.ok(csResult, 'iso_checksum result must be present');
      assert.strictEqual(csResult.ok, true);
      assert.ok(/cached at/.test(csResult.detail), 'success detail must report the cache path');
      assert.ok(res.localIsoPath && /\/root\/\.reinstall-iso-cache\/fake\.iso$/.test(res.localIsoPath));
      // Exactly ONE check (one execCommand call) performs the ISO curl —
      // this is the "download once" guarantee: no separate step re-fetches
      // the same URL elsewhere in the precheck.
      const isoDownloadSteps = calls.filter((c) => /curl -fsSL --max-time 2700 -o '.+\.iso' "/.test(c));
      assert.strictEqual(isoDownloadSteps.length, 1, 'ISO must be curl-downloaded exactly once during precheck');
    }
  );
  console.log('✅ R11.1: checksum computed from the downloaded file, ISO fetched exactly once, cache path reported');
}

async function testMismatchDeletesFileAndAborts() {
  const wi = require('../src/provision/rdp/windowsInstaller.js');
  const target = {
    imageName: 'Windows Server 2022 SERVERSTANDARD',
    displayName: 'Windows Server 2022 Standard',
    isoUrl: 'https://archive.org/download/fake/fake.iso',
    filename: 'fake.iso',
    sizeBytes: 4 * 1024 * 1024 * 1024,
    checksum: { type: 'sha256', value: 'a'.repeat(64), source: 'test' },
  };

  await withScriptedSSH(
    [
      {
        // Combined download+hash command succeeds, but returns the WRONG
        // hash — simulates a corrupted/tampered download that still
        // completed (curl exit 0) yet doesn't match the expected checksum.
        match: /curl -fsSL --max-time 2700 -o '.+fake\.iso'.*sha256sum '.+fake\.iso'/s,
        result: () => ({ stdout: `${'b'.repeat(64)}\n`, stderr: '', code: 0 }),
      },
      { match: /df -BM/, result: () => ({ stdout: '99999', stderr: '', code: 0 }) },
      // The cleanup command precheckOnVps's onFail hook must issue after
      // a mismatch (separate execCommand call, run via execRemote).
      { match: /^rm -f '.+fake\.iso'$/, result: () => ({ stdout: '', stderr: '', code: 0 }) },
    ],
    async (calls) => {
      await assert.rejects(
        () => wi.precheckOnVps('1.2.3.4', { password: 'x' }, target, {}),
        (err) => {
          assert.strictEqual(err.code, 'PRECHECK_ISO_CHECKSUM');
          assert.ok(/MISMATCH/.test(err.message));
          assert.ok(/dihapus dari cache|INSTALASI DIBATALKAN/.test(err.message));
          return true;
        }
      );
      const cleanupCalls = calls.filter((c) => /^rm -f '.+fake\.iso'$/.test(c));
      assert.ok(cleanupCalls.length >= 1, 'corrupted file must be deleted after a checksum mismatch');
    }
  );
  console.log('✅ R11.2: checksum mismatch deletes the cached ISO and aborts precheck (no reinstall dispatch)');
}

async function testDiskSpaceThresholdIsSizeAware() {
  const wi = require('../src/provision/rdp/windowsInstaller.js');
  const bigTarget = {
    imageName: 'Windows Server 2025 SERVERSTANDARD',
    displayName: 'Windows Server 2025 Standard',
    isoUrl: 'https://archive.org/download/fake/big.iso',
    filename: 'big.iso',
    sizeBytes: 6 * 1024 * 1024 * 1024, // 6 GB → needs ~6144 + 2000 = ~8144 MB, still under the 15000 floor
    checksum: null, // no checksum → iso_checksum gate is skipped, disk_space is what we're testing
  };

  // 16000 MB free clears both the 15000 MB floor and the size-based need.
  await withScriptedSSH(
    [{ match: /df -BM/, result: () => ({ stdout: '16000', stderr: '', code: 0 }) }],
    async () => {
      const res = await wi.precheckOnVps('1.2.3.4', { password: 'x' }, bigTarget, {});
      assert.strictEqual(res.ok, true);
    }
  );

  // A genuinely huge ISO (30 GB) must push the requirement ABOVE the old
  // flat 15000 MB floor, proving the threshold is now size-aware and not
  // just the historical constant.
  const hugeTarget = { ...bigTarget, sizeBytes: 30 * 1024 * 1024 * 1024 };
  await withScriptedSSH(
    // 16000 MB free was enough for the 15000 MB floor but NOT for a 30 GB ISO.
    [{ match: /df -BM/, result: () => ({ stdout: '16000', stderr: '', code: 0 }) }],
    async () => {
      await assert.rejects(
        () => wi.precheckOnVps('1.2.3.4', { password: 'x' }, hugeTarget, {}),
        (err) => {
          assert.strictEqual(err.code, 'PRECHECK_DISK_SPACE');
          assert.ok(/butuh ≥ \d{5,}/.test(err.message), 'required MB must scale with ISO size, not stay flat at 15000');
          return true;
        }
      );
    }
  );
  console.log('✅ R11.3: disk_space precheck threshold scales with resolved ISO size (no longer a flat 15000 MB)');
}

(async () => {
  await testChecksumComputedFromDownloadedFile();
  await testMismatchDeletesFileAndAborts();
  await testDiskSpaceThresholdIsSizeAware();
  console.log('\n════════════════════════════════════════════════');
  console.log('Round-11 audit fixes: 3/3 assertions PASSED');
  console.log('════════════════════════════════════════════════');
})().catch((e) => {
  console.error('❌ ROUND-11 TEST FAILED:', e);
  process.exit(1);
});
