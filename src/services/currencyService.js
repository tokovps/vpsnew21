const axios = require('axios');
const Currency = require('../models/Currency');
const Setting = require('../models/Setting');
const audit = require('./auditService');

const DEFAULTS = [
  { code: 'USD', name: 'US Dollar', symbol: '$',  rate: 1,      isBase: true },
  { code: 'IDR', name: 'Rupiah',    symbol: 'Rp', rate: 15800 },
  { code: 'EUR', name: 'Euro',      symbol: '€',  rate: 0.92 },
  { code: 'SGD', name: 'SG Dollar', symbol: 'S$', rate: 1.34 },
  { code: 'JPY', name: 'Yen',       symbol: '¥',  rate: 155 },
  { code: 'MYR', name: 'Ringgit',   symbol: 'RM', rate: 4.7 },
  { code: 'PHP', name: 'Peso',      symbol: '₱',  rate: 58 },
  { code: 'THB', name: 'Baht',      symbol: '฿',  rate: 36 },
];

async function ensureSeed() {
  const c = await Currency.countDocuments();
  if (c > 0) return;
  await Currency.insertMany(DEFAULTS);
}

async function list() { return Currency.find({}).sort({ isBase: -1, code: 1 }).lean(); }
async function enabledList() { return Currency.find({ enabled: true }).sort({ isBase: -1, code: 1 }).lean(); }
async function getByCode(code) { return Currency.findOne({ code: String(code || '').toUpperCase() }); }

async function upsert(code, patch) {
  return Currency.findOneAndUpdate({ code: String(code).toUpperCase() }, { $set: patch }, { new: true, upsert: true });
}

async function remove(code) {
  const c = await Currency.findOne({ code: String(code).toUpperCase() });
  if (!c || c.isBase) return null;
  await Currency.deleteOne({ _id: c._id });
  return c;
}

// Convert amount in `from` -> `to` (both currency codes). Both rates relative to USD base.
async function convert(amount, from, to) {
  const [f, t] = await Promise.all([getByCode(from), getByCode(to)]);
  if (!f || !t) return amount;
  const usd = amount / (f.rate || 1);
  return usd * (t.rate || 1);
}

async function fromUsd(amountUsd, to) {
  const t = await getByCode(to);
  if (!t) return amountUsd;
  return amountUsd * (t.rate || 1);
}

async function toUsd(amount, from) {
  const f = await getByCode(from);
  if (!f) return amount;
  return amount / (f.rate || 1);
}

function format(amount, cur) {
  const n = Math.round(Number(amount || 0) * 100) / 100;
  const s = cur && cur.symbol ? cur.symbol : '';
  const code = cur && cur.code ? cur.code : '';
  return `${s ? s + ' ' : ''}${n.toLocaleString('en-US')}${code ? ' ' + code : ''}`;
}

// Fetch latest rates from exchangerate-api.com (free tier open endpoint: /v4/latest/USD)
async function syncAuto() {
  const settings = await Setting.findOne({ key: 'global' });
  const provider = (settings && settings.exchangeProvider) || 'exchangerate-api';
  const apiKey = (settings && settings.exchangeApiKey) || '';
  try {
    let rates = {};
    if (provider === 'exchangerate-api') {
      const url = apiKey
        ? `https://v6.exchangerate-api.com/v6/${apiKey}/latest/USD`
        : `https://api.exchangerate-api.com/v4/latest/USD`;
      const r = await axios.get(url, { timeout: 20000 });
      rates = r.data.conversion_rates || r.data.rates || {};
    }
    const codes = Object.keys(rates);
    if (!codes.length) throw new Error('No rates returned');
    const enabled = await Currency.find({});
    for (const c of enabled) {
      if (c.isBase) continue;
      if (rates[c.code]) {
        c.rate = rates[c.code];
        c.updatedFrom = 'auto';
        c.lastUpdatedAt = new Date();
        await c.save();
      }
    }
    await Setting.findOneAndUpdate({ key: 'global' }, { $set: { exchangeLastSyncAt: new Date().toISOString(), exchangeLastError: '' } });
    await audit.log('currency.sync', { message: `synced ${codes.length} rates` });
    return { ok: true, count: codes.length };
  } catch (e) {
    await Setting.findOneAndUpdate({ key: 'global' }, { $set: { exchangeLastError: e.message.slice(0, 300) } });
    await audit.log('currency.sync.fail', { message: e.message });
    return { ok: false, error: e.message };
  }
}

function startAutoSync(intervalMs = 6 * 60 * 60 * 1000) {
  setInterval(async () => {
    const s = await Setting.findOne({ key: 'global' });
    if (s && s.exchangeMode === 'auto') await syncAuto();
  }, intervalMs);
}

module.exports = { ensureSeed, list, enabledList, getByCode, upsert, remove, convert, fromUsd, toUsd, format, syncAuto, startAutoSync };
