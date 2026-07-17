// AutoGoPay adapter — 100% compliant with the official docs at
// https://autogopay.site/docs
//
//   Base URL : https://v1-gateway.autogopay.site
//   Auth     : Authorization: Bearer <API_KEY>
//   Endpoints used here:
//     POST /transactions       -> list latest transactions (used for connection test)
//     POST /qris/generate      -> create QRIS invoice
//     POST /qris/status        -> query transaction status
//     POST /qris/cancel        -> cancel a pending QRIS transaction (used as "refund"
//                                 for pending orders; AutoGoPay has no refund endpoint)
//   Webhook signature: HMAC-SHA256(rawBody, API_KEY) === header `X-Signature`
//
const axios = require('axios');
const crypto = require('crypto');

const paymentConfig = require('../services/paymentConfigService');

const BASE_URL = 'https://v1-gateway.autogopay.site';

function authHeaders(apiKey, json = true) {
  const h = { Authorization: `Bearer ${apiKey}` };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

// Map network / HTTP errors into human-readable, distinct messages.
// NEVER collapse everything into "Invalid API Key".
function describeError(e) {
  // Network-layer errors (no HTTP response)
  const netCode = e && e.code;
  if (netCode === 'ENOTFOUND')      return { label: 'Host API AutoGoPay tidak ditemukan (ENOTFOUND)', kind: 'network' };
  if (netCode === 'ECONNREFUSED')   return { label: 'Server AutoGoPay tidak dapat dihubungi (ECONNREFUSED)', kind: 'network' };
  if (netCode === 'ETIMEDOUT' || netCode === 'ECONNABORTED' || /timeout/i.test(e && e.message || '')) {
    return { label: 'Koneksi timeout (ETIMEDOUT)', kind: 'timeout' };
  }
  if (netCode === 'EAI_AGAIN')      return { label: 'DNS gagal me-resolve host AutoGoPay (EAI_AGAIN)', kind: 'network' };
  if (netCode === 'ECONNRESET')     return { label: 'Koneksi diputus oleh server (ECONNRESET)', kind: 'network' };
  if (netCode === 'CERT_HAS_EXPIRED' || /certificate/i.test(e && e.message || '')) {
    return { label: 'Masalah SSL/TLS ke server AutoGoPay', kind: 'network' };
  }

  // HTTP-layer errors
  const status = e && e.response && e.response.status;
  if (status === 400) return { label: 'Request tidak valid (400 Bad Request)', kind: 'client', status };
  if (status === 401) return { label: 'API Key tidak valid (401 Unauthorized)', kind: 'auth', status };
  if (status === 403) return { label: 'API Key ditolak (403 Forbidden)', kind: 'auth', status };
  if (status === 404) return { label: 'Endpoint tidak ditemukan (404 Not Found)', kind: 'client', status };
  if (status === 405) return { label: 'Metode tidak diizinkan (405)', kind: 'client', status };
  if (status === 422) return { label: 'Data tidak valid (422 Unprocessable Entity)', kind: 'client', status };
  if (status === 429) return { label: 'Terlalu banyak request (429 Rate Limited)', kind: 'client', status };
  if (typeof status === 'number' && status >= 500 && status < 600) {
    return { label: `Server AutoGoPay sedang bermasalah (${status})`, kind: 'server', status };
  }

  // Fallback — keep the underlying message rather than mislabelling it.
  const msg = (e && (e.message || String(e))) || 'unknown error';
  return { label: `Error tidak dikenal: ${msg.slice(0, 160)}`, kind: 'unknown' };
}

// ---------------------------------------------------------------------------
// Create QRIS invoice — POST /qris/generate  { amount }
// ---------------------------------------------------------------------------
async function createInvoice({ orderId, amountIdr /*, description */ }) {
  const cfg = await paymentConfig.get('autogopay');
  if (!cfg.enabled) return { ok: false, error: 'AutoGoPay disabled' };
  if (!cfg.apiKey)  return { ok: false, error: 'AutoGoPay apiKey missing' };

  const amount = Number(amountIdr);
  if (!Number.isFinite(amount) || amount < 1 || amount > 10_000_000) {
    return { ok: false, error: `Amount tidak valid (harus 1 - 10.000.000). Got: ${amountIdr}` };
  }

  try {
    const r = await axios.post(`${BASE_URL}/qris/generate`, { amount },
      { headers: authHeaders(cfg.apiKey), timeout: 30000 });
    const body = r.data || {};
    if (body.success === false) {
      return { ok: false, error: body.message || 'AutoGoPay returned success=false' };
    }
    // Unwrap the { success, data: {...} } envelope so callers can access
    // transaction_id / checkout_url / qr_string / qr_url directly on `data`.
    const data = body.data || {};
    // Convenience alias — the shared payment renderer looks for `id`.
    if (data.transaction_id && !data.id) data.id = data.transaction_id;
    // Attach our internal order id for cross-reference (not sent to API).
    data.external_id = String(orderId);
    return { ok: true, data };
  } catch (e) {
    const d = describeError(e);
    return { ok: false, error: d.label, status: d.status, kind: d.kind, response: e.response && e.response.data };
  }
}

// ---------------------------------------------------------------------------
// Query transaction status — POST /qris/status { transaction_id }
// ---------------------------------------------------------------------------
async function getStatus(transactionId) {
  const cfg = await paymentConfig.get('autogopay');
  if (!cfg.apiKey) return { ok: false, error: 'apiKey missing' };
  try {
    const r = await axios.post(`${BASE_URL}/qris/status`, { transaction_id: transactionId },
      { headers: authHeaders(cfg.apiKey), timeout: 15000 });
    return { ok: true, data: (r.data && r.data.data) || r.data };
  } catch (e) {
    const d = describeError(e);
    return { ok: false, error: d.label, status: d.status, kind: d.kind };
  }
}

// ---------------------------------------------------------------------------
// Verify webhook signature per official docs:
//   HMAC-SHA256(rawBody, API_KEY) === X-Signature
// ---------------------------------------------------------------------------
function verifyWebhook(rawBody, headers) {
  const cfg = headers.__cfg;
  if (!cfg) return { ok: false, reason: 'no config' };
  if (!cfg.apiKey) return { ok: false, reason: 'apiKey missing on server' };

  const sig = headers['x-signature'] || headers['X-Signature'] || '';
  if (!sig) return { ok: false, reason: 'missing X-Signature header' };
  // Some gateways prefix with "sha256=" — strip it before comparing.
  const provided = String(sig).replace(/^sha256=/i, '').trim();

  const mac = crypto.createHmac('sha256', cfg.apiKey).update(rawBody || '').digest('hex');
  if (!safeEqual(mac, provided)) return { ok: false, reason: 'invalid signature' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Test connection — official recommendation: call the list-transactions endpoint
//   POST /transactions   (Bearer auth)
// It is safe (read-only), always available, and returns 401/403 for invalid keys.
// ---------------------------------------------------------------------------
async function testConnection() {
  const cfg = await paymentConfig.get('autogopay');
  const checks = [];

  // 1. API Key present?
  if (!cfg.apiKey) {
    checks.push({ ok: false, label: 'API Key kosong' });
    await paymentConfig.update('autogopay', {
      lastTestAt: new Date(), lastTestOk: false, lastError: 'API Key kosong',
    });
    return { ok: false, error: 'API Key kosong', checks };
  }

  // 2. Live call to /transactions to validate the key against the real API.
  let apiOk = false;
  let apiLabel = '';
  let apiErr = '';
  try {
    const r = await axios.post(`${BASE_URL}/transactions`, {},
      { headers: authHeaders(cfg.apiKey), timeout: 10000, validateStatus: () => true });
    if (r.status >= 200 && r.status < 300 && r.data && r.data.success !== false) {
      apiOk = true;
      apiLabel = 'API Key valid — koneksi ke AutoGoPay OK';
    } else if (r.status === 401) {
      apiLabel = 'API Key tidak valid (401 Unauthorized)';
      apiErr = apiLabel;
    } else if (r.status === 403) {
      apiLabel = 'API Key ditolak (403 Forbidden)';
      apiErr = apiLabel;
    } else if (r.status === 404) {
      apiLabel = 'Endpoint /transactions tidak ditemukan (404)';
      apiErr = apiLabel;
    } else if (r.status >= 500) {
      apiLabel = `Server AutoGoPay bermasalah (${r.status})`;
      apiErr = apiLabel;
    } else {
      const msg = (r.data && (r.data.message || r.data.error)) || `HTTP ${r.status}`;
      apiLabel = `Gagal validasi (${msg})`;
      apiErr = apiLabel;
    }
  } catch (e) {
    const d = describeError(e);
    apiLabel = d.label;
    apiErr = d.label;
  }
  checks.push({ ok: apiOk, label: apiLabel });

  // 3. Local sanity checks on admin-provided values (do NOT block connection status).
  const qrisValid = !!cfg.qrisString && cfg.qrisString.length >= 50;
  checks.push({ ok: qrisValid, label: qrisValid ? 'QRIS String terisi' : 'QRIS String kosong / terlalu pendek (opsional)' });

  const webhookValid = !!cfg.webhookUrl && /^https:\/\/.+/i.test(cfg.webhookUrl);
  checks.push({ ok: webhookValid, label: webhookValid ? 'Webhook URL valid (HTTPS)' : 'Webhook URL kosong atau bukan HTTPS' });

  // Connection status is defined solely by the API reachability check.
  await paymentConfig.update('autogopay', {
    lastTestAt: new Date(),
    lastTestOk: apiOk,
    lastError: apiOk ? '' : apiErr,
  });

  return apiOk
    ? { ok: true, checks }
    : { ok: false, error: apiErr || 'Connection failed', checks };
}

function safeEqual(a, b) {
  try {
    const ba = Buffer.from(a); const bb = Buffer.from(b);
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// AutoGoPay does not expose a public /refund endpoint. For pending
// transactions we cancel via POST /qris/cancel; already-settled ones cannot be
// refunded programmatically.
// ---------------------------------------------------------------------------
async function refundInvoice({ orderId, gatewayRef /*, amountIdr */ }) {
  const cfg = await paymentConfig.get('autogopay');
  if (!cfg.apiKey) return { ok: false, error: 'apiKey missing' };
  const transactionId = gatewayRef || orderId;
  try {
    const r = await axios.post(`${BASE_URL}/qris/cancel`, { transaction_id: String(transactionId) },
      { headers: authHeaders(cfg.apiKey), timeout: 15000, validateStatus: () => true });
    if (r.status >= 200 && r.status < 300 && r.data && r.data.success !== false) {
      return { ok: true, data: r.data.data || r.data };
    }
    return {
      ok: false,
      error: (r.data && (r.data.message || r.data.error)) || `HTTP ${r.status}`,
      status: r.status,
    };
  } catch (e) {
    const d = describeError(e);
    return { ok: false, error: d.label, status: d.status, kind: d.kind };
  }
}

module.exports = { createInvoice, verifyWebhook, testConnection, refundInvoice, getStatus, BASE_URL };
