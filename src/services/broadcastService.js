// Shared Broadcast sender — the SAME send-loop previously inlined inside
// adminHandler.doBroadcast(). Extracted so both the manual "📢 Broadcast"
// admin flow and automated triggers (e.g. new-stock notifications) go
// through one identical code path: same throttle, same admin-skip rule,
// same Broadcast audit record. This is NOT a new broadcast system — it is
// the existing one, just callable without a Telegraf `ctx`.
const userService = require('./userService');
const Broadcast = require('../models/Broadcast');
const { config } = require('../config');

// sendBroadcast({ bot, message, adminId })
//  - bot:     anything with `.telegram.sendMessage` (a Telegraf bot instance,
//             or `{ telegram: ctx.telegram }` when only a ctx is available).
//  - message: raw announcement text (the "📢 *PENGUMUMAN*" header is added
//             here, exactly as before).
//  - adminId: identifier stored on the Broadcast audit record. Pass the
//             triggering admin's Telegram id for manual broadcasts, or a
//             descriptive system label (e.g. 'system:new-provider-stock')
//             for automated ones.
async function sendBroadcast({ bot, message, adminId }) {
  const users = await userService.allUsers();
  let sent = 0, failed = 0;
  const adminIdStr = String(config.adminId);
  for (const u of users) {
    if (String(u.telegramId) === adminIdStr) continue;
    try {
      await bot.telegram.sendMessage(u.telegramId, `📢 *PENGUMUMAN*\n\n${message}`, { parse_mode: 'Markdown' });
      sent++;
    } catch (_) { failed++; }
    await new Promise((r) => setTimeout(r, 40));
  }
  await Broadcast.create({ adminId: String(adminId || config.adminId), message, sent, failed });
  return { sent, failed };
}

module.exports = { sendBroadcast };
