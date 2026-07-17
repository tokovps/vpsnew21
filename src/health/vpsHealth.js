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

let botRef = null;
let timerRef = null;

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
  console.log(`✅ VPS Health Check scheduled every ${mins} minute(s)`);
}

async function restart() { await start(); }

module.exports = { attachBot, start, restart, checkAllVps };
