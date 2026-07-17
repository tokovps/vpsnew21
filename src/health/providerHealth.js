// Provider health checker — run periodically to update ProviderApi.quotaAvailable & status.
const ProviderApi = require('../models/ProviderApi');
const providers = require('../providers');
const quota = require('../providers/quota');
const audit = require('../services/auditService');
const providerService = require('../services/providerService');
const { config } = require('../config');
const { isPermanentProviderFailure } = require('../services/providerFailureClassifier');
const vpsCleanupService = require('../services/vpsCleanupService');

const MIN_READY_THRESHOLD = 5;
let botRef = null;
function attachBot(bot) { botRef = bot; }

async function notifyAdmin(text) {
  if (!botRef || !config.adminId) return;
  try { await botRef.telegram.sendMessage(config.adminId, text, { parse_mode: 'Markdown' }); } catch (_) {}
}

async function checkOne(apiId) {
  const api = await ProviderApi.findById(apiId);
  if (!api) return null;
  const prevStatus = api.status;
  const r = await providers.healthCheck(api);
  const patch = { lastCheckAt: new Date() };
  if (r.ok) {
    // Real quota introspection
    let q = { available: 0, used: 0, limit: 0 };
    try { q = await quota.forApi(api); } catch (_) {}
    patch.quotaAvailable = q.available;
    if (q.limit > 0 && q.available === 0) {
      patch.status = 'QUOTA_FULL';
    } else if (['ERROR', 'SUSPENDED', 'QUOTA_FULL'].includes(api.status)) {
      patch.status = 'READY';
    }
    patch.lastError = '';
  } else {
    // Distinguish PERMANENT provider death (unauthorized/invalid token/
    // suspended/closed) from TEMPORARY failures (timeout/DNS/rate-limit/
    // network outage). Only permanent death triggers the DB-only auto
    // cleanup below — temporary failures keep the existing ERROR behaviour
    // untouched (no cleanup, eligible to recover back to READY above).
    const permanentlyDead = isPermanentProviderFailure(r.error);
    patch.status = permanentlyDead ? 'SUSPENDED' : 'ERROR';
    patch.lastError = String(r.error).slice(0, 500);
    if (permanentlyDead) {
      // Never auto-unsuspend a permanently dead account (unlike the 30-min
      // auto-suspend used elsewhere for transient failure streaks).
      patch.suspendedUntil = null;
    }
    await audit.log('health.fail', { refId: api._id, message: patch.lastError });
    if (prevStatus !== 'ERROR' && prevStatus !== 'SUSPENDED') {
      try {
        require('../services/adminNotifyService').notifyRaw(
`━━━━━━━━━━━━━━
❤️ *Health Check GAGAL*

☁️ Provider: *${String(api.provider || '-').toUpperCase()}*
🆔 API ID: \`${api._id}\`
⚠️ Error: ${patch.lastError.slice(0, 200)}
━━━━━━━━━━━━━━`);
      } catch (_) {}
    }
    if (permanentlyDead) {
      // Fix #2 — automatic cleanup: provider is confirmed permanently dead,
      // so every VPS still visible in VPS Management under this ProviderApi
      // is removed from the bot database only (no provider API call).
      try {
        const cleaned = await vpsCleanupService.cleanupDeadProviderApi(api._id);
        if (cleaned && cleaned.cleaned > 0) {
          await audit.log('vps.auto_cleanup', {
            refId: api._id,
            message: `${cleaned.cleaned} VPS dibersihkan dari DB (provider ${api.provider} permanently dead)`,
          });
        }
      } catch (_) {}
    }
  }
  const updated = await ProviderApi.findByIdAndUpdate(apiId, { $set: patch }, { new: true });
  // Trigger catalog refresh if READY count may have changed.
  try {
    if (patch.status && patch.status !== prevStatus) require('../services/catalogService').scheduleUpdate();
  } catch (_) {}
  return updated;
}

async function checkAll() {
  // Auto-unsuspend expired suspensions first
  const unsus = await providerService.unsuspendIfDue();
  if (unsus > 0) await audit.log('api.auto_unsuspend', { message: `${unsus} apis unsuspended` });

  const apis = await ProviderApi.find({ enabled: true }).lean();
  const out = [];
  for (const a of apis) out.push(await checkOne(a._id));

  // Low-stock notification per provider (READY count < threshold)
  const stats = await providerService.statsByProvider();
  const now = new Date();
  for (const p of Object.keys(stats)) {
    const ready = stats[p].READY || 0;
    if (ready < MIN_READY_THRESHOLD) {
      // Rate-limit: notify once per 2h per provider
      const key = `low:${p}`;
      const last = LAST_NOTIFY.get(key) || 0;
      if (now.getTime() - last > 2 * 60 * 60 * 1000) {
        LAST_NOTIFY.set(key, now.getTime());
        await notifyAdmin(
`⚠️ *STOCK API RENDAH*

Provider: *${p.toUpperCase()}*
READY: *${ready}* (batas minimum ${MIN_READY_THRESHOLD})
LOCKED: ${stats[p].LOCKED || 0}
ERROR: ${stats[p].ERROR || 0}
QUOTA_FULL: ${stats[p].QUOTA_FULL || 0}
SUSPENDED: ${stats[p].SUSPENDED || 0}

Silakan tambahkan API baru via /admin → Enterprise → VPS Providers.`);
        await audit.log('notify.low_stock', { message: `${p} READY=${ready}` });
      }
    }
  }
  // Quota-full notification per api
  const qf = await ProviderApi.find({ enabled: true, status: 'QUOTA_FULL' }).lean();
  for (const a of qf) {
    const key = `qf:${a._id}`;
    const last = LAST_NOTIFY.get(key) || 0;
    if (now.getTime() - last > 6 * 60 * 60 * 1000) {
      LAST_NOTIFY.set(key, now.getTime());
      await notifyAdmin(`📦 *QUOTA HABIS*\n\nAPI ${a.provider.toUpperCase()} (id=${a._id}) mencapai quota limit.`);
    }
  }
  return out;
}

const LAST_NOTIFY = new Map();

function startPeriodic(intervalMs = 5 * 60 * 1000) {
  setInterval(() => {
    checkAll().catch(e => console.error('health.checkAll:', e.message));
  }, intervalMs);
}

module.exports = { checkOne, checkAll, startPeriodic, attachBot };
