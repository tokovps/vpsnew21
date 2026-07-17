const { mainMenu } = require('../keyboards/user');
const { adminMenu } = require('../keyboards/admin');
const { config } = require('../config');
const { getSettings } = require('../services/settingService');
const orderService = require('../services/orderService');
const userService = require('../services/userService');
const { isAdmin } = require('../middlewares/auth');
const { setPanel } = require('../handlers/adminPanelStore');
const User = require('../models/User');
const rewardService = require('../services/rewardService');

async function startCommand(ctx) {
  // Capture "isNew" indicator BEFORE we touch firstSeenAt below.
  let _isNewUser = false;
  try {
    const pre = await User.findOne({ telegramId: String(ctx.from.id) }, { firstSeenAt: 1 }).lean();
    _isNewUser = !pre || !pre.firstSeenAt;
  } catch (_) {}

  // ===== Referral capture (before anything else) =====
  try {
    const u = await User.findOne({ telegramId: String(ctx.from.id) });
    if (u) {
      if (!u.firstSeenAt) {
        u.firstSeenAt = u.createdAt || new Date();
        await u.save();
      }
      if (ctx.startPayload && !u.referredBy) {
        const r = await rewardService.tryAttachReferrer(u, ctx.startPayload);
        if (r.ok) {
          try { await ctx.reply(`✅ Anda bergabung melalui referral \`${ctx.startPayload}\``, { parse_mode: 'Markdown' }); } catch (_) {}
        }
      }
      await rewardService.ensureReferralCode(u);
    }
  } catch (e) { console.error('start:referral capture:', e.message); }

  // ═══ DEEP LINK: /start buy_vps  |  /start buy_rdp ═════════════════════
  // Direct → tier menu. Do NOT render home first (that produced two stacked
  // messages in the chat which the user complained about). Send exactly ONE
  // message = the tier menu itself, then treat it as the anchor for all
  // subsequent edits (Back → renderHome will edit this same message).
  try {
    const dl = String(ctx.startPayload || '').toLowerCase();
    if (dl === 'buy_vps' || dl === 'buy_rdp') {
      const category = dl === 'buy_vps' ? 'vps' : 'rdp';
      const orderService2 = require('../services/orderService');
      const catalog = require('../services/catalogService');
      const userHandler = require('../handlers/userHandler');
      const { tierMenu } = require('../keyboards/user');
      const s0 = await getSettings();

      // Guard 1 — user has an active in-flight order.
      const active = await orderService2.userActiveOrders(ctx.from.id);
      if (active.length) {
        return userHandler.renderActiveOrderBlocker(ctx);
      }
      // Guard 2 — stock zero.
      const st = await catalog.getBuyMenuStock();
      if (!st.stock || st.stock <= 0) {
        const label = category === 'vps' ? 'VPS' : 'RDP';
        const { Markup } = require('telegraf');
        const kb = Markup.inlineKeyboard([
          [Markup.button.url('📞 Hubungi Admin', `https://t.me/${config.adminUsername}`)],
          [Markup.button.callback('⬅️ Kembali', 'menu:home')],
        ]);
        return ctx.replyWithPhoto(s0.homeBanner, {
          caption: `❌ *STOCK ${label} SEDANG KOSONG*\n\nMohon maaf, stock ${label} sedang habis.\nSilakan coba beberapa saat lagi atau hubungi admin.`,
          parse_mode: 'Markdown',
          ...kb,
        });
      }

      // Send the tier menu directly (single message, no home clutter).
      const caption =
`━━━━━━━━━━━━━━━━━━━━━━

🚀 *TOKO VPS & RDP*

${st.statusLine}
${st.stockLine}
${st.etaLine}

━━━━━━━━━━━━━━━━━━━━━━

_Silakan pilih paket yang tersedia._`;
      return ctx.replyWithPhoto(s0.homeBanner, {
        caption, parse_mode: 'Markdown', ...tierMenu(category),
      });
    }
  } catch (e) { console.error('start:deep-link:', e.message); }

  // ===== Admin notify: user ran /start (auto-delete via adminNotifyService TTL) =====
  try {
    require('../services/adminNotifyService').notifyStart(ctx.from, _isNewUser);
  } catch (_) {}

  if (await isAdmin(ctx.from.id)) {
    const msg = await ctx.reply(
`👑 *ADMIN PANEL*

Selamat datang, Admin.
Pilih menu di bawah untuk mengelola toko.`,
      { parse_mode: 'Markdown', ...adminMenu() });
    setPanel(ctx.from.id, msg.chat.id, msg.message_id);
    return;
  }

  const s = await getSettings();
  const caption = await require('../services/homeCaptionService').buildHomeCaption(ctx);
  return ctx.replyWithPhoto(s.homeBanner, {
    caption, parse_mode: 'Markdown', ...mainMenu(),
  });
}

module.exports = { startCommand };
