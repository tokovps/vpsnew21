// Round-6 static verification for multi-signal reboot detection.
// No live network / no mongo — verifies exports + orchestrator wiring
// against grep of the source.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const doAd = require(path.join(__dirname, '..', 'src', 'providers', 'digitalocean.js'));
const ssh  = require(path.join(__dirname, '..', 'src', 'provision', 'rdp', 'rdpSSH.js'));

function testDoAdapterPowerActions() {
  for (const m of ['powerOn', 'powerOff', 'powerCycle', 'rebootDroplet', 'getRecentActions']) {
    assert.strictEqual(typeof doAd[m], 'function', `digitalocean.${m} missing`);
  }
  console.log('✅ R6.1: DO adapter exposes powerOn/powerOff/powerCycle/rebootDroplet/getRecentActions');
}

function testProbeRebootState() {
  assert.strictEqual(typeof ssh.probeRebootState, 'function');
  console.log('✅ R6.2: rdpSSH.probeRebootState exported');
}

function testOrchestratorWiring() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'provision', 'rdp', 'rdpOrchestrator.js'), 'utf8');
  // Multi-signal detection markers
  const markers = [
    'probeRebootState',                                          // uses SSH probe
    'apiRebootDetected',                                         // DO API actions check
    'getRecentActions',                                          // adapter action list
    'REBOOT_HARD_LIMIT_MS',                                      // 5-minute hard timeout
    "method: 'port22-closed'",                                   // signal A
    "method: 'uptime-check'",                                    // signal B
    "method: 'os-family-change'",                                // signal C
    "method: 'ssh-host-key-change'",                             // signal D
    "method: 'do-api-actions'",                                  // signal E
    'adapter.powerOn',                                            // auto power-on
    'adapter.rebootDroplet',                                      // force reboot on hard-fail
    'forceRebootStage',                                          // R7: escalation ladder (was forcedRebootTried)
    'FORCE_REBOOT',                                               // log tag
    'POWER_ON',                                                   // log tag
    'cfg.REBOOT_HARD_LIMIT_MS',                                   // central env-backed override
  ];
  for (const m of markers) {
    assert.ok(src.includes(m), `orchestrator missing marker: "${m}"`);
  }
  // Old bogus assumption must be gone
  assert.ok(!/rebootDeadline\s*=\s*Date\.now\(\)\s*\+\s*cfg\.STALL_TIMEOUT_MS/.test(src),
    'old STALL_TIMEOUT-based rebootDeadline must be removed (replaced by REBOOT_HARD_LIMIT_MS)');
  console.log('✅ R6.3: orchestrator wired for all 5 reboot-detection signals + power-on + force-reboot');
}

function testMultiSignalOrdering() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'provision', 'rdp', 'rdpOrchestrator.js'), 'utf8');
  // Extract the monitor-loop region
  const startIdx = src.indexOf('ROUND-6 MONITOR LOOP');
  const endIdx = src.indexOf('---- RDP configuring', startIdx);
  assert.ok(startIdx > 0 && endIdx > startIdx, 'monitor loop region not found');
  const region = src.slice(startIdx, endIdx);
  // Each detection method must set linuxWentDown = true
  const setCount = (region.match(/linuxWentDown\s*=\s*true/g) || []).length;
  assert.ok(setCount >= 5, `expected >=5 places setting linuxWentDown=true (one per signal), got ${setCount}`);
  // Progress must transition to WINDOWS_INSTALLING when detected
  const winInstallCount = (region.match(/setState\('WINDOWS_INSTALLING'\)/g) || []).length;
  assert.ok(winInstallCount >= 4, `expected multiple setState('WINDOWS_INSTALLING'), got ${winInstallCount}`);
  console.log(`✅ R6.4: ${setCount} paths flip linuxWentDown=true across 5 signals`);
}

function testHardFailIncludesTechnicalReason() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'provision', 'rdp', 'rdpOrchestrator.js'), 'utf8');
  assert.ok(src.includes('Reboot TIDAK terjadi dalam'),                       'hard-fail message must mention Reboot TIDAK terjadi');
  assert.ok(src.includes('port 22 tetap terbuka'),                            'hard-fail must mention port 22');
  assert.ok(src.includes('uptime menunjukkan Ubuntu asli'),                   'hard-fail must mention uptime');
  assert.ok(src.includes('DO API tidak melaporkan reboot event'),             'hard-fail must mention DO API');
  assert.ok(src.includes('reinstall.sh gagal setup bootloader, atau kernel panic'), 'hard-fail must mention bootloader/kernel');
  console.log('✅ R6.5: hard-fail includes full technical reason (no generic exit=1)');
}

try { testDoAdapterPowerActions(); }         catch (e) { console.error('FAIL R6.1:', e.message); process.exit(1); }
try { testProbeRebootState(); }              catch (e) { console.error('FAIL R6.2:', e.message); process.exit(1); }
try { testOrchestratorWiring(); }            catch (e) { console.error('FAIL R6.3:', e.message); process.exit(1); }
try { testMultiSignalOrdering(); }           catch (e) { console.error('FAIL R6.4:', e.message); process.exit(1); }
try { testHardFailIncludesTechnicalReason();} catch (e) { console.error('FAIL R6.5:', e.message); process.exit(1); }

console.log('\n════════════════════════════════════════════════');
console.log('Round-6 fixes: 5/5 static assertions PASSED');
console.log('════════════════════════════════════════════════');
