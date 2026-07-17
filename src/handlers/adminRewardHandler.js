// Admin Reward Center handlers.
const { Markup } = require('telegraf');
const { safeEditText, answerCb, respondSaved, respondInSession } = require('../utils/safeEdit');
const { openInputSession, clearSession, getSession } = require('./sessionStore');
const rewardService = require('../services/rewardService');
const RewardConfig = require('../models/RewardConfig');
const UserProgress = require('../models/UserProgress');
const RewardClaim = require('../models/RewardClaim');
const User = require('../models/User');
const kb = require('../keyboards/reward');

const PAGE = 8;

async function renderHome(ctx) {
  await answerCb(ctx);
  return safeEditText(ctx,
`🏆 *REWARD CENTER*

Kelola sistem Loyalty, Referral, Badge, Frame, dan seluruh pengaturan reward dari sini.

_Semua perubahan tersimpan realtime ke MongoDB._`,
    { parse_mode: 'Markdown', ...kb.adminRewardHome() });
}

async function renderDashboard(ctx) {
  const d = await rewardService.adminDashboard();
  const cfg = await rewardService.getConfig();
  await answerCb(ctx);
  return safeEditText(ctx,
`📊 *REWARD DASHBOARD*

Loyalty    : ${cfg.loyaltyEnabled ? '🟢 Aktif' : '🔴 Nonaktif'}
Referral   : ${cfg.referralEnabled ? '🟢 Aktif' : '🔴 Nonaktif'}
Badge      : ${cfg.badgeEnabled ? '🟢 Aktif' : '🔴 Nonaktif'}

👥 Total User (progress) : *${d.totalUsers}*
👑 VIP User              : *${d.vipUsers}*
💎 Diamond User          : *${d.diamondUsers}*
🏅 Total Badge Earned    : *${d.totalBadges}*
🎁 Reward Hari Ini       : *${d.rewardsToday}*
🎁 Reward Bulan Ini      : *${d.rewardsMonth}*
🎯 User Siap Claim       : *${d.readyCount}*

Min Umur Akun : *${cfg.minAccountAgeDays} hari*
Min VPS Aktif : *${cfg.minVpsActiveHours} jam*
Reward Slot   : *Spec ${cfg.rewardSlot}*`,
    { parse_mode: 'Markdown', ...kb.adminBack('a:rw:home') });
}

// ===== LOYALTY / REFERRAL CONFIG =====
async function renderLoyalty(ctx) {
  const cfg = await rewardService.getConfig();
  await answerCb(ctx);
  const lines = cfg.loyaltyTiers.map((t, i) => `${i + 1}. ${t.active ? '✅' : '❌'} ${t.threshold} tx → *${t.label || t.rewardTier.toUpperCase()}* (${t.warrantyDays}h, ${t.maxReplace}x replace)`).join('\n');
  return safeEditText(ctx,
`🎁 *LOYALTY CONFIG*

Status: ${cfg.loyaltyEnabled ? '🟢 Aktif' : '🔴 Nonaktif'}

${lines}

_Pilih tier untuk mengubah:_`,
    { parse_mode: 'Markdown', ...kb.loyaltyTiersKb(cfg) });
}

async function renderReferral(ctx) {
  const cfg = await rewardService.getConfig();
  await answerCb(ctx);
  const lines = cfg.referralTiers.map((t, i) => `${i + 1}. ${t.active ? '✅' : '❌'} ${t.threshold} ref → *${t.label || t.rewardTier.toUpperCase()}* (${t.warrantyDays}h, ${t.maxReplace}x replace)`).join('\n');
  return safeEditText(ctx,
`👥 *REFERRAL CONFIG*

Status: ${cfg.referralEnabled ? '🟢 Aktif' : '🔴 Nonaktif'}
Min Umur Akun : *${cfg.minAccountAgeDays} hari*
Min VPS Aktif : *${cfg.minVpsActiveHours} jam*

${lines}`,
    { parse_mode: 'Markdown', ...kb.referralTiersKb(cfg) });
}

async function toggleFlag(ctx, field, backCb) {
  const cfg = await rewardService.getConfig();
  cfg[field] = !cfg[field];
  await cfg.save();
  await answerCb(ctx, cfg[field] ? '🟢 Aktif' : '🔴 Nonaktif');
  if (backCb === 'a:rw:loyalty') return renderLoyalty(ctx);
  if (backCb === 'a:rw:referral') return renderReferral(ctx);
  return renderHome(ctx);
}

async function renderTierEdit(ctx, kind, idx) {
  const cfg = await rewardService.getConfig();
  const tiers = kind === 'loyalty' ? cfg.loyaltyTiers : cfg.referralTiers;
  const t = tiers[idx];
  if (!t) { await answerCb(ctx, 'Tier tidak ditemukan', true); return; }
  await answerCb(ctx);
  return safeEditText(ctx,
`✏️ *EDIT ${kind.toUpperCase()} TIER #${idx + 1}*

🎯 Target       : *${t.threshold}*
🎁 Reward Tier  : *${t.rewardTier.toUpperCase()}*
🏷 Label        : ${t.label || '-'}
🛡 Garansi      : ${t.warrantyDays} hari
🔁 Max Replace  : ${t.maxReplace}x
Status          : ${t.active ? '🟢 Aktif' : '🔴 Nonaktif'}

_Pilih field yang ingin diubah:_`,
    { parse_mode: 'Markdown', ...kb.tierEditKb(kind, idx, t) });
}

async function handleTierField(ctx, kind, idx, field) {
  const cfg = await rewardService.getConfig();
  const tiers = kind === 'loyalty' ? cfg.loyaltyTiers : cfg.referralTiers;
  const t = tiers[idx];
  if (!t) { await answerCb(ctx, 'Tier tidak ditemukan', true); return; }
  if (field === 'toggle') {
    t.active = !t.active;
    await cfg.save();
    await answerCb(ctx, t.active ? '🟢' : '🔴');
    return renderTierEdit(ctx, kind, idx);
  }
  openInputSession(ctx, { action: 'admin_rw_tier', kind, idx, field, returnTo: `a:rw:${kind}:e:${idx}` });
  await answerCb(ctx);
  const prompts = {
    threshold: '🎯 Kirim *target baru* (angka, jumlah transaksi/referral):',
    rewardTier: '🎁 Kirim *reward tier* baru — ketik salah satu:\n`low`, `basic`, `medium`, `special`',
    label: '🏷 Kirim *label baru* untuk tier ini:',
    warrantyDays: '🛡 Kirim *lama garansi* (hari, angka):',
    maxReplace: '🔁 Kirim *max replace* (angka):',
  };
  return safeEditText(ctx, prompts[field] || '_Kirim nilai baru:_', { parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', `a:rw:${kind}:e:${idx}`)]]) });
}

// ===== BADGES =====
async function renderBadges(ctx) {
  const cfg = await rewardService.getConfig();
  await answerCb(ctx);
  return safeEditText(ctx,
`🏅 *BADGE MANAGER*

Total: *${cfg.badges.length}* badge

_Pilih badge untuk edit / tambah baru:_`,
    { parse_mode: 'Markdown', ...kb.badgesListKb(cfg) });
}

async function renderBadgeEdit(ctx, idx) {
  const cfg = await rewardService.getConfig();
  const b = cfg.badges[idx];
  if (!b) { await answerCb(ctx, 'Badge tidak ditemukan', true); return; }
  await answerCb(ctx);
  return safeEditText(ctx,
`🏅 *EDIT BADGE #${idx + 1}*

${b.icon} *${b.name}*
Kind      : ${b.kind}
Threshold : ${b.threshold}
Kode      : \`${b.code}\`
Status    : ${b.active ? '🟢 Aktif' : '🔴 Nonaktif'}`,
    { parse_mode: 'Markdown', ...kb.badgeEditKb(idx, b) });
}

async function handleBadgeField(ctx, idx, field) {
  const cfg = await rewardService.getConfig();
  const b = cfg.badges[idx];
  if (!b) { await answerCb(ctx, 'Badge tidak ditemukan', true); return; }
  if (field === 'toggle') {
    b.active = !b.active;
    await cfg.save();
    await answerCb(ctx, b.active ? '🟢' : '🔴');
    return renderBadgeEdit(ctx, idx);
  }
  openInputSession(ctx, { action: 'admin_rw_badge', idx, field, returnTo: `a:rw:badges:e:${idx}` });
  await answerCb(ctx);
  const prompts = {
    name: '🏷 Kirim *nama badge* baru:',
    icon: '🎨 Kirim *icon emoji* baru:',
    threshold: '🎯 Kirim *threshold* baru (angka):',
    kind: '🔀 Kirim *kind* — ketik `vps` atau `referral`:',
  };
  return safeEditText(ctx, prompts[field], { parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', `a:rw:badges:e:${idx}`)]]) });
}

async function deleteBadge(ctx, idx) {
  const cfg = await rewardService.getConfig();
  if (!cfg.badges[idx]) { await answerCb(ctx, 'Badge tidak ditemukan', true); return; }
  cfg.badges.splice(idx, 1);
  await cfg.save();
  await answerCb(ctx, '🗑 Dihapus');
  return renderBadges(ctx);
}

async function startAddBadge(ctx) {
  openInputSession(ctx, { action: 'admin_rw_badge_add', returnTo: 'a:rw:badges' });
  await answerCb(ctx);
  return safeEditText(ctx,
`➕ *TAMBAH BADGE*

Kirim data badge baru (satu baris, pisah dengan koma):
\`kode,nama,icon,kind,threshold\`

Contoh:
\`epic_hunter,Epic Hunter,🎯,vps,300\``,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', 'a:rw:badges')]]) });
}

// ===== FRAMES =====
async function renderFrames(ctx) {
  const cfg = await rewardService.getConfig();
  await answerCb(ctx);
  return safeEditText(ctx,
`👑 *FRAME MANAGER*

Frame otomatis ditetapkan berdasarkan jumlah VPS Tx.

_Pilih frame untuk edit:_`,
    { parse_mode: 'Markdown', ...kb.framesListKb(cfg) });
}

async function renderFrameEdit(ctx, idx) {
  const cfg = await rewardService.getConfig();
  const f = cfg.frames[idx];
  if (!f) { await answerCb(ctx, 'Frame tidak ditemukan', true); return; }
  await answerCb(ctx);
  return safeEditText(ctx,
`👑 *EDIT FRAME #${idx + 1}*

${f.icon} *${f.name}*
Threshold : ${f.threshold} VPS
Kode      : \`${f.code}\``,
    { parse_mode: 'Markdown', ...kb.frameEditKb(idx) });
}

async function handleFrameField(ctx, idx, field) {
  openInputSession(ctx, { action: 'admin_rw_frame', idx, field, returnTo: `a:rw:frames:e:${idx}` });
  await answerCb(ctx);
  const prompts = { name: '🏷 Nama frame:', icon: '🎨 Icon frame:', threshold: '🎯 Threshold (VPS count):' };
  return safeEditText(ctx, prompts[field], { parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', `a:rw:frames:e:${idx}`)]]) });
}

// ===== SETTINGS =====
async function renderSettings(ctx) {
  const cfg = await rewardService.getConfig();
  await answerCb(ctx);
  return safeEditText(ctx,
`⚙ *PENGATURAN REWARD*

📅 Min Umur Akun    : *${cfg.minAccountAgeDays}* hari
⏱ Min VPS Aktif    : *${cfg.minVpsActiveHours}* jam
🎁 Reward VPS Slot : Spec *${cfg.rewardSlot}*
🎯 Reward Spesial Loyalty:
${cfg.specialLoyaltyReward}
🎯 Reward Spesial Referral:
${cfg.specialReferralReward}`,
    { parse_mode: 'Markdown', ...kb.settingsKb() });
}

async function handleSettingField(ctx, field) {
  openInputSession(ctx, { action: 'admin_rw_setting', field, returnTo: 'a:rw:settings' });
  await answerCb(ctx);
  const prompts = {
    minAccountAgeDays: '📅 Kirim minimal umur akun (angka, hari):',
    minVpsActiveHours: '⏱ Kirim minimal jam VPS aktif (angka):',
    rewardSlot: '🎁 Kirim slot reward VPS (1, 2, atau 3):',
    specialLoyaltyReward: '🎯 Kirim deskripsi reward spesial LOYALTY:',
    specialReferralReward: '🎯 Kirim deskripsi reward spesial REFERRAL:',
  };
  return safeEditText(ctx, prompts[field] || '_Kirim nilai baru:_', { parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', 'a:rw:settings')]]) });
}

// ===== USER PROGRESS =====
async function renderUsers(ctx, page = 1) {
  const total = await UserProgress.countDocuments();
  const totalPages = Math.max(1, Math.ceil(total / PAGE));
  page = Math.min(Math.max(1, page), totalPages);
  const items = await UserProgress.find({}).sort({ vpsTxCount: -1 }).skip((page - 1) * PAGE).limit(PAGE).lean();
  const lines = items.map((p, i) => `${(page - 1) * PAGE + i + 1}. \`${p.userId}\` — ☁${p.vpsTxCount} 👥${p.referralCount} 🏅${(p.badges || []).length}`).join('\n');
  const rows = items.map(p => [Markup.button.callback(`👤 ${p.userId}`, `a:rw:user:${p.userId}`)]);
  const nav = [];
  if (page > 1) nav.push(Markup.button.callback('⬅️', `a:rw:users:${page - 1}`));
  nav.push(Markup.button.callback(`${page}/${totalPages}`, 'noop'));
  if (page < totalPages) nav.push(Markup.button.callback('➡️', `a:rw:users:${page + 1}`));
  rows.push(nav);
  rows.push([Markup.button.callback('⬅️ Back', 'a:rw:home')]);
  await answerCb(ctx);
  return safeEditText(ctx,
`👥 *USER PROGRESS* — hal ${page}/${totalPages} (${total})

${lines || '_(kosong)_'}`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
}

async function renderUserDetail(ctx, userId) {
  const p = await UserProgress.findOne({ userId: String(userId) });
  const u = await User.findOne({ telegramId: String(userId) });
  if (!p) { await answerCb(ctx, 'Progress tidak ditemukan', true); return; }
  await answerCb(ctx);
  return safeEditText(ctx,
`👤 *USER DETAIL*

TelegramID : \`${p.userId}\`
Username   : @${u ? u.username || '-' : '-'}
Blacklist  : ${u && u.blacklisted ? '🚫 YA' : '✅ Tidak'}
Referrer   : ${u && u.referredBy ? '\`' + u.referredBy + '\`' : '-'}

☁ VPS Tx    : *${p.vpsTxCount}*
👥 Referral : *${p.referralCount}*
🏅 Badge    : *${(p.badges || []).length}* (${(p.badges || []).join(', ') || '-'})
👑 Frame    : ${p.frame || '-'}
🎁 Rewards  : *${p.totalRewardsClaimed}*

Claimed Loyalty  : ${(p.claimedLoyalty || []).join(', ') || '-'}
Claimed Referral : ${(p.claimedReferral || []).join(', ') || '-'}`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
      [Markup.button.callback(u && u.blacklisted ? '✅ Un-blacklist' : '🚫 Blacklist', `a:rw:user:bl:${p.userId}`)],
      [Markup.button.callback('♻️ Reset Progress', `a:rw:user:reset:${p.userId}`)],
      [Markup.button.callback('⬅️ Back', 'a:rw:users:1')],
    ]) });
}

async function toggleBlacklist(ctx, userId) {
  const u = await User.findOne({ telegramId: String(userId) });
  if (!u) { await answerCb(ctx, 'User tidak ditemukan', true); return; }
  u.blacklisted = !u.blacklisted;
  await u.save();
  try { require('../services/adminNotifyService').notifyActivity(u, u.blacklisted ? 'User DIBLACKLIST oleh Admin' : 'User di UN-BLACKLIST'); } catch (_) {}
  await answerCb(ctx, u.blacklisted ? '🚫 Diblacklist' : '✅ Un-blacklist');
  return renderUserDetail(ctx, userId);
}

async function resetProgress(ctx, userId) {
  await UserProgress.findOneAndUpdate({ userId: String(userId) }, {
    $set: { vpsTxCount: 0, referralCount: 0, claimedLoyalty: [], claimedReferral: [], badges: [], frame: '', totalRewardsClaimed: 0, referrals: [] },
  });
  await answerCb(ctx, '♻️ Progress direset');
  return renderUserDetail(ctx, userId);
}

// ===== CLAIM HISTORY =====
async function renderHistory(ctx, page = 1) {
  const total = await RewardClaim.countDocuments();
  const totalPages = Math.max(1, Math.ceil(total / PAGE));
  page = Math.min(Math.max(1, page), totalPages);
  const items = await RewardClaim.find({}).sort({ createdAt: -1 }).skip((page - 1) * PAGE).limit(PAGE).lean();
  const lines = items.map((c, i) => {
    const st = c.status === 'success' ? '✅' : c.status === 'failed' ? '❌' : c.status === 'pending_admin' ? '⏳' : '🆕';
    return `${(page - 1) * PAGE + i + 1}. ${st} \`${c.userId}\` • ${c.kind} • ${c.threshold} → ${c.rewardTier}`;
  }).join('\n');
  const nav = [];
  if (page > 1) nav.push(Markup.button.callback('⬅️', `a:rw:history:${page - 1}`));
  nav.push(Markup.button.callback(`${page}/${totalPages}`, 'noop'));
  if (page < totalPages) nav.push(Markup.button.callback('➡️', `a:rw:history:${page + 1}`));
  await answerCb(ctx);
  return safeEditText(ctx,
`📜 *CLAIM HISTORY* — hal ${page}/${totalPages} (${total})

${lines || '_(kosong)_'}`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([nav, [Markup.button.callback('⬅️ Back', 'a:rw:home')]]) });
}

// ===== LEADERBOARD =====
async function renderAdminLeaderboard(ctx) {
  const [buyers, refs, badges, rewards] = await Promise.all([
    rewardService.leaderboardTopBuyers(5),
    rewardService.leaderboardTopReferrers(5),
    rewardService.leaderboardTopBadges(5),
    rewardService.leaderboardTopRewards(5),
  ]);
  const f1 = buyers.map((u, i) => `${i + 1}. \`${u.userId}\` — ${u.vpsTxCount}`).join('\n') || '-';
  const f2 = refs.map((u, i) => `${i + 1}. \`${u.userId}\` — ${u.referralCount}`).join('\n') || '-';
  const f3 = badges.map((u, i) => `${i + 1}. \`${u.userId}\` — ${u.badgesCount}`).join('\n') || '-';
  const f4 = rewards.map((u, i) => `${i + 1}. \`${u.userId}\` — ${u.totalRewardsClaimed}`).join('\n') || '-';
  await answerCb(ctx);
  return safeEditText(ctx,
`🏆 *LEADERBOARD*

☁ *TOP BUYER*
${f1}

👥 *TOP REFERRAL*
${f2}

🏅 *TOP BADGE*
${f3}

🎁 *TOP REWARD*
${f4}`,
    { parse_mode: 'Markdown', ...kb.adminBack('a:rw:home') });
}

// ===== TEXT HANDLER (admin_rw_* sessions) =====
async function handleAdminRewardText(ctx) {
  const s = getSession(ctx.from.id);
  if (!s || !s.action || !s.action.startsWith('admin_rw_')) return false;
  const text = String(ctx.message.text || '').trim();
  const returnTo = s.returnTo || 'a:rw:home';

  if (s.action === 'admin_rw_tier') {
    const cfg = await rewardService.getConfig();
    const tiers = s.kind === 'loyalty' ? cfg.loyaltyTiers : cfg.referralTiers;
    const t = tiers[s.idx];
    if (!t) { clearSession(ctx.from.id); return respondSaved(ctx, '❌ Tier hilang', 'a:rw:home'); }
    if (['threshold', 'warrantyDays', 'maxReplace'].includes(s.field)) {
      const n = parseInt(text.replace(/\D/g, ''), 10);
      if (!Number.isFinite(n) || n < 0) return respondInSession(ctx, '⚠️ Angka tidak valid. Kirim ulang:');
      t[s.field] = n;
    } else if (s.field === 'rewardTier') {
      const v = text.toLowerCase();
      if (!['low', 'basic', 'medium', 'special'].includes(v)) return respondInSession(ctx, '⚠️ Harus salah satu: low/basic/medium/special');
      t.rewardTier = v;
    } else {
      t[s.field] = text;
    }
    await cfg.save();
    clearSession(ctx.from.id);
    return respondSaved(ctx, `✅ Field *${s.field}* diperbarui.`, returnTo);
  }

  if (s.action === 'admin_rw_badge') {
    const cfg = await rewardService.getConfig();
    const b = cfg.badges[s.idx];
    if (!b) { clearSession(ctx.from.id); return respondSaved(ctx, '❌ Badge hilang', 'a:rw:badges'); }
    if (s.field === 'threshold') {
      const n = parseInt(text.replace(/\D/g, ''), 10);
      if (!Number.isFinite(n) || n < 0) return respondInSession(ctx, '⚠️ Angka tidak valid.');
      b.threshold = n;
    } else if (s.field === 'kind') {
      const v = text.toLowerCase();
      if (!['vps', 'referral'].includes(v)) return respondInSession(ctx, '⚠️ Harus `vps` atau `referral`.');
      b.kind = v;
    } else {
      b[s.field] = text;
    }
    await cfg.save();
    clearSession(ctx.from.id);
    return respondSaved(ctx, `✅ Badge diperbarui.`, returnTo);
  }

  if (s.action === 'admin_rw_badge_add') {
    const parts = text.split(',').map(p => p.trim());
    if (parts.length < 5) return respondInSession(ctx, '⚠️ Format salah. `kode,nama,icon,kind,threshold`');
    const [code, name, icon, kind, thStr] = parts;
    if (!['vps', 'referral'].includes(kind)) return respondInSession(ctx, '⚠️ Kind harus `vps` atau `referral`.');
    const th = parseInt(thStr, 10);
    if (!Number.isFinite(th)) return respondInSession(ctx, '⚠️ Threshold harus angka.');
    const cfg = await rewardService.getConfig();
    if (cfg.badges.find(b => b.code === code)) return respondInSession(ctx, '⚠️ Kode badge sudah ada.');
    cfg.badges.push({ code, name, icon, kind, threshold: th, active: true });
    await cfg.save();
    clearSession(ctx.from.id);
    return respondSaved(ctx, `✅ Badge \`${code}\` ditambah.`, 'a:rw:badges');
  }

  if (s.action === 'admin_rw_frame') {
    const cfg = await rewardService.getConfig();
    const f = cfg.frames[s.idx];
    if (!f) { clearSession(ctx.from.id); return respondSaved(ctx, '❌ Frame hilang', 'a:rw:frames'); }
    if (s.field === 'threshold') {
      const n = parseInt(text.replace(/\D/g, ''), 10);
      if (!Number.isFinite(n) || n < 0) return respondInSession(ctx, '⚠️ Angka tidak valid.');
      f.threshold = n;
    } else {
      f[s.field] = text;
    }
    await cfg.save();
    clearSession(ctx.from.id);
    return respondSaved(ctx, `✅ Frame diperbarui.`, returnTo);
  }

  if (s.action === 'admin_rw_setting') {
    const cfg = await rewardService.getConfig();
    if (['minAccountAgeDays', 'minVpsActiveHours', 'rewardSlot'].includes(s.field)) {
      const n = parseInt(text.replace(/\D/g, ''), 10);
      if (!Number.isFinite(n) || n < 0) return respondInSession(ctx, '⚠️ Angka tidak valid.');
      if (s.field === 'rewardSlot' && ![1, 2, 3].includes(n)) return respondInSession(ctx, '⚠️ Slot harus 1, 2, atau 3.');
      cfg[s.field] = n;
    } else {
      cfg[s.field] = text;
    }
    await cfg.save();
    clearSession(ctx.from.id);
    return respondSaved(ctx, `✅ Pengaturan diperbarui.`, returnTo);
  }

  return false;
}

module.exports = {
  renderHome, renderDashboard,
  renderLoyalty, renderReferral, toggleFlag,
  renderTierEdit, handleTierField,
  renderBadges, renderBadgeEdit, handleBadgeField, deleteBadge, startAddBadge,
  renderFrames, renderFrameEdit, handleFrameField,
  renderSettings, handleSettingField,
  renderUsers, renderUserDetail, toggleBlacklist, resetProgress,
  renderHistory, renderAdminLeaderboard,
  handleAdminRewardText,
};
