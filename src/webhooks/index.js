// Express routes for payment webhooks (mounted from src/app.js).
const express = require('express');
const paymentConfig = require('../services/paymentConfigService');
const Order = require('../models/Order');
const autogopay = require('../payments/autogopay');
const binancepay = require('../payments/binancepay');
const { processPaidOrder } = require('../services/paymentProcessor');

// Simple in-memory replay-nonce cache
const seen = new Map();
function seenRecently(id, ttlMs = 10 * 60 * 1000) {
  if (!id) return false;
  const now = Date.now();
  for (const [k, ts] of seen) if (now - ts > ttlMs) seen.delete(k);
  if (seen.has(id)) return true;
  seen.set(id, now);
  return false;
}

function router(bot) {
  const r = express.Router();

  // Raw-body middleware for signature validation
  r.use(express.json({
    verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
  }));

  r.get('/webhook/status', async (_req, res) => {
    const list = await paymentConfig.listAll();
    res.json({ ok: true, providers: list });
  });

  r.post('/webhook/autogopay', async (req, res) => {
    const cfg = await paymentConfig.get('autogopay');
    req.headers.__cfg = cfg;
    const v = autogopay.verifyWebhook(req.rawBody || '', req.headers);
    if (!v.ok) {
      console.warn('[webhook:autogopay] rejected:', v.reason);
      await paymentConfig.markCallback('autogopay', false, v.reason);
      return res.status(401).json({ ok: false, error: v.reason });
    }
    // Official payload shape:
    //   { event, timestamp, transaction: { id, amount, status, ... } }
    const body = req.body || {};
    const tx = body.transaction || {};
    const eventId = tx.id || body.event_id || '';
    if (seenRecently(eventId)) {
      console.log('[webhook:autogopay] replay ignored:', eventId);
      return res.json({ ok: true, replay: true });
    }
    const status = String(tx.status || body.status || '').toLowerCase();
    console.log('[webhook:autogopay] received', { event: body.event, id: tx.id, status });
    // Resolve order: prefer external_id (if provider echoes it back), else
    // look up by paymentGatewayRef which we stored as transaction_id.
    const externalId = body.external_id || tx.external_id || '';
    let order = externalId ? await Order.findById(externalId).catch(() => null) : null;
    if (!order && tx.id) {
      order = await Order.findOne({ paymentGateway: 'autogopay', paymentGatewayRef: tx.id }).catch(() => null);
    }
    if (!order) {
      console.warn('[webhook:autogopay] order not found for tx', tx.id);
      await paymentConfig.markCallback('autogopay', false, 'order not found');
      return res.status(404).json({ ok: false });
    }
    // AutoGoPay success status is "settlement"; accept common aliases too.
    const isPaid = ['settlement', 'paid', 'success', 'completed'].includes(status);
    if (isPaid) {
      const result = await processPaidOrder(bot, order._id, {
        gateway: 'autogopay',
        gatewayRef: tx.id || order.paymentGatewayRef,
        actor: 'webhook:autogopay',
      });
      console.log('[webhook:autogopay] processPaidOrder →', result.status);
    }
    await paymentConfig.markCallback('autogopay', true);
    res.json({ success: true });
  });

  r.post('/webhook/binancepay', async (req, res) => {
    const cfg = await paymentConfig.get('binancepay');
    req.headers.__cfg = cfg;
    const v = binancepay.verifyWebhook(req.rawBody || '', req.headers);
    if (!v.ok) {
      await paymentConfig.markCallback('binancepay', false, v.reason);
      return res.status(401).json({ ok: false, error: v.reason });
    }
    const body = req.body || {};
    const bizId = body.bizId || body.data && body.data.merchantTradeNo || '';
    if (seenRecently(bizId)) return res.json({ ok: true, replay: true });
    const externalId = body.data && body.data.merchantTradeNo || body.merchantTradeNo || '';
    const type = String(body.bizType || '').toUpperCase();
    const status = String(body.bizStatus || '').toUpperCase();
    const order = externalId ? await Order.findById(externalId).catch(() => null) : null;
    if (!order) {
      await paymentConfig.markCallback('binancepay', false, 'order not found');
      return res.status(404).json({ ok: false });
    }
    if (type === 'PAY' && ['PAY_SUCCESS'].includes(status)) {
      const result = await processPaidOrder(bot, order._id, {
        gateway: 'binancepay',
        gatewayRef: bizId,
        actor: 'webhook:binancepay',
      });
      console.log('[webhook:binancepay] processPaidOrder →', result.status);
    }
    await paymentConfig.markCallback('binancepay', true);
    res.json({ returnCode: 'SUCCESS', returnMessage: null });
  });

  return r;
}

module.exports = { router };
