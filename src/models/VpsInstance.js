const mongoose = require('mongoose');

const vpsInstanceSchema = new mongoose.Schema({
  orderId: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  provider: { type: String, required: true },
  apiId: { type: String, default: '' },

  instanceId: { type: String, default: '' },     // provider-side instance id
  region: { type: String, default: '' },
  imageId: { type: String, default: '' },
  osLabel: { type: String, default: '' },
  size: { type: String, default: '' },
  publicIp: { type: String, default: '' },
  privateIp: { type: String, default: '' },
  username: { type: String, default: 'root' },
  password: { type: String, default: '' },
  sshKeyName: { type: String, default: '' },

  status: { type: String, default: 'creating' }, // creating | running | stopped | offline | error | terminated | destroyed
  // ═══ LIFECYCLE MARKER (workflow separation guarantee) ═══════════════════
  // 'vps' → droplet Ubuntu Linux (VPS orchestrator). SSH root+password/key.
  // 'rdp' → droplet yang sudah/akan di-reinstall menjadi Windows via
  //         bin456789/reinstall (RDP orchestrator). SEKALI sebuah droplet
  //         masuk lifecycle 'rdp', ia TIDAK PERNAH boleh diperlakukan sebagai
  //         VPS Linux — meskipun kemudian di-delete dan quota provider
  //         kembali. Setiap pembelian VPS Linux berikutnya WAJIB memicu
  //         pembuatan droplet Ubuntu BARU dari `adapter.createInstance`,
  //         tidak boleh me-refer instance lama apapun.
  lifecycle: { type: String, enum: ['vps', 'rdp'], default: 'vps', index: true },
  errorMessage: { type: String, default: '' },
  raw: { type: mongoose.Schema.Types.Mixed, default: {} },
  lastHealthAt: { type: Date, default: null },
  lastHealthStatus: { type: String, default: '' },
  hostname: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('VpsInstance', vpsInstanceSchema);
