const AuditLog = require('../models/AuditLog');

async function log(type, { actor = 'system', refId = '', message = '', meta = {} } = {}) {
  try {
    await AuditLog.create({ type, actor: String(actor), refId: String(refId), message, meta });
  } catch (e) { console.error('AuditLog error:', e.message); }
}

async function recent(limit = 50, filter = {}) {
  return AuditLog.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
}

module.exports = { log, recent };
