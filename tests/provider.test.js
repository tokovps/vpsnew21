// Provider Reusability Tests — validates the fix for the "Provider single-use" bug.
//
// Bug (reported): After a successful VPS provision, the Provider status was
// flipped to 'USED' permanently, causing:
//   • Stock immediately dropped to 0.
//   • Provider disappeared from the READY pool.
//   • The bot asked for a NEW token on the next order even though the old
//     token still had quotaAvailable > 0.
//
// Expected behaviour (spec):
//   • Provider must remain reusable while enabled && quotaAvailable > 0.
//   • After each successful provision:
//        - usageCount += 1
//        - quotaAvailable -= 1
//        - lastUsedAt updated
//        - status stays 'READY'  (or becomes 'QUOTA_FULL' when quota == 0)
//        - Provider NEVER becomes 'USED'.
//   • Stock = SUM(quotaAvailable) across enabled+READY providers (not count).
//
// Uses mongodb-memory-server — no external DB, no BOT_TOKEN required.
// Run:  node tests/provider.test.js

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const assert = require('assert');

let mongod;
async function setup() {
  try {
    mongod = await MongoMemoryServer.create({ binary: { systemBinary: '/usr/bin/mongod' } });
  } catch (_) {
    const uri = `mongodb://127.0.0.1:27017/provider_test_${Date.now()}`;
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

const ProviderApi = require('../src/models/ProviderApi');
const providerService = require('../src/services/providerService');
// catalogService imports settingService which imports mongoose model —
// safe to require after mongoose.connect().
const catalogService = require('../src/services/catalogService');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log('  ✅', name); }
  catch (e) { results.push({ name, ok: false, err: e.message }); console.log('  ❌', name, '—', e.message); }
}

async function mkProvider(opts = {}) {
  return ProviderApi.create({
    provider: opts.provider || 'digitalocean',
    label: opts.label || 'test',
    enabled: opts.enabled !== undefined ? opts.enabled : true,
    status: opts.status || 'READY',
    doToken: opts.doToken || 'dop_v1_dummy_' + Math.random().toString(36).slice(2),
    quotaAvailable: opts.quotaAvailable !== undefined ? opts.quotaAvailable : 10,
    usageCount: opts.usageCount || 0,
    score: opts.score || 60,
  });
}

async function run() {
  await setup();
  console.log('\n🧪 PROVIDER REUSABILITY TESTS\n');

  // ================================================================
  // 1. Provider dengan Quota > 0 TETAP READY setelah 1x provisioning
  // ================================================================
  await test('markUsed(): Provider stays READY when quotaAvailable > 0', async () => {
    const p = await mkProvider({ quotaAvailable: 10, usageCount: 0 });
    const updated = await providerService.markUsed(p._id);
    assert.strictEqual(updated.status, 'READY', 'status must remain READY');
    assert.strictEqual(updated.quotaAvailable, 9, 'quota must decrement by 1');
    assert.strictEqual(updated.usageCount, 1, 'usageCount must increment');
    assert(updated.lastUsedAt, 'lastUsedAt must be set');
    assert.strictEqual(updated.lockedAt, null, 'lockedAt must be released');
    // Never USED
    assert.notStrictEqual(updated.status, 'USED', 'MUST NEVER become USED');
  });

  // ================================================================
  // 2. usageCount naik & quota turun setiap markUsed
  // ================================================================
  await test('markUsed(): 3 sequential provisions on the same provider', async () => {
    const p = await mkProvider({ quotaAvailable: 10, usageCount: 0 });
    for (let i = 1; i <= 3; i++) {
      const u = await providerService.markUsed(p._id);
      assert.strictEqual(u.status, 'READY', `iter ${i}: status`);
      assert.strictEqual(u.usageCount, i, `iter ${i}: usageCount`);
      assert.strictEqual(u.quotaAvailable, 10 - i, `iter ${i}: quota`);
    }
  });

  // ================================================================
  // 3. Status berubah ke QUOTA_FULL saat quotaAvailable habis
  // ================================================================
  await test('markUsed(): status → QUOTA_FULL only when quota exhausted', async () => {
    const p = await mkProvider({ quotaAvailable: 2, usageCount: 0 });
    let u = await providerService.markUsed(p._id);
    assert.strictEqual(u.status, 'READY', 'after 1st use (quota 1) → READY');
    assert.strictEqual(u.quotaAvailable, 1);

    u = await providerService.markUsed(p._id);
    assert.strictEqual(u.status, 'QUOTA_FULL', 'after 2nd use (quota 0) → QUOTA_FULL');
    assert.strictEqual(u.quotaAvailable, 0);
    assert.notStrictEqual(u.status, 'USED');
  });

  // ================================================================
  // 4. findReadyApis() masih mengembalikan provider yg sudah dipakai
  //    selama quota > 0
  // ================================================================
  await test('findReadyApis(): provider remains in pool after use', async () => {
    // Bersihkan agar deterministik
    await ProviderApi.deleteMany({});
    const p = await mkProvider({ provider: 'linode', quotaAvailable: 5, linodeToken: 'ln_x' });
    await providerService.markUsed(p._id); // simulate one successful provision

    const pool = await providerService.findReadyApis();
    const inPool = pool.find(x => String(x._id) === String(p._id));
    assert(inPool, 'provider must still be in READY pool');
    assert.strictEqual(inPool.quotaAvailable, 4);
    assert.strictEqual(inPool.status, 'READY');
  });

  // ================================================================
  // 5. Stock berbasis SUM(quotaAvailable), bukan COUNT provider
  // ================================================================
  await test('getStock(): stock = SUM(quotaAvailable) across READY providers', async () => {
    await ProviderApi.deleteMany({});
    await mkProvider({ provider: 'aws', quotaAvailable: 3, awsAccessKey: 'A', awsSecretKey: 'S' });
    await mkProvider({ provider: 'digitalocean', quotaAvailable: 7 });
    // Provider bukan READY → tidak dihitung
    await mkProvider({ provider: 'linode', linodeToken: 'ln', quotaAvailable: 99, status: 'ERROR' });
    // Provider disabled → tidak dihitung
    await mkProvider({ provider: 'azure', azClientId: 'z', quotaAvailable: 50, enabled: false });

    const stock = await catalogService.getStock();
    assert.strictEqual(stock.ready, 10, 'expected 3+7 = 10 (SUM quota)');
  });

  // ================================================================
  // 6. Stock tidak jadi 0 setelah 1 order (regression untuk bug utama)
  // ================================================================
  await test('Stock stays > 0 after first successful provision', async () => {
    await ProviderApi.deleteMany({});
    const p = await mkProvider({ provider: 'digitalocean', quotaAvailable: 10 });
    // Sebelum
    let stock = await catalogService.getStock();
    assert.strictEqual(stock.ready, 10);
    // Simulasi 1x provision
    await providerService.markUsed(p._id);
    stock = await catalogService.getStock();
    assert.strictEqual(stock.ready, 9, 'stock must be 9 after 1 provision (not 0!)');
    assert(stock.ready > 0);
  });

  // ================================================================
  // 7. Multi-order pada Provider yang sama (skenario bug user)
  //    Order 1 & 2 tidak boleh minta token baru.
  // ================================================================
  await test('Same provider selected & locked for consecutive orders', async () => {
    await ProviderApi.deleteMany({});
    const p = await mkProvider({ provider: 'digitalocean', quotaAvailable: 3 });

    // ORDER 1: lock → markUsed
    const l1 = await providerService.tryLockApi(p._id, 'order1');
    assert(l1, 'ORDER 1: lock must succeed');
    assert.strictEqual(l1.status, 'LOCKED');
    const a1 = await providerService.markUsed(p._id);
    assert.strictEqual(a1.status, 'READY', 'ORDER 1: back to READY');
    assert.strictEqual(a1.quotaAvailable, 2);

    // ORDER 2: same provider must be lockable again
    const l2 = await providerService.tryLockApi(p._id, 'order2');
    assert(l2, 'ORDER 2: lock must succeed on SAME provider (bug!)');
    assert.strictEqual(String(l2._id), String(p._id), 'must be same provider');
    const a2 = await providerService.markUsed(p._id);
    assert.strictEqual(a2.status, 'READY');
    assert.strictEqual(a2.quotaAvailable, 1);
    assert.strictEqual(a2.usageCount, 2);

    // ORDER 3: quota drops to 0 → QUOTA_FULL
    const l3 = await providerService.tryLockApi(p._id, 'order3');
    assert(l3, 'ORDER 3: lock still ok while quota > 0');
    const a3 = await providerService.markUsed(p._id);
    assert.strictEqual(a3.quotaAvailable, 0);
    assert.strictEqual(a3.status, 'QUOTA_FULL', 'ORDER 3: quota exhausted → QUOTA_FULL');

    // ORDER 4: no longer lockable (quota gone)
    const l4 = await providerService.tryLockApi(p._id, 'order4');
    assert.strictEqual(l4, null, 'ORDER 4: cannot lock — quota truly exhausted');
  });

  // ================================================================
  // 8. Regression: verify no code path writes status='USED' in markUsed
  // ================================================================
  await test('Provider MUST NEVER be marked as USED (regression)', async () => {
    await ProviderApi.deleteMany({});
    const p = await mkProvider({ provider: 'aws', awsAccessKey: 'A', awsSecretKey: 'S', quotaAvailable: 5 });
    for (let i = 0; i < 5; i++) {
      const u = await providerService.markUsed(p._id);
      assert.notStrictEqual(u.status, 'USED', `iter ${i + 1}: status must not be USED`);
    }
    const final = await ProviderApi.findById(p._id);
    assert.strictEqual(final.status, 'QUOTA_FULL');
    assert.strictEqual(final.quotaAvailable, 0);
    assert.strictEqual(final.usageCount, 5);
    // No records of USED anywhere in DB
    const usedCount = await ProviderApi.countDocuments({ status: 'USED' });
    assert.strictEqual(usedCount, 0, 'no provider anywhere should be USED');
  });

  // ================================================================
  // 9. Enabled=false → tidak ikut dihitung meski READY
  // ================================================================
  await test('Disabled provider excluded from ready pool & stock', async () => {
    await ProviderApi.deleteMany({});
    await mkProvider({ provider: 'digitalocean', quotaAvailable: 5, enabled: false });
    const pool = await providerService.findReadyApis();
    assert.strictEqual(pool.length, 0);
    const stock = await catalogService.getStock();
    assert.strictEqual(stock.ready, 0);
  });

  // ================================================================
  // 10. Recovery: setelah QUOTA_FULL, jika health-check refresh quota
  //     kembali > 0, provider harus kembali READY (backed by providerHealth).
  //     Ini bukan tanggung jawab markUsed, jadi kita verify hanya bahwa
  //     enum tetap kompatibel dan status QUOTA_FULL != USED (state final).
  // ================================================================
  await test('QUOTA_FULL is recoverable state (not terminal like USED)', async () => {
    await ProviderApi.deleteMany({});
    const p = await mkProvider({ provider: 'digitalocean', quotaAvailable: 1 });
    await providerService.markUsed(p._id);
    let cur = await ProviderApi.findById(p._id);
    assert.strictEqual(cur.status, 'QUOTA_FULL');
    // Simulate health-check restoring quota
    await ProviderApi.findByIdAndUpdate(p._id, { $set: { quotaAvailable: 4, status: 'READY' } });
    cur = await ProviderApi.findById(p._id);
    assert.strictEqual(cur.status, 'READY');
    assert.strictEqual(cur.quotaAvailable, 4);
    // And can be used again
    const u = await providerService.markUsed(p._id);
    assert.strictEqual(u.status, 'READY');
    assert.strictEqual(u.usageCount, 2, 'usageCount is cumulative across recoveries');
  });

  // ===== Summary =====
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n📊 Result: ${passed} passed, ${failed} failed of ${results.length}\n`);
  await teardown();
  process.exit(failed === 0 ? 0 : 1);
}

run().catch(async (e) => { console.error('FATAL:', e); try { await teardown(); } catch (_) {} process.exit(1); });
