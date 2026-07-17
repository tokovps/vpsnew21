// ================================================================
// POST STOK SERVICE — retrofit on top of catalogService + providerService.
// ----------------------------------------------------------------
// Exposes 3 pure-async ops used by the Admin → 📢 Post Stok panel:
//
//   • publishStok(bot, category)  → send fresh card to the stok channel,
//                                   store lastMessageId per category.
//   • previewStok(bot, chatId, category) → send SAME card to admin DM
//                                   (no persistence, no button URL open).
//   • deleteLastStok(bot, category) → delete the previously-published card
//                                   using saved lastMessageId, then clear.
//
// SOURCE OF TRUTH: catalogService.getBuyMenuStock() — realtime SUM of
// quotaAvailable across READY, ENABLED providers. RDP and VPS share the
// SAME pool (RDP is provisioned on top of a VPS droplet). This function
// is called on every publish/preview so numbers ALWAYS reflect the current
// state of providers/tokens.
//
// Channel resolution: prefer `stokChannelId`; if empty fall back to
// `catalogChannelId` (so operators with one channel don't have to set
// twice). Both may be `@username` or numeric `-100...`.
// ================================================================
const Setting = require('../models/Setting');
const catalogService = require('./catalogService');
const settingService = require('./settingService');
// Late-bound getters so test doubles / monkey patches on settingService's
// exported functions are honoured. Destructuring here would freeze the ref.
const getSettings   = (...a) => settingService.getSettings(...a);
// settingService.updateSetting expects an OBJECT patch (findOneAndUpdate).
// Wrap so callers can pass either (key, value) or (patchObj) safely.
const updateSetting = (k, v) => {
  const patch = (v === undefined && typeof k === 'object' && k !== null) ? k : { [k]: v };
  return settingService.updateSetting(patch);
};

async function resolveChannel() {
  const s = await getSettings();
  const chan = String(s.stokChannelId || s.catalogChannelId || '').trim();
  return { channelId: chan, hasStokChan: !!s.stokChannelId };
}

async function botUsername(bot) {
  try {
    const me = await bot.telegram.getMe();
    return me.username || 'bot';
  } catch (_) { return 'bot'; }
}

function fmtTsWib() {
  // dd/mm/yyyy HH:mm:ss  (WIB / Asia/Jakarta)
  const d = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`;
}

async function buildStokCard(bot, category) {
  const stock = await catalogService.getBuyMenuStock();
  const uname = await botUsername(bot);
  const isVps = category === 'vps';
  const header = isVps ? '🚀 TOKO VPS' : '🖥 TOKO RDP';
  const label  = isVps ? 'VPS' : 'RDP';
  const text = [
    '━━━━━━━━━━━━━━━━━━',
    header,
    '━━━━━━━━━━━━━━━━━━',
    '',
    '📦 Ready Stock',
    `*${stock.stock} ${label}*`,
    '',
    '🕒 Update:',
    fmtTsWib(),
    '',
    `Klik tombol di bawah untuk membeli ${label}.`,
  ].join('\n');
  const url = `https://t.me/${uname}?start=${isVps ? 'buy_vps' : 'buy_rdp'}`;
  const opts = {
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [[{ text: isVps ? '🛒 Buy VPS' : '🛒 Buy RDP', url }]] },
  };
  return { text, opts, stockValue: stock.stock };
}

// Publish (or overwrite) the stok card in the configured channel.
// Strategy: send a NEW message every time (per user spec: "Kirim Postingan
// Baru ke Channel"). Previous last-post id is preserved separately so that
// the 🗑 Hapus button can remove it explicitly.
async function publishStok(bot, category) {
  const { channelId } = await resolveChannel();
  if (!channelId) return { ok: false, error: 'Channel belum di-set. Buka Post Stok → 📝 Atur Channel.' };
  const { text, opts, stockValue } = await buildStokCard(bot, category);
  try {
    const sent = await bot.telegram.sendMessage(channelId, text, opts);
    const key = category === 'vps' ? 'stokLastMsgIdVps' : 'stokLastMsgIdRdp';
    await updateSetting(key, String(sent.message_id));
    return { ok: true, messageId: sent.message_id, stock: stockValue, channelId };
  } catch (e) {
    return { ok: false, error: (e && e.description) || (e && e.message) || 'sendMessage gagal' };
  }
}

// Send the SAME rendered card to the admin's private chat. No side effects.
async function previewStok(bot, chatId, category) {
  const { text, opts, stockValue } = await buildStokCard(bot, category);
  try {
    const sent = await bot.telegram.sendMessage(chatId, text, opts);
    return { ok: true, messageId: sent.message_id, stock: stockValue };
  } catch (e) {
    return { ok: false, error: (e && e.description) || (e && e.message) || 'sendMessage gagal' };
  }
}

// Delete the last posted card (per category). Idempotent — clears the id
// even if the message was already removed manually in the channel.
async function deleteLastStok(bot, category) {
  const { channelId } = await resolveChannel();
  if (!channelId) return { ok: false, error: 'Channel belum di-set.' };
  const s = await getSettings();
  const key = category === 'vps' ? 'stokLastMsgIdVps' : 'stokLastMsgIdRdp';
  const mid = String(s[key] || '').trim();
  if (!mid) return { ok: false, error: `Belum ada postingan ${category.toUpperCase()} yang tersimpan.` };
  try {
    await bot.telegram.deleteMessage(channelId, Number(mid));
  } catch (e) {
    // If the message is already gone (403 message can't be deleted / 400 not
    // found) still clear the saved id — the record is stale.
    const d = (e && e.description) || '';
    if (!/message to delete not found|not modified/i.test(d)) {
      await updateSetting(key, '');
      return { ok: false, error: d || (e && e.message) || 'deleteMessage gagal', clearedId: mid };
    }
  }
  await updateSetting(key, '');
  return { ok: true, clearedId: mid, channelId };
}

module.exports = {
  buildStokCard,
  publishStok,
  previewStok,
  deleteLastStok,
  resolveChannel,
};
