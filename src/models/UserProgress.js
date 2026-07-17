const mongoose = require('mongoose');

// Embedded referral log entry — tidak butuh collection terpisah untuk
// menjaga struktur DB tetap sederhana.
const referralLogSchema = new mongoose.Schema({
  referredUserId: { type: String, required: true }, // telegramId user yang direfer
  orderId: { type: String, default: '' },           // Order VPS pertama user tsb
  status: { type: String, enum: ['pending', 'qualified', 'rejected'], default: 'pending', index: true },
  reason: { type: String, default: '' },            // alasan rejected
  qualifiedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
}, { _id: false });

const schema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true, index: true }, // telegramId
  vpsTxCount: { type: Number, default: 0 },       // cumulative valid VPS transactions
  referralCount: { type: Number, default: 0 },    // cumulative qualified referrals
  claimedLoyalty: { type: [Number], default: [] },  // thresholds already claimed
  claimedReferral: { type: [Number], default: [] },
  badges: { type: [String], default: [] },        // badge codes earned
  frame: { type: String, default: '' },           // current frame code
  loginStreak: { type: Number, default: 0 },
  lastLoginAt: { type: Date, default: null },
  referrals: { type: [referralLogSchema], default: [] },
  totalRewardsClaimed: { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('UserProgress', schema);
