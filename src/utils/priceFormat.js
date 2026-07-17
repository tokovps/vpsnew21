// Format price for a specific Telegram user, converting from IDR (legacy storage) to their chosen currency.
// Existing product prices are stored in IDR (rupiah). We treat IDR as the source currency.
const User = require('../models/User');
const currencyService = require('../services/currencyService');
const { rupiah } = require('./format');

async function getUserCurrencyCode(ctx) {
  if (!ctx || !ctx.from) return 'IDR';
  const u = await User.findOne({ telegramId: String(ctx.from.id) }).lean();
  return (u && u.currency) || 'IDR';
}

async function formatForUser(ctx, amountIdr) {
  const code = await getUserCurrencyCode(ctx);
  if (!code || code === 'IDR') return rupiah(amountIdr);
  try {
    const converted = await currencyService.convert(amountIdr, 'IDR', code);
    const cur = await currencyService.getByCode(code);
    return currencyService.format(converted, cur);
  } catch (_) { return rupiah(amountIdr); }
}

// Convert IDR amount to USD (base). Used for gateway calls that expect USD (Binance Pay).
async function idrToUsd(amountIdr) {
  try { return await currencyService.toUsd(amountIdr, 'IDR'); } catch { return amountIdr / 15800; }
}

module.exports = { formatForUser, getUserCurrencyCode, idrToUsd };
