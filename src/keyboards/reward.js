const { Markup } = require('telegraf');

// ===== USER =====
const userExtraMenu = () => Markup.inlineKeyboard([
  [Markup.button.callback('🎁 VPS Reward', 'rw:menu'), Markup.button.callback('👥 Referral Saya', 'rf:menu')],
  [Markup.button.callback('🏅 Achievement', 'ach:menu'), Markup.button.callback('🏆 Leaderboard', 'lb:menu')],
  [Markup.button.callback('👤 Profil Saya', 'pf:show')],
]);

const rewardMenuKb = (canClaim, tierKey) => {
  const rows = [];
  if (canClaim) rows.push([Markup.button.callback('🎁 CLAIM REWARD', `rw:claim:${tierKey}`)]);
  rows.push([Markup.button.callback('⬅️ Kembali', 'menu:home')]);
  return Markup.inlineKeyboard(rows);
};

const referralMenuKb = () => Markup.inlineKeyboard([
  [Markup.button.callback('📊 Detail Referral', 'rf:detail')],
  [Markup.button.callback('⬅️ Kembali', 'menu:home')],
]);

const achievementKb = () => Markup.inlineKeyboard([
  [Markup.button.callback('🏅 Badge VPS', 'ach:vps'), Markup.button.callback('🤝 Badge Referral', 'ach:ref')],
  [Markup.button.callback('⬅️ Kembali', 'menu:home')],
]);

const leaderboardKb = (active) => Markup.inlineKeyboard([
  [Markup.button.callback((active === 'buyer' ? '✅ ' : '') + 'Top Buyer', 'lb:buyer'),
   Markup.button.callback((active === 'ref' ? '✅ ' : '') + 'Top Referral', 'lb:ref')],
  [Markup.button.callback((active === 'badge' ? '✅ ' : '') + 'Top Badge', 'lb:badge'),
   Markup.button.callback((active === 'reward' ? '✅ ' : '') + 'Top Reward', 'lb:reward')],
  [Markup.button.callback('⬅️ Kembali', 'menu:home')],
]);

const profileKb = () => Markup.inlineKeyboard([
  [Markup.button.callback('📤 Bagikan Profil', 'pf:share')],
  [Markup.button.callback('⬅️ Kembali', 'menu:home')],
]);

// ===== ADMIN =====
const adminRewardHome = () => Markup.inlineKeyboard([
  [Markup.button.callback('📊 Reward Dashboard', 'a:rw:dash')],
  [Markup.button.callback('🎁 Loyalty Config', 'a:rw:loyalty'),
   Markup.button.callback('👥 Referral Config', 'a:rw:referral')],
  [Markup.button.callback('🏅 Badge Manager', 'a:rw:badges'),
   Markup.button.callback('👑 Frame Manager', 'a:rw:frames')],
  [Markup.button.callback('👥 User Progress', 'a:rw:users:1'),
   Markup.button.callback('📜 Claim History', 'a:rw:history:1')],
  [Markup.button.callback('🏆 Leaderboard', 'a:rw:lb'),
   Markup.button.callback('⚙ Pengaturan', 'a:rw:settings')],
  [Markup.button.callback('⬅️ Back', 'a:home')],
]);

const adminBack = (to = 'a:rw:home') => Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', to)]]);

const loyaltyTiersKb = (cfg) => {
  const rows = cfg.loyaltyTiers.map((t, i) => [Markup.button.callback(
    `${t.active ? '✅' : '❌'} ${t.threshold} tx → ${t.label || t.rewardTier}`,
    `a:rw:loyalty:e:${i}`,
  )]);
  rows.push([Markup.button.callback(cfg.loyaltyEnabled ? '🔴 Nonaktifkan Loyalty' : '🟢 Aktifkan Loyalty', 'a:rw:loyalty:tog')]);
  rows.push([Markup.button.callback('⬅️ Back', 'a:rw:home')]);
  return Markup.inlineKeyboard(rows);
};

const referralTiersKb = (cfg) => {
  const rows = cfg.referralTiers.map((t, i) => [Markup.button.callback(
    `${t.active ? '✅' : '❌'} ${t.threshold} ref → ${t.label || t.rewardTier}`,
    `a:rw:referral:e:${i}`,
  )]);
  rows.push([Markup.button.callback(cfg.referralEnabled ? '🔴 Nonaktifkan Referral' : '🟢 Aktifkan Referral', 'a:rw:referral:tog')]);
  rows.push([Markup.button.callback('⬅️ Back', 'a:rw:home')]);
  return Markup.inlineKeyboard(rows);
};

const tierEditKb = (kind, idx, tier) => Markup.inlineKeyboard([
  [Markup.button.callback('🎯 Ubah Target', `a:rw:${kind}:f:${idx}:threshold`)],
  [Markup.button.callback('🎁 Ubah Reward Tier', `a:rw:${kind}:f:${idx}:rewardTier`)],
  [Markup.button.callback('🏷 Ubah Label', `a:rw:${kind}:f:${idx}:label`)],
  [Markup.button.callback('🛡 Garansi (hari)', `a:rw:${kind}:f:${idx}:warrantyDays`),
   Markup.button.callback('🔁 Max Replace', `a:rw:${kind}:f:${idx}:maxReplace`)],
  [Markup.button.callback(tier.active ? '🔴 Nonaktifkan' : '🟢 Aktifkan', `a:rw:${kind}:f:${idx}:toggle`)],
  [Markup.button.callback('⬅️ Back', `a:rw:${kind}`)],
]);

const badgesListKb = (cfg) => {
  const rows = cfg.badges.map((b, i) => [Markup.button.callback(
    `${b.active ? '' : '❌ '}${b.icon} ${b.name} (${b.kind} ≥${b.threshold})`,
    `a:rw:badges:e:${i}`,
  )]);
  rows.push([Markup.button.callback('➕ Tambah Badge', 'a:rw:badges:add')]);
  rows.push([Markup.button.callback('⬅️ Back', 'a:rw:home')]);
  return Markup.inlineKeyboard(rows);
};

const badgeEditKb = (idx, badge) => Markup.inlineKeyboard([
  [Markup.button.callback('🏷 Nama', `a:rw:badges:f:${idx}:name`),
   Markup.button.callback('🎨 Icon', `a:rw:badges:f:${idx}:icon`)],
  [Markup.button.callback('🎯 Threshold', `a:rw:badges:f:${idx}:threshold`),
   Markup.button.callback('🔀 Kind', `a:rw:badges:f:${idx}:kind`)],
  [Markup.button.callback(badge.active ? '🔴 Nonaktifkan' : '🟢 Aktifkan', `a:rw:badges:f:${idx}:toggle`)],
  [Markup.button.callback('🗑 Hapus', `a:rw:badges:del:${idx}`)],
  [Markup.button.callback('⬅️ Back', 'a:rw:badges')],
]);

const framesListKb = (cfg) => {
  const rows = cfg.frames.map((f, i) => [Markup.button.callback(
    `${f.icon} ${f.name} (≥${f.threshold} VPS)`, `a:rw:frames:e:${i}`,
  )]);
  rows.push([Markup.button.callback('⬅️ Back', 'a:rw:home')]);
  return Markup.inlineKeyboard(rows);
};

const frameEditKb = (idx) => Markup.inlineKeyboard([
  [Markup.button.callback('🏷 Nama', `a:rw:frames:f:${idx}:name`),
   Markup.button.callback('🎨 Icon', `a:rw:frames:f:${idx}:icon`)],
  [Markup.button.callback('🎯 Threshold', `a:rw:frames:f:${idx}:threshold`)],
  [Markup.button.callback('⬅️ Back', 'a:rw:frames')],
]);

const settingsKb = () => Markup.inlineKeyboard([
  [Markup.button.callback('📅 Min Umur Akun (hari)', 'a:rw:settings:f:minAccountAgeDays')],
  [Markup.button.callback('⏱ Min VPS Aktif (jam)', 'a:rw:settings:f:minVpsActiveHours')],
  [Markup.button.callback('🎁 Slot Reward VPS (1/2/3)', 'a:rw:settings:f:rewardSlot')],
  [Markup.button.callback('🎯 Reward Spesial Loyalty', 'a:rw:settings:f:specialLoyaltyReward')],
  [Markup.button.callback('🎯 Reward Spesial Referral', 'a:rw:settings:f:specialReferralReward')],
  [Markup.button.callback(' Toggle Loyalty', 'a:rw:loyalty:tog'),
   Markup.button.callback(' Toggle Referral', 'a:rw:referral:tog')],
  [Markup.button.callback('⬅️ Back', 'a:rw:home')],
]);

module.exports = {
  userExtraMenu, rewardMenuKb, referralMenuKb, achievementKb, leaderboardKb, profileKb,
  adminRewardHome, adminBack,
  loyaltyTiersKb, referralTiersKb, tierEditKb,
  badgesListKb, badgeEditKb, framesListKb, frameEditKb, settingsKb,
};
