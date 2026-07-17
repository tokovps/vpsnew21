const mongoose = require('mongoose');

const broadcastSchema = new mongoose.Schema({
  adminId: { type: String, required: true },
  message: { type: String, required: true },
  sent: { type: Number, default: 0 },
  failed: { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('Broadcast', broadcastSchema);
