// VPS Auto Health Check.
// Periodically polls every ACTIVE VpsInstance (status='running') via the
// provider's action adapter, updates DB, and notifies admin when a VPS
// becomes offline / stopped / terminated / errored.
//
// Interval is configurable from admin panel (Setting.healthCheckIntervalMinutes).
// Enable/disable via Setting.vpsHealthCheckEnabled ('on'|'off').
const VpsInstance = require('../models/VpsInstance');
const ProviderApi = require('../models/ProviderApi');
const Order = require('../models/Order');
const providerActions = require('../providers/actions');
const { getSettings } = require('../services/settingService');
const { config } = require('../config');
const audit = require('../services/auditService');
const rdpConfig = require('../provision/rdp/rdpConfig');
const { rdpHandshakeDetailed } = require('../provision/rdp/rdpValidator');

let botRef = null;
let timerRef = null;
let rdpTimerRef = null;

function envInt(name, fallback, min, max) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

const RDP_HEALTH_INTERVAL_MS = envInt('RDP_HEALTH_INTERVAL_MS', 2 * 60 * 1000, 30 * 1000, 30 * 60 * 1000);
const RDP_FAILURE_THRESHOLD = envInt('RDP_HEALTH_FAILURE_THRESHOLD', 2, 1, 10);
const RDP_REPAIR_COOLDOWN_MS = envInt('RDP_REPAIR_COOLDOWN_MS', 5 * 60 * 1000, 60 * 1000, 60 * 60 * 1000);
const RDP_MAX_REPAIR_ATTEMPTS = envInt('RDP_MAX_REPAIR_ATTEMPTS', 3, 1, 10);

function attachBot(bot) { botRef = bot; }

async function notifyAdmin(text) {
  if (!botRef || !config.adminId) return;
  try { await botRef.telegram.sendMessage(config.adminId, text, { parse_mode: 'Markdown' }); } catch (_) {}
}

async function checkAllVps() {
  // Hanya cek VPS yang masih aktif — skip yang sudah deleted/terminated/destroyed/cancelled.
  const running = await VpsInstance.find({ status: { $in: ['running', 'creating'] } }).lean();
  let alerts = 0;
  for (const v of running) {
    if (!v.apiId || !v.instanceId) continue;
    const api = await ProviderApi.findById(v.apiId);
    if (!api) continue;
    const acts = providerActions.forProvider(v.provider);
    if (!acts) continue;
    const r = await acts.getStatus(api, v).catch(e => ({ ok: false, error: e.message }));
    const patch = { lastHealthAt: new Date() };
    if (r.ok) {
      patch.lastHealthStatus = r.status;
      if (r.status !== v.status) patch.status = r.status;
      if (['stopped', 'offline', 'terminated', 'error'].includes(r.status) && v.status === 'running') {
        alerts++;
        const o = await Order.findById(v.orderId).lean();
        await notifyAdmin(
`🚨 *VPS ALERT*

Invoice  : \`${(o && o.invoice) || '-'}\`
User     : @${(o && o.username) || '-'} (\`${v.userId}\`)
Provider : ${v.provider.toUpperCase()}
IP       : \`${v.publicIp}\`

Status   : *${r.status.toUpperCase()}*

_Silakan lakukan pengecekan via /admin → VPS Management._`);
        await audit.log('vps.alert', { refId: v._id, message: `${v.provider} ${r.status}` });
      }
    } else {
      patch.lastHealthStatus = 'error';
    }
    await VpsInstance.findByIdAndUpdate(v._id, { $set: patch });
  }
  return { checked: running.length, alerts };
}

async function rdpAlert(v, title, detail) {
  const o = await Order.findById(v.orderId).lean().catch(() => null);
  await notifyAdmin(
`🛠 *${title}*

Invoice  : \`${(o && o.invoice) || '-'}\`
Provider : ${String(v.provider || '-').toUpperCase()}
IP       : \`${v.publicIp || '-'}:${rdpConfig.RDP_PORT}\`
Detail   : ${String(detail || '-').slice(0, 300)}`);
}

async function checkOneRdp(v) {
  if (!v.apiId || !v.instanceId || !v.publicIp) return { skipped: true };
  const api = await ProviderApi.findById(v.apiId);
  if (!api) return { skipped: true };
  const acts = providerActions.forProvider(v.provider);
  if (!acts) return { skipped: true };

  const now = Date.now();
  const lastRepair = v.rdpLastRepairAt ? new Date(v.rdpLastRepairAt).getTime() : 0;
  const repairAllowed = (Number(v.rdpRepairAttempts) || 0) < RDP_MAX_REPAIR_ATTEMPTS
    && now - lastRepair >= RDP_REPAIR_COOLDOWN_MS;
  const provider = await acts.getStatus(api, v).catch(e => ({ ok: false, error: e.message }));
  const patch = { lastHealthAt: new Date() };

  if (!provider.ok) {
    patch.lastHealthStatus = 'rdp-provider-check-error';
    await VpsInstance.findByIdAndUpdate(v._id, { $set: patch });
    return { ok: false, reason: provider.error || 'provider-status-error' };
  }

  if (provider.status === 'terminated' || provider.status === 'destroyed') {
    patch.status = provider.status;
    patch.lastHealthStatus = 'rdp-instance-gone';
    await VpsInstance.findByIdAndUpdate(v._id, { $set: patch });
    if (!['terminated', 'destroyed'].includes(v.status)) {
      await rdpAlert(v, 'RDP HILANG DI PROVIDER', `status=${provider.status}; tidak dapat dipulihkan otomatis`);
    }
    return { ok: false, reason: provider.status };
  }

  if (provider.status === 'stopped' || provider.status === 'offline') {
    patch.status = provider.status;
    patch.lastHealthStatus = 'rdp-powered-off';
    if (repairAllowed && typeof acts.start === 'function') {
      const started = await acts.start(api, v).catch(e => ({ ok: false, error: e.message }));
      patch.rdpLastRepairAt = new Date();
      patch.rdpRepairAttempts = (Number(v.rdpRepairAttempts) || 0) + 1;
      patch.rdpConsecutiveFailures = 0;
      if (started.ok) {
        patch.status = 'running';
        patch.lastHealthStatus = 'rdp-auto-power-on';
        await rdpAlert(v, 'RDP AUTO POWER-ON', 'Provider melaporkan VPS mati; perintah power_on berhasil dikirim.');
      } else {
        patch.lastHealthStatus = 'rdp-auto-power-on-failed';
        await rdpAlert(v, 'RDP POWER-ON GAGAL', started.error || 'provider menolak power_on');
      }
    }
    await VpsInstance.findByIdAndUpdate(v._id, { $set: patch });
    // A provider accepting power_on is not proof that Windows/RDP is ready.
    // The next health pass must still complete the public TLS handshake.
    return { ok: false, repaired: patch.lastHealthStatus === 'rdp-auto-power-on' };
  }

  const handshake = await rdpHandshakeDetailed(v.publicIp, rdpConfig.RDP_PORT, 8000)
    .catch(e => ({ ok: false, tlsReady: false, reason: e.message }));
  if (handshake.ok && handshake.tlsReady) {
    Object.assign(patch, {
      status: 'running',
      lastHealthStatus: 'rdp-ready',
      rdpLastReadyAt: new Date(),
      rdpConsecutiveFailures: 0,
      rdpRepairAttempts: 0,
    });
    await VpsInstance.findByIdAndUpdate(v._id, { $set: patch });
    return { ok: true };
  }

  const failures = (Number(v.rdpConsecutiveFailures) || 0) + 1;
  patch.status = 'running';
  patch.lastHealthStatus = 'rdp-unreachable';
  patch.rdpConsecutiveFailures = failures;
  if (failures >= RDP_FAILURE_THRESHOLD && repairAllowed && typeof acts.reboot === 'function') {
    const rebooted = await acts.reboot(api, v).catch(e => ({ ok: false, error: e.message }));
    patch.rdpLastRepairAt = new Date();
    patch.rdpRepairAttempts = (Number(v.rdpRepairAttempts) || 0) + 1;
    patch.rdpConsecutiveFailures = 0;
    patch.lastHealthStatus = rebooted.ok ? 'rdp-auto-reboot' : 'rdp-auto-reboot-failed';
    await rdpAlert(v, rebooted.ok ? 'RDP AUTO REPAIR' : 'RDP AUTO REPAIR GAGAL',
      rebooted.ok
        ? `RDP gagal ${failures} pemeriksaan; reboot dikirim agar watchdog Windows memulihkan listener.`
        : (rebooted.error || 'provider menolak reboot'));
  }
  await VpsInstance.findByIdAndUpdate(v._id, { $set: patch });
  return { ok: false, reason: handshake.reason || 'rdp-handshake-failed', failures };
}

async function checkRdpLiveness() {
  const instances = await VpsInstance.find({
    lifecycle: 'rdp',
    status: { $nin: ['deleted', 'terminated', 'destroyed', 'cancelled'] },
  }).lean();
  const results = [];
  // Provider APIs and socket probes are network-bound. Process small batches
  // so many RDP records cannot create an unbounded connection burst.
  for (let i = 0; i < instances.length; i += 5) {
    const batch = instances.slice(i, i + 5);
    const settled = await Promise.all(batch.map(v => checkOneRdp(v).catch(e => ({ ok: false, reason: e.message }))));
    results.push(...settled);
  }
  return {
    checked: instances.length,
    ready: results.filter(r => r && r.ok).length,
    repaired: results.filter(r => r && r.repaired).length,
  };
}

async function loop() {
  try {
    const s = await getSettings();
    if ((s.vpsHealthCheckEnabled || 'on') !== 'on') return;
    await checkAllVps();
  } catch (e) { console.error('vpsHealth loop:', e.message); }
}

async function start() {
  const s = await getSettings();
  const mins = parseInt(s.healthCheckIntervalMinutes, 10) || 15;
  if (timerRef) clearInterval(timerRef);
  timerRef = setInterval(loop, Math.max(1, mins) * 60 * 1000);
  if (rdpTimerRef) clearInterval(rdpTimerRef);
  rdpTimerRef = setInterval(() => {
    checkRdpLiveness().catch(e => console.error('RDP health loop:', e.message));
  }, RDP_HEALTH_INTERVAL_MS);
  setTimeout(() => {
    checkRdpLiveness().catch(e => console.error('RDP initial health check:', e.message));
  }, 15000);
  console.log(`✅ VPS Health Check scheduled every ${mins} minute(s); RDP liveness every ${Math.round(RDP_HEALTH_INTERVAL_MS / 1000)}s`);
}

async function restart() { await start(); }

module.exports = {
  attachBot,
  start,
  restart,
  checkAllVps,
  checkRdpLiveness,
  checkOneRdp,
  RDP_HEALTH_INTERVAL_MS,
  RDP_FAILURE_THRESHOLD,
  RDP_REPAIR_COOLDOWN_MS,
  RDP_MAX_REPAIR_ATTEMPTS,
};
