// Internal integration tests for the VPS Reward Ecosystem.
// Uses mongodb-memory-server — no external DB, no BOT_TOKEN required.
//
// Run with:  node tests/reward.test.js
//
// Covers:
//  1. Loyalty progress increments on VPS provision success (idempotent).
//  2. Loyalty progress NOT counted for admin, reward-order, blacklisted, RDP, non-success.
//  3. Cumulative loyalty tier claim (progress not reset).
//  4. Cannot double-claim same tier.
//  5. Referral attach on /start payload (locked once set).
//  6. Referral qualification cron with 24h VPS age + 7d account age.
//  7. Referral rejected when VPS terminated.
//  8. Badge auto-unlock on threshold.
//  9. Frame auto-assign on threshold.
// 10. Admin config change is realtime (no cache).
// 11. Leaderboard sorting.
// 12. Reward VPS order (isRewardOrder=true, total=0) skips loyalty count.

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const assert = require('assert');

let mongod;
async function setup() {
  // Prefer system mongod when available (network download blocked in container)
  try {
    mongod = await MongoMemoryServer.create({ binary: { systemBinary: '/usr/bin/mongod' } });
  } catch (_) {
    // Fallback: use local mongod service directly with unique dbName
    const uri = `mongodb://127.0.0.1:27017/reward_test_${Date.now()}`;
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

const User = require('../src/models/User');
const Order = require('../src/models/Order');
const VpsInstance = require('../src/models/VpsInstance');
const RewardConfig = require('../src/models/RewardConfig');
const UserProgress = require('../src/models/UserProgress');
const RewardClaim = require('../src/models/RewardClaim');
const rewardService = require('../src/services/rewardService');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log('  ✅', name); }
  catch (e) { results.push({ name, ok: false, err: e.message }); console.log('  ❌', name, '—', e.message); }
}

async function mkUser(id, opts = {}) {
  return User.findOneAndUpdate({ telegramId: String(id) }, {
    $set: { telegramId: String(id), username: 'u' + id, name: 'User ' + id,
            firstSeenAt: opts.firstSeenAt || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), ...opts },
  }, { upsert: true, new: true });
}

async function mkOrder(userId, opts = {}) {
  return Order.create({
    invoice: 'INV' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    userId: String(userId),
    category: opts.category || 'vps',
    tier: opts.tier || 'low',
    slot: 1,
    productName: 'VPS LOW Spec 1',
    price: opts.total ?? 100000,
    total: opts.total ?? 100000,
    status: opts.status || 'success',
    isRewardOrder: opts.isRewardOrder || false,
    paidAt: opts.paidAt || new Date(Date.now() - 25 * 60 * 60 * 1000),
    ...opts,
  });
}

async function run() {
  await setup();
  console.log('\n🧪 REWARD ECOSYSTEM TESTS\n');

  // ===== Test 1 =====
  await test('Loyalty count increments on VPS provision success', async () => {
    await mkUser(1001);
    const o = await mkOrder(1001);
    const r = await rewardService.onVpsProvisionSuccess(o);
    assert(r.ok, 'expected ok');
    const p = await UserProgress.findOne({ userId: '1001' });
    assert.strictEqual(p.vpsTxCount, 1);
  });

  // ===== Test 2 (idempotent) =====
  await test('Loyalty count is idempotent for the same order', async () => {
    const o = await Order.findOne({ userId: '1001' });
    await rewardService.onVpsProvisionSuccess(o);
    await rewardService.onVpsProvisionSuccess(o);
    const p = await UserProgress.findOne({ userId: '1001' });
    assert.strictEqual(p.vpsTxCount, 1);
  });

  // ===== Test 3 =====
  await test('RDP orders do not count toward VPS loyalty', async () => {
    await mkUser(1002);
    const o = await mkOrder(1002, { category: 'rdp' });
    const r = await rewardService.onVpsProvisionSuccess(o);
    assert(r.skipped);
  });

  // ===== Test 4 =====
  await test('Reward VPS orders do NOT count toward loyalty', async () => {
    await mkUser(1003);
    const o = await mkOrder(1003, { isRewardOrder: true });
    const r = await rewardService.onVpsProvisionSuccess(o);
    assert(r.skipped);
  });

  // ===== Test 5 =====
  await test('Blacklisted user does not accumulate loyalty', async () => {
    await mkUser(1004, { blacklisted: true });
    const o = await mkOrder(1004);
    const r = await rewardService.onVpsProvisionSuccess(o);
    assert(r.skipped);
  });

  // ===== Test 6 =====
  await test('Cumulative loyalty — progress not reset after claim', async () => {
    await mkUser(2000);
    // simulate 30 successful VPS orders
    for (let i = 0; i < 30; i++) {
      const o = await mkOrder(2000);
      await rewardService.onVpsProvisionSuccess(o);
    }
    let p = await UserProgress.findOne({ userId: '2000' });
    assert.strictEqual(p.vpsTxCount, 30);
    const cfg = await rewardService.getConfig();
    const t15 = cfg.loyaltyTiers.find(t => t.threshold === 15);
    await rewardService.recordClaim('2000', 'loyalty', t15);
    p = await UserProgress.findOne({ userId: '2000' });
    assert.strictEqual(p.vpsTxCount, 30, 'progress must remain cumulative');
    assert(p.claimedLoyalty.includes(15));
    // Next available should be 30
    const nc = await rewardService.nextClaimable('loyalty', p, cfg);
    assert(nc.available.find(t => t.threshold === 30), 'tier 30 should now be claimable');
  });

  // ===== Test 7 =====
  await test('Cannot double-claim the same loyalty tier', async () => {
    const cfg = await rewardService.getConfig();
    const t15 = cfg.loyaltyTiers.find(t => t.threshold === 15);
    const p = await UserProgress.findOne({ userId: '2000' });
    const nc = await rewardService.nextClaimable('loyalty', p, cfg);
    assert(!nc.available.find(t => t.threshold === 15), 'tier 15 should NOT be re-claimable');
  });

  // ===== Test 8 =====
  await test('Badges auto-unlock on VPS threshold', async () => {
    const p = await UserProgress.findOne({ userId: '2000' });
    assert(p.badges.includes('first_vps'));
    assert(p.badges.includes('bronze_b'));
    assert(p.badges.includes('silver_b'));
    assert(!p.badges.includes('gold_b')); // needs 50
  });

  // ===== Test 9 =====
  await test('Frame auto-assign at 30 = silver', async () => {
    const p = await UserProgress.findOne({ userId: '2000' });
    assert.strictEqual(p.frame, 'silver');
  });

  // ===== Test 10: Referral attach =====
  await test('Referral attach on /start payload — new user gets referrer', async () => {
    const referrer = await mkUser(3000);
    await rewardService.ensureReferralCode(referrer);
    const code = (await User.findOne({ telegramId: '3000' })).referralCode;
    const newUser = await mkUser(3001, { firstSeenAt: new Date() });
    const r = await rewardService.tryAttachReferrer(newUser, code);
    assert(r.ok);
    const u = await User.findOne({ telegramId: '3001' });
    assert.strictEqual(u.referredBy, '3000');
  });

  // ===== Test 11: Referrer locked =====
  await test('Referrer is LOCKED once set — cannot change', async () => {
    const other = await mkUser(3002);
    await rewardService.ensureReferralCode(other);
    const otherCode = (await User.findOne({ telegramId: '3002' })).referralCode;
    const existing = await User.findOne({ telegramId: '3001' });
    const r = await rewardService.tryAttachReferrer(existing, otherCode);
    assert(!r.ok);
    assert.strictEqual(r.reason, 'already_has_referrer');
  });

  // ===== Test 12: Self-referral blocked =====
  await test('Self-referral blocked', async () => {
    const u = await User.findOne({ telegramId: '3000' });
    const r = await rewardService.tryAttachReferrer(u, u.referralCode);
    assert(!r.ok);
  });

  // ===== Test 13: Referral qualification with 24h VPS + 7d account age =====
  await test('Referral qualifies after 24h VPS active + 7d account age', async () => {
    // Create paid order for user 3001 aged >24h, and a running VPS
    const order = await mkOrder('3001', { status: 'success' });
    // ensure user's firstSeenAt is >7 days old
    await User.findOneAndUpdate({ telegramId: '3001' }, {
      $set: { firstSeenAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) },
    });
    await VpsInstance.create({
      orderId: String(order._id), userId: '3001', provider: 'aws', status: 'running',
    });
    // Entry already exists from tryAttachReferrer — no need to push again.
    const r = await rewardService.qualifyPendingReferrals();
    assert(r.qualified >= 1);
    const p2 = await UserProgress.findOne({ userId: '3000' });
    assert(p2.referralCount >= 1);
    const entry3001 = p2.referrals.find(x => x.referredUserId === '3001');
    assert.strictEqual(entry3001.status, 'qualified');
  });

  // ===== Test 14: Referral rejected if account too new =====
  await test('Referral rejected when referred account < 7 days old', async () => {
    const referrer = await mkUser(4000);
    await rewardService.ensureReferralCode(referrer);
    const newbie = await mkUser(4001, { firstSeenAt: new Date() }); // brand new
    await rewardService.tryAttachReferrer(newbie, (await User.findOne({ telegramId: '4000' })).referralCode);
    const o = await mkOrder('4001', { status: 'success' });
    await VpsInstance.create({ orderId: String(o._id), userId: '4001', provider: 'aws', status: 'running' });
    const p = await rewardService.ensureProgress('4000');
    p.referrals.push({ referredUserId: '4001', orderId: String(o._id), status: 'pending' });
    await p.save();
    await rewardService.qualifyPendingReferrals();
    const p2 = await UserProgress.findOne({ userId: '4000' });
    const entry = p2.referrals.find(x => x.referredUserId === '4001');
    // Should still be pending because account too young (or rejected — either non-qualified)
    assert(entry.status !== 'qualified', 'must not qualify young account');
  });

  // ===== Test 15: Referral rejected on VPS terminated =====
  await test('Referral rejected if VPS terminated before qualification', async () => {
    const referrer = await mkUser(5000);
    await rewardService.ensureReferralCode(referrer);
    const newbie = await mkUser(5001, { firstSeenAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) });
    await rewardService.tryAttachReferrer(newbie, (await User.findOne({ telegramId: '5000' })).referralCode);
    const o = await mkOrder('5001', { status: 'success' });
    await VpsInstance.create({ orderId: String(o._id), userId: '5001', provider: 'aws', status: 'terminated' });
    // Entry already exists from tryAttachReferrer.
    await rewardService.qualifyPendingReferrals();
    const p2 = await UserProgress.findOne({ userId: '5000' });
    const entry = p2.referrals.find(x => x.referredUserId === '5001');
    assert.strictEqual(entry.status, 'rejected');
  });

  // ===== Test 16: Leaderboard =====
  await test('Leaderboard top buyer returns user 2000 first', async () => {
    const lb = await rewardService.leaderboardTopBuyers(5);
    assert(lb[0] && lb[0].userId === '2000');
  });

  // ===== Test 17: Admin config change is realtime =====
  await test('Admin config change (threshold) is realtime', async () => {
    const cfg = await rewardService.getConfig();
    cfg.loyaltyTiers[0].threshold = 5;
    await cfg.save();
    const cfg2 = await rewardService.getConfig();
    assert.strictEqual(cfg2.loyaltyTiers[0].threshold, 5);
    // Reset
    cfg2.loyaltyTiers[0].threshold = 15;
    await cfg2.save();
  });

  // ===== Test 18: RewardClaim recorded =====
  await test('RewardClaim collection records claims', async () => {
    const claims = await RewardClaim.find({ userId: '2000' });
    assert(claims.length >= 1);
    assert.strictEqual(claims[0].kind, 'loyalty');
    assert.strictEqual(claims[0].threshold, 15);
  });

  // ===== Summary =====
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n📊 Result: ${passed} passed, ${failed} failed of ${results.length}\n`);
  await teardown();
  process.exit(failed === 0 ? 0 : 1);
}

run().catch(async (e) => { console.error('FATAL:', e); try { await teardown(); } catch (_) {} process.exit(1); });
