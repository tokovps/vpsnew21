// Enterprise admin handler — Provider Center, Payment Center, Currency Center,
// Language Center, Provider Dashboard, Audit Log, Backup Config.
// This EXTENDS the existing adminHandler without replacing it.
const { Markup } = require('telegraf');
const { safeEditText, answerCb, respondInSession } = require('../utils/safeEdit');
const { setSession, clearSession, getSession, openInputSession } = require('./sessionStore');
const { getPanel } = require('./adminPanelStore');
const { adminMenu, adminBack } = require('../keyboards/admin');
const { updateSetting, getSettings } = require('../services/settingService');
const ProviderApi = require('../models/ProviderApi');
const AuditLog = require('../models/AuditLog');
const providerService = require('../services/providerService');
const providerHealth = require('../health/providerHealth');
const currencyService = require('../services/currencyService');
const i18n = require('../services/i18nService');
const paymentConfig = require('../services/paymentConfigService');
const autogopay = require('../payments/autogopay');
const binancepay = require('../payments/binancepay');
const backup = require('../services/backupService');
const { provisionQueue } = require('../queues/provisionQueue');
const Order = require('../models/Order');

// =========================================================
// Enterprise menu keyboard (added to admin home via extra row).
// Audit 2026-01: tombol duplikat dihapus.
//   • `☁️ VPS Providers` (e:prov:menu) → sudah tersedia di menu utama
//     sebagai `🌐 Provider Management` dengan callback yang SAMA. Dihapus
//     dari sini untuk menghindari dua pintu masuk ke handler yang identik.
//   • `💳 Payment Center` (e:pay:menu) → sudah tersedia di menu utama
//     sebagai `💳 Payment Center` dengan callback yang SAMA. Dihapus dari
//     sini karena alasan yang sama.
// Item lain (Currency, Language, Dashboard, Queue, Audit, Backup, AutoProv)
// UNIK dan tetap dipertahankan di Enterprise Panel.
const entMenu = () => Markup.inlineKeyboard([
  [Markup.button.callback('💱 Currency Center', 'e:cur:menu'),
   Markup.button.callback('🌐 Language', 'e:lang:menu')],
  [Markup.button.callback('📊 Provider Dashboard', 'e:dash:providers'),
   Markup.button.callback('📡 Queue Dashboard', 'e:queue:menu')],
  [Markup.button.callback('📜 Audit Log', 'e:audit:menu'),
   Markup.button.callback('💾 Backup/Restore', 'e:bak:menu')],
  [Markup.button.callback('⚡ Auto Provisioning', 'e:autoprov:tog')],
  [Markup.button.callback('⬅️ Kembali', 'a:home')],
]);

async function renderEnterpriseHome(ctx) {
  const s = await getSettings();
  const enabled = (s.autoProvisionEnabled || 'off') === 'on';
  const q = provisionQueue.stats();
  const text =
`🚀 *ENTERPRISE PANEL*

Auto Provisioning: *${enabled ? '🟢 ON' : '🔴 OFF'}*
Queue: running=${q.running} pending=${q.pending}

Pilih menu di bawah untuk mengelola sistem provisioning otomatis, payment gateway, mata uang, bahasa, audit & backup.`;
  await answerCb(ctx);
  return safeEditText(ctx, text, { parse_mode: 'Markdown', ...entMenu() });
}

async function toggleAutoProvisioning(ctx) {
  const s = await getSettings();
  const next = (s.autoProvisionEnabled || 'off') === 'on' ? 'off' : 'on';
  await updateSetting({ autoProvisionEnabled: next });
  await answerCb(ctx, next === 'on' ? '🟢 Auto Provisioning ON' : '🔴 Auto Provisioning OFF');
  return renderEnterpriseHome(ctx);
}

// =========================================================
// PROVIDER MENU
// =========================================================
const provTypeMenu = () => Markup.inlineKeyboard([
  [Markup.button.callback('➕ Tambah AWS', 'e:prov:add:aws')],
  [Markup.button.callback('➕ Tambah DigitalOcean', 'e:prov:add:digitalocean')],
  [Markup.button.callback('➕ Tambah Linode', 'e:prov:add:linode')],
  [Markup.button.callback('➕ Tambah Azure', 'e:prov:add:azure')],
  [Markup.button.callback('📋 Daftar API', 'e:prov:list')],
  [Markup.button.callback('🔄 Health Check Semua', 'e:prov:healthall')],
  [Markup.button.callback('♻️ Reset ERROR → READY', 'e:prov:reseterr')],
  [Markup.button.callback('⬅️ Kembali', 'e:home')],
]);

async function showProviderMenu(ctx) {
  const stats = await providerService.statsByProvider();
  const lines = ['aws', 'digitalocean', 'linode', 'azure'].map(p => {
    const s = stats[p] || {};
    return `*${p.toUpperCase()}*  READY:${s.READY || 0}  LOCKED:${s.LOCKED || 0}  USED:${s.USED || 0}  ERROR:${s.ERROR || 0}`;
  });
  await answerCb(ctx);
  return safeEditText(ctx,
    `☁️ *VPS PROVIDERS*\n\n${lines.join('\n')}\n\nGunakan menu untuk menambah / mengelola API key.`,
    { parse_mode: 'Markdown', ...provTypeMenu() });
}

const ADD_FIELDS = {
  aws: [
    { k: 'awsAccessKey', label: 'AWS Access Key ID' },
    { k: 'awsSecretKey', label: 'AWS Secret Access Key' },
    { k: 'awsRegion',    label: 'Region (opsional, mis. ap-southeast-1). Kirim "-" untuk auto.' },
  ],
  digitalocean: [{ k: 'doToken', label: 'DigitalOcean API Token' }],
  linode:       [{ k: 'linodeToken', label: 'Linode API Token' }],
  azure: [
    { k: 'azTenantId',       label: 'Azure Tenant ID' },
    { k: 'azClientId',       label: 'Azure Client ID' },
    { k: 'azClientSecret',   label: 'Azure Client Secret' },
    { k: 'azSubscriptionId', label: 'Azure Subscription ID' },
  ],
};

async function startAddProvider(ctx, provider) {
  const fields = ADD_FIELDS[provider];
  if (!fields) { await answerCb(ctx, 'Provider tidak valid', true); return; }
  openInputSession(ctx, { action: 'e_prov_add', provider, fields, idx: 0, values: {}, returnTo: 'e:prov:menu' });
  await answerCb(ctx);
  return safeEditText(ctx,
    `➕ *Tambah API ${provider.toUpperCase()}*\n\nKirim: *${fields[0].label}*`,
    { parse_mode: 'Markdown', ...adminBack() });
}

async function handleProvAddText(ctx, session, text) {
  const cur = session.fields[session.idx];
  const val = text.trim() === '-' ? '' : text.trim();
  session.values[cur.k] = val;
  session.idx++;
  if (session.idx < session.fields.length) {
    openInputSession(ctx, session);
    return respondInSession(ctx, `Kirim: *${session.fields[session.idx].label}*`, { parse_mode: 'Markdown', ...adminBack() });
  }
  // === SMART LOADING VALIDATION (single-message, generic across providers) ===
  // Delete user's last text; keep session anchor for streaming edits.
  try { if (ctx.message && ctx.message.message_id) await ctx.deleteMessage(ctx.message.message_id); } catch (_) {}
  const anchor = require('./sessionStore').getAnchor(ctx.from.id);
  const providersMod = require('../providers');
  const PROV_LABEL = session.provider.toUpperCase();

  // Pipeline steps we will render (icons update as they complete)
  const PIPELINE = [
    'Memvalidasi API Key',
    'Menghubungi Provider',
    'Memeriksa Authentication',
    'Memeriksa Billing',
    'Memeriksa Permission',
    'Memeriksa Region',
    'Memeriksa Image',
    'Memeriksa Quota',
    'Menguji kemampuan membuat VPS',
    'Menghitung Health Score',
  ];

  // Map completed-adapter-step labels to pipeline positions.
  function mapStepIdx(label) {
    const m = String(label).toLowerCase();
    if (m.startsWith('api valid')) return 0;
    if (m.startsWith('authentication')) return 2;
    if (m.startsWith('billing')) return 3;
    if (m.startsWith('permission')) return 4;
    if (m.startsWith('region')) return 5;
    if (m.startsWith('image')) return 6;
    if (m.startsWith('quota')) return 7;
    if (m.startsWith('provision test')) return 8;
    if (m.startsWith('health')) return 9;
    return -1;
  }

  // Render helper — one editMessageText per progress tick.
  let lastRender = '';
  async function render(completedIdx, failedIdx = -1, failDetail = '') {
    const linesUi = PIPELINE.map((label, i) => {
      let icon = '⏳';
      if (i === failedIdx) icon = '❌';
      else if (completedIdx.has(i)) icon = '✅';
      else if (completedIdx.size >= i && i === Math.min(...[...Array(PIPELINE.length).keys()].filter(x => !completedIdx.has(x)))) icon = '🔄';
      return `${icon} ${label}...`;
    });
    // Step 1 (Contact provider) auto-complete after step 0 (API Valid)
    if (completedIdx.has(0)) completedIdx.add(1);
    const body =
`━━━━━━━━━━━━━━━━━━
☁ *Menambahkan Provider ${PROV_LABEL}...*

${linesUi.join('\n')}
━━━━━━━━━━━━━━━━━━`;
    if (body === lastRender) return;
    lastRender = body;
    try {
      await ctx.telegram.editMessageText(anchor.chatId, anchor.messageId, undefined, body,
        { parse_mode: 'Markdown', ...adminBack() });
    } catch (_) {}
  }

  const completed = new Set();
  await render(completed);

  // Fake api object (NOT persisted yet). deepProbe expects same fields as ProviderApi.
  const pendingApi = { provider: session.provider, ...session.values };

  const result = await providersMod.deepProbe(pendingApi, async (steps) => {
    const last = steps[steps.length - 1];
    if (!last) return;
    const idx = mapStepIdx(last.label);
    if (idx < 0) return;
    if (last.ok) {
      completed.add(idx);
      await render(completed);
    } else {
      await render(completed, idx, last.detail);
    }
  });

  if (!result.ok) {
    // Do NOT persist — show clear failure and offer retry/back.
    const failLine = result.steps && result.steps.find(s => !s.ok);
    const reason = (failLine && failLine.detail) ? failLine.detail : (result.error || 'unknown');
    clearSession(ctx.from.id);
    const errBody =
`❌ *Provider ${PROV_LABEL} GAGAL Divalidasi*

*Penyebab:* ${result.error || 'Validation Failed'}
${failLine ? `_Detail: ${String(reason).slice(0, 300)}_` : ''}

Token *TIDAK* disimpan. Coba periksa credential lalu tambahkan ulang.`;
    try {
      await ctx.telegram.editMessageText(anchor.chatId, anchor.messageId, undefined, errBody,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'e:prov:menu')]]) });
    } catch (_) {}
    return;
  }

  // ═══ AUTO NOTIF STOCK BARU — snapshot stock SEBELUM provider baru
  // dipersist. catalogService adalah satu-satunya sumber perhitungan stock
  // yang sudah ada di project (VPS & RDP berbagi satu pool quotaAvailable);
  // tidak ada sistem stock baru yang dibuat di sini.
  const catalogService = require('../services/catalogService');
  const beforeStockCount = (await catalogService.getBuyMenuStock()).stock;

  // === PERSIST only after full pass ===
  const api = await ProviderApi.create({
    provider: session.provider,
    ...session.values,
    // Persist detected region if user left blank
    awsRegion: session.provider === 'aws' ? (session.values.awsRegion || result.region || '') : session.values.awsRegion,
    status: 'READY',
    quotaAvailable: (result.quota && result.quota.available) || 0,
    score: result.score || 60,
    lastCheckAt: new Date(),
  });
  clearSession(ctx.from.id);

  try {
    require('../services/adminNotifyService').notifyActivity(
      ctx.from, `Admin Menambah Provider ${PROV_LABEL}`,
      { '☁️ Provider:': PROV_LABEL, '🌍 Region:': result.region || '-', '📊 Score:': String(result.score || 60) },
    );
  } catch (_) {}

  // ═══ AUTO NOTIF STOCK BARU ═══════════════════════════════════════════
  // Broadcast HANYA jika: Provider tersimpan (di titik ini sudah pasti —
  // ProviderApi.create() di atas berhasil), Health Check sukses & Quota
  // berhasil dihitung (dijamin oleh deepProbe/result.ok di atas — kalau
  // gagal, fungsi ini sudah return lebih awal dan token tidak disimpan),
  // dan stock bertambah (>0) dibanding snapshot sebelum provider ini
  // ditambahkan. Menggunakan broadcastService yang SUDAH ADA (sistem yang
  // sama persis dengan menu admin "📢 Broadcast") — tidak membuat sistem
  // broadcast baru.
  try {
    const availQuota = (result.quota && result.quota.available) || 0;
    if (availQuota > 0) {
      const afterStock = await catalogService.getBuyMenuStock();
      const added = afterStock.stock - beforeStockCount;
      if (added > 0) {
        const bcText =
`🎉 *STOCK BARU TELAH TERSEDIA*

☁️ Provider : ${PROV_LABEL}
🖥 Stock VPS : +${added}
🖥 Stock RDP : +${added}

📦 *Total Stock Sekarang*

☁️ VPS : ${afterStock.stock}
🖥 RDP : ${afterStock.stock}

🔥 Silakan lakukan pemesanan melalui menu BUY VPS / BUY RDP.`;
        const { sendBroadcast } = require('../services/broadcastService');
        await sendBroadcast({
          bot: { telegram: ctx.telegram },
          message: bcText,
          adminId: `system:new-provider-stock:${api._id}`,
        });
      }
    }
  } catch (_) { /* best-effort — never block provider creation flow */ }

  const okBody =
`✅ *Provider ${PROV_LABEL} Berhasil Ditambahkan*

✅ API Valid
✅ Billing Aktif
✅ Permission Lengkap
✅ Region Tersedia${result.region ? ` (${result.region})` : ''}
✅ Quota Tersedia${result.quota && result.quota.limit ? ` (${result.quota.available}/${result.quota.limit})` : ''}
✅ Provision Test Berhasil
✅ Health Check Lulus (score ${result.score || 60})

*Status:* 🟢 READY
*ID:* \`${api._id}\``;
  try {
    await ctx.telegram.editMessageText(anchor.chatId, anchor.messageId, undefined, okBody,
      { parse_mode: 'Markdown', ...entMenu() });
  } catch (_) {}
}

async function listProviderApis(ctx) {
  const all = await providerService.listAll();
  if (!all.length) { await answerCb(ctx, 'Kosong', true); return showProviderMenu(ctx); }
  const rows = all.slice(0, 30).map((a) => [
    Markup.button.callback(`${a.enabled ? '🟢' : '🔴'} ${a.provider} • ${a.status} • ${(a.awsAccessKey || a.doToken || a.linodeToken || a.azClientId || '').slice(0, 6)}…`, `e:prov:api:${a._id}`),
  ]);
  rows.push([Markup.button.callback('⬅️ Kembali', 'e:prov:menu')]);
  await answerCb(ctx);
  return safeEditText(ctx, `📋 *Daftar API (${all.length})*`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
}

async function showApiDetail(ctx, id) {
  const a = await ProviderApi.findById(id).lean();
  if (!a) { await answerCb(ctx, 'Tidak ditemukan', true); return; }
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback(a.enabled ? '🔴 Nonaktifkan' : '🟢 Aktifkan', `e:prov:tog:${id}`)],
    [Markup.button.callback('🔎 Health Check', `e:prov:hc:${id}`), Markup.button.callback('🗑 Hapus', `e:prov:del:${id}`)],
    [Markup.button.callback('⬅️ Kembali', 'e:prov:list')],
  ]);
  await answerCb(ctx);
  const detail =
`🔑 *API ${a.provider.toUpperCase()}*
Status: *${a.status}*
Enabled: ${a.enabled ? 'yes' : 'no'}
Region: ${a.awsRegion || '-'}
Quota available: ${a.quotaAvailable}
Usage count: ${a.usageCount}
Last error: ${(a.lastError || '-').slice(0, 200)}
Last check: ${a.lastCheckAt ? new Date(a.lastCheckAt).toISOString() : '-'}`;
  return safeEditText(ctx, detail, { parse_mode: 'Markdown', ...kb });
}

async function toggleApi(ctx, id) {
  const a = await ProviderApi.findById(id);
  if (!a) { await answerCb(ctx, 'Tidak ditemukan', true); return; }
  a.enabled = !a.enabled; await a.save();
  await answerCb(ctx, a.enabled ? '🟢 Aktif' : '🔴 Nonaktif');
  return showApiDetail(ctx, id);
}

async function healthCheckOne(ctx, id) {
  await answerCb(ctx, '🔎 Mengecek...');
  await providerHealth.checkOne(id);
  return showApiDetail(ctx, id);
}

async function deleteApi(ctx, id) {
  await ProviderApi.deleteOne({ _id: id });
  await answerCb(ctx, 'Dihapus');
  return listProviderApis(ctx);
}

async function healthAll(ctx) {
  await answerCb(ctx, 'Menjalankan health check...');
  await providerHealth.checkAll();
  return showProviderMenu(ctx);
}

async function resetErrors(ctx) {
  const r = await providerService.resetAllErrors();
  await answerCb(ctx, `♻️ Reset ${r.modifiedCount || 0}`);
  return showProviderMenu(ctx);
}

// =========================================================
// PAYMENT CENTER
// =========================================================
const payMenu = () => Markup.inlineKeyboard([
  [Markup.button.callback('🇮🇩 AutoGoPay', 'e:pay:cfg:autogopay')],
  [Markup.button.callback('🌐 Binance Pay', 'e:pay:cfg:binancepay')],
  [Markup.button.callback('📡 Webhook Monitor', 'e:pay:monitor')],
  [Markup.button.callback('⬅️ Kembali', 'e:home')],
]);

async function showPayMenu(ctx) {
  const list = await paymentConfig.listAll();
  const lines = list.map(p => `• ${p.provider} — ${p.enabled ? '🟢 Aktif' : '🔴 Nonaktif'}`);
  await answerCb(ctx);
  return safeEditText(ctx, `💳 *PAYMENT CENTER*\n\n${lines.join('\n') || '(none)'}\n\nAtur payment gateway di bawah:`, { parse_mode: 'Markdown', ...payMenu() });
}

async function showPayConfig(ctx, provider) {
  // Clear any lingering edit-field wizard so re-opening this menu is always clean.
  const stale = getSession(ctx.from.id);
  if (stale && (stale.action === 'e_pay_field')) clearSession(ctx.from.id);
  const c = await paymentConfig.get(provider);
  // Escape Markdown-special chars so user-supplied values (API keys, QRIS
  // strings, webhook URLs) can never break the message parser and lock the
  // panel into an un-editable state.
  const esc = (s) => String(s == null ? '' : s).replace(/([_*`\[\]])/g, '\\$1');
  const mask = (s) => s ? esc(s.slice(0, 4) + '****' + s.slice(-4)) : '(kosong)';
  const enabledLine = c.enabled ? '🟢 Aktif' : '🔴 Nonaktif';
  const lastCallback = c.lastCallbackAt ? new Date(c.lastCallbackAt).toISOString() : '-';
  const connStatus = c.lastTestOk ? '🟢 Connected' : (c.lastError ? '🔴 Disconnected' : '⚪ Belum diuji');

  let text = '';
  let rows = [];
  if (provider === 'autogopay') {
    text =
`📦 *AUTOGOPAY*

Status : ${enabledLine}
API Key : ${mask(c.apiKey)}
QRIS String : ${c.qrisString ? mask(c.qrisString) : '(kosong)'}
Webhook URL : ${c.webhookUrl ? esc(c.webhookUrl) : '-'}
Last Callback : ${lastCallback}
Connection Status : ${connStatus}`;
    rows = [
      [Markup.button.callback(c.enabled ? '🔴 Disable' : '🟢 Enable', `e:pay:tog:${provider}`)],
      [Markup.button.callback('🔑 Edit API Key', `e:pay:field:${provider}:apiKey`)],
      [Markup.button.callback('📱 Edit QRIS String', `e:pay:field:${provider}:qrisString`)],
      [Markup.button.callback('🔗 Edit Webhook URL', `e:pay:field:${provider}:webhookUrl`)],
      [Markup.button.callback('🧪 Test Connection', `e:pay:test:${provider}`)],
      [Markup.button.callback('⬅️ Kembali', 'e:pay:menu')],
    ];
  } else if (provider === 'binancepay') {
    text =
`📦 *BINANCE PAY*

Status : ${enabledLine}
API Key : ${mask(c.apiKey)}
API Secret : ${mask(c.apiSecret)}
Webhook URL : ${c.webhookUrl ? esc(c.webhookUrl) : '-'}
Connection Status : ${connStatus}
Last Callback : ${lastCallback}`;
    rows = [
      [Markup.button.callback(c.enabled ? '🔴 Disable' : '🟢 Enable', `e:pay:tog:${provider}`)],
      [Markup.button.callback('🔑 Edit API Key', `e:pay:field:${provider}:apiKey`)],
      [Markup.button.callback('🔒 Edit API Secret', `e:pay:field:${provider}:apiSecret`)],
      [Markup.button.callback('🔗 Edit Webhook URL', `e:pay:field:${provider}:webhookUrl`)],
      [Markup.button.callback('🧪 Test Connection', `e:pay:test:${provider}`)],
      [Markup.button.callback('⬅️ Kembali', 'e:pay:menu')],
    ];
  } else {
    // Fallback (unknown provider)
    text = `📦 *${provider.toUpperCase()}*\n\nStatus: ${enabledLine}`;
    rows = [[Markup.button.callback('⬅️ Kembali', 'e:pay:menu')]];
  }
  await answerCb(ctx);
  return safeEditText(ctx, text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
}

async function togglePayment(ctx, provider) {
  await paymentConfig.toggle(provider);
  await answerCb(ctx, 'Toggled');
  return showPayConfig(ctx, provider);
}

async function startEditPayField(ctx, provider, field) {
  openInputSession(ctx, { action: 'e_pay_field', provider, field, returnTo: `e:pay:${provider}` });
  await answerCb(ctx);
  return safeEditText(ctx, `📝 Kirim nilai baru untuk *${provider}.${field}*:\n\n(kirim "-" untuk kosongkan)`, { parse_mode: 'Markdown', ...adminBack() });
}

async function testPayment(ctx, provider) {
  await answerCb(ctx, 'Menguji...');
  const r = provider === 'autogopay' ? await autogopay.testConnection() : await binancepay.testConnection();
  const panel = getPanel(ctx.from.id);
  let text;
  if (r.ok) {
    const bullets = (r.checks || []).map(c => `${c.ok ? '✅' : '❌'} ${c.label}`).join('\n');
    text = `✅ *Connection Success*\n\n${bullets || '_(no details)_'}`;
  } else {
    const bullets = (r.checks || []).map(c => `${c.ok ? '✅' : '❌'} ${c.label}`).join('\n');
    text = `❌ *Connection Failed*\n\n${bullets ? bullets + '\n\n' : ''}Penyebab: _${(r.error || 'unknown').toString().slice(0, 200)}_`;
  }
  if (panel) { try { await ctx.telegram.editMessageText(panel.chatId, panel.messageId, undefined, text, { parse_mode: 'Markdown', ...entMenu() }); return; } catch (_) {} }
  return respondInSession(ctx, text, { parse_mode: 'Markdown' });
}

async function showWebhookMonitor(ctx) {
  const list = await paymentConfig.listAll();
  await answerCb(ctx);
  const lines = list.map(p =>
`*${p.provider}* — ${p.enabled ? '🟢 online' : '🔴 disabled'}
  last: ${p.lastCallbackAt ? new Date(p.lastCallbackAt).toISOString() : '-'}
  success: ${p.successCount}  failed: ${p.failedCount}
  err: ${(p.lastError || '-').slice(0, 100)}`);
  return safeEditText(ctx, `📡 *WEBHOOK MONITOR*\n\n${lines.join('\n\n')}`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'e:pay:menu')]]) });
}

// =========================================================
// CURRENCY CENTER
// =========================================================
async function showCurrencyMenu(ctx) {
  const s = await getSettings();
  const list = await currencyService.list();
  const rows = list.map(c => [Markup.button.callback(`${c.enabled ? '🟢' : '🔴'} ${c.symbol || ''} ${c.code} — ${c.rate}${c.isBase ? ' (base)' : ''}`, `e:cur:edit:${c.code}`)]);
  rows.push([Markup.button.callback('➕ Tambah Currency', 'e:cur:add')]);
  rows.push([Markup.button.callback(s.exchangeMode === 'auto' ? '⏸ Set Manual Rate' : '🔄 Set Auto Rate', 'e:cur:mode')]);
  rows.push([Markup.button.callback('🔁 Sync Sekarang', 'e:cur:sync')]);
  rows.push([Markup.button.callback('⬅️ Kembali', 'e:home')]);
  await answerCb(ctx);
  return safeEditText(ctx,
`💱 *CURRENCY CENTER*

Base: *${s.baseCurrency || 'USD'}*
Mode: *${s.exchangeMode || 'manual'}*
Provider: ${s.exchangeProvider || '-'}
Last sync: ${s.exchangeLastSyncAt || '-'}
Error: ${(s.exchangeLastError || '-').slice(0, 120)}`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
}

async function editCurrency(ctx, code) {
  const c = await currencyService.getByCode(code);
  if (!c) { await answerCb(ctx, 'Tidak ditemukan', true); return; }
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('💱 Edit Rate', `e:cur:rate:${code}`)],
    [Markup.button.callback(c.enabled ? '🔴 Nonaktifkan' : '🟢 Aktifkan', `e:cur:tog:${code}`)],
    ...(c.isBase ? [] : [[Markup.button.callback('🗑 Hapus', `e:cur:del:${code}`)]]),
    [Markup.button.callback('⬅️ Kembali', 'e:cur:menu')],
  ]);
  await answerCb(ctx);
  return safeEditText(ctx,
`💱 *${c.code}* — ${c.name}
Symbol: ${c.symbol}
Rate: 1 USD = ${c.rate} ${c.code}
Enabled: ${c.enabled}
Updated: ${c.lastUpdatedAt ? new Date(c.lastUpdatedAt).toISOString() : '-'} (${c.updatedFrom})`,
    { parse_mode: 'Markdown', ...kb });
}

async function startEditRate(ctx, code) {
  openInputSession(ctx, { action: 'e_cur_rate', code, returnTo: 'e:cur:menu' });
  await answerCb(ctx);
  return safeEditText(ctx, `💱 Kirim rate baru untuk *${code}* (1 USD = ? ${code}):`, { parse_mode: 'Markdown', ...adminBack() });
}

async function toggleCurrency(ctx, code) {
  const c = await currencyService.getByCode(code);
  await currencyService.upsert(code, { enabled: !c.enabled });
  await answerCb(ctx);
  return editCurrency(ctx, code);
}

async function removeCurrency(ctx, code) {
  await currencyService.remove(code);
  await answerCb(ctx, 'Dihapus');
  return showCurrencyMenu(ctx);
}

async function startAddCurrency(ctx) {
  openInputSession(ctx, { action: 'e_cur_add', step: 'code', returnTo: 'e:cur:menu' });
  await answerCb(ctx);
  return safeEditText(ctx, `➕ *Tambah Currency*\n\nKirim kode 3 huruf (mis. \`KRW\`):`, { parse_mode: 'Markdown', ...adminBack() });
}

async function toggleExchangeMode(ctx) {
  const s = await getSettings();
  const next = s.exchangeMode === 'auto' ? 'manual' : 'auto';
  await updateSetting({ exchangeMode: next });
  await answerCb(ctx, `Mode: ${next}`);
  return showCurrencyMenu(ctx);
}

async function syncCurrencies(ctx) {
  await answerCb(ctx, 'Sync…');
  const r = await currencyService.syncAuto();
  const panel = getPanel(ctx.from.id);
  const text = r.ok ? `✅ Sync ${r.count} rates` : `❌ Sync gagal: ${r.error}`;
  if (panel) { try { await ctx.telegram.editMessageText(panel.chatId, panel.messageId, undefined, text, { parse_mode: 'Markdown', ...entMenu() }); return; } catch (_) {} }
  return respondInSession(ctx, text);
}

// =========================================================
// LANGUAGE CENTER
// =========================================================
async function showLangMenu(ctx) {
  const s = await getSettings();
  const list = await i18n.listAll();
  await answerCb(ctx);
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback(`🇮🇩 Default: ${s.defaultLanguage}`, 'e:lang:default')],
    [Markup.button.callback('📝 Edit Terjemahan', 'e:lang:list')],
    [Markup.button.callback('⬅️ Kembali', 'e:home')],
  ]);
  return safeEditText(ctx,
`🌐 *LANGUAGE CENTER*

Default: *${s.defaultLanguage}*
Bahasa didukung: ${i18n.LANGS.join(', ')}
Total keys: *${list.length}*`, { parse_mode: 'Markdown', ...kb });
}

async function toggleDefaultLang(ctx) {
  const s = await getSettings();
  const idx = i18n.LANGS.indexOf(s.defaultLanguage || 'id');
  const next = i18n.LANGS[(idx + 1) % i18n.LANGS.length];
  await updateSetting({ defaultLanguage: next });
  await answerCb(ctx, `Default → ${next}`);
  return showLangMenu(ctx);
}

async function listTranslations(ctx, page = 0) {
  const list = await i18n.listAll();
  const per = 8;
  const slice = list.slice(page * per, (page + 1) * per);
  const rows = slice.map(t => [Markup.button.callback(`📝 ${t.key}`, `e:lang:edit:${t.key}`)]);
  if (list.length > per) {
    const nav = [];
    if (page > 0) nav.push(Markup.button.callback('◀', `e:lang:list:${page - 1}`));
    if ((page + 1) * per < list.length) nav.push(Markup.button.callback('▶', `e:lang:list:${page + 1}`));
    if (nav.length) rows.push(nav);
  }
  rows.push([Markup.button.callback('⬅️ Kembali', 'e:lang:menu')]);
  await answerCb(ctx);
  return safeEditText(ctx, `📝 *Translations* (page ${page + 1})`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
}

async function startEditTranslation(ctx, key) {
  openInputSession(ctx, { action: 'e_lang_edit', key, returnTo: 'e:lang:menu' });
  await answerCb(ctx);
  const list = await i18n.listAll();
  const cur = list.find(x => x.key === key);
  const v = cur && cur.values || {};
  return safeEditText(ctx,
`📝 *Edit Translation*

Key: \`${key}\`
Saat ini:
- id: ${v.id || '-'}
- en: ${v.en || '-'}

Kirim JSON: \`{"id":"...","en":"..."}\``,
    { parse_mode: 'Markdown', ...adminBack() });
}

// =========================================================
// PROVIDER DASHBOARD
// =========================================================
async function showProviderDashboard(ctx) {
  const stats = await providerService.statsByProvider();
  const providers = ['aws', 'digitalocean', 'linode', 'azure'];
  const lines = providers.map(p => {
    const s = stats[p] || {};
    return `*${p.toUpperCase()}*
  🟢 READY: ${s.READY || 0}
  🔒 LOCKED: ${s.LOCKED || 0}
  ✅ USED: ${s.USED || 0}
  ❌ ERROR: ${s.ERROR || 0}
  📦 QUOTA_FULL: ${s.QUOTA_FULL || 0}
  ⛔ SUSPENDED: ${s.SUSPENDED || 0}`;
  });
  const q = provisionQueue.stats();
  await answerCb(ctx);
  return safeEditText(ctx,
`📊 *PROVIDER DASHBOARD*

${lines.join('\n\n')}

⚙️ Queue: running=${q.running} pending=${q.pending} concurrency=${q.concurrency}`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh', 'e:dash:providers'), Markup.button.callback('⬅️ Kembali', 'e:home')]]) });
}

// =========================================================
// AUDIT LOG
// =========================================================
async function showAuditMenu(ctx, page = 0) {
  const per = 15;
  const items = await AuditLog.find({}).sort({ createdAt: -1 }).skip(page * per).limit(per).lean();
  const total = await AuditLog.countDocuments();
  const lines = items.map(a => `\`${new Date(a.createdAt).toISOString().replace('T', ' ').slice(0, 19)}\` [${a.type}] ${(a.message || '').slice(0, 80)}`);
  const rows = [];
  const nav = [];
  if (page > 0) nav.push(Markup.button.callback('◀', `e:audit:${page - 1}`));
  if ((page + 1) * per < total) nav.push(Markup.button.callback('▶', `e:audit:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([Markup.button.callback('⬅️ Kembali', 'e:home')]);
  await answerCb(ctx);
  return safeEditText(ctx, `📜 *AUDIT LOG* — page ${page + 1} / ${Math.ceil(total / per) || 1}\n\n${lines.join('\n') || '(kosong)'}`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
}

// =========================================================
// BACKUP / RESTORE
// =========================================================
async function showBackupMenu(ctx) {
  await answerCb(ctx);
  return safeEditText(ctx,
`💾 *BACKUP & RESTORE*

Export akan menghasilkan JSON konfigurasi (providers, payments, currencies, translations, settings).
Import: kirim JSON hasil export.`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
      [Markup.button.callback('📤 Export Config', 'e:bak:export')],
      [Markup.button.callback('📥 Import Config', 'e:bak:import')],
      [Markup.button.callback('⬅️ Kembali', 'e:home')],
    ]) });
}

async function doExport(ctx) {
  await answerCb(ctx, 'Exporting…');
  const data = await backup.exportAll();
  const json = JSON.stringify(data, null, 2);
  try {
    await ctx.replyWithDocument({ source: Buffer.from(json, 'utf8'), filename: `bot-config-${Date.now()}.json` });
  } catch (e) { await respondInSession(ctx, json.slice(0, 3800)); }
}

async function startImport(ctx) {
  openInputSession(ctx, { action: 'e_bak_import', returnTo: 'e:bak:menu' });
  await answerCb(ctx);
  return safeEditText(ctx, `📥 *IMPORT CONFIG*\n\nKirim isi JSON hasil export (bisa document atau teks).`, { parse_mode: 'Markdown', ...adminBack() });
}

// =========================================================
// TEXT DISPATCHER — called from bot.on('text') if user has enterprise session
// =========================================================
async function handleEnterpriseText(ctx) {
  const s = getSession(ctx.from.id);
  if (!s || !s.action || !s.action.startsWith('e_')) return false;
  const text = ctx.message.text;

  if (s.action === 'e_prov_add') { await handleProvAddText(ctx, s, text); return true; }

  if (s.action === 'e_pay_field') {
    const val = text.trim() === '-' ? '' : text.trim();
    await paymentConfig.update(s.provider, { [s.field]: val });
    clearSession(ctx.from.id);
    if (ctx.message) { try { await ctx.deleteMessage(); } catch (_) {} }
    await editPanel(ctx, `✅ ${s.provider}.${s.field} diperbarui.`);
    return true;
  }

  if (s.action === 'e_cur_rate') {
    const n = Number(text.replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0) { await respondInSession(ctx, '⚠️ Rate tidak valid.'); return true; }
    await currencyService.upsert(s.code, { rate: n, updatedFrom: 'manual', lastUpdatedAt: new Date() });
    clearSession(ctx.from.id);
    if (ctx.message) { try { await ctx.deleteMessage(); } catch (_) {} }
    await editPanel(ctx, `✅ Rate ${s.code} → ${n}`);
    return true;
  }

  if (s.action === 'e_cur_add') {
    if (s.step === 'code') {
      const code = text.trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(code)) { await respondInSession(ctx, '⚠️ Kode harus 3 huruf.'); return true; }
      s.code = code; s.step = 'name'; openInputSession(ctx, s);
      await respondInSession(ctx, `Kirim nama untuk ${code} (mis. "Won"):`); return true;
    }
    if (s.step === 'name') {
      s.name = text.trim(); s.step = 'symbol'; openInputSession(ctx, s);
      await respondInSession(ctx, 'Kirim symbol (mis. "₩"), atau "-" untuk kosong:'); return true;
    }
    if (s.step === 'symbol') {
      s.symbol = text.trim() === '-' ? '' : text.trim();
      s.step = 'rate'; openInputSession(ctx, s);
      await respondInSession(ctx, `Kirim rate awal (1 USD = ? ${s.code}):`); return true;
    }
    if (s.step === 'rate') {
      const n = Number(text.replace(',', '.'));
      if (!Number.isFinite(n) || n <= 0) { await respondInSession(ctx, '⚠️ Rate tidak valid.'); return true; }
      await currencyService.upsert(s.code, { name: s.name, symbol: s.symbol, rate: n, enabled: true, updatedFrom: 'manual', lastUpdatedAt: new Date() });
      clearSession(ctx.from.id);
      if (ctx.message) { try { await ctx.deleteMessage(); } catch (_) {} }
      await editPanel(ctx, `✅ Currency ${s.code} ditambahkan.`);
      return true;
    }
  }

  if (s.action === 'e_lang_edit') {
    try {
      const obj = JSON.parse(text);
      await i18n.upsertKey(s.key, obj);
      clearSession(ctx.from.id);
      if (ctx.message) { try { await ctx.deleteMessage(); } catch (_) {} }
      await editPanel(ctx, `✅ Translation "${s.key}" diperbarui.`);
    } catch (e) { await respondInSession(ctx, '⚠️ JSON tidak valid. Kirim ulang.'); }
    return true;
  }

  if (s.action === 'e_bak_import') {
    try {
      const data = JSON.parse(text);
      const report = await backup.importAll(data);
      clearSession(ctx.from.id);
      if (ctx.message) { try { await ctx.deleteMessage(); } catch (_) {} }
      await editPanel(ctx, `✅ Import selesai: ${JSON.stringify(report)}`);
    } catch (e) { await respondInSession(ctx, '⚠️ Import gagal: ' + e.message); }
    return true;
  }

  return false;
}

// Handle document upload for backup import
async function handleEnterpriseDocument(ctx) {
  const s = getSession(ctx.from.id);
  if (!s || s.action !== 'e_bak_import') return false;
  try {
    const fileId = ctx.message.document.file_id;
    const link = await ctx.telegram.getFileLink(fileId);
    const axios = require('axios');
    const r = await axios.get(link.href, { timeout: 30000 });
    const data = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    const report = await backup.importAll(data);
    clearSession(ctx.from.id);
    if (ctx.message) { try { await ctx.deleteMessage(); } catch (_) {} }
    await editPanel(ctx, `✅ Import selesai: ${JSON.stringify(report)}`);
  } catch (e) { await respondInSession(ctx, '⚠️ Import gagal: ' + e.message); }
  return true;
}

async function editPanel(ctx, text) {
  const panel = getPanel(ctx.from.id);
  if (panel) {
    try { await ctx.telegram.editMessageText(panel.chatId, panel.messageId, undefined, text, { parse_mode: 'Markdown', ...entMenu() }); return; } catch (_) {}
  }
  await respondInSession(ctx, text, { parse_mode: 'Markdown', ...entMenu() });
}

// =========================================================
// QUEUE DASHBOARD & LIVE PROVISION LOG
// =========================================================
async function showQueueDashboard(ctx) {
  const q = provisionQueue.stats();
  const [running, waiting, success, failed, retried] = await Promise.all([
    Order.find({ provisionStatus: { $in: ['queued', 'selecting_provider', 'checking', 'creating', 'waiting_ip'] } }).sort({ updatedAt: -1 }).limit(8).lean(),
    Order.countDocuments({ status: 'processing', provisionStatus: { $in: ['', 'queued'] } }),
    Order.countDocuments({ provisionStatus: 'success' }),
    Order.countDocuments({ provisionStatus: 'failed' }),
    Order.countDocuments({ provisionRetryCount: { $gt: 0 } }),
  ]);

  const runLines = running.length
    ? running.map(o => `• \`${o.invoice}\` — ${o.provisionStatus || 'queued'} — ${(o.providerUsed || '-')} — retry:${o.provisionRetryCount || 0}`).join('\n')
    : '_(kosong)_';

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Refresh', 'e:queue:menu'), Markup.button.callback('📡 Live Provisions', 'e:queue:live')],
    [Markup.button.callback('📜 Riwayat Gagal', 'e:queue:failed'), Markup.button.callback('✅ Riwayat Sukses', 'e:queue:success')],
    [Markup.button.callback('⬅️ Kembali', 'e:home')],
  ]);
  await answerCb(ctx);
  return safeEditText(ctx,
`📊 *QUEUE DASHBOARD*

⚙️ Queue: running=*${q.running}* pending=*${q.pending}* max=${q.concurrency}
🟡 Waiting: *${waiting}*
✅ Success total: *${success}*
❌ Failed total: *${failed}*
🔁 Orders w/ retry: *${retried}*

🔄 *Sedang berjalan (${running.length})*:
${runLines}`, { parse_mode: 'Markdown', ...kb });
}

async function showLiveProvisions(ctx) {
  const live = await Order.find({ provisionStatus: { $in: ['queued', 'selecting_provider', 'checking', 'creating', 'waiting_ip'] } })
    .sort({ updatedAt: -1 }).limit(20).lean();
  const rows = live.map(o => [Markup.button.callback(`🔴 ${o.invoice} • ${(o.providerUsed || '?')} • try ${o.provisionRetryCount || 0}`, `e:queue:order:${o._id}`)]);
  if (!rows.length) rows.push([Markup.button.callback('_(tidak ada provisioning aktif)_', 'noop')]);
  rows.push([Markup.button.callback('🔄 Refresh', 'e:queue:live'), Markup.button.callback('⬅️ Kembali', 'e:queue:menu')]);
  await answerCb(ctx);
  return safeEditText(ctx, `📡 *LIVE PROVISIONS* (${live.length})\n\nKlik pesanan untuk melihat log realtime.`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
}

async function showProvisionLog(ctx, orderId) {
  const o = await Order.findById(orderId).lean();
  if (!o) { await answerCb(ctx, 'Tidak ditemukan', true); return; }
  const steps = (o.provisionSteps || []).slice(-25).map(s => `• ${s}`).join('\n') || '_(belum ada)_';
  const logs = await AuditLog.find({ refId: String(o._id) }).sort({ createdAt: -1 }).limit(15).lean();
  const auditLines = logs.map(a => `\`${new Date(a.createdAt).toISOString().slice(11, 19)}\` [${a.type}] ${(a.message || '').slice(0, 80)}`).join('\n') || '_(tidak ada audit)_';
  await answerCb(ctx);
  return safeEditText(ctx,
`🔴 *LIVE LOG — ${o.invoice}*

Status: *${o.provisionStatus || '-'}*
Provider: ${o.providerUsed || '-'}
Retries: ${o.provisionRetryCount || 0}
Public IP: ${o.publicIp || '-'}
Error: ${(o.provisionError || '-').slice(0, 200)}

*Progress steps:*
${steps}

*Audit trail:*
${auditLines}`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh', `e:queue:order:${o._id}`), Markup.button.callback('⬅️ Kembali', 'e:queue:live')]]) });
}

async function showQueueFailed(ctx) {
  const items = await Order.find({ provisionStatus: 'failed' }).sort({ updatedAt: -1 }).limit(15).lean();
  const lines = items.map(o => `❌ \`${o.invoice}\` — ${(o.provisionError || '-').slice(0, 80)}`).join('\n') || '_(kosong)_';
  await answerCb(ctx);
  return safeEditText(ctx, `❌ *RIWAYAT GAGAL* (${items.length})\n\n${lines}`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'e:queue:menu')]]) });
}

async function showQueueSuccess(ctx) {
  const items = await Order.find({ provisionStatus: 'success' }).sort({ updatedAt: -1 }).limit(15).lean();
  const lines = items.map(o => `✅ \`${o.invoice}\` — ${o.providerUsed || '-'} — \`${o.publicIp || '-'}\``).join('\n') || '_(kosong)_';
  await answerCb(ctx);
  return safeEditText(ctx, `✅ *RIWAYAT SUKSES* (${items.length})\n\n${lines}`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'e:queue:menu')]]) });
}

module.exports = {
  entMenu,
  renderEnterpriseHome, toggleAutoProvisioning,
  showProviderMenu, startAddProvider, listProviderApis, showApiDetail,
  toggleApi, healthCheckOne, deleteApi, healthAll, resetErrors,
  showPayMenu, showPayConfig, togglePayment, startEditPayField, testPayment, showWebhookMonitor,
  showCurrencyMenu, editCurrency, startEditRate, toggleCurrency, removeCurrency,
  startAddCurrency, toggleExchangeMode, syncCurrencies,
  showLangMenu, toggleDefaultLang, listTranslations, startEditTranslation,
  showProviderDashboard,
  showAuditMenu,
  showBackupMenu, doExport, startImport,
  showQueueDashboard, showLiveProvisions, showProvisionLog, showQueueFailed, showQueueSuccess,
  handleEnterpriseText, handleEnterpriseDocument,
};
