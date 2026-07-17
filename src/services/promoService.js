// ═══════════════════════════════════════════════════════════════════════
// Promo Service — SIMPLIFIED (revisi 2026-01)
// ─────────────────────────────────────────────────────────────────────────
// Sumber tunggal untuk:
//   • Logika diskon (applyToPrice, discountFor, resolveEffectivePrice)
//   • Blok promo di Home / Katalog (homeBlockText)
//   • Format harga (formatPriceLine)
//   • Pengumuman promo ke channel (announceStart / announceEnd)
//
// TIDAK ADA LAGI:
//   ❌ Jam / tanggal mulai / tanggal berakhir
//   ❌ Countdown / expired time
//   ❌ Scheduler otomatis (startScheduler / runOnce)
//
// Promo aktif = `enabled: true`. Titik.
// ═══════════════════════════════════════════════════════════════════════
const Promo = require('../models/Promo');

function rupiah(n) { return 'Rp' + Number(n || 0).toLocaleString('id-ID'); }

const TARGET_LABEL = {
  'vps:low': '☁ VPS LOW', 'vps:basic': '☁ VPS BASIC', 'vps:medium': '☁ VPS MEDIUM',
  'rdp:low': '🖥 RDP LOW', 'rdp:basic': '🖥 RDP BASIC', 'rdp:medium': '🖥 RDP MEDIUM',
};

// Return list of promos currently ACTIVE (enabled, non-voucher).
// Voucher promos (voucherCode terisi) tidak muncul di daftar auto-diskon
// karena mereka hanya berlaku saat user memasukkan kode.
async function getActivePromos() {
  return Promo.find({
    enabled: true,
    $or: [{ voucherCode: '' }, { voucherCode: { $exists: false } }],
  }).lean();
}

// Get best (largest reduction) discount for a category+tier from ACTIVE (non-voucher) promos.
async function discountFor(category, tier, oldPrice) {
  if (!oldPrice || oldPrice <= 0) return null;
  const key = `${category}:${tier}`;
  const promos = await getActivePromos();
  let best = null;
  for (const p of promos) {
    if (!Array.isArray(p.targets) || !p.targets.includes(key)) continue;
    const off = p.discountType === 'percent'
      ? Math.round(oldPrice * (Math.min(100, p.discountValue) / 100))
      : Math.min(oldPrice, p.discountValue);
    if (!best || off > best.off) best = { promo: p, off, newPrice: Math.max(0, oldPrice - off) };
  }
  return best;
}

// Convenience: apply discount → returns { original, discounted, promo|null }.
async function applyToPrice(oldPrice, category, tier) {
  const d = await discountFor(category, tier, oldPrice);
  if (!d) return { original: oldPrice, discounted: oldPrice, promo: null };
  return { original: oldPrice, discounted: d.newPrice, promo: d.promo, off: d.off };
}

// Formatted price string. If discount active → ~~old~~ new 🔥
async function formatPriceLine(oldPrice, category, tier) {
  const r = await applyToPrice(oldPrice, category, tier);
  if (!r.promo || r.discounted === r.original) return rupiah(oldPrice);
  return `~~${rupiah(r.original)}~~ ${rupiah(r.discounted)} 🔥`;
}

// Home Menu block. Returns empty string when no active promo.
// Format DISEDERHANAKAN — tanpa tanggal berakhir (promo aktif sampai admin hentikan).
async function homeBlockText() {
  const promos = await getActivePromos();
  if (!promos.length) return '';
  const SEP = '━━━━━━━━━━━━━━━━━━━━';
  const lines = [SEP, '', '🎉 PROMO AKTIF', ''];
  for (const p of promos.slice(0, 5)) {
    const disc = p.discountType === 'percent' ? `${p.discountValue}%` : rupiah(p.discountValue);
    const targets = (p.targets || []).map(t => TARGET_LABEL[t] || t).join(', ');
    lines.push(`🔥 ${targets || p.name} Diskon ${disc}`);
    lines.push('');
  }
  lines.push(SEP);
  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════
// PENGUMUMAN PROMO — dipanggil eksplisit dari promoAdminHandler saat
// Admin BUAT / HAPUS / NON-AKTIFKAN promo. Target = catalogChannelId
// (sistem broadcast yang sudah berjalan di project). Tidak ada scheduler.
// ═══════════════════════════════════════════════════════════════════════
function _announceStartText(p) {
  const disc = p.discountType === 'percent' ? `${p.discountValue}%` : rupiah(p.discountValue);
  const targets = (p.targets || []).map(t => TARGET_LABEL[t] || t).join(', ');
  return [
    '━━━━━━━━━━━━━━',
    '',
    '🎉 *PROMO BARU TELAH DIMULAI*',
    '',
    `🔥 Diskon: *${disc}*`,
    '',
    '📦 Berlaku untuk:',
    targets || '_(semua paket)_',
    '',
    p.description ? `_${p.description}_` : '',
    'Promo akan tetap berlangsung sampai Admin menghentikannya.',
    '',
    '━━━━━━━━━━━━━━',
  ].filter(Boolean).join('\n');
}

function _announceEndText() {
  return [
    '━━━━━━━━━━━━━━',
    '',
    '📢 *PROMO TELAH BERAKHIR*',
    '',
    'Terima kasih kepada seluruh pelanggan yang telah mengikuti Promo.',
    '',
    'Harga kembali normal.',
    '',
    '━━━━━━━━━━━━━━',
  ].join('\n');
}

// Kirim pengumuman ke channel katalog. Return { ok, error? }.
async function _sendAnnouncement(bot, text) {
  if (!bot) return { ok: false, error: 'bot not attached' };
  try {
    const { getSettings } = require('./settingService');
    const s = await getSettings();
    const chan = String(s.catalogChannelId || '').trim();
    if (!chan) return { ok: false, error: 'catalogChannelId belum di-set' };
    await bot.telegram.sendMessage(chan, text, { parse_mode: 'Markdown', disable_web_page_preview: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.description) || e.message };
  }
}

async function announceStart(bot, promo) {
  // Voucher promos tidak dipublish (mereka private, pakai kode).
  if (promo && promo.voucherCode) return { ok: true, skipped: 'voucher' };
  return _sendAnnouncement(bot, _announceStartText(promo));
}

async function announceEnd(bot, promo) {
  if (promo && promo.voucherCode) return { ok: true, skipped: 'voucher' };
  return _sendAnnouncement(bot, _announceEndText());
}

// Refresh catalog channel setelah perubahan promo agar kolom harga di
// katalog ikut ter-update. Best-effort — abaikan error.
function refreshCatalog(bot) {
  try { require('./catalogService').scheduleUpdate(bot); } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════════════
// SINGLE SOURCE OF TRUTH untuk harga efektif. Dipakai oleh Menu, Confirm,
// Payment, Invoice, Order-DB, dan admin notifications — semuanya sepakat
// pada satu angka.
// ═══════════════════════════════════════════════════════════════════════
async function resolveEffectivePrice(settings, category, tier, slot) {
  const { specOf } = require('./settingService');
  const { spec, price: originalPrice } = specOf(settings, category, tier, slot);
  if (!originalPrice || originalPrice <= 0) {
    return { spec, originalPrice: 0, price: 0, promo: null, off: 0 };
  }
  const r = await applyToPrice(originalPrice, category, tier);
  return {
    spec,
    originalPrice: r.original,
    price: r.discounted,
    promo: r.promo,
    off: r.off || 0,
  };
}

module.exports = {
  getActivePromos, discountFor, applyToPrice, formatPriceLine, homeBlockText,
  announceStart, announceEnd, refreshCatalog,
  TARGET_LABEL, rupiah,
  resolveEffectivePrice,
};
