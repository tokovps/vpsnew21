const Order = require('../models/Order');
const { generateInvoice } = require('../utils/invoice');
const { parseSpecText, deriveDoSizeSlug } = require('../utils/specMapping');

// Hanya 2 status yang dianggap "aktif" (tampil di Pesanan Saya & blokir double order)
const ACTIVE_STATUSES = ['waiting_payment', 'waiting_review'];

async function createOrder({ from, category, tier, slot, spec, price, originalPrice, promoName, promoOff, region, osType, osFamily, osVersion, warranty, replace }) {
  const productName = `${category.toUpperCase()} ${tier.toUpperCase()} - Spec ${slot}`;

  // ─── STRUCTURED SPEC EXTRACTION (root-cause fix for RAM mismatch) ───
  // Parse the admin free-form text into numeric cpu / ramMb / diskGb so
  // we can (a) build the correct DO create payload and (b) validate the
  // live droplet post-create. If parsing fails we STILL create the order
  // (backwards-compat) but flag the missing fields so the orchestrator
  // can refuse to provision instead of silently defaulting to 1GB.
  const parsed = parseSpecText(spec);
  const cpu    = Number(parsed.cpu)    || 0;
  const ramMb  = Number(parsed.ramMb)  || 0;
  const diskGb = Number(parsed.diskGb) || 0;
  const bwTb   = Number(parsed.bwTb)   || 0;
  const sizeSlug = deriveDoSizeSlug({ cpu, ramMb, diskGb }) || '';

  console.log('[order:create]', JSON.stringify({
    invoice: 'pending', category, tier, slot,
    selectedCpu: cpu, selectedRamMb: ramMb, selectedDiskGb: diskGb, selectedBwTb: bwTb,
    selectedRegion: region || '', selectedOs: osVersion || osFamily || '',
    derivedSizeSlug: sizeSlug,
    specTextPreview: String(spec || '').slice(0, 120),
  }));

  const order = await Order.create({
    invoice: generateInvoice(),
    userId: String(from.id),
    username: from.username || '',
    name: [from.first_name, from.last_name].filter(Boolean).join(' '),
    category, tier, slot,
    productName,
    description: spec,
    cpu, ramMb, diskGb, bwTb, sizeSlug,
    region: region || '',
    osType: osType || '',
    osFamily: osFamily || '',
    osVersion: osVersion || '',
    warranty: warranty || '',
    replace: replace || '',
    price,
    originalPrice: Number(originalPrice) || Number(price) || 0,
    promoName: String(promoName || ''),
    promoOff: Number(promoOff) || 0,
    qty: 1,
    total: price,
    status: 'waiting_payment',
  });
  return order;
}

const getById = (id) => Order.findById(id);

async function userActiveOrders(userId) {
  return Order.find({
    userId: String(userId),
    status: { $in: ACTIVE_STATUSES },
  }).sort({ createdAt: -1 });
}

async function setStatus(id, status, patch = {}) {
  return Order.findByIdAndUpdate(id, { status, ...patch }, { new: true });
}

async function findExistingProofUid(uid) {
  if (!uid) return null;
  return Order.findOne({
    paymentProofUid: uid,
    status: { $nin: ['cancelled', 'rejected'] },
  });
}

async function cancelStaleOrders(thresholdMinutes) {
  if (!thresholdMinutes || thresholdMinutes <= 0) return { cancelled: 0 };
  const cutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000);
  const r = await Order.updateMany(
    { status: 'waiting_payment', createdAt: { $lt: cutoff } },
    { $set: { status: 'cancelled' } },
  );
  return { cancelled: r.modifiedCount || 0 };
}

async function countUserSuccess(userId) {
  return Order.countDocuments({ userId: String(userId), status: { $in: ['processing', 'success'] } });
}

async function countAllSuccess() {
  return Order.countDocuments({ status: { $in: ['processing', 'success'] } });
}

async function dashboardStats() {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const [totalOrders, todayOrders, waitingPayment, waitingReview, processing, success, revenueAgg] = await Promise.all([
    Order.countDocuments(),
    Order.countDocuments({ createdAt: { $gte: startOfDay } }),
    Order.countDocuments({ status: 'waiting_payment' }),
    Order.countDocuments({ status: 'waiting_review' }),
    Order.countDocuments({ status: 'processing' }),
    Order.countDocuments({ status: 'success' }),
    Order.aggregate([{ $match: { status: { $in: ['success', 'processing'] } } }, { $group: { _id: null, total: { $sum: '$total' } } }]),
  ]);
  return {
    totalOrders, todayOrders, waitingPayment, waitingReview, processing, success,
    revenue: (revenueAgg[0] && revenueAgg[0].total) || 0,
  };
}

module.exports = {
  ACTIVE_STATUSES,
  createOrder, getById, userActiveOrders, setStatus,
  countUserSuccess, countAllSuccess, dashboardStats,
  findExistingProofUid, cancelStaleOrders,
};
