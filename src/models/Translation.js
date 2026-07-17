const mongoose = require('mongoose');

// Simple key-value translations. key = 'menu.buy_vps', values by language code.
const translationSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, index: true },
  values: { type: mongoose.Schema.Types.Mixed, default: {} }, // { id: '...', en: '...' }
}, { timestamps: true });

module.exports = mongoose.model('Translation', translationSchema);
