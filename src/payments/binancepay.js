// Binance Pay adapter — create order + verify webhook.
// Binance Pay signature: HMAC-SHA512 upper of "timestamp\nnonce\nbody\n" with API Secret.
const axios = require('axios');
const crypto = require('crypto');
const paymentConfig = require('../services/paymentConfigService');

const BASE = 'https://bpay.binanceapi.com';

async function createInvoice({ orderId, amountUsd, description }) {
  const cfg = await paymentConfig.get('binancepay');
  if (!cfg.enabled) throw new Error('Binance Pay disabled');
  if (!cfg.apiKey || !cfg.apiSecret) throw new Error('Binance Pay keys missing');
  const body = JSON.stringify({
    env: { terminalType: 'WEB' },
    merchantTradeNo: String(orderId).slice(0, 32),
    orderAmount: Number(amountUsd).toFixed(2),
    currency: 'USDT',
    goods: {
      goodsType: '02', goodsCategory: 'Z000',
      referenceGoodsId: String(orderId),
      goodsName: description || 'VPS Order',
    },
  });
  const timestamp = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = `${timestamp}\n${nonce}\n${body}\n`;
  const signature = crypto.createHmac('sha512', cfg.apiSecret).update(payload).digest('hex').toUpperCase();
  try {
    const r = await axios.post(`${BASE}/binancepay/openapi/v3/order`, body, {
      headers: {
        'Content-Type': 'application/json',
        'BinancePay-Timestamp': timestamp,
        'BinancePay-Nonce': nonce,
        'BinancePay-Certificate-SN': cfg.apiKey,
        'BinancePay-Signature': signature,
      },
      timeout: 30000,
    });
    return { ok: true, data: r.data };
  } catch (e) {
    return { ok: false, error: (e.response && e.response.data) || e.message };
  }
}

function verifyWebhook(rawBody, headers) {
  const cfg = headers.__cfg;
  if (!cfg || !cfg.apiSecret) return { ok: false, reason: 'no secret' };
  const timestamp = headers['binancepay-timestamp'] || '';
  const nonce = headers['binancepay-nonce'] || '';
  const sig = (headers['binancepay-signature'] || '').toUpperCase();
  if (!timestamp || !nonce || !sig) return { ok: false, reason: 'missing headers' };
  const payload = `${timestamp}\n${nonce}\n${rawBody}\n`;
  const mac = crypto.createHmac('sha512', cfg.apiSecret).update(payload).digest('hex').toUpperCase();
  if (mac !== sig) return { ok: false, reason: 'bad signature' };
  const drift = Math.abs(Date.now() - Number(timestamp));
  if (Number.isFinite(drift) && drift > 5 * 60 * 1000) return { ok: false, reason: 'stale' };
  return { ok: true };
}

async function testConnection() {
  const cfg = await paymentConfig.get('binancepay');
  const checks = [];
  if (!cfg.apiKey) checks.push({ ok: false, label: 'Invalid API Key (kosong)' });
  if (!cfg.apiSecret) checks.push({ ok: false, label: 'Invalid API Secret (kosong)' });
  if (checks.length) {
    await paymentConfig.update('binancepay', { lastTestAt: new Date(), lastTestOk: false, lastError: 'keys missing' });
    // Still add webhook check for completeness
    const webhookOk = !!cfg.webhookUrl && /^https?:\/\/.+/.test(cfg.webhookUrl);
    checks.push({ ok: webhookOk, label: webhookOk ? 'Webhook Configured' : 'Invalid Webhook URL' });
    return { ok: false, error: 'Keys missing', checks };
  }
  try {
    const timestamp = Date.now().toString();
    const nonce = crypto.randomBytes(16).toString('hex');
    const body = '{}';
    const payload = `${timestamp}\n${nonce}\n${body}\n`;
    const signature = crypto.createHmac('sha512', cfg.apiSecret).update(payload).digest('hex').toUpperCase();
    const r = await axios.post(`${BASE}/binancepay/openapi/certificates`, body, {
      headers: {
        'Content-Type': 'application/json',
        'BinancePay-Timestamp': timestamp,
        'BinancePay-Nonce': nonce,
        'BinancePay-Certificate-SN': cfg.apiKey,
        'BinancePay-Signature': signature,
      }, timeout: 10000,
    });
    const success = r.data && r.data.status === 'SUCCESS';
    // Binance returns SUCCESS when both key + signature valid
    checks.push({ ok: success, label: success ? 'API Key Valid' : 'Invalid API Key' });
    checks.push({ ok: success, label: success ? 'API Secret Valid' : 'Invalid API Secret' });
    const webhookOk = !!cfg.webhookUrl && /^https?:\/\/.+/.test(cfg.webhookUrl);
    checks.push({ ok: webhookOk, label: webhookOk ? 'Webhook Configured' : 'Invalid Webhook URL' });
    const allOk = success && webhookOk;
    await paymentConfig.update('binancepay', {
      lastTestAt: new Date(), lastTestOk: allOk,
      lastError: allOk ? '' : (r.data && r.data.errorMessage) || checks.filter(c => !c.ok).map(c => c.label).join(', '),
    });
    return allOk
      ? { ok: true, checks }
      : { ok: false, error: (r.data && r.data.errorMessage) || checks.filter(c => !c.ok).map(c => c.label).join(', '), checks };
  } catch (e) {
    const isTimeout = e.code === 'ECONNABORTED' || /timeout/i.test(e.message);
    checks.push({ ok: false, label: isTimeout ? 'Connection Timeout' : 'Invalid API Key / Secret' });
    const webhookOk = !!cfg.webhookUrl && /^https?:\/\/.+/.test(cfg.webhookUrl);
    checks.push({ ok: webhookOk, label: webhookOk ? 'Webhook Configured' : 'Invalid Webhook URL' });
    await paymentConfig.update('binancepay', { lastTestAt: new Date(), lastTestOk: false, lastError: e.message.slice(0, 200) });
    return { ok: false, error: isTimeout ? 'Connection Timeout' : e.message, checks };
  }
}

async function refundInvoice({ orderId, gatewayRef }) {
  const cfg = await paymentConfig.get('binancepay');
  if (!cfg.apiKey || !cfg.apiSecret) return { ok: false, error: 'keys missing' };
  const body = JSON.stringify({
    refundRequestId: `rf-${orderId}-${Date.now()}`.slice(0, 32),
    prepayId: gatewayRef,
    refundAmount: '0',   // Full refund — Binance interprets 0 as full
    refundReason: 'Provisioning failed',
  });
  const timestamp = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = `${timestamp}\n${nonce}\n${body}\n`;
  const signature = crypto.createHmac('sha512', cfg.apiSecret).update(payload).digest('hex').toUpperCase();
  try {
    const r = await axios.post(`${BASE}/binancepay/openapi/order/refund`, body, {
      headers: {
        'Content-Type': 'application/json',
        'BinancePay-Timestamp': timestamp,
        'BinancePay-Nonce': nonce,
        'BinancePay-Certificate-SN': cfg.apiKey,
        'BinancePay-Signature': signature,
      }, timeout: 30000,
    });
    const ok = r.data && r.data.status === 'SUCCESS';
    return { ok, data: r.data, error: ok ? null : (r.data && r.data.errorMessage) };
  } catch (e) { return { ok: false, error: (e.response && e.response.data) || e.message }; }
}

module.exports = { createInvoice, verifyWebhook, testConnection, refundInvoice };
