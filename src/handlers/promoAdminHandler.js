// ═══════════════════════════════════════════════════════════════════════
// Promo Center — Admin CRUD (SIMPLIFIED, revisi 2026-01)
// ─────────────────────────────────────────────────────────────────────────
// Menu Promo Center:
//   📢 Buat Promo        (+ voucher variant)
//   📝 Edit Promo
//   🗑 Hapus Promo
//   📊 Status Promo
//   ⬅ Kembali
//
// TIDAK ADA lagi pengaturan tanggal / jam / countdown / expired time.
// Promo langsung Aktif saat dibuat, dan hanya berakhir bila Admin menekan
// Hapus atau Nonaktifkan.
// ═══════════════════════════════════════════════════════════════════════
const { Markup } = require('telegraf');
const { safeEditText, answerCb, respondInSession, respondSaved } = require('../utils/safeEdit');
const { cancelKb, promoCenterMenu } = require('../keyboards/admin');
const { setSession, clearSession, getSession, openInputSession } = require('./sessionStore');
const Promo = require('../models/Promo');
const promoSvc = require('../services/promoService');

const CAT_TIERS = ['vps:low', 'vps:basic', 'vps:medium', 'rdp:low', 'rdp:basic', 'rdp:medium'];

// Ambil botRef yang sudah di-attach ke catalogService saat boot (app.js).
// Fallback ke ctx.telegram bila diperlukan.
function _getBot(ctx) {
  try {
    const c = require('../services/catalogService');
    const b = typeof c.getBot === 'function' ? c.getBot() : null;
    if (b) return b;
  } catch (_) {}
  return ctx && ctx.telegram ? { telegram: ctx.telegram } : null;
}

// ─── HOME ────────────────────────────────────────────────────────────
async function showHome(ctx) {
  const active = await Promo.countDocuments({ enabled: true });
  const inactive = await Promo.countDocuments({ enabled: false });
  await safeEditText(ctx,
`🎉 *PROMO CENTER*

🟢 Aktif      : *${active}*
🔴 Non-Aktif  : *${inactive}*

_Promo langsung aktif saat dibuat dan tetap berlaku sampai Admin menekan Hapus / Nonaktifkan._

Pilih menu di bawah:`,
    { parse_mode: 'Markdown', ...promoCenterMenu() });
  await answerCb(ctx);
}

// ─── STATUS PROMO (list) ─────────────────────────────────────────────
// mode: 'active' | 'inactive' | 'all' | 'edit' | 'delete'
async function showList(ctx, mode = 'all') {
  const filter =
    mode === 'active'   ? { enabled: true }
  : mode === 'inactive' ? { enabled: false }
  : {};
  const rows = await Promo.find(filter).sort({ createdAt: -1 }).limit(30).lean();

  const title =
      mode === 'active'   ? '📊 *PROMO AKTIF*'
    : mode === 'inactive' ? '🔴 *PROMO NON-AKTIF*'
    : mode === 'edit'     ? '📝 *PILIH PROMO UNTUK DI-EDIT*'
    : mode === 'delete'   ? '🗑 *PILIH PROMO UNTUK DIHAPUS*'
    : '📋 *SEMUA PROMO*';

  // Prefix callback tergantung mode agar aksi lanjutan sesuai konteks.
  const cbFor = (id) =>
      mode === 'edit'   ? `a:promo:edit:${id}`
    : mode === 'delete' ? `a:promo:del:${id}`
    : `a:promo:d:${id}`;

  const btns = rows.map(p => {
    const state = p.enabled ? '🟢' : '🔴';
    const disc = p.discountType === 'percent' ? `${p.discountValue}%` : `Rp${p.discountValue}`;
    const voucher = p.voucherCode ? ' 🎟' : '';
    return [Markup.button.callback(`${state} ${p.name} · ${disc}${voucher}`, cbFor(p._id))];
  });
  btns.push([Markup.button.callback('⬅️ Kembali', 'a:promo:home')]);

  await safeEditText(ctx,
    `${title}\n\n${rows.length ? `Total: *${rows.length}*` : '_(kosong)_'}`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(btns) });
  await answerCb(ctx);
}

// ─── DETAIL PROMO ────────────────────────────────────────────────────
async function showDetail(ctx, id) {
  const p = await Promo.findById(id).lean();
  if (!p) { await answerCb(ctx, '⚠️ Tidak ditemukan', true); return showList(ctx, 'all'); }
  const disc = p.discountType === 'percent' ? `${p.discountValue}%` : `Rp${p.discountValue}`;
  const targets = (p.targets || []).map(t => promoSvc.TARGET_LABEL[t] || t).join(', ') || '_(belum ada)_';
  const state = p.enabled ? '🟢 Aktif' : '🔴 Non-Aktif';
  const body =
`🎉 *${p.name}*

${p.description ? `_${p.description}_\n\n` : ''}💥 Diskon: *${disc}*
🎯 Target: ${targets}
📌 Status : ${state}
${p.voucherCode ? `🎟 Kode: \`${p.voucherCode}\`` : ''}`;
  await safeEditText(ctx, body, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('📝 Edit', `a:promo:edit:${p._id}`)],
      [Markup.button.callback(p.enabled ? '⏸ Nonaktifkan' : '▶️ Aktifkan', `a:promo:tog:${p._id}`)],
      [Markup.button.callback('🗑 Hapus', `a:promo:del:${p._id}`)],
      [Markup.button.callback('⬅️ Kembali', 'a:promo:list:all')],
    ]),
  });
  await answerCb(ctx);
}

// ─── TOGGLE AKTIF / NON-AKTIF ────────────────────────────────────────
async function toggle(ctx, id) {
  const p = await Promo.findById(id);
  if (!p) { await answerCb(ctx, '⚠️ Tidak ditemukan', true); return; }
  const wasEnabled = p.enabled;
  p.enabled = !p.enabled;
  await p.save();

  const bot = _getBot(ctx);
  if (wasEnabled) {
    // Dinonaktifkan → umumkan promo berakhir
    promoSvc.announceEnd(bot, p).catch(() => {});
  } else {
    // Diaktifkan kembali → umumkan promo baru
    promoSvc.announceStart(bot, p).catch(() => {});
  }
  promoSvc.refreshCatalog(bot);

  await answerCb(ctx, p.enabled ? '▶️ Aktif' : '⏸ Non-aktif');
  return showDetail(ctx, id);
}

// ─── HAPUS PROMO ─────────────────────────────────────────────────────
async function confirmDel(ctx, id) {
  await safeEditText(ctx, '🗑 *Hapus promo ini?*\n\nAksi tidak dapat dibatalkan.', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Ya, Hapus', `a:promo:delok:${id}`)],
      [Markup.button.callback('❌ Batal', `a:promo:d:${id}`)],
    ]),
  });
  await answerCb(ctx);
}

async function doDelete(ctx, id) {
  const p = await Promo.findById(id).lean();
  await Promo.deleteOne({ _id: id });
  if (p) {
    const bot = _getBot(ctx);
    // Umumkan promo berakhir (hanya jika sebelumnya aktif — biar tidak spam
    // ketika admin membersihkan promo yang memang sudah non-aktif).
    if (p.enabled) promoSvc.announceEnd(bot, p).catch(() => {});
    promoSvc.refreshCatalog(bot);
  }
  await answerCb(ctx, '🗑 Terhapus');
  return showList(ctx, 'all');
}

// ─── WIZARD: TAMBAH PROMO ────────────────────────────────────────────
async function startAdd(ctx, isVoucher) {
  openInputSession(ctx, {
    action: 'promo_add',
    step: 'name',
    draft: { voucher: !!isVoucher },
    returnTo: 'a:promo:home',
  });
  await safeEditText(ctx,
`${isVoucher ? '🎟 *TAMBAH VOUCHER*' : '📢 *BUAT PROMO*'}

Langkah 1/5 — *Nama Promo*
Contoh: _Flash Sale Weekend_

Kirim nama promo:`,
    { parse_mode: 'Markdown', ...cancelKb('a:promo:home') });
  await answerCb(ctx);
}

// ─── WIZARD: EDIT PROMO ──────────────────────────────────────────────
async function showEditList(ctx) { return showList(ctx, 'edit'); }
async function showDeleteList(ctx) { return showList(ctx, 'delete'); }

async function startEdit(ctx, id) {
  const p = await Promo.findById(id).lean();
  if (!p) { await answerCb(ctx, '⚠️ Tidak ditemukan', true); return; }
  const disc = p.discountType === 'percent' ? `${p.discountValue}%` : `Rp${p.discountValue}`;
  const targets = (p.targets || []).map(t => promoSvc.TARGET_LABEL[t] || t).join(', ') || '_(belum ada)_';
  await safeEditText(ctx,
`📝 *EDIT PROMO*

🎉 ${p.name}
💥 Diskon: *${disc}*
🎯 Target: ${targets}
📌 Status: ${p.enabled ? '🟢 Aktif' : '🔴 Non-Aktif'}

Pilih bagian yang ingin di-edit:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✏️ Nama', `a:promo:ef:${id}:name`)],
        [Markup.button.callback('📝 Deskripsi', `a:promo:ef:${id}:description`)],
        [Markup.button.callback('💥 Jenis Diskon', `a:promo:ef:${id}:type`)],
        [Markup.button.callback('🔢 Nilai Diskon', `a:promo:ef:${id}:value`)],
        [Markup.button.callback('🎯 Target Tier', `a:promo:ef:${id}:targets`)],
        [Markup.button.callback('⬅️ Kembali', `a:promo:d:${id}`)],
      ]),
    });
  await answerCb(ctx);
}

async function startEditField(ctx, id, field) {
  const p = await Promo.findById(id).lean();
  if (!p) { await answerCb(ctx, '⚠️ Tidak ditemukan', true); return; }
  const prompts = {
    name:        { title: '✏️ *EDIT NAMA*', hint: 'Kirim nama baru:', current: p.name },
    description: { title: '📝 *EDIT DESKRIPSI*', hint: 'Kirim deskripsi baru, atau ketik `-` untuk mengosongkan:', current: p.description || '(kosong)' },
    type:        { title: '💥 *EDIT JENIS DISKON*', hint: 'Ketik `percent` atau `nominal`:', current: p.discountType },
    value:       { title: '🔢 *EDIT NILAI DISKON*', hint: p.discountType === 'percent' ? 'Kirim angka 1-100 (persen):' : 'Kirim angka nominal Rupiah, tanpa titik/Rp:', current: String(p.discountValue) },
    targets:     { title: '🎯 *EDIT TARGET TIER*', hint: 'Kirim daftar tier dipisah koma (`vps:low, vps:basic, ...`) atau `all`.', current: (p.targets || []).join(', ') || '(kosong)' },
  };
  const cfg = prompts[field];
  if (!cfg) { await answerCb(ctx, '⚠️ Field tidak valid', true); return; }

  openInputSession(ctx, {
    action: 'promo_edit',
    step: field,
    promoId: String(id),
    returnTo: `a:promo:edit:${id}`,
  });
  await safeEditText(ctx,
`${cfg.title}

Nilai saat ini: \`${cfg.current}\`

${cfg.hint}`,
    { parse_mode: 'Markdown', ...cancelKb(`a:promo:edit:${id}`) });
  await answerCb(ctx);
}

// ═══════════════════════════════════════════════════════════════════════
// TEXT HANDLER — dipanggil dari adminHandler.handleAdminText
// ═══════════════════════════════════════════════════════════════════════
async function handleText(ctx) {
  const session = getSession(ctx.from.id);
  if (!session) return false;
  if (session.action === 'promo_add')  return _handleAddText(ctx, session);
  if (session.action === 'promo_edit') return _handleEditText(ctx, session);
  return false;
}

async function _handleAddText(ctx, session) {
  const text = String(ctx.message.text || '').trim();
  const d = session.draft;

  const advance = async (nextStep, promptText) => {
    setSession(ctx.from.id, { ...session, step: nextStep });
    return respondInSession(ctx, promptText, { parse_mode: 'Markdown', ...cancelKb('a:promo:home') });
  };

  switch (session.step) {
    case 'name': {
      if (!text) return respondInSession(ctx, '⚠️ Kosong. Kirim ulang nama promo:', { parse_mode: 'Markdown', ...cancelKb('a:promo:home') });
      d.name = text;
      return advance('description',
`Langkah 2/5 — *Deskripsi* (opsional)
Kirim deskripsi, atau ketik \`-\` untuk kosong:`);
    }
    case 'description': {
      d.description = text === '-' ? '' : text;
      return advance('type',
`Langkah 3/5 — *Jenis Diskon*
Ketik \`percent\` atau \`nominal\`:`);
    }
    case 'type': {
      const t = text.toLowerCase();
      if (t !== 'percent' && t !== 'nominal') return respondInSession(ctx, '⚠️ Ketik `percent` atau `nominal` saja.', { parse_mode: 'Markdown', ...cancelKb('a:promo:home') });
      d.discountType = t;
      return advance('value',
`Langkah 4/5 — *Nilai Diskon*
${t === 'percent' ? 'Kirim angka 1-100 (persen).' : 'Kirim angka nominal Rupiah, tanpa titik/Rp.'}`);
    }
    case 'value': {
      const n = parseInt(text.replace(/\D/g, ''), 10);
      if (!n || n < 1 || (d.discountType === 'percent' && n > 100)) return respondInSession(ctx, '⚠️ Nilai tidak valid. Kirim ulang:', { parse_mode: 'Markdown', ...cancelKb('a:promo:home') });
      d.discountValue = n;
      return advance('targets',
`Langkah 5/5 — *Target Tier*
Kirim daftar tier dipisah koma. Pilihan:
\`vps:low\`, \`vps:basic\`, \`vps:medium\`, \`rdp:low\`, \`rdp:basic\`, \`rdp:medium\`

Contoh: \`vps:low, vps:basic\`
Atau ketik \`all\` untuk semua tier.`);
    }
    case 'targets': {
      let list;
      if (text.toLowerCase() === 'all') list = [...CAT_TIERS];
      else list = text.split(',').map(x => x.trim().toLowerCase()).filter(x => CAT_TIERS.includes(x));
      if (!list.length) return respondInSession(ctx, '⚠️ Tidak ada tier valid. Kirim ulang:', { parse_mode: 'Markdown', ...cancelKb('a:promo:home') });
      d.targets = list;

      if (d.voucher) {
        setSession(ctx.from.id, { ...session, step: 'voucher_code' });
        return respondInSession(ctx, '🎟 *Kode Voucher* (huruf/angka, tanpa spasi):', { parse_mode: 'Markdown', ...cancelKb('a:promo:home') });
      }
      return _savePromo(ctx, d);
    }
    case 'voucher_code': {
      const code = text.replace(/\s+/g, '').toUpperCase();
      if (code.length < 3) return respondInSession(ctx, '⚠️ Kode terlalu pendek. Min 3 karakter.', { parse_mode: 'Markdown', ...cancelKb('a:promo:home') });
      d.voucherCode = code;
      return _savePromo(ctx, d);
    }
  }
  return true;
}

async function _handleEditText(ctx, session) {
  const text = String(ctx.message.text || '').trim();
  const id = session.promoId;
  const p = await Promo.findById(id);
  if (!p) {
    clearSession(ctx.from.id);
    return respondSaved(ctx, '⚠️ Promo tidak ditemukan.', 'a:promo:home');
  }

  const returnTo = `a:promo:edit:${id}`;
  const fail = (msg) => respondInSession(ctx, msg, { parse_mode: 'Markdown', ...cancelKb(returnTo) });

  switch (session.step) {
    case 'name': {
      if (!text) return fail('⚠️ Kosong. Kirim ulang:');
      p.name = text;
      break;
    }
    case 'description': {
      p.description = text === '-' ? '' : text;
      break;
    }
    case 'type': {
      const t = text.toLowerCase();
      if (t !== 'percent' && t !== 'nominal') return fail('⚠️ Ketik `percent` atau `nominal` saja.');
      p.discountType = t;
      break;
    }
    case 'value': {
      const n = parseInt(text.replace(/\D/g, ''), 10);
      if (!n || n < 1 || (p.discountType === 'percent' && n > 100)) return fail('⚠️ Nilai tidak valid. Kirim ulang:');
      p.discountValue = n;
      break;
    }
    case 'targets': {
      let list;
      if (text.toLowerCase() === 'all') list = [...CAT_TIERS];
      else list = text.split(',').map(x => x.trim().toLowerCase()).filter(x => CAT_TIERS.includes(x));
      if (!list.length) return fail('⚠️ Tidak ada tier valid. Kirim ulang:');
      p.targets = list;
      break;
    }
    default: return fail('⚠️ Field tidak valid.');
  }

  await p.save();
  clearSession(ctx.from.id);
  // Refresh katalog agar perubahan diskon langsung tercermin.
  promoSvc.refreshCatalog(_getBot(ctx));

  return respondSaved(ctx,
`✅ *Promo diperbarui*

🎉 ${p.name}
💥 ${p.discountType === 'percent' ? p.discountValue + '%' : 'Rp' + p.discountValue}
📌 ${p.enabled ? '🟢 Aktif' : '🔴 Non-Aktif'}`,
    returnTo, '📝 Ke Edit Promo');
}

// ─── SAVE PROMO BARU ─────────────────────────────────────────────────
async function _savePromo(ctx, d) {
  const p = await Promo.create({
    name: d.name,
    description: d.description || '',
    discountType: d.discountType,
    discountValue: d.discountValue,
    targets: d.targets,
    voucherCode: d.voucherCode || '',
    enabled: true,
  });
  clearSession(ctx.from.id);

  // Kirim pengumuman promo baru + refresh katalog. Best-effort — jangan
  // blokir UI admin bila channel belum di-set / bot bukan admin di channel.
  const bot = _getBot(ctx);
  const announce = await promoSvc.announceStart(bot, p);
  promoSvc.refreshCatalog(bot);

  const disc = p.discountType === 'percent' ? p.discountValue + '%' : 'Rp' + p.discountValue;
  const noteAnnounce = announce.ok
    ? (announce.skipped ? '_Voucher — pengumuman channel di-skip._' : '📣 Pengumuman channel: *terkirim*')
    : `⚠️ Pengumuman channel gagal: _${announce.error}_`;

  const body =
`✅ *Promo tersimpan & langsung Aktif*

🎉 ${p.name}
💥 ${disc}
🎯 ${(p.targets || []).map(t => promoSvc.TARGET_LABEL[t] || t).join(', ') || '_(kosong)_'}
${p.voucherCode ? '🎟 Kode: `' + p.voucherCode + '`\n' : ''}
${noteAnnounce}

_Promo tetap aktif tanpa batas waktu sampai Admin menekan Hapus / Nonaktifkan._`;
  return respondSaved(ctx, body, 'a:promo:home', '🎉 Ke Promo Center');
}

module.exports = {
  showHome, showList, showDetail,
  toggle, confirmDel, doDelete,
  startAdd,
  showEditList, showDeleteList, startEdit, startEditField,
  handleText,
};
