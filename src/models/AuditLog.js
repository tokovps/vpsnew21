const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  type: { type: String, required: true, index: true },   // e.g. 'admin.edit', 'payment.paid', 'provision.success', 'api.lock', 'rollback'
  actor: { type: String, default: '' },                  // telegramId or 'system' or 'webhook:<provider>'
  refId: { type: String, default: '', index: true },     // orderId / apiId
  message: { type: String, default: '' },
  meta: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

module.exports = mongoose.model('AuditLog', auditLogSchema);
