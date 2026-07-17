const mongoose = require('mongoose');

// Currency configuration. USD is base (rate=1). Rates express: 1 USD = rate <code>.
const currencySchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, uppercase: true, index: true },
  name: { type: String, default: '' },
  symbol: { type: String, default: '' },
  rate: { type: Number, default: 1 },   // 1 USD => rate <code>
  enabled: { type: Boolean, default: true },
  isBase: { type: Boolean, default: false },
  updatedFrom: { type: String, default: 'manual' },   // 'manual' | 'auto'
  lastUpdatedAt: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.model('Currency', currencySchema);
