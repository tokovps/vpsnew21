// User-facing reward/referral/achievement/leaderboard/profile handlers.
const { Markup } = require('telegraf');
const { safeEditText, safeEditMedia, answerCb } = require('../utils/safeEdit');
const rewardService = require('../services/rewardService');
const User = require('../models/User');
const UserProgress = require('../models/UserProgress');
const RewardClaim = require('../models/RewardClaim');
const orderService = require('../services/orderService');
const userHandler = require('./userHandler');
const { setSession, clearSession } = require('./sessionStore');
const { getSettings } = require('../services/settingService');
const kb = require('../keyboards/reward');

function progressBar(count, target) {
  const total = 16;
  const filled = Math.min(total, Math.floor((count / Math.max(1, target)) * total));
  return '█'.repeat(filled) + '░'.repeat(total - filled);
}

async function renderRewardMenu(ctx) {
  const cfg = await rewardService.getConfig();
  const p = await rewardService.ensureProgress(ctx.from.id);
  const { available, nextTier, count } = await rewardService.nextClaimable('loyalty', p, cfg);
  const s = await getSettings();

  if (!cfg.loyaltyEnabled) {
    return safeEditMedia(ctx, { type: 'photo', media: s.homeBanner,
      caption: '🎁 *VPS REWARD CENTER*\n\n_Sistem reward sedang dinonaktifkan Admin._',
      parse_mode: 'Markdown' }, kb.rewardMenuKb(false));
  }

  let caption;
  let claimKey = null;
  if (available.length) {
    const t = available[0];
    claimKey = `L${t.threshold}`;
    caption =
`━━━━━━━━━━━━━━
🏆 *Progress*

${progressBar(count, t.threshold)}
${count} / ${t.threshold} Transaksi

━━━━━━━━━━━━━━
🎁 *SIAP DIKLAIM*
${t.label || t.rewardTier.toUpperCase()}
Garansi ${t.warrantyDays} Hari • Max ${t.maxReplace}x Replace
━━━━━━━━━━━━━━

_Tekan tombol di bawah untuk klaim._`;
  } else if (nextTier) {
    const sisa = nextTier.threshold - count;
    caption =
`━━━━━━━━━━━━━━
🏆 *Progress*

${progressBar(count, nextTier.threshold)}
${count} / ${nextTier.threshold} Transaksi

━━━━━━━━━━━━━━
Reward Berikutnya
🎁 *${nextTier.label || nextTier.rewardTier.toUpperCase()}*
Garansi ${nextTier.warrantyDays} Hari
Max ${nextTier.maxReplace}x Replace
━━━━━━━━━━━━━━

Sisa *${sisa}* Transaksi lagi.

_Reward hanya dihitung untuk transaksi VPS yang berhasil, tidak dibatalkan, dan tidak refund._`;
  } else {
    caption =
`━━━━━━━━━━━━━━
🏆 *Progress*

Total Transaksi VPS: *${count}*

_Semua tier reward loyalty sudah Anda klaim. Terima kasih atas kesetiaan Anda!_`;
  }

  return safeEditMedia(ctx, { type: 'photo', media: s.homeBanner,
    caption, parse_mode: 'Markdown' }, kb.rewardMenuKb(!!claimKey, claimKey));
}

// Claim button — sets a reward-flow session and shows region picker (reuse renderRegion)
async function startClaim(ctx, tierKey) {
  const cfg = await rewardService.getConfig();
  const p = await rewardService.ensureProgress(ctx.from.id);
  const kind = tierKey.startsWith('L') ? 'loyalty' : 'referral';
  const threshold = parseInt(tierKey.slice(1), 10);
  const tier = (kind === 'loyalty' ? cfg.loyaltyTiers : cfg.referralTiers).find(t => t.threshold === threshold);
  if (!tier || !tier.active) { await answerCb(ctx, 'Tier tidak tersedia', true); return; }
  const claimedList = kind === 'loyalty' ? p.claimedLoyalty : p.claimedReferral;
  if (claimedList.includes(threshold)) { await answerCb(ctx, 'Reward tier ini sudah pernah diklaim', true); return; }
  const count = kind === 'loyalty' ? p.vpsTxCount : p.referralCount;
  if (count < threshold) { await answerCb(ctx, 'Belum memenuhi target', true); return; }

  // SPECIAL reward = notify admin, don't run buy flow.
  if (tier.rewardTier === 'special') {
    await rewardService.recordClaim(ctx.from.id, kind, tier);
    try { require('../services/adminNotifyService').notifyActivity(ctx.from, `Claim Reward SPESIAL (${kind})`, { '🎯 Tier:': `#${threshold}` }); } catch (_) {}
    const specialText = kind === 'loyalty' ? cfg.specialLoyaltyReward : cfg.specialReferralReward;
    await answerCb(ctx, '✅ Klaim tercatat');
    const s = await getSettings();
    return safeEditMedia(ctx, { type: 'photo', media: s.homeBanner,
      caption: `🎯 *REWARD SPESIAL*\n\n${specialText}\n\n_Admin akan menghubungi Anda._`,
      parse_mode: 'Markdown' }, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'menu:home')]]));
  }

  // Guard: user can't be mid-order
  const active = await orderService.userActiveOrders(ctx.from.id);
  if (active.length) { await answerCb(ctx, '⚠️ Selesaikan transaksi aktif dulu', true); return; }

  setSession(ctx.from.id, {
    action: 'buy_flow',
    step: 'region',
    category: 'vps',
    tier: tier.rewardTier, // low|basic|medium
    slot: cfg.rewardSlot || 1,
    isReward: true,
    rewardKind: kind,
    rewardThreshold: threshold,
    rewardWarrantyDays: tier.warrantyDays,
    rewardMaxReplace: tier.maxReplace,
  });
  try { require('../services/adminNotifyService').notifyActivity(ctx.from, `Claim Reward ${kind.toUpperCase()}`, { '🎁 Tier:': tier.rewardTier.toUpperCase(), '🎯 Threshold:': String(threshold) }); } catch (_) {}
  await answerCb(ctx, '🎁 Silakan pilih region');
  const { getSession } = require('./sessionStore');
  return userHandler.renderRegion(ctx, getSession(ctx.from.id));
}

// ===== REFERRAL =====
async function renderReferral(ctx) {
  const u = await User.findOne({ telegramId: String(ctx.from.id) });
  const code = await rewardService.ensureReferralCode(u);
  const p = await rewardService.ensureProgress(ctx.from.id);
  const cfg = await rewardService.getConfig();
  const s = await getSettings();
  const botInfo = await ctx.telegram.getMe().catch(() => ({ username: 'yourbot' }));
  const link = `https://t.me/${botInfo.username}?start=${code}`;

  const { available, nextTier, count } = await rewardService.nextClaimable('referral', p, cfg);
  const pendingCount = (p.referrals || []).filter(r => r.status === 'pending').length;
  const qualifiedCount = (p.referrals || []).filter(r => r.status === 'qualified').length;

  let rewardLine = '';
  if (available.length) {
    rewardLine = `\n🎁 *SIAP DIKLAIM:* ${available[0].label || available[0].rewardTier.toUpperCase()}`;
  } else if (nextTier) {
    rewardLine = `\n🎁 Reward berikutnya: *${nextTier.label || nextTier.rewardTier.toUpperCase()}* (${nextTier.threshold - count} referral lagi)`;
  }

  const caption =
`👥 *REFERRAL SAYA*

🔗 Link Referral Anda:
\`${link}\`

Kode: \`${code}\`

━━━━━━━━━━━━━━
✅ Qualified : *${qualifiedCount}*
⏳ Pending   : *${pendingCount}*
🏆 Total Valid: *${count}*
━━━━━━━━━━━━━━${rewardLine}

_Syarat referral valid:_
• Akun Telegram ≥ ${cfg.minAccountAgeDays} hari
• User baru (belum pernah pakai bot)
• Beli VPS & bayar sukses
• VPS aktif minimal ${cfg.minVpsActiveHours} jam
• Tidak refund / cancel`;

  const rows = [];
  if (available.length) {
    rows.push([Markup.button.callback(`🎁 CLAIM ${available[0].label || available[0].rewardTier.toUpperCase()}`, `rw:claim:R${available[0].threshold}`)]);
  }
  rows.push([Markup.button.url('📤 Bagikan Link', `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Yuk gabung! Beli VPS di sini:')}`)]);
  rows.push([Markup.button.callback('📊 Detail Referral', 'rf:detail')]);
  rows.push([Markup.button.callback('⬅️ Kembali', 'menu:home')]);

  return safeEditMedia(ctx, { type: 'photo', media: s.homeBanner,
    caption, parse_mode: 'Markdown' }, Markup.inlineKeyboard(rows));
}

async function renderReferralDetail(ctx) {
  const p = await rewardService.ensureProgress(ctx.from.id);
  const s = await getSettings();
  const list = (p.referrals || []).slice(-15).reverse();
  const lines = list.length ? list.map((r, i) => {
    const st = r.status === 'qualified' ? '✅' : r.status === 'rejected' ? '❌' : '⏳';
    return `${i + 1}. ${st} \`${r.referredUserId}\` ${r.reason ? '(' + r.reason + ')' : ''}`;
  }).join('\n') : '_(belum ada referral)_';
  const caption =
`📊 *DETAIL REFERRAL*

15 referral terakhir:

${lines}`;
  return safeEditMedia(ctx, { type: 'photo', media: s.homeBanner,
    caption, parse_mode: 'Markdown' }, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'rf:menu')]]));
}

// ===== ACHIEVEMENT =====
async function renderAchievement(ctx, filter = 'all') {
  const cfg = await rewardService.getConfig();
  const p = await rewardService.ensureProgress(ctx.from.id);
  const owned = new Set(p.badges || []);
  const s = await getSettings();
  const list = cfg.badges.filter(b => filter === 'all' || b.kind === filter);
  const lines = list.map(b => {
    const has = owned.has(b.code);
    const cnt = b.kind === 'vps' ? p.vpsTxCount : p.referralCount;
    return `${has ? '✅' : '⬜'} ${b.icon} *${b.name}* — ${b.threshold} (${cnt}/${b.threshold})`;
  }).join('\n');
  const caption =
`🏅 *ACHIEVEMENT*

Total Badge: *${(p.badges || []).length} / ${cfg.badges.length}*

${lines || '_(tidak ada badge)_'}`;
  return safeEditMedia(ctx, { type: 'photo', media: s.homeBanner,
    caption, parse_mode: 'Markdown' }, kb.achievementKb());
}

// ===== LEADERBOARD =====
async function renderLeaderboard(ctx, type = 'buyer') {
  const s = await getSettings();
  let title, data, formatter;
  if (type === 'ref') {
    title = '👥 TOP REFERRAL';
    data = await rewardService.leaderboardTopReferrers(10);
    formatter = (u, i) => `${i + 1}. \`${u.userId}\` — *${u.referralCount}* ref`;
  } else if (type === 'badge') {
    title = '🏅 TOP BADGE';
    data = await rewardService.leaderboardTopBadges(10);
    formatter = (u, i) => `${i + 1}. \`${u.userId}\` — *${u.badgesCount}* badge`;
  } else if (type === 'reward') {
    title = '🎁 TOP REWARD';
    data = await rewardService.leaderboardTopRewards(10);
    formatter = (u, i) => `${i + 1}. \`${u.userId}\` — *${u.totalRewardsClaimed}* reward`;
  } else {
    title = '☁ TOP BUYER';
    data = await rewardService.leaderboardTopBuyers(10);
    formatter = (u, i) => `${i + 1}. \`${u.userId}\` — *${u.vpsTxCount}* VPS`;
  }
  const lines = data.length ? data.map(formatter).join('\n') : '_(belum ada data)_';
  return safeEditMedia(ctx, { type: 'photo', media: s.homeBanner,
    caption: `🏆 *LEADERBOARD*\n\n${title}\n\n${lines}`, parse_mode: 'Markdown' },
    kb.leaderboardKb(type));
}

// ===== PROFILE =====
async function renderProfile(ctx) {
  const u = await User.findOne({ telegramId: String(ctx.from.id) });
  const p = await rewardService.ensureProgress(ctx.from.id);
  const cfg = await rewardService.getConfig();
  const s = await getSettings();
  const rank = await rewardService.userRank(ctx.from.id);
  const frame = (cfg.frames || []).find(f => f.code === p.frame);
  const frameIcon = frame ? frame.icon : '⚪';
  const frameName = frame ? frame.name : 'Basic Member';
  const name = u && u.name ? u.name : (ctx.from.first_name || '-');
  const caption =
`👤 *${name}*
━━━━━━━━━━━━
${frameIcon} ${frameName}
━━━━━━━━━━━━
🏅 Badge     : *${(p.badges || []).length}*
☁ VPS       : *${p.vpsTxCount}*
👥 Referral  : *${p.referralCount}*
🎁 Reward    : *${p.totalRewardsClaimed}*
🔥 Login     : *${p.loginStreak} Hari*
🏆 Ranking   : *#${rank.rank}*
━━━━━━━━━━━━

_Terus berbelanja untuk naik level!_`;
  return safeEditMedia(ctx, { type: 'photo', media: s.homeBanner,
    caption, parse_mode: 'Markdown' }, kb.profileKb());
}

async function shareProfile(ctx) {
  const u = await User.findOne({ telegramId: String(ctx.from.id) });
  const p = await rewardService.ensureProgress(ctx.from.id);
  const cfg = await rewardService.getConfig();
  const frame = (cfg.frames || []).find(f => f.code === p.frame);
  const name = u && u.name ? u.name : (ctx.from.first_name || '-');
  const shareText =
`🏆 PROFIL SAYA

${frame ? frame.icon + ' ' + frame.name : '⚪ Basic Member'}
👤 ${name}
🏅 ${(p.badges || []).length} Badge
☁ ${p.vpsTxCount} VPS
👥 ${p.referralCount} Referral
🎁 ${p.totalRewardsClaimed} Reward

Powered by 🚀 TOKO VPS & RDP`;
  await answerCb(ctx);
  await ctx.reply(shareText);
}

module.exports = {
  renderRewardMenu, startClaim,
  renderReferral, renderReferralDetail,
  renderAchievement, renderLeaderboard,
  renderProfile, shareProfile,
};
