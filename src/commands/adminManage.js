// Super-admin only (must match env ADMIN_ID) — manages additional admins in DB.
const Admin = require('../models/Admin');
const { config } = require('../config');

function isSuperAdmin(ctx) {
  return ctx.from && String(ctx.from.id) === String(config.adminId);
}

async function addAdminCommand(ctx) {
  if (!isSuperAdmin(ctx)) return;
  const parts = (ctx.message.text || '').trim().split(/\s+/);
  if (parts.length < 2) {
    return ctx.reply('⚠️ Penggunaan: `/addadmin <telegram_id> [username]`', { parse_mode: 'Markdown' });
  }
  const telegramId = parts[1].replace(/^@/, '');
  if (!/^\d+$/.test(telegramId)) {
    return ctx.reply('⚠️ Telegram ID harus berupa angka.');
  }
  const username = (parts[2] || '').replace(/^@/, '');
  await Admin.findOneAndUpdate(
    { telegramId: String(telegramId) },
    { telegramId: String(telegramId), username },
    { upsert: true, new: true },
  );
  return ctx.reply(`✅ Admin ditambahkan: \`${telegramId}\`${username ? ` (@${username})` : ''}`, { parse_mode: 'Markdown' });
}

async function removeAdminCommand(ctx) {
  if (!isSuperAdmin(ctx)) return;
  const parts = (ctx.message.text || '').trim().split(/\s+/);
  if (parts.length < 2) {
    return ctx.reply('⚠️ Penggunaan: `/removeadmin <telegram_id>`', { parse_mode: 'Markdown' });
  }
  const telegramId = parts[1].replace(/^@/, '');
  if (String(telegramId) === String(config.adminId)) {
    return ctx.reply('⚠️ Tidak dapat menghapus Super Admin (dari .env).');
  }
  const removed = await Admin.findOneAndDelete({ telegramId: String(telegramId) });
  if (!removed) return ctx.reply('⚠️ Admin tidak ditemukan.');
  return ctx.reply(`✅ Admin dihapus: \`${telegramId}\``, { parse_mode: 'Markdown' });
}

async function listAdminsCommand(ctx) {
  if (!isSuperAdmin(ctx)) return;
  const admins = await Admin.find().sort({ createdAt: 1 });
  const lines = [`👑 *DAFTAR ADMIN*\n`, `🔹 Super Admin: \`${config.adminId}\` (@${config.adminUsername})`];
  if (admins.length) {
    admins.forEach((a, i) => lines.push(`${i + 1}. \`${a.telegramId}\`${a.username ? ` (@${a.username})` : ''}`));
  } else {
    lines.push('\n_Belum ada admin tambahan._');
  }
  return ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
}

module.exports = { addAdminCommand, removeAdminCommand, listAdminsCommand };
