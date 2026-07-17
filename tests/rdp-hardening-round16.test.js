// Round-16 regression coverage for customer-reachable RDP hardening.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const axios = require('axios');
const digitalocean = require('../src/providers/digitalocean');

const ROOT = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

async function testFirewallParsing() {
  const includes = digitalocean.__firewallPortIncludes;
  assert.strictEqual(includes('3389', 3389), true);
  assert.strictEqual(includes('3000-4000', 3389), true);
  assert.strictEqual(includes('22, 3389', 3389), true);
  assert.strictEqual(includes('all', 3389), true);
  assert.strictEqual(includes('22', 3389), false);

  const target = digitalocean.__firewallTargetsDroplet;
  assert.strictEqual(target({ droplet_ids: [123], tags: [] }, '123', ['tgbot']), true);
  assert.strictEqual(target({ droplet_ids: [], tags: ['tgbot'] }, '123', ['tgbot']), true);
  assert.strictEqual(target({ droplet_ids: [], tags: ['other'] }, '123', ['tgbot']), false);

  const allows = digitalocean.__ruleAllowsPublicTcp;
  assert.strictEqual(allows({
    protocol: 'tcp', ports: '3389', sources: { addresses: ['0.0.0.0/0'] },
  }, 3389), true);
  assert.strictEqual(allows({
    protocol: 'tcp', ports: '3389', sources: { addresses: ['203.0.113.5/32'] },
  }, 3389), false);
  assert.strictEqual(allows({
    protocol: 'udp', ports: '3389', sources: { addresses: ['0.0.0.0/0'] },
  }, 3389), false);
  console.log('✅ DigitalOcean firewall target/port/source parsing is strict');
}

async function testFirewallAuditOutcomes() {
  const originalCreate = axios.create;
  let firewalls = [];
  axios.create = () => ({
    get: async () => ({ data: { firewalls } }),
  });

  try {
    let result = await digitalocean.auditRdpCloudFirewall({ doToken: 'test' }, 123);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.mode, 'no-cloud-firewall');

    firewalls = [{
      id: 'blocked', name: 'restricted', droplet_ids: [123], tags: [],
      inbound_rules: [{ protocol: 'tcp', ports: '3389', sources: { addresses: ['198.51.100.7/32'] } }],
    }];
    result = await digitalocean.auditRdpCloudFirewall({ doToken: 'test' }, 123);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.mode, 'attached-firewall-blocks-public-rdp');

    firewalls.push({
      id: 'public', name: 'rdp-public', droplet_ids: [], tags: ['tgbot'],
      inbound_rules: [{ protocol: 'tcp', ports: '3389', sources: { addresses: ['0.0.0.0/0'] } }],
    });
    result = await digitalocean.auditRdpCloudFirewall({ doToken: 'test' }, 123);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.allowingFirewalls, ['rdp-public']);
  } finally {
    axios.create = originalCreate;
  }
  console.log('✅ Cloud firewall audit passes open/default, blocks restricted, accepts public TCP 3389');
}

function testMirrorDefaultsAndRouteOrder() {
  const configPath = path.join(ROOT, 'src/provision/rdp/rdpConfig.js');
  const output = execFileSync(process.execPath, ['-e', [
    `const c=require(${JSON.stringify(configPath)});`,
    'process.stdout.write(c.REINSTALL_SCRIPT_URL);',
  ].join('')], {
    env: {
      ...process.env,
      WEBHOOK_URL: 'https://bot.example.test',
      CONFHOME_MIRROR_PUBLIC_URL: '',
      REINSTALL_SCRIPT_URL: '',
    },
    encoding: 'utf8',
  });
  assert.strictEqual(output, 'https://bot.example.test/reinstall-mirror/reinstall.sh');

  const mirror = read('src/provision/rdp/confhomeMirror/index.js');
  assert.ok(mirror.indexOf("r.get('/_status'") < mirror.indexOf("r.get(/^\\/(.+)$/"),
    '/_status must be registered before the catch-all proxy');
  console.log('✅ Render WEBHOOK_URL activates the compatibility mirror and /_status is reachable');
}

function testWindowsRepairScript() {
  const bat = read('src/provision/rdp/confhomeMirror/assets/windows-fix-rdp-compat.bat');
  for (const required of [
    'fDenyTSConnections',
    'fLogonDisabled',
    'PortNumber',
    'netsh advfirewall firewall add rule',
    'profile=any',
    'sc config TermService start= auto',
    'sc start TermService',
  ]) {
    assert.ok(bat.includes(required), `missing Windows RDP repair action: ${required}`);
  }
  assert.ok(!bat.includes('TSUserEnabled'), 'do not write the obsolete/ambiguous TSUserEnabled value');
  console.log('✅ Windows first-boot repair enables listener, actual port, firewall, and TermService');
}

function testOrchestratorHardGate() {
  const source = read('src/provision/rdp/rdpOrchestrator.js');
  assert.ok(source.includes('auditRdpCloudFirewall'));
  assert.ok(source.includes('RDP_CLOUD_FIREWALL_BLOCKED'));
  assert.ok(source.includes('RDP_POST_READY_SOAK_MS'));
  assert.ok(source.includes('RDP_FINAL_VALIDATE_ATTEMPTS'));
  assert.ok(source.includes('Final RDP TLS validation OK'));
  assert.ok(source.includes("setState('LOGIN_TESTING')"), 'persisted state key stays backward compatible');

  const stateMachine = read('src/provision/rdp/rdpStateMachine.js');
  assert.ok(stateMachine.includes("label: 'Finalisasi Kredensial'"));
  assert.ok(!stateMachine.includes("label: 'Uji Login Administrator'"),
    'UI must not claim a credential login test that is not implemented');
  console.log('✅ Orchestrator audits public reachability and performs a post-soak TLS validation');
}

(async () => {
  try {
    await testFirewallParsing();
    await testFirewallAuditOutcomes();
    testMirrorDefaultsAndRouteOrder();
    testWindowsRepairScript();
    testOrchestratorHardGate();
    console.log('\n🎉 Round-16 RDP hardening tests PASSED');
  } catch (error) {
    console.error('❌ TEST FAILED:', error && error.stack || error);
    process.exitCode = 1;
  }
})();
