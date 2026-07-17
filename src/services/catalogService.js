// Catalog Service — realtime stock/status/eta + auto-updated Telegram channel post.
//
// Data sources (NO new DB tables/models — all existing):
//   • Setting document → prices, specs, tier captions, catalogChannelId, catalogMessageId
//   • ProviderApi.count({ enabled:true, status:'READY' }) → stock number
//   • provisionQueue.stats() → queue running + pending for ETA
//
// Public API:
//   • getStock()            → { ready, statusLine, etaLine, statusEmoji }
//   • buildCatalogText(s?)  → full catalog text (Markdown)
//   • refreshChannel(bot)   → edit (or create) the single catalog post on channel
//   • scheduleUpdate(bot)   → debounced trigger — safe to call from many hooks
//   • attachBot(bot)        → save bot ref so hooks with no ctx can trigger

const ProviderApi = require('../models/ProviderApi');
const { getSettings, updateSetting, specOf } = require('./settingService');
const { provisionQueue } = require('../queues/provisionQueue');

let botRef = null;
function attachBot(b) { botRef = b; }
function getBot() { return botRef; }

// ---------------- Stock / Status / ETA (single source of truth) ----------------
async function getReadyCount() {
  try { return await ProviderApi.countDocuments({ enabled: true, status: 'READY' }); }
  catch (_) { return 0; }
}

// SUM of Quota Available across providers that are ENABLED and available to
// serve stock. INCLUDES 'LOCKED' (currently running an install) — locked
// providers still have quota; they're only temporarily busy, not out-of-stock.
// EXCLUDES: ERROR, QUOTA_FULL, SUSPENDED, USED, disabled providers, and any
// row with quotaAvailable <= 0.
//
// This separation was introduced to fix the bug where "Provider LOCKED"
// (Windows install in progress) was wrongly interpreted as "STOCK KOSONG".
async function getReadyQuotaSum() {
  try {
    const rows = await ProviderApi.find(
      { enabled: true, status: { $in: ['READY', 'LOCKED'] } },
      { quotaAvailable: 1 },
    ).lean();
    return rows.reduce((sum, r) => sum + (Number(r.quotaAvailable) || 0), 0);
  } catch (_) { return 0; }
}

// Availability breakdown: distinguishes "stock exists but all providers busy"
// (all provisioning slots LOCKED) from "truly out of stock" (0 available).
// Used by Buy-menu guard to decide between "STOCK KOSONG" vs "ANTRIAN".
async function getProviderAvailability() {
  try {
    const rows = await ProviderApi.find(
      { enabled: true, status: { $in: ['READY', 'LOCKED'] } },
      { status: 1, quotaAvailable: 1 },
    ).lean();
    let stock = 0, readyProviders = 0, lockedProviders = 0;
    for (const r of rows) {
      const q = Number(r.quotaAvailable) || 0;
      if (q <= 0) continue;
      stock += q;
      if (r.status === 'READY') readyProviders++;
      else if (r.status === 'LOCKED') lockedProviders++;
    }
    // "allBusy" = ada stock, tapi TIDAK ada provider READY (semua LOCKED).
    // User harus masuk antrean, bukan diberitahu stock habis.
    const allBusy = stock > 0 && readyProviders === 0 && lockedProviders > 0;
    return { stock, readyProviders, lockedProviders, allBusy };
  } catch (_) {
    return { stock: 0, readyProviders: 0, lockedProviders: 0, allBusy: false };
  }
}

// Unified status thresholds — SAME logic used by Admin Panel, Buy Menu, and
// Channel catalog. Based on SUM(quotaAvailable) of READY & ENABLED providers.
//   > 5  → 🟢 Online
//   1–5  → 🟡 Terbatas
//   0    → 🔴 Habis
function statusLine(ready) {
  if (ready > 5) return { emoji: '🟢', text: '🟢 Status Layanan : Online', short: '🟢 Status : Online' };
  if (ready >= 1) return { emoji: '🟡', text: '🟡 Status Layanan : Terbatas', short: '🟡 Status : Terbatas' };
  return { emoji: '🔴', text: '🔴 Status Layanan : Habis', short: '🔴 Status : Habis' };
}

function etaLine(ready, queueStats) {
  if (ready === 0) return '❌ Estimasi Aktivasi : Tidak Tersedia';
  const total = (queueStats.running || 0) + (queueStats.pending || 0);
  if (total === 0 && ready > 5) return '⚡ Estimasi Aktivasi : ±1 Menit';
  if (total >= 1 && total <= 5)  return '⚡ Estimasi Aktivasi : ±1-3 Menit';
  if (total >= 6 && total <= 10) return '⏳ Estimasi Aktivasi : ±3-5 Menit';
  if (total > 10)                return '⏳ Estimasi Aktivasi : ±5-10 Menit';
  return '⚡ Estimasi Aktivasi : ±1-3 Menit';
}

async function getStock() {
  // UNIFIED with Admin Panel logic: stock = SUM(quotaAvailable) across
  // provider APIs that are ENABLED and status === 'READY'.
  // Providers with status ERROR/LOCKED/DISABLED/SUSPENDED/QUOTA_FULL or
  // quotaAvailable === 0 are naturally excluded by the filter/sum.
  const ready = await getReadyQuotaSum();
  const qs = provisionQueue.stats();
  const st = statusLine(ready);
  return {
    ready,
    statusEmoji: st.emoji,
    statusLine: st.text,
    statusLineShort: st.short,
    stockLine: `${st.emoji} Stock Ready : ${ready}`,
    etaLine: etaLine(ready, qs),
    queue: qs,
  };
}

// Buy-menu specific stock: sum of quotaAvailable across READY providers.
// Uses the SAME statusLine() thresholds as Admin Panel & Channel — one source
// of truth to guarantee identical indicators everywhere.
async function getBuyMenuStock() {
  const av = await getProviderAvailability();
  const qs = provisionQueue.stats();
  const st = statusLine(av.stock);
  return {
    stock: av.stock,
    readyProviders: av.readyProviders,
    lockedProviders: av.lockedProviders,
    allBusy: av.allBusy,
    statusLine: st.text,
    stockLine: `${st.emoji} Stock Ready : ${av.stock}`,
    etaLine: etaLine(av.stock, qs),
    queue: qs,
  };
}

// ---------------- Catalog text builder ----------------
function rupiah(n) {
  if (!n && n !== 0) return 'Rp0';
  return 'Rp' + Number(n).toLocaleString('id-ID');
}

// Parse a free-form spec string into a normalized compact line.
// Accepts flexible admin input like:
//   "2GB RAM\n2 CPU\n60GB SSD\n3TB BW"   or "2 CPU 2GB RAM 60 SSD 3 TB"
// Returns e.g. "2C • 2GB • 60SSD • 3TB BW"  (VPS) / drops BW segment when null.
function parseSpec(raw, { includeBw = true } = {}) {
  const s = String(raw || '').replace(/\r/g, '');
  const num = (re) => { const m = s.match(re); return m ? m[1] : null; };
  const cpu = num(/(\d+)\s*(?:c(?:pu|ore)?s?|vcpu)/i);
  const ram = num(/(\d+)\s*g\s*b?\s*(?:ram|memory|mem)?/i) || num(/(\d+)\s*g\b/i);
  const ssd = num(/(\d+)\s*g\s*b?\s*(?:ssd|nvme|disk|storage)/i);
  const bw  = num(/(\d+)\s*t\s*b?\s*(?:bw|bandwidth|traffic)?/i);
  const segs = [];
  if (cpu) segs.push(`${cpu}C`);
  if (ram) segs.push(`${ram}GB`);
  if (ssd) segs.push(`${ssd}SSD`);
  if (includeBw && bw) segs.push(`${bw}TB BW`);
  if (!segs.length) {
    // Fallback: collapse original spec into one line
    return s.split('\n').map(x => x.trim()).filter(Boolean).join(' • ');
  }
  return segs.join(' • ');
}

const CIRCLED = ['①', '②', '③'];

// Build monospace-aligned block for a tier. Uses backtick code fencing so
// spacing is preserved on Android/iOS/Desktop equally.
async function tierBlock(s, category, tier, stock) {
  const icon = category === 'vps' ? '💻' : '🖥';
  const catLabel = category === 'vps' ? 'VPS' : 'RDP';
  const includeBw = category === 'vps';
  const promoSvc = require('./promoService');
  // Collect rows
  const rows = [];
  let anyDiscount = false;
  for (const slot of [1, 2, 3]) {
    const info = specOf(s, category, tier, slot);
    const compact = parseSpec(info.spec, { includeBw });
    const orig = info.price || 0;
    const r = orig > 0 ? await promoSvc.applyToPrice(orig, category, tier) : { discounted: 0, original: 0, promo: null };
    let priceStr;
    if (r.promo && r.discounted !== r.original) {
      anyDiscount = true;
      priceStr = `${rupiah(r.discounted)} 🔥`;
    } else {
      priceStr = rupiah(orig);
    }
    rows.push({ num: CIRCLED[slot - 1], compact, price: priceStr });
  }
  const specColWidth = Math.max(...rows.map(r => r.compact.length));
  const rowWidth = Math.max(38, specColWidth + 14);
  const table = rows.map(r => {
    const left = `${r.num} ${r.compact}`;
    const pad = Math.max(2, rowWidth - left.length - r.price.length);
    return `${left}${' '.repeat(pad)}${r.price}`;
  }).join('\n');

  return [
    `${icon} *${catLabel} ${tier.toUpperCase()}*${anyDiscount ? '  🎉 PROMO' : ''}`,
    '',
    `📦 Stock : ${stock.ready}`,
    stock.statusLineShort,
    '',
    '```',
    table,
    '```',
  ].join('\n');
}

async function buildCatalogText(s) {
  if (!s) s = await getSettings();
  const stock = await getStock();
  const SEP = '━━━━━━━━━━━━━━━━━━━━━━';
  const parts = ['🚀 *TOKO VPS & RDP*', '', SEP];
  // Prepend promo block if any active
  try {
    const promoBlock = await require('./promoService').homeBlockText();
    if (promoBlock) { parts.push(promoBlock); parts.push(SEP); }
  } catch (_) {}
  for (const cat of ['vps', 'rdp']) {
    for (const tier of ['low', 'basic', 'medium']) {
      parts.push(await tierBlock(s, cat, tier, stock));
      parts.push(SEP);
    }
  }
  parts.push('');
  parts.push(stock.etaLine);
  parts.push('');
  parts.push('🕒 _Update Otomatis_');
  return parts.join('\n');
}

// ---------------- Channel post management ----------------
// Edits existing message OR creates a new one on first run.
async function refreshChannel(bot) {
  const b = bot || botRef;
  if (!b) return { ok: false, error: 'bot not attached' };
  const s = await getSettings();
  const chan = String(s.catalogChannelId || '').trim();
  if (!chan) return { ok: false, error: 'catalogChannelId not set' };
  const text = await buildCatalogText(s);
  const opts = { parse_mode: 'Markdown', disable_web_page_preview: true };

  const existingId = parseInt(String(s.catalogMessageId || '').trim(), 10);
  if (existingId) {
    try {
      await b.telegram.editMessageText(chan, existingId, undefined, text, opts);
      return { ok: true, edited: true, messageId: existingId };
    } catch (err) {
      const desc = (err && err.description) || err.message || '';
      // If content identical → benign
      if (/message is not modified/i.test(desc)) return { ok: true, edited: false, messageId: existingId };
      // If message deleted / not found → fall through to re-post
      if (!/message to edit not found|message can't be edited|MESSAGE_ID_INVALID/i.test(desc)) {
        return { ok: false, error: desc };
      }
    }
  }
  // Create fresh post
  try {
    const sent = await b.telegram.sendMessage(chan, text, opts);
    await updateSetting({ catalogMessageId: String(sent.message_id) });
    return { ok: true, created: true, messageId: sent.message_id };
  } catch (err) {
    return { ok: false, error: (err && err.description) || err.message };
  }
}

// ---------------- Debounced trigger ----------------
let _pendingTimer = null;
function scheduleUpdate(bot) {
  if (bot) attachBot(bot);
  if (_pendingTimer) return;
  _pendingTimer = setTimeout(async () => {
    _pendingTimer = null;
    try { await refreshChannel(botRef); } catch (e) { console.error('catalog refresh:', e.message); }
  }, 3000);
}

// Periodic safety refresh every 5 minutes to reflect quota changes even without hook.
function startPeriodic(intervalMs = 5 * 60 * 1000) {
  setInterval(() => { if (botRef) refreshChannel(botRef).catch(() => {}); }, intervalMs);
}

// ═══════════════════════════════════════════════════════════════════════
// STOCK ANNOUNCEMENT POST — separate from the always-edited catalog post.
// Publishes a fresh "STOCK VPS/RDP READY" card with a deep-link button so
// users can tap → open the bot → auto-run the BUY flow. Admin triggers this
// manually via "Update Stock VPS"/"Update Stock RDP" buttons in the panel.
// ═══════════════════════════════════════════════════════════════════════
async function publishStockAnnouncement(bot, category) {
  const b = bot || botRef;
  if (!b) return { ok: false, error: 'bot not attached' };
  const s = await getSettings();
  const chan = String(s.catalogChannelId || '').trim();
  if (!chan) return { ok: false, error: 'catalogChannelId belum di-set (Admin → Catalog Channel)' };
  const stock = await getBuyMenuStock();
  const label = category === 'vps' ? '☁️ STOCK VPS READY' : '🖥 STOCK RDP READY';
  const icon = category === 'vps' ? '📦 VPS Ready' : '📦 RDP Ready';
  const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false });
  const text = [
    '━━━━━━━━━━━━━━━━━━━━',
    `${label}`,
    '━━━━━━━━━━━━━━━━━━━━',
    '',
    `${icon}`,
    `*${stock.stock} Unit*`,
    '',
    `${stock.statusLine}`,
    `${stock.etaLine}`,
    '',
    `🕒 Update: ${now} WIB`,
    '━━━━━━━━━━━━━━━━━━━━',
    '',
    'Silakan klik tombol di bawah untuk memulai pembelian.',
  ].join('\n');
  // Deep-link button → opens the bot, /start payload = buy_vps / buy_rdp.
  const me = await b.telegram.getMe().catch(() => ({ username: 'bot' }));
  const url = `https://t.me/${me.username}?start=${category === 'vps' ? 'buy_vps' : 'buy_rdp'}`;
  const opts = {
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[{ text: category === 'vps' ? '🛒 BUY VPS' : '🛒 BUY RDP', url }]],
    },
  };
  try {
    const sent = await b.telegram.sendMessage(chan, text, opts);
    return { ok: true, messageId: sent.message_id, stock: stock.stock };
  } catch (e) {
    return { ok: false, error: (e && e.description) || e.message };
  }
}

// One-shot admin refresh: recompute stock from providers → refresh main
// catalog post → publish stock announcement. Called from the admin panel
// "Update Stock VPS/RDP" button and from post-provision hooks.
async function fullStockRefresh(bot, category) {
  const b = bot || botRef;
  await refreshChannel(b).catch(() => {});
  return publishStockAnnouncement(b, category);
}



module.exports = {
  getStock, getBuyMenuStock, getProviderAvailability, buildCatalogText, refreshChannel, scheduleUpdate,
  attachBot, getBot, startPeriodic,
  publishStockAnnouncement, fullStockRefresh,
};
