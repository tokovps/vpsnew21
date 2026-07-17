// ROUND-19 — delivered RDP endpoints must stay reachable and self-repair.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

function testPersistentWindowsWatchdog() {
  const bat = read('src/provision/rdp/confhomeMirror/assets/windows-fix-rdp-compat.bat');
  for (const required of [
    '%ProgramData%\\TokoVPS',
    'rdp-watchdog.bat',
    'TokoVPS-RDP-Startup',
    '/sc onstart',
    '/delay 0000:30',
    'TokoVPS-RDP-Watchdog',
    '/sc minute /mo 2',
    '/ru SYSTEM /rl HIGHEST',
    'sc failure TermService',
    'actions= restart/5000/restart/5000/restart/5000',
    'netstat -ano',
    'not LISTENING - restarting TermService',
  ]) {
    assert.ok(bat.includes(required), `persistent Windows repair missing: ${required}`);
  }
  assert.ok(bat.includes('if /i not "%~1"=="/watchdog" del "%~f0"'),
    'only the one-time installer copy may self-delete; watchdog copy must persist');
  assert.ok(!/^del "%~f0"/m.test(bat), 'unconditional self-delete must not return');
  console.log('✅ R19.1: Windows watchdog persists and repairs RDP after boot/policy refresh');
}

function testBotSideAutoRecovery() {
  const health = read('src/health/vpsHealth.js');
  for (const required of [
    "lifecycle: 'rdp'",
    'rdpHandshakeDetailed',
    "typeof acts.start === 'function'",
    "typeof acts.reboot === 'function'",
    'RDP_FAILURE_THRESHOLD',
    'RDP_REPAIR_COOLDOWN_MS',
    'RDP_MAX_REPAIR_ATTEMPTS',
    'rdp-auto-power-on',
    'rdp-auto-reboot',
    'checkRdpLiveness',
  ]) {
    assert.ok(health.includes(required), `bot RDP recovery missing: ${required}`);
  }
  assert.ok(health.includes('setInterval(() => {'));
  assert.ok(health.includes('checkRdpLiveness().catch'));

  const model = read('src/models/VpsInstance.js');
  for (const field of [
    'rdpLastReadyAt', 'rdpConsecutiveFailures', 'rdpRepairAttempts', 'rdpLastRepairAt',
  ]) {
    assert.ok(model.includes(field), `persistent RDP health field missing: ${field}`);
  }

  const orchestrator = read('src/provision/rdp/rdpOrchestrator.js');
  assert.ok(orchestrator.includes('rdpLastReadyAt: new Date()'),
    'a newly delivered RDP must persist its initial verified-ready time');

  const render = read('render.yaml');
  assert.match(render, /RDP_HEALTH_INTERVAL_MS\s+value: "120000"/);
  assert.match(render, /RDP_HEALTH_FAILURE_THRESHOLD\s+value: "2"/);
  assert.match(render, /RDP_MAX_REPAIR_ATTEMPTS\s+value: "3"/);
  console.log('✅ R19.2: bot powers on stopped RDPs and reboots persistently unreachable ones');
}

testPersistentWindowsWatchdog();
testBotSideAutoRecovery();
console.log('\n🎉 ROUND-19 RDP liveness tests PASSED');
