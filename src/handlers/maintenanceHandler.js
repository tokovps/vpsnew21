// Maintenance Mode admin handler.
//
// Scope: rendering the admin panel, toggling on/off, editing estimate &
// message, managing testers, and processing tester requests. This handler
// NEVER mutates other collections — it is purely a "gate access" concern.

const Admin = require('../models/Admin');
const { config } = require('../config');
const { safeEditText, answerCb, respondSaved, respondInSession } = require('../utils/safeEdit');
const { openInputSession, clearSession, getSession } = require('./sessionStore');
const {
  maintenancePanel, estimateMenu, testersMenu, testerRequestKb, cancelToPanel,
} = require('../keyboards/maintenance');
const svc = require('../services/maintenanceService');

// ── Render main Maintenance panel ─────────────────────────────────────────
async function renderPanel(ctx) {
  await answerCb(ctx);
  const s = await svc.getState();
  const eta = svc.formatEstimate(s.estimateMinutes);
  const testerCount = (s.testers || []).length;
  const reqCount = (s.requests || []).length;
  const statusEmoji = s.enabled ? '🟢' : '🔴';
  const statusText  = s.enabled ? 'ONLINE (Maintenance AKTIF)' : 'OFFLINE (Normal)';
  const startedTxt = s.startedAt
    ? new Date(s.startedAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
    : '-';
  const preview = String(s.message || '').slice(0, 400);
  const text =
`🛠 *MAINTENANCE MODE*
━━━━━━━━━━━━━━━━━━

*STATUS:* ${statusEmoji} ${statusText}
*Aktif Sejak:* ${startedTxt}
*Estimasi:* ${eta}
*Tester Aktif:* ${testerCount}
*Permintaan Tester:* ${reqCount}

*Pesan Maintenance (preview):*
${preview}

━━━━━━━━━━━━━━━━━━
_Selama maintenance AKTIF, hanya Admin dan Tester yang bisa mengakses bot._`;
  return safeEditText(ctx, text, { parse_mode: 'Markdown', ...maintenancePanel(s.enabled) });
}

// ── Enable / Disable ──────────────────────────────────────────────────────
async function doEnable(ctx, bot) {
  const before = await svc.getState();
  const state = await svc.enable({ estimateMinutes: before.estimateMinutes, message: before.message });
  // Notify all users (fire-and-forget). Includes estimate.
  const eta = svc.formatEstimate(state.estimateMinutes);
  const notif =
`━━━━━━━━━━━━━━
🛠 *BOT SEDANG MAINTENANCE*

Kami sedang melakukan peningkatan sistem.

⏱ *Estimasi selesai:* ${eta}

Mohon menunggu.
Terima kasih.
━━━━━━━━━━━━━━`;
  svc.broadcastToAllUsers(bot, notif).catch(() => {});
  await answerCb(ctx, '✅ Maintenance AKTIF');
  return renderPanel(ctx);
}

async function doDisable(ctx, bot) {
  await svc.disable();
  const notif =
`━━━━━━━━━━━━━━
🎉 *MAINTENANCE SELESAI*

Bot sudah kembali Online.
Seluruh layanan sudah dapat digunakan kembali.

Terima kasih telah menunggu.
Silakan tekan /start untuk mulai menggunakan Bot.
━━━━━━━━━━━━━━`;
  svc.broadcastToAllUsers(bot, notif).catch(() => {});
  await answerCb(ctx, '🔴 Maintenance NONAKTIF');
  return renderPanel(ctx);
}

// ── Estimate editing ──────────────────────────────────────────────────────
async function renderEstimateMenu(ctx) {
  await answerCb(ctx);
  const s = await svc.getState();
  const text =
`⏱ *EDIT ESTIMASI MAINTENANCE*

Estimasi saat ini: *${svc.formatEstimate(s.estimateMinutes)}*

Pilih salah satu preset atau masukkan sendiri:`;
  return safeEditText(ctx, text, { parse_mode: 'Markdown', ...estimateMenu(s.estimateMinutes) });
}

async function setEstimate(ctx, minutes) {
  const n = parseInt(minutes, 10);
  if (!Number.isFinite(n) || n < 0) { await answerCb(ctx, '❌ Angka tidak valid'); return; }
  await svc.updateEstimate(n);
  await answerCb(ctx, `✅ Estimasi → ${svc.formatEstimate(n)}`);
  return renderEstimateMenu(ctx);
}

async function startCustomEstimate(ctx) {
  openInputSession(ctx, { action: 'maintenance_custom_minutes', returnTo: 'a:maint:eta:menu' });
  await answerCb(ctx);
  return safeEditText(ctx,
    `⏱ *ESTIMASI MAINTENANCE — CUSTOM*\n\nKirim angka *menit* (contoh: \`45\`, \`90\`, \`240\`).\nKirim \`0\` untuk mengosongkan.`,
    { parse_mode: 'Markdown', ...cancelToPanel() });
}

// ── Message editing ───────────────────────────────────────────────────────
async function startEditMessage(ctx) {
  const s = await svc.getState();
  openInputSession(ctx, { action: 'maintenance_edit_message', returnTo: 'a:maint:menu' });
  await answerCb(ctx);
  const preview = String(s.message || '').slice(0, 400);
  return safeEditText(ctx,
    `📝 *EDIT PESAN MAINTENANCE*\n\nSaat ini:\n\`\`\`\n${preview || '(kosong)'}\n\`\`\`\n\nKirim *teks baru* (Markdown didukung).`,
    { parse_mode: 'Markdown', ...cancelToPanel() });
}

// ── Tester management ─────────────────────────────────────────────────────
async function renderTesterList(ctx) {
  await answerCb(ctx);
  const s = await svc.getState();
  const lines = (s.testers || []).map((t, i) =>
    `${i + 1}. \`${t.telegramId}\` ${t.username ? '@' + t.username : ''} — ${t.name || '-'}`
  ).join('\n');
  const reqLines = (s.requests || []).map((r, i) =>
    `${i + 1}. \`${r.telegramId}\` ${r.username ? '@' + r.username : ''} — ${r.name || '-'}`
  ).join('\n');
  const text =
`👤 *TESTER MODE*
━━━━━━━━━━━━━━━━━━

*Tester Aktif (${(s.testers || []).length}):*
${lines || '_(kosong)_'}

*Permintaan Pending (${(s.requests || []).length}):*
${reqLines || '_(kosong)_'}

━━━━━━━━━━━━━━━━━━
_Tekan nama tester untuk menghapus. Semua tester akan otomatis dihapus saat Maintenance dimatikan._`;
  return safeEditText(ctx, text, { parse_mode: 'Markdown', ...testersMenu(s.testers || []) });
}

async function removeTesterAction(ctx, tid) {
  await svc.removeTester(tid);
  await answerCb(ctx, `🗑 Tester \`${tid}\` dihapus`);
  return renderTesterList(ctx);
}

async function startAddTester(ctx) {
  openInputSession(ctx, { action: 'maintenance_add_tester', returnTo: 'a:maint:testers' });
  await answerCb(ctx);
  return safeEditText(ctx,
    `➕ *TAMBAH TESTER MANUAL*\n\nKirim *Telegram ID* user (angka) yang ingin dijadikan tester.\nContoh: \`123456789\``,
    { parse_mode: 'Markdown', ...cancelToPanel() });
}

// ── Handler for tester REQUEST from user (called from /start gate) ────────
// Sends "Permintaan Tester" card to all admins and stores request.
async function fireTesterRequest(bot, user) {
  const uid = String(user.id || user.telegramId);
  const username = user.username || '';
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ')
    || user.firstName || user.name || '';
  await svc.addRequest({ telegramId: uid, username, name });
  const time = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const card =
`━━━━━━━━━━━━━━
🆕 *PERMINTAAN TESTER*

👤 *Nama:* ${name || '-'}
🆔 *ID:* \`${uid}\`
👤 *Username:* ${username ? '@' + username : '-'}
🕒 *Waktu:* ${time}
━━━━━━━━━━━━━━

_Bot sedang Maintenance. User pertama kali membuka Bot._
_Setujui untuk memberi akses selama Maintenance aktif._`;
  const ids = await _adminIds();
  for (const adminId of ids) {
    try {
      const m = await bot.telegram.sendMessage(adminId, card, {
        parse_mode: 'Markdown', ...testerRequestKb(uid),
      });
      if (m && m.message_id) await svc.saveRequestAdminMsg(uid, adminId, m.message_id).catch(() => {});
    } catch (_) { /* ignore */ }
  }
}

async function _adminIds() {
  const ids = new Set();
  if (config.adminId) ids.add(String(config.adminId));
  try {
    const admins = await Admin.find({}, { telegramId: 1 }).lean();
    for (const a of admins) if (a.telegramId) ids.add(String(a.telegramId));
  } catch (_) {}
  return [...ids];
}

// ── Approve / Reject tester request (admin callback) ──────────────────────
async function approveRequest(ctx, bot, tid) {
  const state = await svc.getState();
  const req = state.requests.find(r => String(r.telegramId) === String(tid));
  await svc.addTester({
    telegramId: tid,
    username: req ? req.username : '',
    name: req ? req.name : '',
  });
  // Clean up admin cards (all admins).
  if (req && req.adminMessageIds) {
    for (const [adminId, msgId] of req.adminMessageIds.entries()) {
      try { await bot.telegram.editMessageText(adminId, msgId, undefined,
        `✅ *Tester disetujui:* \`${tid}\` ${req.username ? '@' + req.username : ''}`,
        { parse_mode: 'Markdown' }); } catch (_) {}
    }
  }
  // Notify the user.
  try {
    await bot.telegram.sendMessage(tid,
`✅ *Anda telah dijadikan Tester*

Silakan gunakan Bot secara normal selama Maintenance aktif.
Tekan /start untuk memulai.`,
      { parse_mode: 'Markdown' });
  } catch (_) {}
  await answerCb(ctx, '✅ Disetujui');
}

async function rejectRequest(ctx, bot, tid) {
  const req = await svc.rejectRequest(tid);
  if (req && req.adminMessageIds) {
    for (const [adminId, msgId] of req.adminMessageIds.entries()) {
      try { await bot.telegram.editMessageText(adminId, msgId, undefined,
        `❌ *Tester ditolak:* \`${tid}\` ${req.username ? '@' + req.username : ''}`,
        { parse_mode: 'Markdown' }); } catch (_) {}
    }
  }
  try {
    await bot.telegram.sendMessage(tid,
`Maaf.

Saat ini Bot masih dalam tahap Maintenance.
Admin belum mengizinkan Anda menjadi Tester.
Silakan tunggu hingga Maintenance selesai.`,
      { parse_mode: 'Markdown' });
  } catch (_) {}
  await answerCb(ctx, '❌ Ditolak');
}

// ── Text handler (chained from adminHandler.handleAdminText) ──────────────
async function handleMaintenanceText(ctx) {
  const session = getSession(ctx.from.id);
  if (!session || !session.action || !session.action.startsWith('maintenance_')) return false;
  const text = String(ctx.message.text || '').trim();

  if (session.action === 'maintenance_custom_minutes') {
    const n = parseInt(text.replace(/\D/g, ''), 10);
    if (!Number.isFinite(n) || n < 0) return respondInSession(ctx, '⚠️ Angka tidak valid. Kirim menit dalam angka:');
    await svc.updateEstimate(n);
    clearSession(ctx.from.id);
    return respondSaved(ctx,
      `✅ Estimasi diatur ke *${svc.formatEstimate(n)}*.`,
      session.returnTo || 'a:maint:menu');
  }
  if (session.action === 'maintenance_edit_message') {
    if (!text) return respondInSession(ctx, '⚠️ Pesan tidak boleh kosong. Kirim ulang:');
    await svc.updateMessage(text);
    clearSession(ctx.from.id);
    return respondSaved(ctx, `✅ Pesan Maintenance berhasil diubah.`, session.returnTo || 'a:maint:menu');
  }
  if (session.action === 'maintenance_add_tester') {
    const id = text.replace(/[^0-9]/g, '');
    if (!id) return respondInSession(ctx, '⚠️ Telegram ID tidak valid. Kirim angka (contoh: 123456789):');
    // Try to look up user profile from User collection for nice label.
    let username = '', name = '';
    try {
      const User = require('../models/User');
      const u = await User.findOne({ telegramId: id }).lean();
      if (u) { username = u.username || ''; name = u.name || ''; }
    } catch (_) {}
    await svc.addTester({ telegramId: id, username, name });
    clearSession(ctx.from.id);
    return respondSaved(ctx, `✅ Tester ditambahkan: \`${id}\``, session.returnTo || 'a:maint:testers');
  }
  return false;
}

module.exports = {
  renderPanel, doEnable, doDisable,
  renderEstimateMenu, setEstimate, startCustomEstimate,
  startEditMessage,
  renderTesterList, removeTesterAction, startAddTester,
  fireTesterRequest, approveRequest, rejectRequest,
  handleMaintenanceText,
};
