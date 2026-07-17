const PaymentConfig = require('../models/PaymentConfig');
const audit = require('./auditService');

const KNOWN = ['autogopay', 'binancepay'];

async function ensureSeed() {
  for (const p of KNOWN) {
    await PaymentConfig.findOneAndUpdate({ provider: p }, { $setOnInsert: { provider: p } }, { upsert: true, new: true });
  }
}

async function get(provider) {
  return PaymentConfig.findOneAndUpdate({ provider }, { $setOnInsert: { provider } }, { new: true, upsert: true });
}

async function update(provider, patch) {
  return PaymentConfig.findOneAndUpdate({ provider }, { $set: patch }, { new: true, upsert: true });
}

async function toggle(provider) {
  const c = await get(provider);
  return update(provider, { enabled: !c.enabled });
}

async function markCallback(provider, ok, err = '') {
  const patch = { lastCallbackAt: new Date() };
  const inc = ok ? { successCount: 1 } : { failedCount: 1 };
  if (!ok) patch.lastError = String(err).slice(0, 300);
  const c = await PaymentConfig.findOneAndUpdate({ provider }, { $set: patch, $inc: inc }, { new: true, upsert: true });
  await audit.log(ok ? 'webhook.ok' : 'webhook.fail', { actor: 'webhook:' + provider, message: err });
  return c;
}

async function listAll() { return PaymentConfig.find({}).lean(); }

module.exports = { KNOWN, ensureSeed, get, update, toggle, markCallback, listAll };
