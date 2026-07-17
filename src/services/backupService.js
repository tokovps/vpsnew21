// Backup/restore: export & import all configuration to/from JSON.
const Setting = require('../models/Setting');
const ProviderApi = require('../models/ProviderApi');
const PaymentConfig = require('../models/PaymentConfig');
const Currency = require('../models/Currency');
const Translation = require('../models/Translation');

async function exportAll() {
  const [settings, providers, payments, currencies, translations] = await Promise.all([
    Setting.findOne({ key: 'global' }).lean(),
    ProviderApi.find({}).lean(),
    PaymentConfig.find({}).lean(),
    Currency.find({}).lean(),
    Translation.find({}).lean(),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    settings,
    providers,
    payments,
    currencies,
    translations,
  };
}

async function importAll(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid payload');
  const { settings, providers, payments, currencies, translations } = payload;
  const report = { settings: 0, providers: 0, payments: 0, currencies: 0, translations: 0 };
  if (settings && typeof settings === 'object') {
    const patch = { ...settings }; delete patch._id; delete patch.__v; delete patch.key;
    await Setting.findOneAndUpdate({ key: 'global' }, { $set: patch }, { upsert: true, new: true });
    report.settings = 1;
  }
  if (Array.isArray(providers)) {
    for (const p of providers) {
      const q = { ...p }; delete q._id; delete q.__v;
      await ProviderApi.findOneAndUpdate({ provider: q.provider, label: q.label || '' }, { $set: q }, { upsert: true });
      report.providers++;
    }
  }
  if (Array.isArray(payments)) {
    for (const p of payments) {
      const q = { ...p }; delete q._id; delete q.__v;
      await PaymentConfig.findOneAndUpdate({ provider: q.provider }, { $set: q }, { upsert: true });
      report.payments++;
    }
  }
  if (Array.isArray(currencies)) {
    for (const c of currencies) {
      const q = { ...c }; delete q._id; delete q.__v;
      await Currency.findOneAndUpdate({ code: q.code }, { $set: q }, { upsert: true });
      report.currencies++;
    }
  }
  if (Array.isArray(translations)) {
    for (const t of translations) {
      const q = { ...t }; delete q._id; delete q.__v;
      await Translation.findOneAndUpdate({ key: q.key }, { $set: q }, { upsert: true });
      report.translations++;
    }
  }
  return report;
}

module.exports = { exportAll, importAll };
