// Maintenance Mode singleton state.
//
// Design goals:
//   • Standalone collection, does NOT touch Setting / Order / User / Provider /
//     Queue / Payment / Promo / Reward / Referral / VpsInstance schemas.
//   • Single document keyed by { key: 'global' } — mirrors Setting pattern.
//   • Tester list embedded (typically ≤ 100 entries during a maintenance
//     window). Wiped on disable() so no DB residue between windows.
//   • Rejected list embedded — prevents rejected user from spamming re-requests
//     during the same maintenance window (cleared on disable too).

const mongoose = require('mongoose');

const testerSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, index: true },
  username: { type: String, default: '' },
  name: { type: String, default: '' },
  approvedAt: { type: Date, default: () => new Date() },
}, { _id: false });

const requestSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, index: true },
  username: { type: String, default: '' },
  name: { type: String, default: '' },
  requestedAt: { type: Date, default: () => new Date() },
  // adminMessageIds: for cleanup — telegram messages sent to admins as the
  // "Permintaan Tester" card, keyed by adminId → messageId.
  adminMessageIds: { type: Map, of: Number, default: () => new Map() },
}, { _id: false });

const schema = new mongoose.Schema({
  key: { type: String, default: 'global', unique: true },
  enabled: { type: Boolean, default: false },
  estimateMinutes: { type: Number, default: 60 }, // default 1 jam
  message: {
    type: String,
    default:
`🛠 *BOT SEDANG MAINTENANCE*

Halo.

Saat ini Admin sedang melakukan maintenance dan peningkatan sistem.
Mohon tunggu hingga proses selesai.

Terima kasih atas pengertiannya.`,
  },
  startedAt: { type: Date, default: null },
  // Testers approved during CURRENT maintenance window. Wiped on disable().
  testers: { type: [testerSchema], default: [] },
  // Pending tester requests (waiting admin decision). Also wiped on disable.
  requests: { type: [requestSchema], default: [] },
  // Rejected list — prevents user from re-requesting during same window.
  rejected: { type: [String], default: [] },
}, { timestamps: true, minimize: false });

module.exports = mongoose.model('MaintenanceState', schema);
