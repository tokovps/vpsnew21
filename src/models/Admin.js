const mongoose = require('mongoose');

const adminSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true, index: true },
  username: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('Admin', adminSchema);
