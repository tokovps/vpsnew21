const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true, index: true },
  username: { type: String, default: '' },
  name: { type: String, default: '' },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  // Extensions (safe defaults preserve legacy)
  currency: { type: String, default: '' },     // set via /start Currency picker or Settings
  language: { type: String, default: 'id' },   // 'id' | 'en' | ...
  sshPublicKey: { type: String, default: '' }, // optional SSH key
  authMethod: { type: String, enum: ['password', 'ssh'], default: 'password' },
  // ===== Reward Ecosystem (VPS only) =====
  referralCode: { type: String, default: '', index: true },
  referredBy: { type: String, default: '' },
  referredAt: { type: Date, default: null },
  firstSeenAt: { type: Date, default: null },
  blacklisted: { type: Boolean, default: false },
  loginStreak: { type: Number, default: 0 },
  lastLoginAt: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
