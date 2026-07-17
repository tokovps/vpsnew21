const mongoose = require('mongoose');

// One-doc-per-provider payment configuration (AutoGoPay, Binance Pay, etc.)
const paymentConfigSchema = new mongoose.Schema({
  provider: { type: String, required: true, unique: true, index: true },
  enabled: { type: Boolean, default: false },

  // Generic keys used across providers
  apiKey: { type: String, default: '' },
  apiSecret: { type: String, default: '' },
  merchantId: { type: String, default: '' },
  qrisString: { type: String, default: '' },
  webhookUrl: { type: String, default: '' },
  webhookSecret: { type: String, default: '' },

  // Statistics/monitor
  lastCallbackAt: { type: Date, default: null },
  successCount: { type: Number, default: 0 },
  failedCount: { type: Number, default: 0 },
  lastError: { type: String, default: '' },
  lastTestAt: { type: Date, default: null },
  lastTestOk: { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.model('PaymentConfig', paymentConfigSchema);
