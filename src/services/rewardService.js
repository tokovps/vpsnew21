// Core reward/loyalty/referral/badge logic.
// Semua fungsi idempotent & anti-abuse aware.
const RewardConfig = require('../models/RewardConfig');
const UserProgress = require('../models/UserProgress');
const RewardClaim = require('../models/RewardClaim');
const User = require('../models/User');
const Order = require('../models/Order');
const VpsInstance = require('../models/VpsInstance');
const Admin = require('../models/Admin');

async function getConfig() {
  let c = await RewardConfig.findOne({ key: 'global' });
  if (!c) c = await RewardConfig.create({ key: 'global' });
  return c;
}

async function ensureProgress(userId) {
  const uid = String(userId);
  let p = await UserProgress.findOne({ userId: uid });
  if (!p) p = await UserProgress.create({ userId: uid });
  return p;
}

async function isAdminUser(userId) {
  const { config } = require('../config');
  const uid = String(userId);
  if (uid === String(config.adminId)) return true;
  const a = await Admin.findOne({ telegramId: uid });
  return !!a;
}

// Check whether an order counts toward loyalty progress.
async function orderQualifies(order) {
  if (!order) return { ok: false, reason: 'no_order' };
  if (order.category !== 'vps') return { ok: false, reason: 'not_vps' };
  if (order.status !== 'success') return { ok: false, reason: 'not_success' };
  if (order.isRewardOrder) return { ok: false, reason: 'is_reward' };
  if (await isAdminUser(order.userId)) return { ok: false, reason: 'admin' };
  const u = await User.findOne({ telegramId: String(order.userId) });
  if (u && u.blacklisted) return { ok: false, reason: 'blacklisted' };
  return { ok: true };
}

// Called by orchestrator immediately after VPS provision success.
async function onVpsProvisionSuccess(order) {
  const q = await orderQualifies(order);
  if (!q.ok) return { skipped: true, reason: q.reason };
  const cfg = await getConfig();
  const p = await ensureProgress(order.userId);
  // Idempotent: only increment once per order.
  if (p.referrals.find(r => r.orderId === String(order._id))) {
    // (already tracked as referral order — still count loyalty once)
  }
  // Use $inc with unique guard via a "counted orders" side check would need a
  // separate collection. For minimal-invasive, we use an atomic increment
  // guarded by a sentinel: we tag Order with `loyaltyCounted=true` flag.
  const fresh = await Order.findById(order._id);
  if (fresh.loyaltyCounted) return { skipped: true, reason: 'already_counted' };
  await Order.findByIdAndUpdate(order._id, { $set: { loyaltyCounted: true } });
  p.vpsTxCount = (p.vpsTxCount || 0) + 1;
  await recomputeBadgesAndFrame(p, cfg);
  await p.save();
  return { ok: true, vpsTxCount: p.vpsTxCount };
}

// Recompute badges/frame based on current counts.
async function recomputeBadgesAndFrame(progress, cfg) {
  if (!cfg) cfg = await getConfig();
  const owned = new Set(progress.badges || []);
  for (const b of cfg.badges) {
    if (!b.active) continue;
    if (b.kind === 'vps' && progress.vpsTxCount >= b.threshold) owned.add(b.code);
    if (b.kind === 'referral' && progress.referralCount >= b.threshold) owned.add(b.code);
  }
  progress.badges = Array.from(owned);
  // Frame: highest threshold matched
  let bestFrame = '';
  for (const f of (cfg.frames || []).slice().sort((a, b) => a.threshold - b.threshold)) {
    if (progress.vpsTxCount >= f.threshold) bestFrame = f.code;
  }
  progress.frame = bestFrame;
}

// === REFERRAL ===

function generateReferralCode(userId) {
  // Deterministic 6-char code from userId (uppercase base36-ish)
  const n = BigInt(String(userId).replace(/\D/g, '') || '1');
  const s = n.toString(36).toUpperCase();
  return ('R' + s).slice(0, 8).padEnd(6, '0');
}

async function ensureReferralCode(user) {
  if (user.referralCode) return user.referralCode;
  const code = generateReferralCode(user.telegramId);
  await User.findOneAndUpdate({ telegramId: user.telegramId }, { $set: { referralCode: code } });
  return code;
}

// Handle /start ABC123 referral payload for a brand-new user.
// Rules: user must be brand-new (no prior /start), referrer must exist, not self,
// user has no referrer yet. Locked once set.
async function tryAttachReferrer(newUser, payload) {
  if (!payload || !String(payload).trim()) return { ok: false, reason: 'no_payload' };
  if (newUser.referredBy) return { ok: false, reason: 'already_has_referrer' };
  const code = String(payload).trim().toUpperCase();
  const referrer = await User.findOne({ referralCode: code });
  if (!referrer) return { ok: false, reason: 'code_not_found' };
  if (String(referrer.telegramId) === String(newUser.telegramId)) return { ok: false, reason: 'self_referral' };
  // Guard: newUser must have no prior orders (never used bot for real).
  const anyOrder = await Order.findOne({ userId: String(newUser.telegramId) });
  if (anyOrder) return { ok: false, reason: 'already_used_bot' };
  await User.findOneAndUpdate({ telegramId: newUser.telegramId }, {
    $set: { referredBy: String(referrer.telegramId), referredAt: new Date() },
  });
  // Track pending entry on referrer's UserProgress
  const rp = await ensureProgress(referrer.telegramId);
  if (!rp.referrals.find(r => r.referredUserId === String(newUser.telegramId))) {
    rp.referrals.push({ referredUserId: String(newUser.telegramId), status: 'pending', createdAt: new Date() });
    await rp.save();
  }
  return { ok: true, referrerId: String(referrer.telegramId) };
}

// Called on VPS provision success — if referred, attach orderId to pending log.
async function onVpsSuccessLinkReferral(order) {
  const u = await User.findOne({ telegramId: String(order.userId) });
  if (!u || !u.referredBy) return { skipped: true };
  const rp = await ensureProgress(u.referredBy);
  const entry = rp.referrals.find(r => r.referredUserId === String(order.userId) && r.status === 'pending');
  if (!entry) return { skipped: true };
  if (!entry.orderId) {
    entry.orderId = String(order._id);
    await rp.save();
  }
  return { ok: true };
}

// Cron: qualify referrals where the referred user's VPS has been active >= minVpsActiveHours.
async function qualifyPendingReferrals() {
  const cfg = await getConfig();
  if (!cfg.referralEnabled) return { checked: 0, qualified: 0 };
  const minMs = (cfg.minVpsActiveHours || 24) * 60 * 60 * 1000;
  const minAccountMs = (cfg.minAccountAgeDays || 7) * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let checked = 0, qualified = 0, rejected = 0;
  const allProgress = await UserProgress.find({ 'referrals.status': 'pending' });
  for (const p of allProgress) {
    let changed = false;
    for (const r of p.referrals) {
      if (r.status !== 'pending') continue;
      checked++;
      // Self-heal: if orderId missing, look up referred user's latest success VPS order.
      if (!r.orderId) {
        const latest = await Order.findOne({
          userId: String(r.referredUserId), category: 'vps', status: 'success', isRewardOrder: false,
        }).sort({ paidAt: -1, createdAt: -1 });
        if (!latest) continue;
        r.orderId = String(latest._id);
        changed = true;
      }
      const order = await Order.findById(r.orderId);
      if (!order) continue;
      // Order must be success + not cancelled/rejected + not reward
      if (order.isRewardOrder || ['cancelled', 'rejected'].includes(order.status)) {
        r.status = 'rejected'; r.reason = 'order_invalid'; changed = true; rejected++; continue;
      }
      if (order.status !== 'success') continue;
      // Check paidAt / createdAt aging >= minMs
      const paidAt = order.paidAt || order.updatedAt || order.createdAt;
      if (!paidAt || now - new Date(paidAt).getTime() < minMs) continue;
      // Check VPS still running
      const vps = await VpsInstance.findOne({ orderId: String(order._id) });
      if (!vps) continue;
      if (['terminated', 'destroyed', 'deleted', 'error', 'cancelled'].includes(vps.status)) {
        r.status = 'rejected'; r.reason = 'vps_inactive'; changed = true; rejected++; continue;
      }
      // Account age check on referred user
      const ref = await User.findOne({ telegramId: r.referredUserId });
      if (!ref) continue;
      const firstSeen = ref.firstSeenAt || ref.createdAt;
      if (!firstSeen || now - new Date(firstSeen).getTime() < minAccountMs) continue;
      // Anti-abuse: check referred is not admin, not blacklisted
      if (ref.blacklisted || await isAdminUser(r.referredUserId)) {
        r.status = 'rejected'; r.reason = 'abuse'; changed = true; rejected++; continue;
      }
      // Qualify
      r.status = 'qualified';
      r.qualifiedAt = new Date();
      changed = true;
      qualified++;
      p.referralCount = (p.referralCount || 0) + 1;
      try {
        const owner = await User.findOne({ telegramId: p.userId });
        require('./adminNotifyService').notifyActivity(
          owner || { telegramId: p.userId },
          'Referral Berhasil (Qualified)',
          { '👥 Referred:': `\`${r.referredUserId}\``, '📊 Total Ref:': String(p.referralCount) },
        );
      } catch (_) {}
    }
    if (changed) {
      await recomputeBadgesAndFrame(p, cfg);
      await p.save();
    }
  }
  return { checked, qualified, rejected };
}

// === CLAIM ===

// Return the next available loyalty/referral tier for user (uncommunicated => can claim now).
async function nextClaimable(kind, progress, cfg) {
  const tiers = (kind === 'loyalty' ? cfg.loyaltyTiers : cfg.referralTiers) || [];
  const claimed = new Set(kind === 'loyalty' ? progress.claimedLoyalty : progress.claimedReferral);
  const count = kind === 'loyalty' ? progress.vpsTxCount : progress.referralCount;
  const enabled = kind === 'loyalty' ? cfg.loyaltyEnabled : cfg.referralEnabled;
  if (!enabled) return { available: [], nextTier: null };
  const sortedTiers = tiers.slice().sort((a, b) => a.threshold - b.threshold);
  const available = sortedTiers.filter(t => t.active && count >= t.threshold && !claimed.has(t.threshold));
  const nextTier = sortedTiers.find(t => t.active && count < t.threshold) || null;
  return { available, nextTier, count, sortedTiers };
}

// Mark a claim as consumed on progress + create RewardClaim record.
async function recordClaim(userId, kind, tier) {
  const p = await ensureProgress(userId);
  if (kind === 'loyalty') {
    if (!p.claimedLoyalty.includes(tier.threshold)) p.claimedLoyalty.push(tier.threshold);
  } else {
    if (!p.claimedReferral.includes(tier.threshold)) p.claimedReferral.push(tier.threshold);
  }
  p.totalRewardsClaimed = (p.totalRewardsClaimed || 0) + 1;
  await p.save();
  return RewardClaim.create({
    userId: String(userId),
    kind,
    threshold: tier.threshold,
    rewardTier: tier.rewardTier,
    status: tier.rewardTier === 'special' ? 'pending_admin' : 'created',
  });
}

// === Dashboards ===
async function leaderboardTopBuyers(limit = 10) {
  return UserProgress.find({ vpsTxCount: { $gt: 0 } }).sort({ vpsTxCount: -1 }).limit(limit).lean();
}
async function leaderboardTopReferrers(limit = 10) {
  return UserProgress.find({ referralCount: { $gt: 0 } }).sort({ referralCount: -1 }).limit(limit).lean();
}
async function leaderboardTopBadges(limit = 10) {
  return UserProgress.aggregate([
    { $project: { userId: 1, badgesCount: { $size: { $ifNull: ['$badges', []] } }, vpsTxCount: 1, referralCount: 1 } },
    { $match: { badgesCount: { $gt: 0 } } },
    { $sort: { badgesCount: -1 } },
    { $limit: limit },
  ]);
}
async function leaderboardTopRewards(limit = 10) {
  return UserProgress.find({ totalRewardsClaimed: { $gt: 0 } }).sort({ totalRewardsClaimed: -1 }).limit(limit).lean();
}

async function userRank(userId) {
  const p = await UserProgress.findOne({ userId: String(userId) });
  if (!p) return { rank: 0, count: 0 };
  const higher = await UserProgress.countDocuments({ vpsTxCount: { $gt: p.vpsTxCount || 0 } });
  return { rank: higher + 1, count: p.vpsTxCount || 0 };
}

async function adminDashboard() {
  const cfg = await getConfig();
  const totalUsers = await UserProgress.countDocuments();
  const vipUsers = await UserProgress.countDocuments({ frame: { $in: ['gold', 'platinum', 'diamond'] } });
  const diamondUsers = await UserProgress.countDocuments({ frame: 'diamond' });
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const startOfMonth = new Date(); startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);
  const [rewardsToday, rewardsMonth] = await Promise.all([
    RewardClaim.countDocuments({ createdAt: { $gte: startOfDay } }),
    RewardClaim.countDocuments({ createdAt: { $gte: startOfMonth } }),
  ]);
  const badgesAgg = await UserProgress.aggregate([
    { $project: { c: { $size: { $ifNull: ['$badges', []] } } } },
    { $group: { _id: null, total: { $sum: '$c' } } },
  ]);
  const totalBadges = (badgesAgg[0] && badgesAgg[0].total) || 0;
  // User siap claim: has any available loyalty/referral tier
  const allP = await UserProgress.find({}).lean();
  let readyCount = 0;
  for (const p of allP) {
    for (const t of cfg.loyaltyTiers) {
      if (t.active && p.vpsTxCount >= t.threshold && !(p.claimedLoyalty || []).includes(t.threshold)) { readyCount++; break; }
    }
    if (cfg.referralEnabled) {
      for (const t of cfg.referralTiers) {
        if (t.active && p.referralCount >= t.threshold && !(p.claimedReferral || []).includes(t.threshold)) { readyCount++; break; }
      }
    }
  }
  return { totalUsers, vipUsers, diamondUsers, rewardsToday, rewardsMonth, totalBadges, readyCount };
}

module.exports = {
  getConfig, ensureProgress, isAdminUser, orderQualifies,
  onVpsProvisionSuccess, onVpsSuccessLinkReferral,
  ensureReferralCode, tryAttachReferrer, qualifyPendingReferrals,
  nextClaimable, recordClaim, recomputeBadgesAndFrame,
  leaderboardTopBuyers, leaderboardTopReferrers, leaderboardTopBadges, leaderboardTopRewards,
  userRank, adminDashboard, generateReferralCode,
};
