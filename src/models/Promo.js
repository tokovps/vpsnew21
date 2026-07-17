const mongoose = require('mongoose');

// ═══════════════════════════════════════════════════════════════════════
// PROMO CENTER — SIMPLIFIED (revisi 2026-01)
// ─────────────────────────────────────────────────────────────────────────
// Sistem promo TIDAK LAGI menggunakan tanggal / jam / countdown.
// Aturan baru:
//   • Promo hanya memiliki dua status: 🟢 Aktif (enabled=true) / 🔴 Non-aktif.
//   • Saat Admin membuat promo → langsung Aktif, TANPA batas waktu.
//   • Promo hanya berakhir bila Admin menekan "Hapus" atau "Nonaktifkan".
//   • Voucher tetap didukung: bila `voucherCode` terisi, promo hanya berlaku
//     untuk pesanan yang memakai kode (lihat catatan di voucherCode).
//
// Backward compatibility: field lama (`startAt`, `endAt`, `announcedStart`,
// `announcedEnd`) DIHAPUS dari schema baru. Data promo lama di MongoDB tidak
// akan error karena Mongoose secara default mengabaikan field yang tidak
// dideklarasikan di schema (strict:true bawaan cuma memfilter saat write).
// ═══════════════════════════════════════════════════════════════════════
const promoSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String, default: '' },
  // Status manual — satu-satunya sumber kebenaran untuk aktif/non-aktif.
  enabled: { type: Boolean, default: true, index: true },
  discountType: { type: String, enum: ['nominal', 'percent'], required: true },
  discountValue: { type: Number, required: true, min: 0 },
  // Sasaran: array of "vps:low" | "vps:basic" | "vps:medium" | "rdp:low" | ...
  targets: { type: [String], default: [] },
  voucherCode: { type: String, default: '', index: true, uppercase: true, trim: true },
}, { timestamps: true, strict: false });

// Field lama (`startAt`, `endAt`, `announcedStart`, `announcedEnd`) sengaja
// DIBIARKAN ada di dokumen lama (strict:false) tapi tidak dievaluasi lagi.

module.exports = mongoose.model('Promo', promoSchema);
