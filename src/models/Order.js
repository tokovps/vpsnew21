const mongoose = require('mongoose');

const ORDER_STATUS = ['waiting_payment', 'waiting_review', 'processing', 'success', 'cancelled', 'rejected',
  'pending_admin', 'rdp_processing', 'rdp_completed', 'rdp_cancelled', 'failed'];

const orderSchema = new mongoose.Schema({
  invoice: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  username: { type: String, default: '' },
  name: { type: String, default: '' },

  // Slot-based (no more Product collection)
  category: { type: String, enum: ['vps', 'rdp'], required: true },
  tier: { type: String, enum: ['low', 'basic', 'medium'], required: true },
  slot: { type: Number, min: 1, max: 3, required: true },

  productName: { type: String, required: true },
  description: { type: String, default: '' },

  // ===== Structured spec snapshot (parsed from admin free-form text at
  //  purchase time). Used by orchestrator to build the DO create-droplet
  //  payload AND by Detail VPS validator. If any of these is missing, the
  //  order is refused (see orderService.createOrder). This is the single
  //  source of truth for the size the user paid for. =========
  cpu:    { type: Number, default: 0 },   // vCPU count
  ramMb:  { type: Number, default: 0 },   // RAM in MB
  diskGb: { type: Number, default: 0 },   // Disk in GB
  bwTb:   { type: Number, default: 0 },   // Bandwidth in TB (informational)
  sizeSlug: { type: String, default: '' },// DO size slug derived deterministically

  // Post-provision verification snapshot — populated after we GET the live
  // droplet from provider. Used for auditing (Detail VPS also live-refreshes
  // from provider on view — this snapshot is the last-known-good).
  verifiedSizeSlug: { type: String, default: '' },
  verifiedMemoryMb: { type: Number, default: 0 },
  verifiedVcpus:    { type: Number, default: 0 },
  verifiedDiskGb:   { type: Number, default: 0 },

  // New: customer selections
  region: { type: String, default: '' },
  osType: { type: String, default: '' },     // RDP only: 'windows' | 'linux'
  osFamily: { type: String, default: '' },   // VPS: Ubuntu/Debian/... ; RDP: same as osType label
  osVersion: { type: String, default: '' },
  warranty: { type: String, default: '' },
  replace: { type: String, default: '' },
  price: { type: Number, required: true },
  // Promo snapshot at purchase time (preserved even if promo later disabled).
  originalPrice: { type: Number, default: 0 },
  promoName:     { type: String, default: '' },
  promoOff:      { type: Number, default: 0 },
  qty: { type: Number, default: 1 },
  total: { type: Number, required: true },

  status: { type: String, enum: ORDER_STATUS, default: 'waiting_payment', index: true },
  paymentProof: { type: String, default: '' },
  paymentProofUid: { type: String, default: '', index: true },
  paymentMethod: { type: String, default: 'qris' },
  credentials: { type: String, default: '' },
  rejectReason: { type: String, default: '' },

  // ===== VPS Auto Provisioning extensions (Extend, Never Replace) =====
  autoProvision: { type: Boolean, default: false }, // true when this order should auto-create VPS
  provisionStatus: { type: String, default: '' },   // '' | queued | selecting_provider | checking | creating | waiting_ip | success | failed
  provisionSteps: { type: [String], default: [] },  // append-only progress log for edit-message UX
  providerUsed: { type: String, default: '' },      // aws | digitalocean | linode | azure
  apiUsedId: { type: String, default: '' },         // ProviderApi._id
  vpsInstanceId: { type: String, default: '' },     // VpsInstance._id
  publicIp: { type: String, default: '' },
  provisionRetryCount: { type: Number, default: 0 },
  provisionError: { type: String, default: '' },
  progressMessageId: { type: Number, default: 0 },  // Telegram message id used to editMessage progress
  progressChatId: { type: Number, default: 0 },

  // ===== RDP Auto-Create state machine (single source of truth) =====
  rdpState: { type: String, default: '' },          // enum lives in rdpStateMachine.STATES
  rdpStateAt: { type: Date, default: null },
  rdpProgressPct: { type: Number, default: 0 },     // monotonic floor
  rdpFinishBy: { type: Date, default: null },       // absolute ETA deadline for current state
  // Persist provisioning context so a boot-sweep after crash can safely
  // (a) unlock the ProviderApi, (b) call adapter.cleanup on the orphan droplet.
  rdpApiId:      { type: String, default: '' },     // ProviderApi._id currently locked
  rdpInstanceId: { type: String, default: '' },     // provider-side droplet/linode id
  rdpPublicIp:   { type: String, default: '' },

  // Payment webhook linkage
  paymentGatewayRef: { type: String, default: '', index: true }, // external invoice/ref id
  paymentGateway: { type: String, default: '' },                 // 'autogopay' | 'binancepay' | 'manual'
  paidAt: { type: Date, default: null },

  // Dynamic-invoice artefacts returned by auto gateways (AutoGoPay QRIS, Binance Pay link, …)
  paymentQrUrl: { type: String, default: '' },        // AutoGoPay: dynamic QRIS image URL
  paymentCheckoutUrl: { type: String, default: '' },  // AutoGoPay checkout link / Binance checkoutUrl
  paymentExpiryTime: { type: String, default: '' },   // Human-readable expiry from gateway

  // Currency snapshot at time of order (base is USD; totalUsd is canonical)
  currencyCode: { type: String, default: 'IDR' },
  currencyRate: { type: Number, default: 1 },   // 1 USD => rate <currencyCode>
  totalUsd: { type: Number, default: 0 },

  // Auth choice for VPS creation
  authMethod: { type: String, enum: ['password', 'ssh'], default: 'password' },
  sshPublicKey: { type: String, default: '' },
  // Password Mode: pre-generated password (BEFORE provisioning) so the same
  // string is injected into the provider AND delivered to the user.
  generatedPassword: { type: String, default: '' },
  // Provider pool vetted by live health check at buy time (VPS only).
  // Orchestrator will try these first before falling back to global pool.
  preferredApiIds: { type: [String], default: [] },
  // ===== Reward Ecosystem markers =====
  isRewardOrder: { type: Boolean, default: false },
  rewardKind: { type: String, default: '' },
  rewardThreshold: { type: Number, default: 0 },
  loyaltyCounted: { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.model('Order', orderSchema);
module.exports.ORDER_STATUS = ORDER_STATUS;
