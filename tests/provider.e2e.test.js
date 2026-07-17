// End-to-End Provider Reuse Simulation
// ---------------------------------------------------------------------------
// Menguji BUG kritis "Provider sekali pakai" secara end-to-end:
// Mock provider adapter → panggil orchestrator asli → verifikasi provider
// tetap dipakai di order ke-2, ke-3, dst sampai quota benar-benar habis.
//
// Skenario user (per problem statement):
//   1. Provider baru dengan quotaAvailable = 10
//   2. Order 1 → sukses
//   3. Order 2 → wajib pakai provider yang SAMA (bukan minta token baru!)
//   4. Order 3 → wajib pakai provider yang SAMA
//   5. Ulangi sampai quota habis → status berubah ke QUOTA_FULL
//   6. Provider TIDAK BOLEH menjadi USED
//
// Run: node tests/provider.e2e.test.js

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const assert = require('assert');

let mongod;
async function setup() {
  try {
    mongod = await MongoMemoryServer.create({ binary: { systemBinary: '/usr/bin/mongod' } });
  } catch (_) {
    const uri = `mongodb://127.0.0.1:27017/provider_e2e_${Date.now()}`;
    await mongoose.connect(uri);
    process.env.MONGODB_URI = uri;
    return;
  }
  const uri = mongod.getUri();
  process.env.MONGODB_URI = uri;
  process.env.BOT_TOKEN = 'test';
  process.env.ADMIN_ID = '999999';
  process.env.ADMIN_USERNAME = 'testadmin';
  await mongoose.connect(uri);
}
async function teardown() {
  try { await mongoose.disconnect(); } catch (_) {}
  if (mongod) { try { await mongod.stop(); } catch (_) {} }
}

// ---- Mock the provider adapter BEFORE loading orchestrator ----
const providersMod = require('../src/providers');
const CALLS = { create: 0, health: 0 };

// Patch adapter registry with a fake DO adapter
providersMod.ADAPTERS.digitalocean = {
  validate: async () => true,
  createInstance: async (api, spec /* , onProgress */) => {
    CALLS.create++;
    return {
      provider: 'digitalocean',
      instanceId: `mock-instance-${CALLS.create}`,
      region: 'sgp1',
      imageId: 'ubuntu-22-04-x64',
      osLabel: 'Ubuntu 22.04',
      size: 's-1vcpu-1gb',
      publicIp: `1.2.3.${CALLS.create}`,
      username: 'root',
      password: spec.password || 'pw',
      raw: {},
    };
  },
  cleanup: async () => true,
};
// Patch healthCheck used by orchestrator (module-level, not adapter method)
const origHealth = providersMod.healthCheck;
providersMod.healthCheck = async () => { CALLS.health++; return { ok: true }; };

// Patch adminNotifyService to no-op (avoid Telegram calls)
const admNotify = require('../src/services/adminNotifyService');
admNotify.notifyActivity = async () => {};
admNotify.notifyRaw = async () => {};

// Patch adminHandler.sendReceipt (loaded lazily inside orchestrator)
const adminHandler = require('../src/handlers/adminHandler');
adminHandler.sendReceipt = async () => {};

// Fake bot — swallow all telegram interactions
const fakeBot = {
  telegram: {
    editMessageCaption: async () => ({}),
    editMessageText:    async () => ({}),
    sendMessage:        async () => ({ chat: { id: 1 }, message_id: 1 }),
  },
};

const ProviderApi = require('../src/models/ProviderApi');
const Order = require('../src/models/Order');
const providerService = require('../src/services/providerService');
const orchestrator = require('../src/provision/orchestrator');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log('  ✅', name); }
  catch (e) { results.push({ name, ok: false, err: e.message }); console.log('  ❌', name, '—', e.message); throw e; }
}

async function mkOrder(i) {
  return Order.create({
    invoice: `INV-E2E-${i}-${Date.now()}`,
    userId: '77',
    category: 'vps', tier: 'low', slot: 1,
    productName: 'VPS LOW Spec 1',
    price: 100000, total: 100000,
    status: 'processing',
    authMethod: 'password',
    generatedPassword: 'testpass1',
    osFamily: 'Ubuntu',
    region: 'sgp1',
  });
}

async function run() {
  await setup();
  console.log('\n🧪 E2E PROVIDER REUSE SIMULATION\n');

  // Prepare a single DO provider with quota=3 (small so we exhaust quickly)
  const provider = await ProviderApi.create({
    provider: 'digitalocean',
    label: 'e2e-token',
    enabled: true,
    status: 'READY',
    doToken: 'dop_v1_e2e_test',
    quotaAvailable: 3,
    usageCount: 0,
    score: 90,
  });
  console.log(`  ℹ️  Provider seeded: id=${provider._id} quota=3\n`);

  const providerId = String(provider._id);

  // ORDER 1
  await test('ORDER 1: provisions successfully, provider stays READY', async () => {
    const order = await mkOrder(1);
    await orchestrator.provisionOrder(fakeBot, order);
    // wait for queue to drain
    await new Promise(r => setTimeout(r, 200));
    const p = await ProviderApi.findById(providerId);
    assert.strictEqual(p.status, 'READY', 'must be READY (quota still 2)');
    assert.strictEqual(p.quotaAvailable, 2);
    assert.strictEqual(p.usageCount, 1);
    assert.notStrictEqual(p.status, 'USED');
    const o = await Order.findById(order._id);
    assert.strictEqual(o.status, 'success');
    assert.strictEqual(o.apiUsedId, providerId, 'must use our provider');
  });

  // ORDER 2 — MUST use the SAME provider (bug regression)
  await test('ORDER 2: reuses SAME provider (no new token needed)', async () => {
    const order = await mkOrder(2);
    await orchestrator.provisionOrder(fakeBot, order);
    await new Promise(r => setTimeout(r, 200));
    const p = await ProviderApi.findById(providerId);
    assert.strictEqual(p.status, 'READY', 'must remain READY');
    assert.strictEqual(p.quotaAvailable, 1);
    assert.strictEqual(p.usageCount, 2);
    const o = await Order.findById(order._id);
    assert.strictEqual(o.status, 'success');
    assert.strictEqual(o.apiUsedId, providerId, 'MUST reuse the same provider');
  });

  // ORDER 3 — quota drops to 0, provider becomes QUOTA_FULL (not USED)
  await test('ORDER 3: quota exhausted → status QUOTA_FULL (never USED)', async () => {
    const order = await mkOrder(3);
    await orchestrator.provisionOrder(fakeBot, order);
    await new Promise(r => setTimeout(r, 200));
    const p = await ProviderApi.findById(providerId);
    assert.strictEqual(p.quotaAvailable, 0);
    assert.strictEqual(p.status, 'QUOTA_FULL', 'quota=0 → QUOTA_FULL');
    assert.notStrictEqual(p.status, 'USED', 'MUST NEVER be USED');
    assert.strictEqual(p.usageCount, 3);
    const o = await Order.findById(order._id);
    assert.strictEqual(o.status, 'success');
    assert.strictEqual(o.apiUsedId, providerId);
  });

  // ORDER 4 — no provider available (correct fallback behaviour)
  await test('ORDER 4: no READY provider → provisioning fails (expected)', async () => {
    const order = await mkOrder(4);
    await orchestrator.provisionOrder(fakeBot, order);
    await new Promise(r => setTimeout(r, 200));
    const o = await Order.findById(order._id);
    // Provisioning should fail because quota exhausted for the only provider
    assert.strictEqual(o.provisionStatus, 'failed');
  });

  // Verify total adapter invocations = 3 (only successful orders reached adapter)
  await test('Adapter createInstance called exactly 3 times (one per success)', async () => {
    assert.strictEqual(CALLS.create, 3, `expected 3, got ${CALLS.create}`);
  });

  // Regression: ensure nothing anywhere is in USED status
  await test('No provider anywhere has status = USED', async () => {
    const usedCount = await ProviderApi.countDocuments({ status: 'USED' });
    assert.strictEqual(usedCount, 0);
  });

  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n📊 Result: ${passed} passed, ${failed} failed of ${results.length}\n`);

  // restore
  providersMod.healthCheck = origHealth;
  await teardown();
  process.exit(failed === 0 ? 0 : 1);
}

run().catch(async (e) => { console.error('FATAL:', e); try { await teardown(); } catch (_) {} process.exit(1); });
