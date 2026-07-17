// Home caption builder — SIMPLIFIED (2026-01 revision).
// Per user request: banner stays center-stage, caption is ringkas — only:
//   • STATUS LAYANAN (VPS / RDP / Payment)
//   • STOCK READY  (VPS realtime / RDP realtime / ETA)
//   • "Silakan Pilih Menu Dibawah 👇"
//
// REMOVED (were "AI slop" / info-overload): SELAMAT DATANG, homeSubtitle,
// PROMO AKTIF block, INFORMASI USER, INFORMASI BOT, homeFooter.
// The corresponding Setting fields (homeTitle/homeSubtitle/homeFooter) are
// deprecated — kept in the model for backwards-compat but never rendered.
const { getSettings } = require('./settingService');
const catalogService = require('./catalogService');
const PaymentConfig = require('../models/PaymentConfig');

const SEP = '━━━━━━━━━━━━━━━━━━';

function _emoji(state) {
  return state === 'online' ? '🟢' : state === 'limited' ? '🟡' : '🔴';
}
function _label(state) {
  return state === 'online' ? 'Online' : state === 'limited' ? 'Terbatas' : 'Offline';
}
function _stateFromStock(n) {
  if (n > 5) return 'online';
  if (n >= 1) return 'limited';
  return 'offline';
}
async function _paymentState() {
  try {
    const on = await PaymentConfig.countDocuments({ enabled: true });
    return on > 0 ? 'online' : 'offline';
  } catch (_) { return 'offline'; }
}

async function buildHomeCaption(_ctx) {
  const [s, stock, payState] = await Promise.all([
    getSettings(),
    catalogService.getStock(),
    _paymentState(),
  ]);
  const stockN = Number(stock.ready) || 0;
  const vpsState = _stateFromStock(stockN);
  const rdpState = _stateFromStock(stockN);
  const eta = String(stock.etaLine || '').replace(/^[^A-Za-z0-9±]+/, '').replace(/^Estimasi Aktivasi\s*:\s*±?/i, '');
  const etaText = (s.homeActivationOverride && String(s.homeActivationOverride).trim()) || eta || '1 Menit';

  const lines = [
    SEP,
    '',
    '🟢 STATUS LAYANAN',
    '',
    `☁ VPS : ${_emoji(vpsState)} ${_label(vpsState)}`,
    `🖥 RDP : ${_emoji(rdpState)} ${_label(rdpState)}`,
    `💳 Payment : ${_emoji(payState)} ${_label(payState)}`,
    '',
    SEP,
    '',
    '📦 STOCK READY',
    '',
    `☁ VPS : ${stockN}`,
    `🖥 RDP : ${stockN}`,
    `⚡ Estimasi Aktivasi : ±${etaText}`,
    '',
    SEP,
    '',
    s.homeMenuPrompt || 'Silakan Pilih Menu Dibawah 👇',
  ];
  return lines.join('\n');
}

module.exports = { buildHomeCaption };
