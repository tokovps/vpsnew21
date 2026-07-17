const ProviderApi = require('../models/ProviderApi');
const audit = require('./auditService');

function triggerCatalog() { try { require('./catalogService').scheduleUpdate(); } catch (_) {} }

// Compute performance score = successRate * 100 - min(avgDurationMs, 60000)/1000
// Higher is better. Successful+fast API wins.
function computeScore(api) {
  const total = (api.totalSuccess || 0) + (api.totalFail || 0);
  const successRate = total > 0 ? api.totalSuccess / total : 0.5; // unknown → neutral
  const durationPenalty = Math.min(api.avgDurationMs || 0, 60000) / 1000;
  return Math.round(successRate * 100 - durationPenalty);
}

// Called by orchestrator after each provisioning attempt to update stats + auto-suspend.
async function recordAttempt(apiId, ok, durationMs) {
  const api = await ProviderApi.findById(apiId);
  if (!api) return null;
  const inc = ok ? { totalSuccess: 1 } : { totalFail: 1, consecutiveFailures: 1 };
  const set = {};
  // rolling avg duration
  const prev = api.avgDurationMs || 0;
  const total = (api.totalSuccess || 0) + (api.totalFail || 0);
  set.avgDurationMs = total === 0 ? durationMs : Math.round((prev * total + durationMs) / (total + 1));
  if (ok) set.consecutiveFailures = 0;
  await ProviderApi.findByIdAndUpdate(apiId, { $inc: inc, $set: set });
  const updated = await ProviderApi.findById(apiId);
  updated.score = computeScore(updated);
  await updated.save();
  // Auto suspend after 3 consecutive failures
  if (!ok && updated.consecutiveFailures >= 3) {
    updated.status = 'SUSPENDED';
    updated.suspendedUntil = new Date(Date.now() + 30 * 60 * 1000);
    await updated.save();
    await audit.log('api.suspended', { refId: updated._id, message: `Auto-suspend: ${updated.consecutiveFailures} consecutive failures` });
  }
  return updated;
}

// Auto-unsuspend on periodic check if suspendedUntil elapsed
async function unsuspendIfDue() {
  const now = new Date();
  const r = await ProviderApi.updateMany(
    { status: 'SUSPENDED', suspendedUntil: { $lte: now } },
    { $set: { status: 'READY', consecutiveFailures: 0, suspendedUntil: null } },
  );
  return r.modifiedCount || 0;
}

// Atomically lock a READY api → LOCKED. Returns the locked doc or null.
async function tryLockApi(apiId, orderId = '') {
  const doc = await ProviderApi.findOneAndUpdate(
    { _id: apiId, enabled: true, status: 'READY' },
    { $set: { status: 'LOCKED', lockedAt: new Date(), lastOrderId: String(orderId || '') } },
    { new: true },
  );
  if (doc) await audit.log('api.lock', { refId: doc._id, message: `${doc.provider} locked` });
  if (doc) triggerCatalog();
  return doc;
}

async function unlockApi(apiId, { reason = '' } = {}) {
  const doc = await ProviderApi.findOneAndUpdate(
    { _id: apiId, status: 'LOCKED' },
    { $set: { status: 'READY', lockedAt: null } },
    { new: true },
  );
  if (doc) await audit.log('api.unlock', { refId: doc._id, message: reason || 'rollback' });
  if (doc) triggerCatalog();
  return doc;
}

// Called by orchestrator AFTER a successful provisioning. A Provider is NEVER
// single-use: it must remain usable as long as quotaAvailable > 0.
// Rules (per product spec):
//   • usageCount += 1
//   • quotaAvailable -= 1 (floor 0)
//   • lastUsedAt = now
//   • release lock (lockedAt = null)
//   • status = 'READY'      if remaining quota > 0
//   • status = 'QUOTA_FULL' if remaining quota == 0
// Status 'USED' is intentionally NEVER written here — the Provider stays in the
// pool until quota is truly exhausted (spec: "Provider TIDAK BOLEH menjadi sekali pakai").
async function markUsed(apiId) {
  const cur = await ProviderApi.findById(apiId);
  if (!cur) return null;
  const remaining = Math.max(0, (Number(cur.quotaAvailable) || 0) - 1);
  const nextStatus = remaining > 0 ? 'READY' : 'QUOTA_FULL';
  const doc = await ProviderApi.findByIdAndUpdate(
    apiId,
    {
      $set: {
        status: nextStatus,
        quotaAvailable: remaining,
        lastUsedAt: new Date(),
        lockedAt: null,
      },
      $inc: { usageCount: 1 },
    },
    { new: true },
  );
  if (doc) {
    await audit.log('api.used', {
      refId: doc._id,
      message: `${doc.provider} used → quota ${remaining} • status ${nextStatus}`,
    });
    triggerCatalog();
  }
  return doc;
}

async function markError(apiId, err) {
  const doc = await ProviderApi.findByIdAndUpdate(
    apiId,
    { $set: { status: 'ERROR', lastError: String(err && err.message || err || '').slice(0, 500) } },
    { new: true },
  );
  if (doc) await audit.log('api.error', { refId: doc._id, message: doc.lastError });
  if (doc) triggerCatalog();
  return doc;
}

// Find READY apis, sorted by score desc, then quota desc, then usageCount asc.
async function findReadyApis({ providers } = {}) {
  const filter = { enabled: true, status: 'READY' };
  if (providers && providers.length) filter.provider = { $in: providers };
  return ProviderApi.find(filter).sort({ score: -1, quotaAvailable: -1, usageCount: 1 }).lean();
}

async function listAll() {
  return ProviderApi.find({}).sort({ provider: 1, createdAt: 1 }).lean();
}

async function statsByProvider() {
  const rows = await ProviderApi.aggregate([
    { $group: { _id: { provider: '$provider', status: '$status' }, n: { $sum: 1 } } },
  ]);
  const out = {}; // { aws: { READY: 2, LOCKED: 0, ... }, ... }
  for (const r of rows) {
    const p = r._id.provider;
    if (!out[p]) out[p] = { READY: 0, LOCKED: 0, USED: 0, ERROR: 0, QUOTA_FULL: 0, SUSPENDED: 0 };
    out[p][r._id.status] = r.n;
  }
  return out;
}

async function resetAllErrors() {
  return ProviderApi.updateMany({ status: 'ERROR' }, { $set: { status: 'READY', lastError: '' } });
}

// Live health-check across the current READY pool. Returns only apis whose
// provider adapter reports { ok: true } in a live probe. Used BEFORE creating
// an invoice so users never pay when no provider can actually deliver.
// Runs probes concurrently with per-provider timeout for snappy buy flow.
async function liveHealthCheckPool({ providers, timeoutMs = 8000 } = {}) {
  const candidates = await findReadyApis({ providers });
  if (!candidates.length) return [];
  const providersMod = require('../providers');
  const withTimeout = (p, ms) => Promise.race([
    p,
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'timeout' }), ms)),
  ]);
  const results = await Promise.all(candidates.map(async (api) => {
    try {
      const r = await withTimeout(providersMod.healthCheck(api), timeoutMs);
      return r && r.ok ? api : null;
    } catch (_) { return null; }
  }));
  return results.filter(Boolean);
}

module.exports = { tryLockApi, unlockApi, markUsed, markError, findReadyApis, liveHealthCheckPool, listAll, statsByProvider, resetAllErrors, recordAttempt, unsuspendIfDue, computeScore };
