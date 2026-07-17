const Setting = require('../models/Setting');

async function getSettings() {
  let s = await Setting.findOne({ key: 'global' });
  if (!s) s = await Setting.create({ key: 'global' });
  return s;
}

async function updateSetting(patch) {
  const res = await Setting.findOneAndUpdate({ key: 'global' }, patch, { new: true, upsert: true });
  // Trigger catalog refresh if any product-facing field changed.
  try {
    const keys = Object.keys(patch || {});
    const isProductField = keys.some(k =>
      /Price\d$/.test(k) || /Spec\d$/.test(k) || /(Caption|Banner)$/.test(k) || /tierWarranty/i.test(k));
    if (isProductField) require('./catalogService').scheduleUpdate();
  } catch (_) {}
  return res;
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// Resolve banner + caption field name for a (category, tier)
function tierFields(category, tier) {
  const cap = capitalize(tier);
  return { banner: `${category}${cap}Banner`, caption: `${category}${cap}Caption` };
}

// Get spec text & price for (category, tier, slot 1..3)
// Spec text is shared across tiers; price is per (category, tier, slot).
function specOf(settings, category, tier, slot) {
  const cap = capitalize(tier);
  return {
    spec: settings[`${category}Spec${slot}`] || '',
    price: settings[`${category}${cap}Price${slot}`] || 0,
  };
}

// Scope mapping for admin banner/caption editor
const BANNER_SCOPES = {
  home: { banner: 'homeBanner', label: 'Beranda' },
  payment: { banner: 'paymentBanner', label: 'Pembayaran' },
  orders: { banner: 'myOrdersBanner', label: 'Pesanan Saya' },
  vpsLow: { banner: 'vpsLowBanner', label: 'VPS LOW' },
  vpsBasic: { banner: 'vpsBasicBanner', label: 'VPS BASIC' },
  vpsMedium: { banner: 'vpsMediumBanner', label: 'VPS MEDIUM' },
  rdpLow: { banner: 'rdpLowBanner', label: 'RDP LOW' },
  rdpBasic: { banner: 'rdpBasicBanner', label: 'RDP BASIC' },
  rdpMedium: { banner: 'rdpMediumBanner', label: 'RDP MEDIUM' },
};

const CAPTION_SCOPES = {
  home: { caption: 'homeCaption', label: 'Beranda' },
  payment: { caption: 'paymentCaption', label: 'Pembayaran' },
  orders: { caption: 'myOrdersCaption', label: 'Pesanan Saya' },
  vpsLow: { caption: 'vpsLowCaption', label: 'VPS LOW' },
  vpsBasic: { caption: 'vpsBasicCaption', label: 'VPS BASIC' },
  vpsMedium: { caption: 'vpsMediumCaption', label: 'VPS MEDIUM' },
  rdpLow: { caption: 'rdpLowCaption', label: 'RDP LOW' },
  rdpBasic: { caption: 'rdpBasicCaption', label: 'RDP BASIC' },
  rdpMedium: { caption: 'rdpMediumCaption', label: 'RDP MEDIUM' },
  contactAdmin: { caption: 'contactAdminCaption', label: 'CS Admin' },
  joinChannel: { caption: 'joinChannelCaption', label: 'Join Channel' },
  successPayment: { caption: 'successPaymentCaption', label: 'Sukses Pembayaran' },
  rejectPayment: { caption: 'rejectPaymentCaption', label: 'Reject Pembayaran' },
  processingOrder: { caption: 'processingOrderCaption', label: 'Processing Order' },
};

// Resolve regions list per category from settings
function regionsOf(settings, category) {
  return Array.isArray(settings[`${category}Regions`]) ? settings[`${category}Regions`] : [];
}

// VPS OS families (array of strings)
function vpsOsFamilies(settings) {
  return Array.isArray(settings.vpsOsFamilies) ? settings.vpsOsFamilies : [];
}

// VPS OS versions for a given family
function vpsOsVersionsOf(settings, family) {
  const map = settings.vpsOsVersions || {};
  return Array.isArray(map[family]) ? map[family] : [];
}

function rdpWindowsVersions(settings) {
  return Array.isArray(settings.rdpWindowsVersions) ? settings.rdpWindowsVersions : [];
}
function rdpLinuxVersions(settings) {
  return Array.isArray(settings.rdpLinuxVersions) ? settings.rdpLinuxVersions : [];
}

// Warranty text per tier
function warrantyOf(settings, tier) {
  const cap = capitalize(tier);
  return settings[`tierWarranty${cap}`] || '';
}

// Replace text PER PAKET (category + tier). Fallback ke legacy global `tierReplace`
// bila field per-paket masih kosong — supaya instalasi lama tetap konsisten.
function replaceOf(settings, category, tier) {
  const cap = capitalize(tier);
  const perTier = settings[`${category}${cap}Replace`];
  if (perTier != null && String(perTier).trim() !== '') return String(perTier);
  return settings.tierReplace || '';
}

// Manual payment methods have been fully removed. Only auto-gateway
// providers (AutoGoPay, Binance Pay) are supported end-to-end.
const PAYMENT_METHOD_DEFS = [];

// Auto-invoice gateways (enabled via PaymentConfig collection, not Settings toggles)
const AUTO_GATEWAY_DEFS = [
  { key: 'autogopay', label: '⚡ AutoGoPay (Auto QRIS)', gateway: 'autogopay' },
  { key: 'binancepay', label: '⚡ Binance Pay (Crypto)', gateway: 'binancepay' },
];

function allPaymentMethods(_settings) {
  return [];
}

// Async: fetch enabled auto gateways from PaymentConfig collection.
async function allPaymentMethodsAsync(settings) {
  try {
    const PaymentConfig = require('../models/PaymentConfig');
    const autos = await PaymentConfig.find({ enabled: true }).lean();
    return autos.map(a => {
      const def = AUTO_GATEWAY_DEFS.find(d => d.gateway === a.provider);
      if (!def) return null;
      return {
        key: def.key, label: def.label,
        image: settings.homeBanner,
        caption: `⚡ *${def.label}*\n\nBayar otomatis — invoice akan dibuat langsung. Pesanan diproses saat pembayaran diterima gateway.`,
        enabled: true, auto: true, gateway: def.gateway,
      };
    }).filter(Boolean);
  } catch (_) { return []; }
}

function enabledPaymentMethods(settings) {
  return allPaymentMethods(settings).filter(m => m.enabled);
}

async function enabledPaymentMethodsAsync(settings) {
  const all = await allPaymentMethodsAsync(settings);
  return all.filter(m => m.enabled);
}

function paymentMethodByKey(settings, key) {
  return allPaymentMethods(settings).find(m => m.key === key);
}

async function paymentMethodByKeyAsync(settings, key) {
  const all = await allPaymentMethodsAsync(settings);
  return all.find(m => m.key === key);
}

module.exports = {
  getSettings, updateSetting, tierFields, specOf,
  BANNER_SCOPES, CAPTION_SCOPES,
  regionsOf, vpsOsFamilies, vpsOsVersionsOf,
  rdpWindowsVersions, rdpLinuxVersions, warrantyOf, replaceOf,
  PAYMENT_METHOD_DEFS, AUTO_GATEWAY_DEFS,
  allPaymentMethods, enabledPaymentMethods, paymentMethodByKey,
  allPaymentMethodsAsync, enabledPaymentMethodsAsync, paymentMethodByKeyAsync,
};
