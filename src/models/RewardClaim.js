const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  kind: { type: String, enum: ['loyalty', 'referral'], required: true },
  threshold: { type: Number, required: true },
  rewardTier: { type: String, required: true }, // low|basic|medium|special
  rewardOrderId: { type: String, default: '' },
  status: { type: String, enum: ['created', 'success', 'failed', 'pending_admin'], default: 'created', index: true },
  note: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('RewardClaim', schema);
