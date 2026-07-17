const { Markup } = require('telegraf');

const mainMenu = () => Markup.inlineKeyboard([
  [Markup.button.callback('🛒 BUY VPS', 'menu:vps'), Markup.button.callback('🖥 BUY RDP', 'menu:rdp')],
  [Markup.button.callback('📋 PESANAN SAYA', 'menu:orders'), Markup.button.callback('📞 CS ADMIN', 'menu:contact')],
  [Markup.button.callback('🎁 VPS Reward', 'rw:menu'), Markup.button.callback('👥 Referral', 'rf:menu')],
  [Markup.button.callback('🏅 Achievement', 'ach:menu'), Markup.button.callback('🏆 Leaderboard', 'lb:menu')],
  [Markup.button.callback('👤 Profil Saya', 'pf:show'), Markup.button.callback('⚙️ Pengaturan', 'menu:settings')],
]);

const backHome = () => Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'menu:home')]]);

const tierMenu = (category) => Markup.inlineKeyboard([
  [Markup.button.callback('LOW', `tier:${category}:low`)],
  [Markup.button.callback('BASIC', `tier:${category}:basic`)],
  [Markup.button.callback('MEDIUM', `tier:${category}:medium`)],
  [Markup.button.callback('⬅️ Kembali', 'menu:home')],
]);

// Numbered buttons [1][2][3] for the 3 fixed slots — goes to spec→region flow now
const slotButtons = (category, tier) => Markup.inlineKeyboard([
  [
    Markup.button.callback('1', `spec:${category}:${tier}:1`),
    Markup.button.callback('2', `spec:${category}:${tier}:2`),
    Markup.button.callback('3', `spec:${category}:${tier}:3`),
  ],
  [Markup.button.callback('⬅️ Kembali', `menu:${category}`)],
]);

// Build numeric keyboard 1..N (max 5 per row) + KEMBALI
function numericKeyboard(count, prefix, backCb) {
  const rows = [];
  let row = [];
  for (let i = 1; i <= count; i++) {
    row.push(Markup.button.callback(String(i), `${prefix}:${i}`));
    if (row.length === 5) { rows.push(row); row = []; }
  }
  if (row.length) rows.push(row);
  rows.push([Markup.button.callback('⬅️ Kembali', backCb)]);
  return Markup.inlineKeyboard(rows);
}

const regionKeyboard = (count, backCb) => numericKeyboard(count, 'reg', backCb);
const osFamilyKeyboard = (count, backCb) => numericKeyboard(count, 'osf', backCb);
const osVersionKeyboard = (count, backCb) => numericKeyboard(count, 'osv', backCb);
const rdpVersionKeyboard = (count, backCb) => numericKeyboard(count, 'rdpv', backCb);

const rdpOsTypeKeyboard = (backCb) => Markup.inlineKeyboard([
  [Markup.button.callback('🖥 WINDOWS', 'rdpos:windows')],
  [Markup.button.callback('🐧 LINUX', 'rdpos:linux')],
  [Markup.button.callback('⬅️ Kembali', backCb)],
]);

const confirmKeyboard = (backCb) => Markup.inlineKeyboard([
  [Markup.button.callback('💳 BAYAR SEKARANG', 'confirm:order')],
  [Markup.button.callback('↩ Kembali', backCb)],
]);

const paymentActions = (orderId) => Markup.inlineKeyboard([
  [Markup.button.callback('🔄 Cek Status', `pay:${orderId}`)],
  [Markup.button.callback('🔀 Ganti Metode', `chgmethod:${orderId}`)],
  [Markup.button.callback('❌ Batalkan Pesanan', `cancel:${orderId}`)],
]);

const paymentMethodKeyboard = (methods, orderId) => {
  const rows = methods.map(m => [Markup.button.callback(`💳 ${m.label}`, `pm:${m.key}:${orderId}`)]);
  rows.push([Markup.button.callback('❌ Batalkan Pesanan', `cancel:${orderId}`)]);
  return Markup.inlineKeyboard(rows);
};

const joinGateKeyboard = (channels) => {
  const rows = [];
  for (const ch of channels) {
    const raw = String(ch || '').trim();
    if (!raw) continue;
    let url = null;
    let label = raw;
    if (raw.startsWith('@')) {
      url = `https://t.me/${raw.slice(1)}`;
      label = raw;
    } else if (/^https?:\/\//i.test(raw)) {
      url = raw;
      label = raw.replace(/^https?:\/\//i, '');
    } else if (raw.startsWith('t.me/')) {
      url = `https://${raw}`;
      label = raw;
    } else if (/^-?\d+$/.test(raw)) {
      // numeric chat id — no public URL, skip button
      continue;
    } else if (/^[A-Za-z][A-Za-z0-9_]{3,}$/.test(raw)) {
      url = `https://t.me/${raw}`;
      label = '@' + raw;
    }
    if (url) rows.push([Markup.button.url(`📢 Join ${label}`, url)]);
  }
  rows.push([Markup.button.callback('✅ Saya Sudah Join', 'joingate:check')]);
  return Markup.inlineKeyboard(rows);
};

const ordersList = (orders) => {
  const rows = orders.map(o => [Markup.button.callback(
    `${o.productName} • ${o.invoice.slice(0, 12)}`,
    `order:${o._id}`,
  )]);
  rows.push([Markup.button.callback('⬅️ Kembali', 'menu:home')]);
  return Markup.inlineKeyboard(rows);
};

const orderActions = (orderId) => Markup.inlineKeyboard([
  [Markup.button.callback('💳 Lanjutkan Pembayaran', `pay:${orderId}`)],
  [Markup.button.callback('❌ Batalkan Pesanan', `cancel:${orderId}`)],
  [Markup.button.callback('⬅️ Kembali', 'menu:orders')],
]);

const blockerMenu = () => Markup.inlineKeyboard([
  [Markup.button.callback('📋 Pesanan Saya', 'menu:orders')],
  [Markup.button.callback('⬅️ Kembali', 'menu:home')],
]);

module.exports = {
  mainMenu, backHome, tierMenu, slotButtons,
  regionKeyboard, osFamilyKeyboard, osVersionKeyboard,
  rdpOsTypeKeyboard, rdpVersionKeyboard, confirmKeyboard,
  paymentActions, paymentMethodKeyboard, joinGateKeyboard,
  ordersList, orderActions, blockerMenu,
};
