// VPS Management admin handler.
const { respondInSession } = require('../utils/safeEdit');
// Provides: dashboard stats, paginated list, detail view, actions (refresh/
// reboot/stop/start/delete/rebuild), search by invoice/telegram/ip/provider,
// and Health Check settings menu.
//
// Uses editMessage exclusively (single-message UX).
const { Markup } = require('telegraf');
const VpsInstance = require('../models/VpsInstance');
const Order = require('../models/Order');
const providerActions = require('../providers/actions');
const ProviderApi = require('../models/ProviderApi');
const { answerCb, safeEditText } = require('../utils/safeEdit');
const { setSession, clearSession, getSession, openInputSession } = require('./sessionStore');
const { getSettings, updateSetting } = require('../services/settingService');
const { isPermanentProviderFailure } = require('../services/providerFailureClassifier');

const PAGE_SIZE = 8;

// VPS yang dianggap "sudah tidak aktif" — tidak ditampilkan di daftar VPS Management.
const HIDDEN_STATUSES = ['deleted', 'terminated', 'destroyed', 'cancelled'];
const VISIBLE_FILTER = { status: { $nin: HIDDEN_STATUSES } };

async function renderHome(ctx) {
  const [total, running, provisioning, stopped, failed, deleted] = await Promise.all([
    VpsInstance.countDocuments(VISIBLE_FILTER),
    VpsInstance.countDocuments({ status: 'running' }),
    Order.countDocuments({ provisionStatus: { $nin: ['success', 'failed', ''] }, status: 'processing' }),
    VpsInstance.countDocuments({ status: 'stopped' }),
    Order.countDocuments({ provisionStatus: 'failed' }),
    VpsInstance.countDocuments({ status: { $in: HIDDEN_STATUSES } }),
  ]);
  const text =
`🖥 *VPS MANAGEMENT*

━━━━━━━━━━━━━━━━━━
Total VPS       : *${total}*
🟢 Running       : *${running}*
🟡 Provisioning  : *${provisioning}*
⚪ Stopped       : *${stopped}*
🔴 Failed        : *${failed}*
🗑 Deleted       : *${deleted}*
━━━━━━━━━━━━━━━━━━

Pilih menu di bawah:`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('📋 Daftar VPS', 'v:list:1')],
    [Markup.button.callback('🔍 Cari VPS', 'v:search')],
    [Markup.button.callback('❤️ Health Check Settings', 'v:hc:settings')],
    [Markup.button.callback('⬅️ Back', 'a:home')],
  ]);
  await answerCb(ctx);
  return safeEditText(ctx, text, { parse_mode: 'Markdown', ...kb });
}

async function renderList(ctx, page = 1) {
  const filter = { ...VISIBLE_FILTER };
  const total = await VpsInstance.countDocuments(filter);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  page = Math.min(Math.max(1, page), totalPages);
  const items = await VpsInstance.find(filter).sort({ createdAt: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).lean();
  const orderIds = items.map(i => i.orderId);
  const orders = await Order.find({ _id: { $in: orderIds } }, 'invoice username userId').lean();
  const oMap = Object.fromEntries(orders.map(o => [String(o._id), o]));

  const lines = items.map((v, i) => {
    const o = oMap[String(v.orderId)] || {};
    const idx = (page - 1) * PAGE_SIZE + i + 1;
    return `${idx}. \`${o.invoice || v.orderId.slice(0,8)}\` • ${v.provider} • ${v.publicIp || '-'} • ${statusIcon(v.status)}`;
  }).join('\n');

  const text =
`📋 *DAFTAR VPS* — page ${page}/${totalPages} (${total} total)

${lines || '_(kosong)_'}

_Pilih VPS untuk detail:_`;

  const rows = items.map((v, i) => {
    const o = oMap[String(v.orderId)] || {};
    const idx = (page - 1) * PAGE_SIZE + i + 1;
    return [Markup.button.callback(`${idx}. ${o.invoice ? o.invoice.slice(-8) : v.instanceId.slice(0,8)} • ${v.provider}`, `v:d:${v._id}`)];
  });
  const nav = [];
  if (page > 1) nav.push(Markup.button.callback('⬅️', `v:list:${page - 1}`));
  nav.push(Markup.button.callback(`${page}/${totalPages}`, 'noop'));
  if (page < totalPages) nav.push(Markup.button.callback('➡️', `v:list:${page + 1}`));
  rows.push(nav);
  rows.push([Markup.button.callback('⬅️ Back', 'v:home')]);
  await answerCb(ctx);
  return safeEditText(ctx, text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
}

function statusIcon(st) {
  if (st === 'running') return '🟢 running';
  if (st === 'stopped') return '⚪ stopped';
  if (st === 'terminated' || st === 'destroyed') return '🗑 terminated';
  if (st === 'error' || st === 'offline') return '🔴 ' + st;
  return '🟡 ' + (st || 'unknown');
}

async function renderDetail(ctx, vpsId) {
  const v = await VpsInstance.findById(vpsId).lean();
  if (!v) { await answerCb(ctx, 'VPS tidak ditemukan', true); return; }
  const o = await Order.findById(v.orderId).lean();
  const inv = (o && o.invoice) || '-';
  const uname = (o && o.username) || '-';
  const uid = (o && o.userId) || v.userId || '-';

  // ═══ LIVE READ FROM PROVIDER (root-cause fix) ═════════════════════════
  // Detail VPS must reflect the RUNNING droplet — not a stale DB snapshot
  // and NEVER the admin-authored spec text. We call adapter.getInstance()
  // which returns memory / vcpus / disk / size_slug / region straight from
  // DO's /v2/droplets/:id. On any API error we fall back to Order.verified*
  // (which was captured at create time and verified against DO) then to
  // Order structured spec — but the source is clearly labelled in the UI.
  let live = null;
  let liveSource = 'db-snapshot';
  try {
    const api = await ProviderApi.findById(v.apiId);
    if (api) {
      const acts = providerActions.forProvider(v.provider);
      const adapter = require('../providers').get(v.provider);
      if (adapter && typeof adapter.getInstance === 'function') {
        const inst = await adapter.getInstance(api, v.instanceId);
        if (inst && inst.exists) {
          live = inst;
          liveSource = 'provider-api';
          // Opportunistically refresh DB snapshot so list/search stay fresh.
          if (inst.status && inst.status !== v.status) {
            try { await VpsInstance.updateOne({ _id: v._id }, { $set: { status: inst.status === 'active' ? 'running' : inst.status, lastHealthAt: new Date() } }); }
            catch (_) {}
          }
        }
      }
      void acts;
    }
  } catch (_) { /* fall through to DB snapshot */ }

  // Field resolution priority: LIVE (DO API) → Order.verified* → Order.parsed
  const liveOr = (path, fallback) => (live && (live[path] || live[path] === 0) ? live[path] : fallback);
  const cpuVal    = liveOr('vcpus',    (o && o.verifiedVcpus)    || (o && o.cpu)    || null);
  const ramMbVal  = liveOr('memoryMb', (o && o.verifiedMemoryMb) || (o && o.ramMb)  || null);
  const diskGbVal = liveOr('diskGb',   (o && o.verifiedDiskGb)   || (o && o.diskGb) || null);
  const sizeSlug  = liveOr('sizeSlug', (o && o.verifiedSizeSlug) || v.size || '-');
  const regionVal = liveOr('region',   v.region || '-');
  const statusVal = liveOr('status',   v.status);
  const ipVal     = liveOr('publicIp', v.publicIp || '');
  const bw = (o && o.bwTb) ? `${o.bwTb} TB` : '-';

  const cpuLine  = cpuVal    ? `${cpuVal} vCPU`  : '-';
  const ramLine  = ramMbVal  ? `${(ramMbVal / 1024).toFixed(ramMbVal % 1024 === 0 ? 0 : 1)} GB (${ramMbVal} MB)` : '-';
  const diskLine = diskGbVal ? `${diskGbVal} GB` : '-';

  const authLine = o && o.authMethod === 'ssh' && v.sshKeyName
    ? `🗝 SSH Key       : ${v.sshKeyName}`
    : v.password ? `🔑 Password       : \`${v.password}\`` : '';
  const sourceLine = liveSource === 'provider-api'
    ? '🛰 Sumber Data    : LIVE dari DigitalOcean API'
    : '🛰 Sumber Data    : Cache DB (Provider API tidak dapat dihubungi)';
  const text =
`🖥 *DETAIL VPS*

━━━━━━━━━━━━━━━━━━
🧾 Invoice        : \`${inv}\`
🆔 Telegram ID    : \`${uid}\`
👤 Username       : @${uname}

☁ Provider       : ${v.provider.toUpperCase()}
🆔 Instance ID    : \`${v.instanceId}\`
🌍 Region         : ${regionVal}
🖥 OS             : ${v.osLabel}
📛 Size Slug      : \`${sizeSlug}\`
⚡ CPU            : ${cpuLine}
💾 RAM            : ${ramLine}
💿 Disk           : ${diskLine}
🌐 Bandwidth      : ${bw}

📍 Public IP      : \`${ipVal || '-'}\`
👤 Login User     : \`${v.username}\`
${authLine}
🔌 SSH Port       : 22

📌 Status         : ${statusIcon(statusVal)}
${sourceLine}
🕒 Last Health    : ${v.lastHealthAt ? new Date(v.lastHealthAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) : '-'}
📅 Created        : ${new Date(v.createdAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}
━━━━━━━━━━━━━━━━━━`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Refresh Status', `v:a:refresh:${v._id}`),
     Markup.button.callback('🔁 Reboot', `v:a:reboot:${v._id}`)],
    [Markup.button.callback('⏹ Stop', `v:a:stop:${v._id}`),
     Markup.button.callback('▶ Start', `v:a:start:${v._id}`)],
    [Markup.button.callback('🗑 Delete VPS', `v:a:delete:${v._id}`)],
    [Markup.button.callback('⬅️ Back', 'v:list:1')],
  ]);
  await answerCb(ctx);
  return safeEditText(ctx, text, { parse_mode: 'Markdown', ...kb });
}

async function doAction(ctx, action, vpsId) {
  const v = await VpsInstance.findById(vpsId);
  if (!v) { await answerCb(ctx, 'VPS tidak ditemukan', true); return; }
  const api = await ProviderApi.findById(v.apiId);
  if (!api) { await answerCb(ctx, 'Provider API tidak ditemukan', true); return; }
  const acts = providerActions.forProvider(v.provider);
  if (!acts) { await answerCb(ctx, 'Provider tidak didukung', true); return; }

  let result;
  if (action === 'refresh') {
    result = await acts.getStatus(api, v);
    if (result.ok) {
      v.status = result.status;
      v.lastHealthAt = new Date();
      v.lastHealthStatus = result.status;
      await v.save();
    }
  } else if (action === 'reboot') { result = await acts.reboot(api, v); }
  else if (action === 'stop')   { result = await acts.stop(api, v);   if (result.ok) { v.status = 'stopped'; await v.save(); } }
  else if (action === 'start')  { result = await acts.start(api, v);  if (result.ok) { v.status = 'running'; await v.save(); } }
  else if (action === 'delete') {
    result = await acts.del(api, v);
    // Bugfix: if the provider account itself is permanently dead (invalid
    // token / unauthorized / suspended / closed), the provider API call
    // will NEVER succeed — the droplet cannot be reached, but it also can't
    // be reached to keep blocking cleanup. In that case skip provider API
    // deletion and fall back to a DB-only removal so the record doesn't
    // stay stuck in VPS Management forever.
    let dbOnlyCleanup = false;
    if (!result.ok && isPermanentProviderFailure(result.error)) {
      dbOnlyCleanup = true;
      result = { ok: true };
    }
    if (result.ok) {
      // Tandai VPS sebagai 'deleted' — supaya langsung hilang dari daftar
      // VPS Management. Data order/transaksi tetap utuh di DB (Order tidak
      // dihapus). Status detail juga di-flush.
      v.status = 'deleted';
      v.lastHealthAt = new Date();
      v.lastHealthStatus = dbOnlyCleanup ? 'provider_dead' : 'deleted';
      await v.save();
      // Setelah delete: langsung balik ke list (bukan render detail VPS yang
      // sudah hilang) supaya admin tidak bingung.
      await answerCb(ctx, dbOnlyCleanup
        ? '🗑 VPS dihapus dari database (provider tidak aktif/API tidak dapat dihubungi)'
        : '🗑 VPS berhasil dihapus');
      return renderList(ctx, 1);
    }
  }
  else { result = { ok: false, error: 'unknown action' }; }

  await answerCb(ctx, result.ok ? '✅ OK' : ('❌ ' + (result.error || '').slice(0, 60)), true);
  return renderDetail(ctx, vpsId);
}

async function startSearch(ctx) {
  openInputSession(ctx, { action: 'vps_search', returnTo: 'v:home' });
  await answerCb(ctx);
  return safeEditText(ctx,
`🔍 *CARI VPS*

Kirim kata kunci pencarian. Bot akan mencocokkan pada:
• Invoice
• Telegram ID / Username
• Public IP
• Provider (aws/digitalocean/linode/azure)
• Instance ID`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'v:home')]]) });
}

async function handleSearchText(ctx, q) {
  const sess = getSession(ctx.from.id);
  if (!sess || sess.action !== 'vps_search') return false;
  clearSession(ctx.from.id);
  const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const orders = await Order.find({ $or: [{ invoice: rx }, { userId: rx }, { username: rx }] }, '_id').lean();
  const orderIds = orders.map(o => String(o._id));
  const items = await VpsInstance.find({
    ...VISIBLE_FILTER,
    $or: [
      { publicIp: rx }, { provider: rx }, { instanceId: rx },
      { orderId: { $in: orderIds } },
    ],
  }).limit(20).lean();
  if (!items.length) {
    try { await ctx.deleteMessage(ctx.message.message_id); } catch (_) {}
    await respondInSession(ctx, `🔍 Tidak ada hasil untuk: \`${q}\``, { parse_mode: 'Markdown' });
    return true;
  }
  try { await ctx.deleteMessage(ctx.message.message_id); } catch (_) {}
  const orderMap = Object.fromEntries((await Order.find({ _id: { $in: items.map(i => i.orderId) } }, 'invoice').lean()).map(o => [String(o._id), o]));
  const rows = items.map(v => [Markup.button.callback(
    `${((orderMap[String(v.orderId)] || {}).invoice || v.instanceId).slice(-12)} • ${v.provider} • ${v.publicIp}`,
    `v:d:${v._id}`)]);
  rows.push([Markup.button.callback('⬅️ Back', 'v:home')]);
  await respondInSession(ctx, `🔍 *Hasil* (${items.length}):`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
  return true;
}

async function renderHcSettings(ctx) {
  const s = await getSettings();
  const cur = parseInt(s.healthCheckIntervalMinutes, 10) || 15;
  const enabled = (s.vpsHealthCheckEnabled || 'on') === 'on';
  const text =
`❤️ *HEALTH CHECK SETTINGS*

Status  : ${enabled ? '🟢 Aktif' : '🔴 Nonaktif'}
Interval: *${cur} menit*

_Bot memeriksa status VPS yang berstatus \`running\` setiap interval, lalu update DB & kirim notifikasi ke admin jika ditemukan VPS offline/stopped/terminated._`;
  const rows = [
    [Markup.button.callback(enabled ? '🔴 Nonaktifkan' : '🟢 Aktifkan', 'v:hc:tog')],
  ];
  const opts = [5, 10, 15, 30, 60];
  rows.push(opts.map(n => Markup.button.callback(`${cur === n ? '✅ ' : ''}${n}m`, `v:hc:set:${n}`)));
  rows.push([Markup.button.callback('✏️ Custom (menit)', 'v:hc:custom')]);
  rows.push([Markup.button.callback('▶ Run Now', 'v:hc:run')]);
  rows.push([Markup.button.callback('⬅️ Back', 'v:home')]);
  await answerCb(ctx);
  return safeEditText(ctx, text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
}

async function setHcInterval(ctx, minutes) {
  const n = parseInt(minutes, 10);
  if (!Number.isFinite(n) || n < 1) { await answerCb(ctx, 'Nilai tidak valid', true); return; }
  await updateSetting({ healthCheckIntervalMinutes: n });
  require('./adminPanelStore'); // ensure loaded
  const vpsHealth = require('../health/vpsHealth');
  vpsHealth.restart();
  await answerCb(ctx, `✅ Interval → ${n} menit`);
  return renderHcSettings(ctx);
}

async function toggleHc(ctx) {
  const s = await getSettings();
  const next = (s.vpsHealthCheckEnabled || 'on') === 'on' ? 'off' : 'on';
  await updateSetting({ vpsHealthCheckEnabled: next });
  require('../health/vpsHealth').restart();
  await answerCb(ctx, next === 'on' ? '🟢 Diaktifkan' : '🔴 Dinonaktifkan');
  return renderHcSettings(ctx);
}

async function runHcNow(ctx) {
  await answerCb(ctx, '⏳ Running...');
  const r = await require('../health/vpsHealth').checkAllVps();
  return safeEditText(ctx,
    `❤️ *HEALTH CHECK — MANUAL RUN*\n\nDiperiksa: *${r.checked}*\nOffline/terminated: *${r.alerts}*\n\n_Notifikasi telah dikirim ke admin._`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'v:home')]]) });
}

async function startCustomHc(ctx) {
  openInputSession(ctx, { action: 'vps_hc_custom', returnTo: 'v:hc:settings' });
  await answerCb(ctx);
  return safeEditText(ctx,
    '✏️ Kirim interval baru (menit, angka integer ≥ 1):',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'v:hc:settings')]]) });
}

async function handleCustomHcText(ctx, t) {
  const sess = getSession(ctx.from.id);
  if (!sess || sess.action !== 'vps_hc_custom') return false;
  const returnTo = sess.returnTo || 'v:hc:settings';
  clearSession(ctx.from.id);
  const n = parseInt(String(t).replace(/\D/g, ''), 10);
  const { respondSaved } = require('../utils/safeEdit');
  if (!Number.isFinite(n) || n < 1) { await respondSaved(ctx, '⚠️ Nilai tidak valid — tekan Kembali dan coba lagi.', returnTo); return true; }
  await updateSetting({ healthCheckIntervalMinutes: n });
  require('../health/vpsHealth').restart();
  await respondSaved(ctx, `✅ Interval Health Check diatur ke *${n} menit*.`, returnTo);
  return true;
}

module.exports = {
  renderHome, renderList, renderDetail, doAction,
  startSearch, handleSearchText,
  renderHcSettings, setHcInterval, toggleHc, runHcNow, startCustomHc, handleCustomHcText,
};
