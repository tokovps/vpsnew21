const { adminMenu } = require('../keyboards/admin');
const { setPanel } = require('../handlers/adminPanelStore');

async function adminCommand(ctx) {
  const msg = await ctx.reply(
`👑 *ADMIN PANEL*

Selamat datang, Admin.
Pilih menu di bawah untuk mengelola toko.`,
    { parse_mode: 'Markdown', ...adminMenu() });
  setPanel(ctx.from.id, msg.chat.id, msg.message_id);
}

module.exports = { adminCommand };
