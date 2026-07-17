const { adminMenu, adminBack, cancelKb, bannerMenu, captionMenu, priceMenu, priceTierMenu, priceSlotMenu, specMenu, listMenu, osvFamilyMenu, replaceMenu,
  adminApproved, advancedMenu, paymentMethodsMenu, paymentMethodEdit, gateMenu,
} = require('../keyboards/admin');
const { safeEditText, answerCb, respondInSession, respondSaved } = require('../utils/safeEdit');
const { setSession, clearSession, getSession, openInputSession } = require('./sessionStore');
const { getPanel } = require('./adminPanelStore');
const orderService = require('../services/orderService');
const userService = require('../services/userService');
const { getSettings, updateSetting, BANNER_SCOPES, CAPTION_SCOPES, specOf, vpsOsFamilies,
  allPaymentMethods, paymentMethodByKey,
} = require('../services/settingService');
const { rupiah, statusLabel } = require('../utils/format');
const { config } = require('../config');
const Broadcast = require('../models/Broadcast');

// Edit the admin panel message with a new result + main menu (single-message UX).
// Also deletes the admin's input message so chat stays clean.
async function editPanel(ctx, text, kb = adminMenu()) {
  const panel = getPanel(ctx.from.id);
  // Best-effort: delete admin's text/photo input
  if (ctx.message) { try { await ctx.deleteMessage(ctx.message.message_id); } catch (_) {} }
  if (panel) {
    try {
      await ctx.telegram.editMessageText(panel.chatId, panel.messageId, undefined, text, {
        parse_mode: 'Markdown', ...kb,
      });
      return;
    } catch (_) { /* fallthrough to reply */ }
  }
  await ctx.reply(text, { parse_mode: 'Markdown', ...kb });
}

async function renderAdminHome(ctx) {
  const text =
`👑 *ADMIN PANEL*

Selamat datang, Admin.
Pilih menu di bawah untuk mengelola toko.`;
  return safeEditText(ctx, text, { parse_mode: 'Markdown', ...adminMenu() });
}

async function renderDashboard(ctx) {
  const [stats, users] = await Promise.all([orderService.dashboardStats(), userService.countUsers()]);
  const text =
`📊 *DASHBOARD REALTIME*

👥 Total User: *${users}*
🧾 Total Order: *${stats.totalOrders}*
📅 Order Hari Ini: *${stats.todayOrders}*

🕐 Pending Payment: *${stats.waitingPayment}*
🔎 Waiting Confirmation: *${stats.waitingReview}*
⚙️ Processing: *${stats.processing}*
✅ Success: *${stats.success}*

💰 Revenue: *${rupiah(stats.revenue)}*`;
  return safeEditText(ctx, text, { parse_mode: 'Markdown', ...adminBack() });
}

async function handleAdminText(ctx, bot) {
  const session = getSession(ctx.from.id);
  if (!session || !session.action || !session.action.startsWith('admin_')) {
    if (session && (session.action === 'promo_add' || session.action === 'promo_edit')) {
      return require('./promoAdminHandler').handleText(ctx);
    }
    return false;
  }
  const text = ctx.message.text;

  if (session.action === 'admin_edit_banner') {
    await updateSetting({ [session.field]: text });
    clearSession(ctx.from.id);
    return respondSaved(ctx, `✅ Banner *${session.label}* berhasil diubah.\n\nPilih menu berikutnya:`, session.returnTo || 'a:home');
  }
  if (session.action === 'admin_edit_caption') {
    const val = text.trim() === '-' ? '' : text;
    await updateSetting({ [session.field]: val });
    clearSession(ctx.from.id);
    return respondSaved(ctx, `✅ *${session.label}* berhasil diubah.\n\nPilih menu berikutnya:`, session.returnTo || 'a:home');
  }
  if (session.action === 'admin_edit_price') {
    // Validasi Base Price:
    // • Hanya angka non-negatif (0, 1, 2, ..., n) yang diperbolehkan.
    // • 0 SAH → produk otomatis Nonaktif (dipakai oleh sistem status produk).
    // • Tolak: negatif, huruf, karakter khusus, kosong, null.
    const raw = String(text || '').trim();
    if (!/^\d+$/.test(raw)) {
      return respondInSession(ctx, '⚠️ Harga tidak valid. Kirim angka bulat ≥ 0 (contoh: 0, 5000, 20000):');
    }
    const price = parseInt(raw, 10);
    if (!Number.isFinite(price) || price < 0) {
      return respondInSession(ctx, '⚠️ Harga tidak valid. Kirim angka bulat ≥ 0:');
    }
    await updateSetting({ [session.field]: price });
    clearSession(ctx.from.id);
    const statusNote = price === 0
      ? '\n\n_Produk akan otomatis Nonaktif (Base Price = 0)._'
      : '';
    return respondSaved(ctx, `✅ Harga *${session.label}* berhasil diubah → ${rupiah(price)}.${statusNote}\n\nPilih menu berikutnya:`, session.returnTo || 'a:home');
  }
  if (session.action === 'admin_edit_spec') {
    await updateSetting({ [session.field]: text });
    clearSession(ctx.from.id);
    return respondSaved(ctx, `✅ Spesifikasi *${session.label}* berhasil diubah.\n\nPilih menu berikutnya:`, session.returnTo || 'a:home');
  }
  if (session.action === 'admin_broadcast') {
    clearSession(ctx.from.id);
    return doBroadcast(ctx, bot, text);
  }
  if (session.action === 'admin_edit_list') {
    // text is newline-separated list
    const items = text.split('\n').map(s => s.trim()).filter(Boolean);
    if (!items.length) return respondInSession(ctx, '⚠️ List tidak boleh kosong. Kirim ulang:');
    await updateSetting({ [session.field]: items });
    clearSession(ctx.from.id);
    return respondSaved(ctx, `✅ List *${session.label}* diperbarui (${items.length} item).\n\nPilih menu berikutnya:`, session.returnTo || 'a:home');
  }
  if (session.action === 'admin_edit_osversions') {
    const items = text.split('\n').map(s => s.trim()).filter(Boolean);
    if (!items.length) return respondInSession(ctx, '⚠️ List tidak boleh kosong. Kirim ulang:');
    const s = await getSettings();
    const map = { ...(s.vpsOsVersions || {}) };
    map[session.family] = items;
    await updateSetting({ vpsOsVersions: map });
    clearSession(ctx.from.id);
    return respondSaved(ctx, `✅ Versi OS *${session.family}* diperbarui (${items.length} item).\n\nPilih menu berikutnya:`, session.returnTo || 'a:home');
  }
  if (session.action === 'admin_edit_replace') {
    // Kosongkan bila admin mengirim '-' → fallback ke global tierReplace.
    const val = String(text || '').trim() === '-' ? '' : text;
    await updateSetting({ [session.field]: val });
    clearSession(ctx.from.id);
    const shown = val || '(kosong → pakai fallback global)';
    return respondSaved(ctx, `✅ Replace *${session.label}* berhasil diubah → \`${shown}\`.\n\nPilih menu berikutnya:`, session.returnTo || 'a:rep:menu');
  }
  if (session.action === 'admin_edit_text') {
    await updateSetting({ [session.field]: text });
    clearSession(ctx.from.id);
    return respondSaved(ctx, `✅ *${session.label}* berhasil diubah.\n\nPilih menu berikutnya:`, session.returnTo || 'a:home');
  }
  if (session.action === 'admin_autocancel') {
    const n = parseInt(text.replace(/\D/g, ''), 10);
    if (!Number.isFinite(n) || n < 0) return respondInSession(ctx, '⚠️ Angka tidak valid. Kirim ulang (menit):');
    await updateSetting({ autoCancelMinutes: n });
    clearSession(ctx.from.id);
    return respondSaved(ctx, `✅ Auto-cancel diatur ke *${n} menit*.\n\nPilih menu berikutnya:`, session.returnTo || 'a:home');
  }
  if (session.action === 'admin_receipt_channel') {
    const v = text.trim();
    await updateSetting({ receiptChannel: v });
    clearSession(ctx.from.id);
    return respondSaved(ctx, `✅ Channel resi diatur ke \`${v}\`.\n\nPastikan bot sudah jadi admin di channel tersebut.`, session.returnTo || 'a:adv:menu');
  }
  if (session.action === 'admin_catalog_channel') {
    const v = text.trim();
    await updateSetting({ catalogChannelId: v, catalogMessageId: '' });
    clearSession(ctx.from.id);
    try {
      const r = await require('../services/catalogService').refreshChannel();
      if (!r.ok) return respondSaved(ctx, `⚠️ Channel disimpan \`${v}\` tapi gagal post: ${r.error}\n\nPastikan bot admin di channel.`, 'a:catalog:menu');
      return respondSaved(ctx, `✅ Catalog channel \`${v}\` — post pertama berhasil dibuat.`, 'a:catalog:menu');
    } catch (e) {
      return respondSaved(ctx, `⚠️ Channel disimpan tapi refresh gagal: ${e.message}`, 'a:catalog:menu');
    }
  }
  // ─── Post Stok — set dedicated channel ────────────────────────────────
  if (session.action === 'admin_stok_channel') {
    const v = text.trim();
    await updateSetting({ stokChannelId: v });
    clearSession(ctx.from.id);
    return respondSaved(ctx,
      `✅ Channel Post Stok disimpan: \`${v}\`\n\nPastikan bot sudah menjadi *admin* di channel tersebut agar bisa memposting & menghapus.`,
      'a:stok:menu');
  }
  // ─── Database Manager: URI input (Test / Migrate) ─────────────────────
  if (session.action === 'admin_db_test_uri' || session.action === 'admin_db_migrate_uri') {
    const uri = text.trim();
    clearSession(ctx.from.id);
    const dbAction = session.action === 'admin_db_test_uri' ? 'test' : 'migrate';
    const admDb = require('../handlers/dbAdminHandler');
    return admDb.handleUriInput(ctx, uri, dbAction);
  }
  if (session.action === 'admin_gate_list') {
    const items = text.split('\n').map(s => s.trim()).filter(Boolean);
    await updateSetting({ requiredChannels: items });
    clearSession(ctx.from.id);
    return respondSaved(ctx, `✅ Daftar channel diperbarui (${items.length} channel).\n\nPilih menu berikutnya:`, session.returnTo || 'a:home');
  }
  if (session.action === 'admin_send_credentials') {
    const o = await orderService.getById(session.orderId);
    if (!o) { clearSession(ctx.from.id); return respondSaved(ctx, '❌ Order tidak ditemukan.', session.returnTo || 'a:home'); }
    await orderService.setStatus(o._id, o.status, { credentials: text });
    clearSession(ctx.from.id);
    try {
      await bot.telegram.sendMessage(o.userId,
`🔐 *KREDENSIAL PESANAN ANDA*

🧾 Invoice: \`${o.invoice}\`
🛍 Produk: ${o.productName}

\`\`\`
${text}
\`\`\`

_Simpan baik-baik. Jika ada kendala silakan hubungi admin._`,
        { parse_mode: 'Markdown' });
    } catch (e) { console.error('Send credentials failed:', e.message); }
    return editPanel(ctx, `✅ Kredensial terkirim ke user untuk invoice \`${o.invoice}\`.\n\nPilih menu berikutnya:`);
  }
  return false;
}

// ===== LIST EDITOR (regions / os families / versions) =====
async function showListMenu(ctx) {
  await answerCb(ctx);
  return safeEditText(ctx,
`🌍 *REGION / OS / VERSI*

Pilih daftar yang ingin diubah:
- Region VPS / RDP
- OS Family (VPS)
- Versi OS VPS per family
- Versi Windows / Linux RDP
- Teks garansi & replace`,
    { parse_mode: 'Markdown', ...listMenu() });
}

const LIST_LABELS = {
  vpsRegions: 'Region VPS',
  rdpRegions: 'Region RDP',
  vpsOsFamilies: 'OS Family VPS',
  rdpWindowsVersions: 'Versi Windows RDP',
  rdpLinuxVersions: 'Versi Linux RDP',
};

async function startEditList(ctx, field) {
  const label = LIST_LABELS[field];
  if (!label) { await answerCb(ctx, 'Tidak valid', true); return; }
  const s = await getSettings();
  const current = Array.isArray(s[field]) ? s[field] : [];
  openInputSession(ctx, { action: 'admin_edit_list', field, label, returnTo: 'a:list:menu' });
  await answerCb(ctx);
  return safeEditText(ctx,
`📝 *EDIT ${label.toUpperCase()}*

List saat ini:
\`\`\`
${current.join('\n') || '(kosong)'}
\`\`\`

Kirim *list baru* (satu item per baris). Item akan menggantikan list yang ada.`,
    { parse_mode: 'Markdown', ...cancelKb('a:list:menu') });
}

async function showOsvFamilyMenu(ctx) {
  const s = await getSettings();
  const fams = vpsOsFamilies(s);
  if (!fams.length) { await answerCb(ctx, 'OS Family kosong, edit dulu', true); return; }
  await answerCb(ctx);
  return safeEditText(ctx, '📦 *VERSI OS VPS*\n\nPilih OS family untuk mengubah daftar versinya:',
    { parse_mode: 'Markdown', ...osvFamilyMenu(fams) });
}

async function startEditOsVersions(ctx, famIdx) {
  const s = await getSettings();
  const fams = vpsOsFamilies(s);
  const family = fams[famIdx];
  if (!family) { await answerCb(ctx, 'Family tidak valid', true); return; }
  const current = (s.vpsOsVersions && s.vpsOsVersions[family]) || [];
  openInputSession(ctx, { action: 'admin_edit_osversions', family, returnTo: 'a:osv:menu' });
  await answerCb(ctx);
  return safeEditText(ctx,
`📝 *EDIT VERSI ${family.toUpperCase()}*

List saat ini:
\`\`\`
${current.join('\n') || '(kosong)'}
\`\`\`

Kirim *list versi baru* (satu item per baris).`,
    { parse_mode: 'Markdown', ...cancelKb('a:osv:menu') });
}

const TEXT_LABELS = {
  tierWarrantyLow: 'Garansi LOW',
  tierWarrantyBasic: 'Garansi BASIC',
  tierWarrantyMedium: 'Garansi MEDIUM',
};

const REPLACE_LABELS = {
  'vps:low':    { key: 'vpsLowReplace',    label: '☁ VPS LOW' },
  'vps:basic':  { key: 'vpsBasicReplace',  label: '☁ VPS BASIC' },
  'vps:medium': { key: 'vpsMediumReplace', label: '☁ VPS MEDIUM' },
  'rdp:low':    { key: 'rdpLowReplace',    label: '🖥 RDP LOW' },
  'rdp:basic':  { key: 'rdpBasicReplace',  label: '🖥 RDP BASIC' },
  'rdp:medium': { key: 'rdpMediumReplace', label: '🖥 RDP MEDIUM' },
};

// Menampilkan daftar paket untuk pemilihan Replace Text (per paket).
async function showReplaceMenu(ctx) {
  const s = await getSettings();
  const { replaceOf } = require('../services/settingService');
  const rows = [];
  for (const [k, v] of Object.entries(REPLACE_LABELS)) {
    const [cat, tier] = k.split(':');
    const val = replaceOf(s, cat, tier) || '(kosong)';
    rows.push(`• ${v.label} → \`${val}\``);
  }
  await answerCb(ctx);
  return safeEditText(ctx,
`🔁 *EDIT REPLACE TEXT (PER PAKET)*

Pilih paket untuk mengubah teks Replace-nya. Nilai kosong akan otomatis memakai teks fallback global (\`tierReplace\`).

${rows.join('\n')}`,
    { parse_mode: 'Markdown', ...replaceMenu() });
}

// Mulai sesi input teks Replace untuk paket (category, tier).
async function startEditReplace(ctx, category, tier) {
  const cfg = REPLACE_LABELS[`${category}:${tier}`];
  if (!cfg) { await answerCb(ctx, 'Paket tidak valid', true); return; }
  const s = await getSettings();
  const { replaceOf } = require('../services/settingService');
  const current = replaceOf(s, category, tier);
  openInputSession(ctx, {
    action: 'admin_edit_replace',
    field: cfg.key,
    label: cfg.label,
    returnTo: 'a:rep:menu',
  });
  await answerCb(ctx);
  return safeEditText(ctx,
`📝 *EDIT REPLACE — ${cfg.label}*

Nilai saat ini:
\`\`\`
${current || '(kosong → pakai fallback global)'}
\`\`\`

Kirim teks Replace baru untuk *${cfg.label}*.
Contoh: \`1x\`, \`2x\`, atau kalimat bebas seperti \`1x Replace selama masa garansi\`.
Ketik \`-\` untuk mengosongkan (agar memakai fallback global).`,
    { parse_mode: 'Markdown', ...cancelKb('a:rep:menu') });
}

async function startEditText(ctx, field) {
  const label = TEXT_LABELS[field];
  if (!label) { await answerCb(ctx, 'Tidak valid', true); return; }
  const s = await getSettings();
  const current = s[field] || '';
  openInputSession(ctx, { action: 'admin_edit_text', field, label, returnTo: 'a:list:menu' });
  await answerCb(ctx);
  return safeEditText(ctx,
`📝 *EDIT ${label.toUpperCase()}*

Nilai saat ini:
\`\`\`
${current}
\`\`\`

Kirim teks baru:`,
    { parse_mode: 'Markdown', ...cancelKb('a:list:menu') });
}

// ===== Banner =====
async function showBannerMenu(ctx) {
  await answerCb(ctx);
  return safeEditText(ctx, '🖼 *UBAH BANNER*\n\nPilih banner yang ingin diubah:', {
    parse_mode: 'Markdown', ...bannerMenu(),
  });
}
async function startEditBanner(ctx, scopeKey) {
  const scope = BANNER_SCOPES[scopeKey];
  if (!scope) { await answerCb(ctx, 'Scope tidak valid', true); return; }
  openInputSession(ctx, { action: 'admin_edit_banner', field: scope.banner, label: scope.label, returnTo: 'a:banner:menu' });
  await answerCb(ctx);
  return safeEditText(ctx,
    `🖼 *UBAH BANNER ${scope.label.toUpperCase()}*\n\nKirim *foto* baru atau *URL gambar*:`,
    { parse_mode: 'Markdown', ...cancelKb('a:banner:menu') });
}

// ===== Caption =====
async function showCaptionMenu(ctx) {
  await answerCb(ctx);
  return safeEditText(ctx, '📝 *UBAH CAPTION*\n\nPilih caption yang ingin diubah:', {
    parse_mode: 'Markdown', ...captionMenu(),
  });
}
async function startEditCaption(ctx, scopeKey) {
  const scope = CAPTION_SCOPES[scopeKey];
  if (!scope) { await answerCb(ctx, 'Scope tidak valid', true); return; }
  const s = await getSettings();
  const currentVal = s[scope.caption] || '';
  openInputSession(ctx, { action: 'admin_edit_caption', field: scope.caption, label: scope.label, returnTo: 'a:caption:menu' });
  await answerCb(ctx);
  return safeEditText(ctx,
`📝 *EDIT CAPTION ${scope.label.toUpperCase()}*

Caption saat ini:
\`\`\`
${currentVal.slice(0, 800)}
\`\`\`

Kirim *teks caption baru* (Markdown didukung):`,
    { parse_mode: 'Markdown', ...cancelKb('a:caption:menu') });
}

// ===== Price & Spec =====
// Tampilan top-level: pilih kategori (VPS / RDP) atau ubah spesifikasi.
async function showPriceMenu(ctx) {
  const s = await getSettings();
  const lines = [];
  for (const cat of ['vps', 'rdp']) {
    for (const tier of ['low', 'basic', 'medium']) {
      const tierLabel = tier.toUpperCase();
      const slotsTxt = [1, 2, 3].map(i => {
        const { price } = specOf(s, cat, tier, i);
        return `  • Spec ${i}: ${price > 0 ? rupiah(price) : '_belum diatur_'}`;
      }).join('\n');
      lines.push(`*${cat.toUpperCase()} ${tierLabel}*\n${slotsTxt}`);
    }
  }
  await answerCb(ctx);
  return safeEditText(ctx,
`💰 *KELOLA HARGA & SPESIFIKASI*

${lines.join('\n\n')}

_Setiap kombinasi Paket + Spesifikasi memiliki harga sendiri._
_Pilih menu di bawah:_`,
    { parse_mode: 'Markdown', ...priceMenu() });
}

// Pilih tier untuk satu kategori
async function showPriceTierMenu(ctx, category) {
  const s = await getSettings();
  const lines = ['low', 'basic', 'medium'].map(tier => {
    const slots = [1, 2, 3].map(i => {
      const { price } = specOf(s, category, tier, i);
      return `Spec ${i}: ${price > 0 ? rupiah(price) : '_-_'}`;
    }).join(' | ');
    return `*${tier.toUpperCase()}* — ${slots}`;
  });
  await answerCb(ctx);
  return safeEditText(ctx,
`💰 *KELOLA HARGA ${category.toUpperCase()}*

${lines.join('\n')}

_Pilih paket yang ingin diubah:_`,
    { parse_mode: 'Markdown', ...priceTierMenu(category) });
}

// Pilih slot spec untuk (category, tier)
async function showPriceSlotMenu(ctx, category, tier) {
  const s = await getSettings();
  const slots = [1, 2, 3].map(i => {
    const { spec, price } = specOf(s, category, tier, i);
    return `*Spec ${i}* — ${price > 0 ? rupiah(price) : '_belum diatur_'}\n${spec.replace(/\n/g, ' | ')}`;
  }).join('\n\n');
  await answerCb(ctx);
  return safeEditText(ctx,
`💰 *${category.toUpperCase()} ${tier.toUpperCase()}*

${slots}

_Pilih Spec yang ingin diubah harganya:_`,
    { parse_mode: 'Markdown', ...priceSlotMenu(category, tier) });
}

// Prompt input harga untuk (category, tier, slot)
function capTier(t) { return t.charAt(0).toUpperCase() + t.slice(1); }
async function startEditPrice(ctx, category, tier, slot) {
  const label = `${category.toUpperCase()} ${tier.toUpperCase()} Spec ${slot}`;
  const field = `${category}${capTier(tier)}Price${slot}`;
  openInputSession(ctx, { action: 'admin_edit_price', field, label, returnTo: `a:price:c:${category}` });
  await answerCb(ctx);
  return safeEditText(ctx,
`💰 Kirim *harga baru* untuk *${label}* (angka saja, tanpa titik atau koma):`,
    { parse_mode: 'Markdown', ...cancelKb(`a:price:c:${category}`) });
}

// ===== Spec text (shared antar tier) =====
async function showSpecMenu(ctx) {
  const s = await getSettings();
  const lines = [];
  for (const cat of ['vps', 'rdp']) {
    for (const i of [1, 2, 3]) {
      const spec = s[`${cat}Spec${i}`] || '-';
      lines.push(`*${cat.toUpperCase()} Spec ${i}*\n${spec.replace(/\n/g, ' | ')}`);
    }
  }
  await answerCb(ctx);
  return safeEditText(ctx,
`📝 *UBAH SPESIFIKASI*

${lines.join('\n\n')}

_Spesifikasi berlaku untuk semua paket (LOW/BASIC/MEDIUM)._
_Pilih spec yang ingin diubah:_`,
    { parse_mode: 'Markdown', ...specMenu() });
}

async function startEditSpec(ctx, category, slot) {
  const label = `${category.toUpperCase()} Spec ${slot}`;
  openInputSession(ctx, { action: 'admin_edit_spec', field: `${category}Spec${slot}`, label, returnTo: 'a:spec:menu' });
  await answerCb(ctx);
  return safeEditText(ctx,
`📝 Kirim *spesifikasi baru* untuk *${label}* (multi-baris diperbolehkan).

Contoh:
\`\`\`
2GB RAM
2 CPU
60GB SSD
3TB BW
\`\`\``,
    { parse_mode: 'Markdown', ...cancelKb('a:spec:menu') });
}

async function startBroadcast(ctx) {
  openInputSession(ctx, { action: 'admin_broadcast', returnTo: 'a:home' });
  await answerCb(ctx);
  return safeEditText(ctx, '📢 Kirim *pesan broadcast* yang akan dikirim ke seluruh user:', { parse_mode: 'Markdown', ...cancelKb('a:home') });
}

async function doBroadcast(ctx, bot, message) {
  const { sendBroadcast } = require('../services/broadcastService');
  const { sent, failed } = await sendBroadcast({ bot, message, adminId: ctx.from.id });
  try { require('../services/adminNotifyService').notifyRaw(`📢 *Broadcast Selesai*\n\n📨 Terkirim: *${sent}*\n❌ Gagal: *${failed}*`); } catch (_) {}
  return respondSaved(ctx, `✅ Broadcast selesai.\n\n📨 Terkirim: ${sent}\n❌ Gagal: ${failed}\n\nPilih menu berikutnya:`, 'a:home');
}

async function sendReceipt(bot, order, kind) {
  try {
    const s = await getSettings();
    const target = (s.receiptChannel || '').trim();
    if (!target) return;
    const channel = /^-?\d+$/.test(target) ? Number(target) : target;
    const lines = (order.description || '').split('\n').map(l => l.trim()).filter(Boolean);
    const ram = lines.find(l => /ram/i.test(l)) || '-';
    const cpu = lines.find(l => /cpu|core/i.test(l)) || '-';
    const ssd = lines.find(l => /ssd|disk/i.test(l)) || '-';
    const bw  = lines.find(l => /bw|bandwidth|tb/i.test(l)) || '-';
    const date = new Date(order.updatedAt || order.createdAt || Date.now()).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false });
    const header = kind === 'success'
      ? '🎉 *PESANAN SELESAI*'
      : '🧾 *RESI TRANSAKSI BARU*';
    const statusText = kind === 'success' ? '✅ Selesai / Success' : '✅ Pembayaran Diterima';
    const osLabel = order.category === 'vps'
      ? (order.osFamily || '-')
      : (order.osType === 'windows' ? 'Windows' : order.osType === 'linux' ? 'Linux' : (order.osFamily || '-'));
    const text =
`${header}

🧾 Invoice : \`${order.invoice}\`
👤 Username : @${order.username || '-'}
🆔 User ID : \`${order.userId}\`

📦 Produk : ${order.productName}
📛 Paket : ${(order.category || '').toUpperCase()} ${(order.tier || '').toUpperCase()}

🖥 RAM : ${ram}
⚙ CPU : ${cpu}
💾 SSD : ${ssd}
🌐 Bandwidth : ${bw}

📍 Region : ${order.region || '-'}
💿 OS : ${osLabel}
📀 Versi OS : ${order.osVersion || '-'}

💰 Harga : ${rupiah(order.total)}
🕒 Tanggal : ${date}
📌 Status : ${statusText}`;
    await bot.telegram.sendMessage(channel, text, { parse_mode: 'Markdown' });
  } catch (e) { console.error('Send receipt failed:', e.message); }
}

// ===== Mark Success / Send Credentials =====
async function handleMarkSuccess(ctx, orderId, bot) {
  const o = await orderService.getById(orderId);
  if (!o) { await answerCb(ctx, 'Order tidak ditemukan', true); return; }
  if (!['processing', 'waiting_review'].includes(o.status)) {
    await answerCb(ctx, `Order sudah ${statusLabel(o.status)}`, true); return;
  }
  await orderService.setStatus(o._id, 'success');
  await answerCb(ctx, '✅ Success');
  try {
    await ctx.editMessageCaption(
      `🎉 *SUCCESS*\n\n🧾 ${o.invoice}\n🛍 ${o.productName}\n💵 ${rupiah(o.total)}`,
      { parse_mode: 'Markdown' });
  } catch (_) {}
  try {
    await bot.telegram.sendMessage(o.userId,
`🎉 *Pesanan Anda telah selesai!*

🧾 Invoice: \`${o.invoice}\`
🛍 Produk: ${o.productName}

Terima kasih telah berbelanja. Jika ada kendala silakan hubungi admin.`,
      { parse_mode: 'Markdown' });
  } catch (e) { console.error('Notify success failed:', e.message); }
  await sendReceipt(bot, await orderService.getById(o._id), 'success');
}

async function startSendCredentials(ctx, orderId) {
  const o = await orderService.getById(orderId);
  if (!o) { await answerCb(ctx, 'Order tidak ditemukan', true); return; }
  openInputSession(ctx, { action: 'admin_send_credentials', orderId: String(o._id), returnTo: 'a:home' });
  await answerCb(ctx);
  return safeEditText(ctx,
`📝 *KIRIM KREDENSIAL*

🧾 Invoice: \`${o.invoice}\`
🛍 Produk: ${o.productName}

Kirim teks kredensial (IP, username, password, port, dst). Format bebas, akan diteruskan ke user.`,
    { parse_mode: 'Markdown', ...cancelKb('a:home') });
}

// ===== Advanced settings =====
async function showAdvancedMenu(ctx) {
  await answerCb(ctx);
  return safeEditText(ctx,
`⚙ *PENGATURAN LANJUTAN*

Pilih item yang ingin diubah:`,
    { parse_mode: 'Markdown', ...advancedMenu() });
}

async function startEditAutoCancel(ctx) {
  const s = await getSettings();
  openInputSession(ctx, { action: 'admin_autocancel', returnTo: 'a:adv:menu' });
  await answerCb(ctx);
  return safeEditText(ctx,
`⏰ *AUTO-CANCEL ORDER*

Nilai saat ini: *${s.autoCancelMinutes} menit*

Order dengan status \`waiting_payment\` lebih lama dari nilai ini akan otomatis dibatalkan.
_Kirim angka baru (menit). 0 = nonaktif._`,
    { parse_mode: 'Markdown', ...cancelKb('a:adv:menu') });
}

async function startEditReceiptChannel(ctx) {
  const s = await getSettings();
  openInputSession(ctx, { action: 'admin_receipt_channel', returnTo: 'a:adv:menu' });
  await answerCb(ctx);
  const { Markup } = require('telegraf');
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('🗑 Kosongkan Channel', 'a:receipt:clear')],
    [Markup.button.callback('❌ Batal', 'a:adv:menu')],
  ]);
  return safeEditText(ctx,
`🧾 *CHANNEL RESI*

Nilai saat ini: \`${s.receiptChannel || '(belum diset)'}\`

Bot akan otomatis mengirim resi transaksi ke channel ini saat admin *APPROVE* pembayaran dan saat order *SUCCESS*.

Format yang didukung:
• \`@usernamechannel\` (channel publik)
• \`-100xxxxxxxxxx\` (channel/group privat — bot harus jadi admin)

Kirim nilai baru, atau tekan tombol 🗑 di bawah untuk mengosongkan.`,
    { parse_mode: 'Markdown', ...kb });
}

// ===== CATALOG CHANNEL =====
async function showCatalogMenu(ctx) {
  const s = await getSettings();
  const { catalogMenu } = require('../keyboards/admin');
  await answerCb(ctx);
  const catalog = require('../services/catalogService');
  const stock = await catalog.getStock();
  return safeEditText(ctx,
`📣 *CATALOG CHANNEL*

Channel ID: \`${s.catalogChannelId || '(belum diset)'}\`
Message ID: \`${s.catalogMessageId || '(belum ada post)'}\`

Stock saat ini: *${stock.ready}* token READY
${stock.statusLine}
${stock.etaLine}

Katalog otomatis di-edit saat:
• Harga / Spec / Paket berubah
• Token READY berubah
• Queue provision berubah

Pastikan bot sudah menjadi *admin* di channel target.`,
    { parse_mode: 'Markdown', ...catalogMenu(s) });
}

async function startEditCatalogChannel(ctx) {
  openInputSession(ctx, { action: 'admin_catalog_channel', returnTo: 'a:catalog:menu' });
  await answerCb(ctx);
  const { Markup } = require('telegraf');
  const kb = Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', 'a:catalog:menu')]]);
  return safeEditText(ctx,
`📣 *SET CATALOG CHANNEL*

Kirim Channel ID:
• \`@usernamechannel\` (publik)
• \`-100xxxxxxxxxx\` (privat — bot harus admin)

Bot akan mempost 1 kali, lalu terus meng-edit post yang sama.`,
    { parse_mode: 'Markdown', ...kb });
}

async function refreshCatalogNow(ctx) {
  const catalog = require('../services/catalogService');
  // catalogService has attachBot() called on startup; pass current ctx.telegram as fallback bot.
  const botLike = { telegram: ctx.telegram };
  const r = await catalog.refreshChannel(botLike);
  await answerCb(ctx, r.ok ? '✅ Katalog diperbarui' : `❌ ${r.error}`, !r.ok);
  return showCatalogMenu(ctx);
}

async function resetCatalogMessageId(ctx) {
  await updateSetting({ catalogMessageId: '' });
  await answerCb(ctx, '♻️ Message ID direset — post baru akan dibuat pada refresh berikutnya');
  return showCatalogMenu(ctx);
}

// ═══ POST STOK PANEL — admin menu for dedicated stock announcements ═══
async function showPostStokMenu(ctx) {
  const s = await getSettings();
  const { postStokMenu } = require('../keyboards/admin');
  const catalog = require('../services/catalogService');
  await answerCb(ctx);
  const stock = await catalog.getBuyMenuStock();
  const chan = s.stokChannelId || s.catalogChannelId || '(belum diset)';
  const src  = s.stokChannelId ? '(dedicated)' : s.catalogChannelId ? '(pakai catalog channel)' : '';
  return safeEditText(ctx,
`📢 *POST STOK*

Channel: \`${chan}\` ${src}
Postingan terakhir VPS: \`${s.stokLastMsgIdVps || '(tidak ada)'}\`
Postingan terakhir RDP: \`${s.stokLastMsgIdRdp || '(tidak ada)'}\`

Stock realtime: *${stock.stock}* unit
_(SUM quotaAvailable seluruh Provider READY & ENABLED — VPS & RDP berbagi pool yang sama)_

Pilih aksi di bawah:`,
    { parse_mode: 'Markdown', ...postStokMenu() });
}

async function startEditStokChannel(ctx) {
  openInputSession(ctx, { action: 'admin_stok_channel', returnTo: 'a:stok:menu' });
  await answerCb(ctx);
  const { Markup } = require('telegraf');
  const kb = Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', 'a:stok:menu')]]);
  return safeEditText(ctx,
`📝 *ATUR CHANNEL POST STOK*

Kirim Channel ID:
• \`@usernamechannel\` (publik)
• \`-100xxxxxxxxxx\` (privat — bot wajib admin)

Jika dibiarkan kosong, Post Stok akan otomatis pakai channel catalog utama.`,
    { parse_mode: 'Markdown', ...kb });
}

// Multi-payment menu
async function showPaymentMethodsMenu(ctx) {
  const s = await getSettings();
  const methods = allPaymentMethods(s);
  await answerCb(ctx);
  return safeEditText(ctx,
`💳 *METODE PEMBAYARAN*

Aktifkan/nonaktifkan dan atur gambar & caption tiap metode.
${methods.map(m => `• ${m.enabled ? '✅' : '❌'} ${m.label}`).join('\n')}`,
    { parse_mode: 'Markdown', ...paymentMethodsMenu(methods) });
}

async function showPaymentMethodEdit(ctx, key) {
  const s = await getSettings();
  const m = paymentMethodByKey(s, key);
  if (!m) { await answerCb(ctx, 'Tidak valid', true); return; }
  await answerCb(ctx);
  return safeEditText(ctx,
`💳 *${m.label}*

Status: ${m.enabled ? '🟢 Aktif' : '🔴 Nonaktif'}

Caption saat ini:
\`\`\`
${(m.caption || '').slice(0, 600)}
\`\`\``,
    { parse_mode: 'Markdown', ...paymentMethodEdit(m) });
}

async function togglePaymentMethod(ctx, key) {
  const s = await getSettings();
  const m = paymentMethodByKey(s, key);
  if (!m) { await answerCb(ctx, 'Tidak valid', true); return; }
  const nextVal = m.enabled ? 'off' : 'on';
  await updateSetting({ [m.togField]: nextVal });
  await answerCb(ctx, m.enabled ? '🔴 Dinonaktifkan' : '🟢 Diaktifkan');
  return showPaymentMethodEdit(ctx, key);
}

async function startEditPmImage(ctx, key) {
  const s = await getSettings();
  const m = paymentMethodByKey(s, key);
  if (!m) { await answerCb(ctx, 'Tidak valid', true); return; }
  // Reuse admin_edit_banner action which adminPhotoHandler also processes
  openInputSession(ctx, { action: 'admin_edit_banner', field: m.imgField, label: `Gambar ${m.label}`, returnTo: `a:pm:${m.key}` });
  await answerCb(ctx);
  return safeEditText(ctx,
`🖼 *UBAH GAMBAR ${m.label.toUpperCase()}*

Kirim *foto baru* atau *URL gambar*:`,
    { parse_mode: 'Markdown', ...cancelKb(`a:pm:${m.key}`) });
}

async function startEditPmCaption(ctx, key) {
  const s = await getSettings();
  const m = paymentMethodByKey(s, key);
  if (!m) { await answerCb(ctx, 'Tidak valid', true); return; }
  openInputSession(ctx, { action: 'admin_edit_caption', field: m.capField, label: `Caption ${m.label}`, returnTo: `a:pm:${m.key}` });
  await answerCb(ctx);
  return safeEditText(ctx,
`📝 *UBAH CAPTION ${m.label.toUpperCase()}*

Caption saat ini:
\`\`\`
${(m.caption || '').slice(0, 600)}
\`\`\`

Kirim *teks caption baru* (Markdown didukung):`,
    { parse_mode: 'Markdown', ...cancelKb(`a:pm:${m.key}`) });
}

// Join gate menu
async function showGateMenu(ctx) {
  const s = await getSettings();
  const enabled = (s.joinGateEnabled || 'off') === 'on';
  const channels = Array.isArray(s.requiredChannels) ? s.requiredChannels : [];
  await answerCb(ctx);
  return safeEditText(ctx,
`📢 *CHANNEL WAJIB JOIN*

Status: ${enabled ? '🟢 Aktif' : '🔴 Nonaktif'}
Channel terdaftar (${channels.length}):
\`\`\`
${channels.join('\n') || '(kosong)'}
\`\`\`

_Format channel: \`@username\` atau \`t.me/+invitehash\` atau \`https://t.me/joinchat/...\`. Bot harus jadi admin di channel privat agar bisa cek membership._`,
    { parse_mode: 'Markdown', ...gateMenu(enabled) });
}

async function toggleGate(ctx) {
  const s = await getSettings();
  const next = (s.joinGateEnabled || 'off') === 'on' ? 'off' : 'on';
  await updateSetting({ joinGateEnabled: next });
  await answerCb(ctx, next === 'on' ? '🟢 Gate diaktifkan' : '🔴 Gate dinonaktifkan');
  return showGateMenu(ctx);
}

async function startEditGateList(ctx) {
  const s = await getSettings();
  const channels = Array.isArray(s.requiredChannels) ? s.requiredChannels : [];
  openInputSession(ctx, { action: 'admin_gate_list', returnTo: 'a:gate:menu' });
  await answerCb(ctx);
  return safeEditText(ctx,
`📋 *EDIT DAFTAR CHANNEL WAJIB*

Daftar saat ini:
\`\`\`
${channels.join('\n') || '(kosong)'}
\`\`\`

Kirim daftar baru (satu channel per baris).`,
    { parse_mode: 'Markdown', ...cancelKb('a:gate:menu') });
}

module.exports = {
  renderAdminHome, renderDashboard,
  showBannerMenu, startEditBanner,
  showCaptionMenu, startEditCaption,
  showPriceMenu, showPriceTierMenu, showPriceSlotMenu, startEditPrice,
  showSpecMenu, startEditSpec,
  startBroadcast,
  handleAdminText,
  showListMenu, startEditList, showOsvFamilyMenu, startEditOsVersions, startEditText,
  showReplaceMenu, startEditReplace,
  handleMarkSuccess, startSendCredentials,
  showAdvancedMenu, startEditAutoCancel, startEditReceiptChannel,
  showCatalogMenu, startEditCatalogChannel, refreshCatalogNow, resetCatalogMessageId,
  showPostStokMenu, startEditStokChannel,
  showPaymentMethodsMenu, showPaymentMethodEdit, togglePaymentMethod, startEditPmImage, startEditPmCaption,
  showGateMenu, toggleGate, startEditGateList,
  sendReceipt,
};
