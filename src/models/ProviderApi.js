const mongoose = require('mongoose');

const PROVIDERS = ['aws', 'digitalocean', 'linode', 'azure'];
const API_STATUS = ['READY', 'LOCKED', 'USED', 'ERROR', 'QUOTA_FULL', 'SUSPENDED'];

const providerApiSchema = new mongoose.Schema({
  provider: { type: String, enum: PROVIDERS, required: true, index: true },
  label: { type: String, default: '' },              // free-form nickname
  enabled: { type: Boolean, default: true, index: true },
  status: { type: String, enum: API_STATUS, default: 'READY', index: true },

  // Credentials (per-provider fields — sparse)
  awsAccessKey: { type: String, default: '' },
  awsSecretKey: { type: String, default: '' },
  awsRegion: { type: String, default: '' },          // preferred region (auto-fallback if empty/invalid)

  doToken: { type: String, default: '' },
  linodeToken: { type: String, default: '' },

  azTenantId: { type: String, default: '' },
  azClientId: { type: String, default: '' },
  azClientSecret: { type: String, default: '' },
  azSubscriptionId: { type: String, default: '' },

  // Health/quota metadata (auto-updated on healthCheck)
  lastCheckAt: { type: Date, default: null },
  lastError: { type: String, default: '' },
  quotaAvailable: { type: Number, default: 0 },      // remaining slot estimate
  usageCount: { type: Number, default: 0 },
  lockedAt: { type: Date, default: null },
  lastUsedAt: { type: Date, default: null },
  lastOrderId: { type: String, default: '' },

  // ===== Iter 3 — Performance & Health tracking =====
  consecutiveFailures: { type: Number, default: 0 },
  totalSuccess: { type: Number, default: 0 },
  totalFail: { type: Number, default: 0 },
  avgDurationMs: { type: Number, default: 0 },
  score: { type: Number, default: 0, index: true }, // higher = better
  suspendedUntil: { type: Date, default: null },
  lowStockNotifiedAt: { type: Date, default: null },
}, { timestamps: true });

providerApiSchema.index({ provider: 1, enabled: 1, status: 1 });

module.exports = mongoose.model('ProviderApi', providerApiSchema);
module.exports.PROVIDERS = PROVIDERS;
module.exports.API_STATUS = API_STATUS;
