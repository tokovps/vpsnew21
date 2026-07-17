// Central "order became paid" pipeline. Both the AutoGoPay/Binance webhook AND
// the manual "Cek Status" button funnel through this single function so the
// behaviour is guaranteed identical: no possible state where the user has paid
// but the VPS is never created.
//
// Contract:
//   processPaidOrder(bot, orderOrId, { gateway, gatewayRef, actor }) -> {
//     ok: bool, status: 'processed'|'already'|'not_found'|'not_waiting'|'error',
//     order?, error?,
//   }
//
// Idempotent: repeated calls for the same order return status='already' after
// the first successful invocation and never trigger a second provisioning run.
//
const Order = require('../models/Order');
const audit = require('./auditService');
const { tryLock, clearLock } = require('../utils/locks');
const { provisionOrder } = require('../provision/orchestrator');
const { provisionRdpOrder } = require('../provision/rdp/rdpOrchestrator');
const { config } = require('../config');

async function processPaidOrder(bot, orderOrId, opts = {}) {
  const id = typeof orderOrId === 'string' || typeof orderOrId === 'number'
    ? String(orderOrId)
    : String(orderOrId && orderOrId._id);
  if (!id) return { ok: false, status: 'not_found' };

  // Serialize per-order to prevent race between webhook & Cek Status.
  const lockKey = `paid:${id}`;
  if (!tryLock(lockKey, 15000)) {
    return { ok: false, status: 'busy' };
  }

  try {
    const order = await Order.findById(id);
    if (!order) return { ok: false, status: 'not_found' };

    if (order.status !== 'waiting_payment') {
      // Already processed once — this is normal for webhook retries or a
      // "Cek Status" click that arrives after the webhook.
      return { ok: true, status: 'already', order };
    }

    const patch = {
      status: 'processing',
      paidAt: new Date(),
    };
    if (opts.gateway)    patch.paymentGateway = opts.gateway;
    if (opts.gatewayRef) patch.paymentGatewayRef = opts.gatewayRef;

    await Order.findByIdAndUpdate(order._id, { $set: patch });
    await audit.log('payment.paid', {
      refId: order._id,
      message: opts.gateway || order.paymentGateway || 'unknown',
      actor: opts.actor || 'processPaidOrder',
    });

    const fresh = await Order.findById(order._id);
    console.log('[processPaidOrder] paid → provisioning', String(fresh._id),
      { gateway: fresh.paymentGateway, ref: fresh.paymentGatewayRef, via: opts.actor });

    // Admin activity notify — payment success (auto-delete)
    try {
      require('./adminNotifyService').notifyActivity(
        { telegramId: fresh.userId, username: fresh.username, firstName: fresh.userName || fresh.firstName },
        `Pembayaran BERHASIL (${(fresh.paymentGateway || opts.gateway || '-').toUpperCase()})`,
        { '🧾 Invoice:': `\`${fresh.invoice}\``, '📦 Paket:': fresh.productName, '💰 Total:': String(fresh.total) },
      );
    } catch (_) {}

    // ═══ RDP is now FULL AUTO — reinstall Linux → Windows via SSH. ═══
    // The old manual admin-delivery flow is DEPRECATED but kept accessible
    // for legacy orders already in pending_admin status.
    if (order.category === 'rdp') {
      await Order.findByIdAndUpdate(order._id, { $set: { status: 'rdp_processing', provisionStatus: 'queued', autoProvision: true } });
      const freshRdp = await Order.findById(order._id);
      console.log('[processPaidOrder] RDP paid → AUTO provisioning', String(freshRdp._id));

      // Fire-and-forget — the RDP orchestrator owns the single-message UX
      // and sends the credentials card only after Windows is fully validated.
      if (bot) {
        provisionRdpOrder(bot, freshRdp).catch((err) =>
          console.error('[processPaidOrder] provisionRdpOrder error:', err && err.message));
      }

      // Send receipt to channel (paid, not yet delivered)
      try {
        const { sendReceipt } = require('../handlers/adminHandler');
        await sendReceipt(bot, freshRdp, 'paid');
      } catch (_) {}

      return { ok: true, status: 'processed', order: freshRdp };
    }

    // ═══ Legacy manual-delivery RDP branch removed — RDP now full-auto. ═══

    // Fire-and-forget. The orchestrator sends the "VPS SIAP DIGUNAKAN" message
    // to the user on success and marks the order failed otherwise.
    if (bot) {
      provisionOrder(bot, fresh).catch((err) =>
        console.error('[processPaidOrder] provisionOrder error:', err && err.message));
    }
    return { ok: true, status: 'processed', order: fresh };
  } catch (err) {
    console.error('[processPaidOrder] error:', err && err.message);
    return { ok: false, status: 'error', error: err && err.message };
  } finally {
    clearLock(lockKey);
  }
}

module.exports = { processPaidOrder };
