// RDP Orders admin handler.
// Payment untuk RDP tetap otomatis, tapi delivery dilakukan manual oleh admin.
// Menu: Pending / Processing / Completed / Cancelled → detail order →
// aksi Start Processing / Kirim Detail RDP (multi-step input) / Cancel.
// UI: single-message (editMessage) — anchor pada pesan Admin Panel.
const { Markup } = require('telegraf');
const Order = require('../models/Order');
const { safeEditText, answerCb, respondSaved, respondInSession } = require('../utils/safeEdit');
const { getSession, setSession, clearSession, openInputSession } = require('./sessionStore');

const PAGE_SIZE = 8;

// Map tab → status filter
const TAB_FILTERS = {
  pending:    { category: 'rdp', status: 'pending_admin' },
  processing: { category: 'rdp', status: 'rdp_processing' },
  completed:  { category: 'rdp', status: 'rdp_completed' },
  cancelled:  { category: 'rdp', status: { $in: ['rdp_cancelled', 'cancelled'] } },
};

const TAB_LABELS = {
  pending: '⏳ Pending', processing: '🛠 Processing',
  completed: '✅ Completed', cancelled: '❌ Cancelled',
};

async function renderHome(ctx) {
  const [p, pr, c, x] = await Promise.all([
    Order.countDocuments(TAB_FILTERS.pending),
    Order.countDocuments(TAB_FILTERS.processing),
    Order.countDocuments(TAB_FILTERS.completed),
    Order.countDocuments(TAB_FILTERS.cancelled),
  ]);
  const text =
`🖥 *RDP MANAGEMENT*

━━━━━━━━━━━━━━━━━━
⏳ Pending    : *${p}*
🛠 Processing : *${pr}*
✅ Completed  : *${c}*
❌ Cancelled  : *${x}*
━━━━━━━━━━━━━━━━━━

_Payment untuk RDP tetap otomatis, delivery dilakukan manual oleh admin._`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback(`⏳ Pending (${p})`, 'r:list:pending:1')],
    [Markup.button.callback(`🛠 Processing (${pr})`, 'r:list:processing:1')],
    [Markup.button.callback(`✅ Completed (${c})`, 'r:list:completed:1')],
    [Markup.button.callback(`❌ Cancelled (${x})`, 'r:list:cancelled:1')],
    [Markup.button.callback('⬅️ Back', 'a:home')],
  ]);
  await answerCb(ctx);
  return safeEditText(ctx, text, { parse_mode: 'Markdown', ...kb });
}

async function renderList(ctx, tab, page = 1) {
  const filter = TAB_FILTERS[tab];
  if (!filter) return renderHome(ctx);
  const total = await Order.countDocuments(filter);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  page = Math.min(Math.max(1, page), totalPages);
  const items = await Order.find(filter).sort({ paidAt: -1, createdAt: -1 })
    .skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).lean();

  const lines = items.map((o, i) => {
    const idx = (page - 1) * PAGE_SIZE + i + 1;
    const dt = new Date(o.paidAt || o.createdAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    return `${idx}. \`${o.invoice}\` • @${o.username || '-'} • ${o.productName} • ${dt}`;
  }).join('\n');

  const text =
`🖥 *RDP MANAGEMENT — ${TAB_LABELS[tab]}*  (page ${page}/${totalPages})

${lines || '_(kosong)_'}

_Pilih order untuk detail:_`;

  const rows = items.map((o, i) => {
    const idx = (page - 1) * PAGE_SIZE + i + 1;
    return [Markup.button.callback(`${idx}. ${o.invoice.slice(-8)} • ${o.productName.slice(0, 24)}`, `r:d:${o._id}`)];
  });
  const nav = [];
  if (page > 1) nav.push(Markup.button.callback('⬅️', `r:list:${tab}:${page - 1}`));
  nav.push(Markup.button.callback(`${page}/${totalPages}`, 'noop'));
  if (page < totalPages) nav.push(Markup.button.callback('➡️', `r:list:${tab}:${page + 1}`));
  rows.push(nav);
  rows.push([Markup.button.callback('⬅️ Back', 'r:home')]);
  await answerCb(ctx);
  return safeEditText(ctx, text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
}

function statusLabel(o) {
  if (o.status === 'pending_admin') return '⏳ PENDING_ADMIN';
  if (o.status === 'rdp_processing') return '🛠 PROCESSING';
  if (o.status === 'rdp_completed') return '✅ COMPLETED';
  if (o.status === 'rdp_cancelled' || o.status === 'cancelled') return '❌ CANCELLED';
  return o.status;
}

function detailButtons(o) {
  const rows = [];
  if (o.status === 'pending_admin') {
    rows.push([Markup.button.callback('▶ Start Processing', `r:proc:${o._id}`)]);
    rows.push([Markup.button.callback('❌ Cancel Order', `r:cancel:${o._id}`)]);
  } else if (o.status === 'rdp_processing') {
    rows.push([Markup.button.callback('✅ Kirim Detail RDP', `r:send:${o._id}`)]);
    rows.push([Markup.button.callback('❌ Cancel Order', `r:cancel:${o._id}`)]);
  }
  rows.push([Markup.button.callback('⬅️ Back', 'r:home')]);
  return Markup.inlineKeyboard(rows);
}

async function renderDetail(ctx, orderId) {
  const o = await Order.findById(orderId).lean();
  if (!o || o.category !== 'rdp') { await answerCb(ctx, 'Order tidak ditemukan', true); return; }
  const rd = o.rdpDelivery || {};
  const deliveryBlock = rd.deliveredAt
    ? `\n\n━━━━━━━━━━━━━━━━━━\n📤 *Delivery*\nIP       : \`${rd.ip}\`\nUsername : \`${rd.username}\`\nPassword : \`${rd.password}\`\nPort     : \`${rd.port}\`\nExpired  : ${rd.expired || '-'}\nSent at  : ${new Date(rd.deliveredAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`
    : '';
  const text =
`🖥 *DETAIL ORDER RDP*

━━━━━━━━━━━━━━━━━━
🧾 Invoice    : \`${o.invoice}\`
👤 Telegram   : \`${o.userId}\` (@${o.username || '-'})
📛 Nama       : ${o.name || '-'}
📦 Produk     : ${o.productName}
🎯 Paket      : ${o.tier} · slot ${o.slot}
💰 Harga      : ${o.total}
💳 Metode Bayar: ${o.paymentGateway || o.paymentMethod || '-'}
🕒 Status     : ${statusLabel(o)}${deliveryBlock}
━━━━━━━━━━━━━━━━━━`;
  await answerCb(ctx);
  return safeEditText(ctx, text, { parse_mode: 'Markdown', ...detailButtons(o) });
}

async function startProcessing(ctx, orderId) {
  const o = await Order.findById(orderId);
  if (!o || o.category !== 'rdp' || o.status !== 'pending_admin') {
    await answerCb(ctx, 'Order tidak dapat diproses', true); return;
  }
  o.status = 'rdp_processing';
  await o.save();
  // Notify user (edit anchor if available; important status transition — one msg OK)
  try {
    const msg =
`━━━━━━━━━━━━━━━━━━
🛠 *Pesanan Windows RDP Anda sedang diproses oleh Admin.*
Mohon tunggu beberapa saat.
━━━━━━━━━━━━━━━━━━

🧾 Invoice: \`${o.invoice}\`
🕒 Status : 🛠 PROCESSING`;
    if (o.progressChatId && o.progressMessageId) {
      await ctx.telegram.editMessageCaption(o.progressChatId, o.progressMessageId, undefined, msg, { parse_mode: 'Markdown' })
        .catch(() => ctx.telegram.editMessageText(o.progressChatId, o.progressMessageId, undefined, msg, { parse_mode: 'Markdown' }).catch(() => {}));
    } else {
      await ctx.telegram.sendMessage(o.userId, msg, { parse_mode: 'Markdown' });
    }
  } catch (_) {}
  await answerCb(ctx, '🛠 Status → PROCESSING');
  return renderDetail(ctx, orderId);
}

// ===== KIRIM DETAIL RDP — TRUE SINGLE-MESSAGE WIZARD =====
//
// All wizard state (fields + anchor message_id) lives in session.
// Every step:
//   1. deletes admin's typed message (Telegram Bot API allows this in private
//      chats for incoming messages),
//   2. edits the ORIGINAL wizard message via ctx.telegram.editMessageText(),
// so throughout the entire flow the chat holds EXACTLY ONE bubble.
//
// No ctx.reply / ctx.sendMessage / safeEditText anywhere in the wizard —
// direct telegram.editMessageText only.
const STEPS = ['ip', 'username', 'password', 'port', 'expired'];
const LABELS = {
  ip:       '📍 IP Address',
  username: '👤 Username',
  password: '🔑 Password',
  port:     '🔌 Port',
  expired:  '📅 Expired',
};
const NEXT_PROMPT = {
  ip:       'Silakan kirim *IP Address*.',
  username: 'Silakan kirim *Username*.',
  password: 'Silakan kirim *Password*.',
  port:     'Silakan kirim *Port RDP* (kirim `3389` untuk default).',
  expired:  'Silakan kirim *Tanggal Expired* (mis. `2025-12-31`), atau kirim `-` untuk skip.',
};

// Build the single wizard body based on session state.
function wizardBody(invoice, s, nextKey) {
  const rows = STEPS.map(k => {
    const filled = s.data[k] !== undefined;
    const mark = filled ? '✅' : '☐';
    const val = filled ? `\`${s.data[k]}\`` : '';
    return `${mark} ${LABELS[k]}${val ? ` : ${val}` : ''}`;
  }).join('\n');
  const prompt = nextKey ? `\n\n${NEXT_PROMPT[nextKey]}` : '';
  return `🖥 *KIRIM DETAIL RDP*\n\nInvoice: \`${invoice}\`\n\n${rows}${prompt}`;
}

// Update the anchor message. Throws if editing fails — caller decides recovery.
async function editWizard(ctx, s, text, extra = {}) {
  return ctx.telegram.editMessageText(
    s.__anchor.chatId, s.__anchor.messageId, undefined,
    text, { parse_mode: 'Markdown', ...extra });
}

async function startSendDetail(ctx, orderId) {
  const o = await Order.findById(orderId);
  if (!o || o.category !== 'rdp' || o.status !== 'rdp_processing') {
    await answerCb(ctx, 'Order harus di PROCESSING dulu', true); return;
  }
  // Anchor = the DETAIL screen the admin is currently viewing.
  const msg = ctx.callbackQuery && ctx.callbackQuery.message;
  if (!msg) { await answerCb(ctx, 'Tidak bisa memulai wizard', true); return; }
  const s = {
    action: 'rdp_send',
    orderId: String(o._id),
    invoice: o.invoice,
    step: 0,
    data: {},
    __anchor: { chatId: msg.chat.id, messageId: msg.message_id },
  };
  setSession(ctx.from.id, s);
  await answerCb(ctx);
  return editWizard(ctx, s, wizardBody(o.invoice, s, STEPS[0]));
}

async function handleSendText(ctx, text) {
  const s = getSession(ctx.from.id);
  if (!s || s.action !== 'rdp_send') return false;

  // === STEP 1: delete admin's typed message (single-bubble guarantee) ===
  // Telegram Bot API permits bots to delete incoming private-chat messages.
  // Use direct telegram.deleteMessage for reliability.
  try {
    await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id);
  } catch (err) {
    console.warn('[rdp-wizard] deleteMessage failed:', err && err.description);
  }

  // === STEP 2: record data ===
  const stepKey = STEPS[s.step];
  s.data[stepKey] = text.trim();
  s.step += 1;
  setSession(ctx.from.id, s);

  // === STEP 3: edit the wizard bubble (NEVER send a new one) ===
  try {
    if (s.step < STEPS.length) {
      // Next field prompt on same bubble.
      await editWizard(ctx, s, wizardBody(s.invoice, s, STEPS[s.step]));
    } else {
      // All fields collected → transform bubble into Preview.
      const d = s.data;
      const preview =
`🖥 *PREVIEW DETAIL RDP*

━━━━━━━━━━━━━━━━━━
🧾 Invoice   : \`${s.invoice}\`
📍 IP        : \`${d.ip}\`
👤 Username  : \`${d.username}\`
🔑 Password  : \`${d.password}\`
🔌 Port      : \`${d.port || '3389'}\`
📅 Expired   : ${d.expired && d.expired !== '-' ? d.expired : '-'}
━━━━━━━━━━━━━━━━━━

_Cek dengan teliti sebelum mengirim ke user._`;
      const kb = Markup.inlineKeyboard([
        [Markup.button.callback('✅ Kirim ke User', `r:confirm:${s.orderId}`)],
        [Markup.button.callback('⬅️ Kembali', `r:d:${s.orderId}`)],
      ]);
      await editWizard(ctx, s, preview, kb);
    }
  } catch (err) {
    // The anchor is gone (e.g., admin deleted it) — as a last resort ONLY,
    // send a single fresh bubble and re-anchor to it.
    console.error('[rdp-wizard] edit failed, re-anchoring:', err && err.description);
    const fresh = await ctx.telegram.sendMessage(ctx.chat.id,
      wizardBody(s.invoice, s, STEPS[s.step] || null),
      { parse_mode: 'Markdown' });
    s.__anchor = { chatId: fresh.chat.id, messageId: fresh.message_id };
    setSession(ctx.from.id, s);
  }
  return true;
}

async function confirmSend(ctx, orderId) {
  const s = getSession(ctx.from.id);
  if (!s || s.action !== 'rdp_send' || s.orderId !== orderId) {
    await answerCb(ctx, 'Session sudah expire — mulai ulang', true); return renderDetail(ctx, orderId);
  }
  const d = s.data;
  const o = await Order.findById(orderId);
  if (!o) { await answerCb(ctx, 'Order tidak ditemukan', true); return; }

  o.rdpDelivery = {
    ip: d.ip, username: d.username, password: d.password,
    port: d.port || '3389',
    expired: d.expired && d.expired !== '-' ? d.expired : '',
    deliveredAt: new Date(),
    adminId: String(ctx.from.id),
  };
  o.status = 'rdp_completed';
  o.credentials = `IP: ${d.ip} · User: ${d.username} · Pass: ${d.password} · Port: ${o.rdpDelivery.port}`;
  await o.save();

  try {
    require('../services/adminNotifyService').notifyActivity(
      { telegramId: o.userId, username: o.username, firstName: o.userName || '' },
      'RDP Berhasil Dikirim',
      { '🧾 Invoice:': `\`${o.invoice}\``, '📦 Paket:': o.productName, '📍 IP:': `\`${d.ip}\`` },
    );
  } catch (_) {}

  // Send to user — SATU pesan saja. Prefer edit anchor invoice; fallback ke
  // sendMessage. Never both.
  const userMsg =
`━━━━━━━━━━━━━━━━━━
🎉 *WINDOWS RDP SIAP DIGUNAKAN*

🧾 Invoice   : \`${o.invoice}\`
📍 IP        : \`${d.ip}\`
👤 Username  : \`${d.username}\`
🔑 Password  : \`${d.password}\`
🔌 Port      : \`${o.rdpDelivery.port}\`
📅 Expired   : ${o.rdpDelivery.expired || '-'}
━━━━━━━━━━━━━━━━━━

*Cara Login:*
1. Buka *Remote Desktop Connection* (Windows) / *Microsoft Remote Desktop* (Mac/iOS/Android).
2. Isi Computer: \`${d.ip}:${o.rdpDelivery.port}\`
3. Klik Connect → masukkan Username & Password.

_Jika ada kendala, silakan hubungi Admin._`;
  let deliveredViaEdit = false;
  try {
    if (o.progressChatId && o.progressMessageId) {
      try {
        await ctx.telegram.editMessageCaption(o.progressChatId, o.progressMessageId, undefined, userMsg, { parse_mode: 'Markdown' });
        deliveredViaEdit = true;
      } catch (_) {
        try {
          await ctx.telegram.editMessageText(o.progressChatId, o.progressMessageId, undefined, userMsg, { parse_mode: 'Markdown' });
          deliveredViaEdit = true;
        } catch (__) { /* fallthrough */ }
      }
    }
    if (!deliveredViaEdit) {
      await ctx.telegram.sendMessage(o.userId, userMsg, { parse_mode: 'Markdown' });
    }
  } catch (e) { console.error('rdp send user:', e.message); }

  // Receipt channel
  try {
    const { sendReceipt } = require('./adminHandler');
    await sendReceipt({ telegram: ctx.telegram }, o, 'success');
  } catch (_) {}

  // Finalize the WIZARD bubble in-place — transform Preview into completion
  // card with a Back button (single-bubble discipline).
  const completion =
`✅ *DETAIL RDP BERHASIL DIKIRIM*

━━━━━━━━━━━━━━━━━━
🧾 Invoice : \`${o.invoice}\`
👤 User    : @${o.username || '-'}
📍 IP      : \`${d.ip}\`
🔌 Port    : \`${o.rdpDelivery.port}\`
🕒 Sent    : ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}
━━━━━━━━━━━━━━━━━━`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('📄 Lihat Detail Order', `r:d:${orderId}`)],
    [Markup.button.callback('⬅️ RDP Management', 'r:home')],
  ]);
  try {
    await ctx.telegram.editMessageText(
      s.__anchor.chatId, s.__anchor.messageId, undefined,
      completion, { parse_mode: 'Markdown', ...kb });
  } catch (err) {
    console.error('[rdp-wizard] final edit failed:', err && err.description);
  }
  clearSession(ctx.from.id);
  await answerCb(ctx, '✅ Detail RDP terkirim');
}

async function startCancel(ctx, orderId) {
  const o = await Order.findById(orderId);
  if (!o || o.category !== 'rdp') { await answerCb(ctx, 'Order tidak ditemukan', true); return; }
  openInputSession(ctx, { action: 'rdp_cancel', orderId: String(o._id), returnTo: `r:d:${o._id}` });
  await answerCb(ctx);
  const cancel = Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', `r:d:${o._id}`)]]);
  return safeEditText(ctx,
    `❌ *BATALKAN ORDER RDP*\n\nInvoice: \`${o.invoice}\`\n\nKirim alasan pembatalan (akan dikirim ke user):`,
    { parse_mode: 'Markdown', ...cancel });
}

async function handleCancelText(ctx, text) {
  const s = getSession(ctx.from.id);
  if (!s || s.action !== 'rdp_cancel') return false;
  const reason = text.trim().slice(0, 500);
  const o = await Order.findById(s.orderId);
  if (!o) { clearSession(ctx.from.id); return true; }
  o.status = 'rdp_cancelled';
  o.rejectReason = reason;
  await o.save();
  clearSession(ctx.from.id);

  // Notify user
  const userMsg =
`━━━━━━━━━━━━━━━━━━
❌ *Pesanan Windows RDP Anda dibatalkan.*

🧾 Invoice: \`${o.invoice}\`
📦 Paket  : ${o.productName}

📝 Alasan:
${reason}

Silakan hubungi Admin untuk proses refund.
━━━━━━━━━━━━━━━━━━`;
  try {
    if (o.progressChatId && o.progressMessageId) {
      await ctx.telegram.editMessageCaption(o.progressChatId, o.progressMessageId, undefined, userMsg, { parse_mode: 'Markdown' })
        .catch(() => ctx.telegram.editMessageText(o.progressChatId, o.progressMessageId, undefined, userMsg, { parse_mode: 'Markdown' }).catch(() => {}));
    }
    await ctx.telegram.sendMessage(o.userId, userMsg, { parse_mode: 'Markdown' });
  } catch (_) {}

  await respondSaved(ctx, `✅ Order RDP dibatalkan.\nAlasan sudah dikirim ke user.`, `r:d:${s.orderId}`);
  return true;
}

module.exports = {
  renderHome, renderList, renderDetail,
  startProcessing, startSendDetail, handleSendText, confirmSend,
  startCancel, handleCancelText,
};
