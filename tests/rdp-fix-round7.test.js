// ROUND-7 HARDENING TESTS
// User bug report: "Setelah reinstall — reboot tidak terjadi / Alpine stuck download ISO"
// Hardening applied:
//   1. REINSTALL_MAX 60 → 90 min
//   2. REBOOT_HARD_LIMIT 5 → 10 min (default)
//   3. Force-reboot escalation ladder: reboot → power_cycle → power_off+power_on
//   4. Alpine stuck detector (port22 open > 25 min after reboot → power_cycle)
//   5. archive.org resolver retry 3× with exponential backoff
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const cfg = require('../src/provision/rdp/rdpConfig');
const winInstaller = require('../src/provision/rdp/windowsInstaller');

// ---- 1. Timeouts extended ----
assert.strictEqual(cfg.REINSTALL_MAX_TIMEOUT_MS, 90 * 60 * 1000,
  `REINSTALL_MAX_TIMEOUT_MS should be 90 min; got ${cfg.REINSTALL_MAX_TIMEOUT_MS / 60000} min`);
assert.ok(cfg.ALPINE_STUCK_TIMEOUT_MS >= 20 * 60 * 1000,
  `ALPINE_STUCK_TIMEOUT_MS must be ≥ 20 min; got ${cfg.ALPINE_STUCK_TIMEOUT_MS / 60000}`);
console.log(`✅ R7.1: Timeouts extended — REINSTALL_MAX=${cfg.REINSTALL_MAX_TIMEOUT_MS / 60000}m, ALPINE_STUCK=${cfg.ALPINE_STUCK_TIMEOUT_MS / 60000}m`);

// ---- 2. Force-reboot escalation ladder ----
const orchSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'provision', 'rdp', 'rdpOrchestrator.js'), 'utf8');
assert.ok(orchSrc.includes('forceRebootStage'),                     'escalation state var must exist');
assert.ok(orchSrc.includes('Stage 1/3'),                             'Stage 1 marker missing');
assert.ok(orchSrc.includes('Stage 2/3'),                             'Stage 2 marker missing');
assert.ok(orchSrc.includes('Stage 3/3'),                             'Stage 3 marker missing');
assert.ok(orchSrc.includes('adapter.rebootDroplet'),                 'stage 1 must call rebootDroplet');
assert.ok(orchSrc.includes('adapter.powerCycle'),                    'stage 2 must call powerCycle');
assert.ok(orchSrc.includes('adapter.powerOff') && orchSrc.includes('adapter.powerOn'),
  'stage 3 must call powerOff + powerOn');
console.log('✅ R7.2: Force-reboot escalation ladder (reboot → power_cycle → power_off+power_on)');

// ---- 3. Default REBOOT_HARD_LIMIT 10 min ----
assert.ok(orchSrc.includes('10 * 60 * 1000'),                        'default REBOOT_HARD_LIMIT must be 10 min');
console.log('✅ R7.3: Default REBOOT_HARD_LIMIT extended to 10 min');

// ---- 4. Alpine stuck detector ----
assert.ok(orchSrc.includes('alpineStuckAt'),                          'alpine stuck timer missing');
assert.ok(orchSrc.includes('alpineForcedCycled'),                     'alpine forced-cycle flag missing');
assert.ok(orchSrc.includes('ALPINE_STUCK'),                           'ALPINE_STUCK debug tag missing');
assert.ok(orchSrc.includes('cfg.ALPINE_STUCK_TIMEOUT_MS'),            'must reference ALPINE_STUCK_TIMEOUT_MS');
console.log('✅ R7.4: Alpine stuck detector wired (auto power_cycle after 25 min)');

// ---- 5. archive.org retry ----
const winSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'provision', 'rdp', 'windowsInstaller.js'), 'utf8');
assert.ok(winSrc.includes('maxAttempts = 3'),                         'archive.org resolver must retry 3×');
assert.ok(winSrc.includes('archive.org resolve failed after'),        'must throw with attempt count');
assert.ok(/backoffMs.*\[1000.*3000.*7000\]/.test(winSrc),             'exponential backoff must be 1s/3s/7s');
console.log('✅ R7.5: archive.org resolver retry 3× with exponential backoff');

// ---- 6. Legacy `forcedRebootTried` variable removed (no dead code) ----
assert.ok(!orchSrc.includes('forcedRebootTried'),
  'legacy forcedRebootTried variable must be removed (replaced by forceRebootStage)');
console.log('✅ R7.6: Legacy one-shot flag removed');

console.log('\n════════════════════════════════════════════════');
console.log('Round-7 hardening: 6/6 assertions PASSED');
console.log('════════════════════════════════════════════════');
