// ROUND-7 HARDENING TESTS
// User bug report: "Setelah reinstall — reboot tidak terjadi / Alpine stuck download ISO"
// Hardening applied:
//   1. REINSTALL_MAX was extended to 90 min in R7; R18 now rejects slow ISO
//      routes and targets a 20-minute dispatch-to-RDP deadline.
//   2. REBOOT_HARD_LIMIT is 3 min after dispatch gained a watchdog.
//   3. Force-reboot escalation ladder: reboot → power_cycle → power_off+power_on
//   4. Alpine stuck detector (port22 open > 12 min after reboot → power_cycle)
//   5. archive.org resolver retry 3× with exponential backoff
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const cfg = require('../src/provision/rdp/rdpConfig');
const winInstaller = require('../src/provision/rdp/windowsInstaller');

// ---- 1. Timeouts extended ----
assert.strictEqual(cfg.REINSTALL_MAX_TIMEOUT_MS, 20 * 60 * 1000,
  `REINSTALL_MAX_TIMEOUT_MS should be 20 min; got ${cfg.REINSTALL_MAX_TIMEOUT_MS / 60000} min`);
assert.strictEqual(cfg.ALPINE_STUCK_TIMEOUT_MS, 12 * 60 * 1000,
  `ALPINE_STUCK_TIMEOUT_MS should be 12 min; got ${cfg.ALPINE_STUCK_TIMEOUT_MS / 60000}`);
console.log(`✅ R7.1/R18: bounded timeout — REINSTALL_MAX=${cfg.REINSTALL_MAX_TIMEOUT_MS / 60000}m, ALPINE_STUCK=${cfg.ALPINE_STUCK_TIMEOUT_MS / 60000}m`);

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

// ---- 3. Default REBOOT_HARD_LIMIT 3 min (bounded R18 fast path) ----
assert.strictEqual(cfg.REBOOT_HARD_LIMIT_MS, 3 * 60 * 1000,
  'default REBOOT_HARD_LIMIT must be 3 min');
assert.ok(orchSrc.includes('cfg.REBOOT_HARD_LIMIT_MS'),
  'orchestrator must use central reboot hard limit');
console.log('✅ R7.3/R18: Default REBOOT_HARD_LIMIT bounded to 3 min');

// ---- 4. Alpine stuck detector ----
assert.ok(orchSrc.includes('alpineStuckAt'),                          'alpine stuck timer missing');
assert.ok(orchSrc.includes('alpineForcedCycled'),                     'alpine forced-cycle flag missing');
assert.ok(orchSrc.includes('ALPINE_STUCK'),                           'ALPINE_STUCK debug tag missing');
assert.ok(orchSrc.includes('cfg.ALPINE_STUCK_TIMEOUT_MS'),            'must reference ALPINE_STUCK_TIMEOUT_MS');
console.log('✅ R7.4/R18: Alpine stuck detector wired (auto power_cycle after 12 min)');

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
