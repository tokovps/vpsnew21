const { Telegraf } = require('telegraf');
const { config } = require('./config');
const { attachUser, isAdmin, adminOnly } = require('./middlewares/auth');
const { antiSpamCallback } = require('./middlewares/antiSpam');
const { getSettings } = require('./services/settingService');

const { startCommand } = require('./commands/start');
const { adminCommand } = require('./commands/admin');
const { addAdminCommand, removeAdminCommand, listAdminsCommand } = require('./commands/adminManage');

const userHandler = require('./handlers/userHandler');
const orderHandler = require('./handlers/orderHandler');
const adminHandler = require('./handlers/adminHandler');
const adminPhotoHandler = require('./handlers/adminPhotoHandler');
const { clearSession } = require('./handlers/sessionStore');
const { setPanel } = require('./handlers/adminPanelStore');

function buildBot() {
  const bot = new Telegraf(config.botToken);

  bot.catch((err, ctx) => { console.error('Bot error for', ctx.updateType, err); });

  bot.use(attachUser);
  bot.use(require('./middlewares/loadingFeedback').loadingFeedback());
  bot.use(antiSpamCallback());
  // ─── GLOBAL ANIMATED UI ENGINE ────────────────────────────────────────
  // Every callback tap (except the tiny allow-list inside animatedEngine)
  // plays a 3-frame progress-bar animation on the SAME message BEFORE the
  // real handler runs. Retrofit: no handler changes required — this is a
  // single global middleware. Skips `noop` and `joingate:check` so alert
  // buttons still surface instantly.
  bot.use(require('./ui/animatedEngine').globalMiddleware());

  // Track active admin panel message_id on each admin callback so subsequent
  // text/photo inputs can edit that exact message (single-panel UX).
  bot.use(async (ctx, next) => {
    if (ctx.callbackQuery && ctx.callbackQuery.message && ctx.state.isAdmin) {
      const m = ctx.callbackQuery.message;
      setPanel(ctx.from.id, m.chat.id, m.message_id);
    }
    return next();
  });

  // ─── MAINTENANCE MODE GATE ─────────────────────────────────────────────
  // Runs BEFORE join-gate & any user handler. When maintenance is ON, blocks
  // every non-admin, non-tester user. First-time /start users spawn a
  // "Permintaan Tester" card to admins instead of getting immediate access.
  // Admin panel & admin actions ALWAYS pass. Tester approval callbacks also
  // pass (admin-only, adminGuard enforces auth on the handler side).
  const maintenanceSvc = require('./services/maintenanceService');
  const maintenanceH = require('./handlers/maintenanceHandler');
  bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    if (ctx.state.isAdmin) return next();
    let mstate;
    try { mstate = await maintenanceSvc.getState(); }
    catch (_) { return next(); }
    if (!mstate || !mstate.enabled) return next();
    // Tester bypass.
    const isTester = (mstate.testers || []).some(t => String(t.telegramId) === String(ctx.from.id));
    if (isTester) return next();

    // ── User is BLOCKED. Decide response type ──
    // 1) First-time /start → fire tester request card to admins, notify user.
    const isStart = ctx.message && typeof ctx.message.text === 'string'
      && /^\/start(\s|$|@)/i.test(ctx.message.text);
    if (isStart) {
      const alreadyRejected = (mstate.rejected || []).some(r => String(r) === String(ctx.from.id));
      const alreadyPending  = (mstate.requests || []).some(r => String(r.telegramId) === String(ctx.from.id));
      // Only fire request card if user has NEVER interacted before (no
      // firstSeenAt), matches user's spec "membuka Bot pertama kali".
      let isFirstTime = false;
      try {
        const User = require('./models/User');
        const u = await User.findOne({ telegramId: String(ctx.from.id) }, { firstSeenAt: 1 }).lean();
        isFirstTime = !u || !u.firstSeenAt;
      } catch (_) {}
      if (isFirstTime && !alreadyRejected && !alreadyPending) {
        try { await maintenanceH.fireTesterRequest(bot, ctx.from); } catch (_) {}
        try {
          await ctx.reply(
`🛠 *BOT SEDANG MAINTENANCE*

Halo, Bot saat ini sedang dalam tahap Maintenance.
Permintaan Anda untuk menjadi *Tester* telah dikirim ke Admin.

Mohon tunggu keputusan Admin.
Terima kasih.`,
            { parse_mode: 'Markdown' });
        } catch (_) {}
        return;
      }
      if (alreadyRejected) {
        try {
          await ctx.reply(
`Maaf.

Saat ini Bot masih dalam tahap Maintenance.
Admin belum mengizinkan Anda menjadi Tester.
Silakan tunggu hingga Maintenance selesai.`,
            { parse_mode: 'Markdown' });
        } catch (_) {}
        return;
      }
      // Fallthrough: pending or existing user → show generic maintenance msg.
    }
    // 2) All other interactions (menu callbacks, text, photos, etc.) — show
    //    maintenance card. For callbacks, also answer the query so the button
    //    doesn't spin forever.
    try {
      const msg = maintenanceSvc.buildUserMessage(mstate);
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery('🛠 Bot sedang Maintenance', { show_alert: true }).catch(() => {});
      } else {
        await ctx.reply(msg, { parse_mode: 'Markdown' });
      }
    } catch (_) {}
    return;
  });

  // Join-gate middleware: block non-admin users until they joined required channels
  bot.use(async (ctx, next) => {
    if (!ctx.from || ctx.state.isAdmin) return next();
    // Allow gate recheck callback through
    const data = ctx.callbackQuery && ctx.callbackQuery.data;
    if (data && data.startsWith('joingate:')) return next();
    try {
      const s = await getSettings();
      const enabled = (s.joinGateEnabled || 'off') === 'on';
      const channels = Array.isArray(s.requiredChannels) ? s.requiredChannels : [];
      if (!enabled || !channels.length) return next();
      const blocked = await isUserBlocked(bot, channels, ctx.from.id);
      if (blocked) {
        await userHandler.renderJoinGate(ctx);
        if (ctx.callbackQuery) { try { await ctx.answerCbQuery('Mohon join channel terlebih dahulu', { show_alert: true }); } catch (_) {} }
        return;
      }
    } catch (e) { console.error('Gate check error:', e.message); }
    return next();
  });

  bot.start(startCommand);
  bot.command('admin', adminOnly(), adminCommand);
  bot.command('addadmin', addAdminCommand);
  bot.command('removeadmin', removeAdminCommand);
  bot.command('listadmins', listAdminsCommand);

  bot.action('noop', async (ctx) => { await ctx.answerCbQuery().catch(()=>{}); });

  // ===== USER =====
  bot.action('menu:home', async (ctx) => { clearSession(ctx.from.id); await userHandler.renderHome(ctx); await ctx.answerCbQuery().catch(()=>{}); });
  bot.action('menu:vps', async (ctx) => {
    const active = await require('./services/orderService').userActiveOrders(ctx.from.id);
    if (active.length) { await userHandler.renderActiveOrderBlocker(ctx); await ctx.answerCbQuery('⚠️ Ada transaksi aktif', true).catch(()=>{}); return; }
    // ─── STOCK GUARD: LOCKED ≠ STOCK HABIS ───────────────────────────
    // Stock = SUM quotaAvailable pada provider READY + LOCKED (locked
    // = provider yang sedang jalankan install, bukan berarti kehabisan).
    // Jika stock > 0 tapi seluruh provider LOCKED → user masuk halaman
    // ANTRIAN, bukan halaman STOCK KOSONG.
    const st = await require('./services/catalogService').getBuyMenuStock();
    if (!st.stock || st.stock <= 0) {
      await userHandler.renderStockEmpty(ctx, 'vps');
      await ctx.answerCbQuery('❌ Stock VPS kosong').catch(()=>{});
      return;
    }
    if (st.allBusy) {
      await userHandler.renderBuyQueue(ctx, 'vps');
      await ctx.answerCbQuery('⏳ Semua provider sedang sibuk, mohon menunggu antrean').catch(()=>{});
      return;
    }
    try { require('./services/adminNotifyService').notifyCatalogOpen(ctx.from, 'vps'); } catch (_) {}
    await userHandler.renderTiers(ctx, 'vps'); await ctx.answerCbQuery().catch(()=>{});
  });
  bot.action('menu:rdp', async (ctx) => {
    const active = await require('./services/orderService').userActiveOrders(ctx.from.id);
    if (active.length) { await userHandler.renderActiveOrderBlocker(ctx); await ctx.answerCbQuery('⚠️ Ada transaksi aktif', true).catch(()=>{}); return; }
    // RDP stock dari pool yang sama — logika ANTRIAN identik dengan VPS.
    const st = await require('./services/catalogService').getBuyMenuStock();
    if (!st.stock || st.stock <= 0) {
      await userHandler.renderStockEmpty(ctx, 'rdp');
      await ctx.answerCbQuery('❌ Stock RDP kosong').catch(()=>{});
      return;
    }
    if (st.allBusy) {
      await userHandler.renderBuyQueue(ctx, 'rdp');
      await ctx.answerCbQuery('⏳ Semua provider sedang sibuk, mohon menunggu antrean').catch(()=>{});
      return;
    }
    try { require('./services/adminNotifyService').notifyCatalogOpen(ctx.from, 'rdp'); } catch (_) {}
    await userHandler.renderTiers(ctx, 'rdp'); await ctx.answerCbQuery().catch(()=>{});
  });
  bot.action('menu:orders', async (ctx) => { await userHandler.renderOrders(ctx); await ctx.answerCbQuery().catch(()=>{}); });
  bot.action('menu:contact', async (ctx) => { await userHandler.renderContact(ctx); await ctx.answerCbQuery().catch(()=>{}); });

  bot.action(/^tier:(vps|rdp):(low|basic|medium)$/, async (ctx) => {
    await userHandler.renderTierProducts(ctx, ctx.match[1], ctx.match[2]);
    await ctx.answerCbQuery().catch(()=>{});
  });

  bot.action(/^spec:(vps|rdp):(low|basic|medium):([123])$/, async (ctx) => {
    await orderHandler.handleSpecSelect(ctx, ctx.match[1], ctx.match[2], ctx.match[3]);
  });
  bot.action(/^reg:(\d+)$/, async (ctx) => { await orderHandler.handleRegionSelect(ctx, parseInt(ctx.match[1], 10)); });
  bot.action(/^osf:(\d+)$/, async (ctx) => { await orderHandler.handleOsFamilySelect(ctx, parseInt(ctx.match[1], 10)); });
  bot.action(/^osv:(\d+)$/, async (ctx) => { await orderHandler.handleVpsOsVersionSelect(ctx, parseInt(ctx.match[1], 10)); });
  bot.action(/^rdpos:(windows|linux)$/, async (ctx) => { await orderHandler.handleRdpOsTypeSelect(ctx, ctx.match[1]); });
  bot.action(/^rdpv:(\d+)$/, async (ctx) => { await orderHandler.handleRdpVersionSelect(ctx, parseInt(ctx.match[1], 10)); });
  bot.action(/^back:(region|osf|rdpos|osv|rdpv|auth)$/, async (ctx) => { await orderHandler.handleBack(ctx, ctx.match[1]); });
  bot.action(/^am:(password|ssh)$/, async (ctx) => { await orderHandler.handleAuthMethodSelect(ctx, ctx.match[1]); });
  bot.action('confirm:order', async (ctx) => { await orderHandler.handleConfirmOrder(ctx); });

  bot.action(/^order:([a-f0-9]+)$/, async (ctx) => { await userHandler.renderOrderDetail(ctx, ctx.match[1]); await ctx.answerCbQuery().catch(()=>{}); });
  bot.action(/^pay:([a-f0-9]+)$/, async (ctx) => { await userHandler.handleCheckStatus(ctx, ctx.match[1], bot); });
  bot.action(/^cancel:([a-f0-9]+)$/, async (ctx) => { await orderHandler.handleCancel(ctx, ctx.match[1]); });
  bot.action(/^pm:(autogopay|binancepay):([a-f0-9]+)$/, async (ctx) => { await orderHandler.handlePickMethod(ctx, ctx.match[1], ctx.match[2]); });
  bot.action(/^chgmethod:([a-f0-9]+)$/, async (ctx) => { await orderHandler.handleChangeMethod(ctx, ctx.match[1]); });
  bot.action('joingate:check', async (ctx) => {
    try {
      const s = await getSettings();
      const channels = Array.isArray(s.requiredChannels) ? s.requiredChannels : [];
      const blocked = await isUserBlocked(bot, channels, ctx.from.id);
      if (blocked) {
        await ctx.answerCbQuery('❌ Anda belum join semua channel', { show_alert: true }).catch(()=>{});
        return userHandler.renderJoinGate(ctx);
      }
      await ctx.answerCbQuery('✅ Verifikasi berhasil').catch(()=>{});
      return userHandler.renderHome(ctx);
    } catch (e) { await ctx.answerCbQuery('Error: ' + e.message, { show_alert: true }).catch(()=>{}); }
  });

  // ===== ADMIN =====
  const adminGuard = adminOnly();

  bot.action('a:home', adminGuard, async (ctx) => { clearSession(ctx.from.id); await adminHandler.renderAdminHome(ctx); await ctx.answerCbQuery().catch(()=>{}); });
  bot.action('a:close', adminGuard, async (ctx) => { clearSession(ctx.from.id); try { await ctx.deleteMessage(); } catch(_) {} await ctx.answerCbQuery('Ditutup').catch(()=>{}); });
  bot.action('a:dashboard', adminGuard, async (ctx) => { await adminHandler.renderDashboard(ctx); await ctx.answerCbQuery().catch(()=>{}); });

  bot.action('a:banner:menu', adminGuard, async (ctx) => { await adminHandler.showBannerMenu(ctx); });
  bot.action(/^a:banner:(home|payment|orders|vpsLow|vpsBasic|vpsMedium|rdpLow|rdpBasic|rdpMedium)$/, adminGuard, async (ctx) => {
    await adminHandler.startEditBanner(ctx, ctx.match[1]);
  });

  bot.action('a:caption:menu', adminGuard, async (ctx) => { await adminHandler.showCaptionMenu(ctx); });
  bot.action(/^a:caption:(home|payment|orders|vpsLow|vpsBasic|vpsMedium|rdpLow|rdpBasic|rdpMedium|contactAdmin|joinChannel|successPayment|rejectPayment|processingOrder)$/, adminGuard, async (ctx) => {
    await adminHandler.startEditCaption(ctx, ctx.match[1]);
  });

  bot.action('a:price:menu', adminGuard, async (ctx) => { await adminHandler.showPriceMenu(ctx); });
  bot.action(/^a:price:c:(vps|rdp)$/, adminGuard, async (ctx) => { await adminHandler.showPriceTierMenu(ctx, ctx.match[1]); });
  bot.action(/^a:price:t:(vps|rdp):(low|basic|medium)$/, adminGuard, async (ctx) => { await adminHandler.showPriceSlotMenu(ctx, ctx.match[1], ctx.match[2]); });
  bot.action(/^a:price:e:(vps|rdp):(low|basic|medium):([123])$/, adminGuard, async (ctx) => {
    await adminHandler.startEditPrice(ctx, ctx.match[1], ctx.match[2], ctx.match[3]);
  });
  bot.action('a:spec:menu', adminGuard, async (ctx) => { await adminHandler.showSpecMenu(ctx); });
  bot.action(/^a:spec:e:(vps|rdp):([123])$/, adminGuard, async (ctx) => {
    await adminHandler.startEditSpec(ctx, ctx.match[1], ctx.match[2]);
  });

  bot.action('a:broadcast', adminGuard, async (ctx) => { await adminHandler.startBroadcast(ctx); });

  // List / Region / OS / Version editor
  bot.action('a:list:menu', adminGuard, async (ctx) => { await adminHandler.showListMenu(ctx); });
  bot.action(/^a:list:(vpsRegions|rdpRegions|vpsOsFamilies|rdpWindowsVersions|rdpLinuxVersions)$/, adminGuard, async (ctx) => {
    await adminHandler.startEditList(ctx, ctx.match[1]);
  });
  bot.action('a:osv:menu', adminGuard, async (ctx) => { await adminHandler.showOsvFamilyMenu(ctx); });
  bot.action(/^a:osv:fam:(\d+)$/, adminGuard, async (ctx) => { await adminHandler.startEditOsVersions(ctx, parseInt(ctx.match[1], 10)); });
  bot.action(/^a:txt:(tierWarrantyLow|tierWarrantyBasic|tierWarrantyMedium)$/, adminGuard, async (ctx) => {
    await adminHandler.startEditText(ctx, ctx.match[1]);
  });
  // Replace Text — PER PAKET (VPS/RDP × LOW/BASIC/MEDIUM). Menggunakan tombol
  // "🔁 Replace Text" yang sudah ada; callback lama a:txt:tierReplace diarahkan
  // ke menu baru agar link/pesan lama tetap kompatibel.
  bot.action('a:rep:menu', adminGuard, async (ctx) => { await adminHandler.showReplaceMenu(ctx); });
  bot.action('a:txt:tierReplace', adminGuard, async (ctx) => { await adminHandler.showReplaceMenu(ctx); });
  bot.action(/^a:rep:e:(vps|rdp):(low|basic|medium)$/, adminGuard, async (ctx) => {
    await adminHandler.startEditReplace(ctx, ctx.match[1], ctx.match[2]);
  });

  // Manual approve/reject removed — payments are fully automated via webhooks.
  bot.action(/^a:success:([a-f0-9]+)$/, adminGuard, async (ctx) => { await adminHandler.handleMarkSuccess(ctx, ctx.match[1], bot); });
  bot.action(/^a:cred:([a-f0-9]+)$/, adminGuard, async (ctx) => { await adminHandler.startSendCredentials(ctx, ctx.match[1]); });

  // Advanced settings
  bot.action('a:adv:menu', adminGuard, async (ctx) => { await adminHandler.showAdvancedMenu(ctx); });
  bot.action('a:autocancel', adminGuard, async (ctx) => { await adminHandler.startEditAutoCancel(ctx); });

  // Admin Notify TTL
  bot.action('a:notifttl:menu', adminGuard, async (ctx) => {
    const s = await require('./services/settingService').getSettings();
    const { Markup } = require('telegraf');
    const { safeEditText } = require('./utils/safeEdit');
    const cur = parseInt(s.adminNotifyTTL, 10) || 30;
    const opts = [0, 15, 30, 60, 120, 300];
    const rows = opts.map(n => [Markup.button.callback(
      `${cur === n ? '✅ ' : ''}${n === 0 ? '∞ Tidak dihapus' : n + ' detik'}`, `a:notifttl:set:${n}`)]);
    rows.push([Markup.button.callback('⬅️ Back', 'a:adv:menu')]);
    await safeEditText(ctx,
      `🔔 *ADMIN NOTIFY TTL*\n\nSaat ini: *${cur === 0 ? '∞ (tidak dihapus)' : cur + ' detik'}*\n\n_Notifikasi aktivitas User akan otomatis dihapus dari chat Admin setelah durasi ini._`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
    await ctx.answerCbQuery().catch(()=>{});
  });
  bot.action(/^a:notifttl:set:(\d+)$/, adminGuard, async (ctx) => {
    const n = parseInt(ctx.match[1], 10);
    await require('./services/settingService').updateSetting({ adminNotifyTTL: n });
    await ctx.answerCbQuery(`✅ TTL → ${n === 0 ? '∞' : n + 's'}`).catch(()=>{});
    // Re-render
    const s = await require('./services/settingService').getSettings();
    const { Markup } = require('telegraf');
    const { safeEditText } = require('./utils/safeEdit');
    const cur = parseInt(s.adminNotifyTTL, 10) || 0;
    const optsN = [0, 15, 30, 60, 120, 300];
    const rows = optsN.map(m => [Markup.button.callback(
      `${cur === m ? '✅ ' : ''}${m === 0 ? '∞ Tidak dihapus' : m + ' detik'}`, `a:notifttl:set:${m}`)]);
    rows.push([Markup.button.callback('⬅️ Back', 'a:adv:menu')]);
    await safeEditText(ctx,
      `🔔 *ADMIN NOTIFY TTL*\n\nSaat ini: *${cur === 0 ? '∞ (tidak dihapus)' : cur + ' detik'}*`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
  });
  bot.action('a:receipt', adminGuard, async (ctx) => { await adminHandler.startEditReceiptChannel(ctx); });
  bot.action('a:receipt:clear', adminGuard, async (ctx) => {
    await require('./services/settingService').updateSetting({ receiptChannel: '' });
    const { clearSession } = require('./handlers/sessionStore');
    clearSession(ctx.from.id);
    await ctx.answerCbQuery('✅ Channel resi dikosongkan');
    await adminHandler.showAdvancedMenu(ctx);
  });
  bot.action('a:catalog:menu', adminGuard, async (ctx) => { await adminHandler.showCatalogMenu(ctx); });
  bot.action('a:catalog:set', adminGuard, async (ctx) => { await adminHandler.startEditCatalogChannel(ctx); });
  bot.action('a:catalog:refresh', adminGuard, async (ctx) => { await adminHandler.refreshCatalogNow(ctx); });
  bot.action('a:catalog:reset', adminGuard, async (ctx) => { await adminHandler.resetCatalogMessageId(ctx); });
  // ─── Update Stock (retrofit — uses catalogService.fullStockRefresh) ──
  bot.action(/^a:stock:(vps|rdp)$/, adminGuard, async (ctx) => {
    const cat = ctx.match[1];
    const r = await require('./services/catalogService').fullStockRefresh(bot, cat);
    const { safeEditText } = require('./utils/safeEdit');
    const { Markup } = require('telegraf');
    const msg = r.ok
      ? `✅ *Stock ${cat.toUpperCase()} berhasil di-refresh*\n\n📦 Stock saat ini: *${r.stock}*\n📢 Post baru telah dikirim ke channel.`
      : `❌ Gagal update stock: ${r.error}`;
    await safeEditText(ctx, msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'a:catalog:menu')]]) });
    await ctx.answerCbQuery(r.ok ? '✅ Stock ter-update' : '❌ Gagal').catch(()=>{});
  });

  // ═══ POST STOK PANEL — dedicated menu (a:stok:*) ══════════════════════
  bot.action('a:stok:menu',       adminGuard, async (ctx) => { await adminHandler.showPostStokMenu(ctx); });
  bot.action('a:stok:setchan',    adminGuard, async (ctx) => { await adminHandler.startEditStokChannel(ctx); });
  bot.action(/^a:stok:post:(vps|rdp)$/, adminGuard, async (ctx) => {
    const cat = ctx.match[1];
    const svc = require('./services/postStokService');
    const r = await svc.publishStok(bot, cat);
    const { safeEditText } = require('./utils/safeEdit');
    const { Markup } = require('telegraf');
    const msg = r.ok
      ? `✅ *Post Stok ${cat.toUpperCase()} terkirim*\n\n📦 Stock: *${r.stock}*\n📨 Message ID: \`${r.messageId}\`\n📡 Channel: \`${r.channelId}\``
      : `❌ Gagal post: ${r.error}`;
    await safeEditText(ctx, msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'a:stok:menu')]]) });
    await ctx.answerCbQuery(r.ok ? '✅ Terkirim' : '❌ Gagal').catch(()=>{});
  });
  bot.action(/^a:stok:prev:(vps|rdp)$/, adminGuard, async (ctx) => {
    const cat = ctx.match[1];
    const svc = require('./services/postStokService');
    const r = await svc.previewStok(bot, ctx.from.id, cat);
    await ctx.answerCbQuery(r.ok ? `📤 Preview ${cat.toUpperCase()} dikirim ke DM` : `❌ ${r.error}`, true).catch(()=>{});
    // No editMessage — keep the panel visible.
    await adminHandler.showPostStokMenu(ctx);
  });
  bot.action(/^a:stok:del:(vps|rdp)$/, adminGuard, async (ctx) => {
    const cat = ctx.match[1];
    const svc = require('./services/postStokService');
    const r = await svc.deleteLastStok(bot, cat);
    await ctx.answerCbQuery(r.ok ? `🗑 Postingan ${cat.toUpperCase()} dihapus` : `❌ ${r.error}`, true).catch(()=>{});
    await adminHandler.showPostStokMenu(ctx);
  });

  // ═══ DATABASE MANAGER (Super Admin) ═══════════════════════════════════
  // NOTE: adminGuard already gates by adminIds. All DB ops are executed on
  // the ACTIVE mongoose connection or an isolated secondary connection —
  // migration never touches the active connection until explicit "Ya".
  const dbAdmin = require('./handlers/dbAdminHandler');
  bot.action('a:db:menu',         adminGuard, async (ctx) => dbAdmin.showMenu(ctx));
  bot.action('a:db:status',       adminGuard, async (ctx) => dbAdmin.showStatus(ctx));
  bot.action('a:db:test:ask',     adminGuard, async (ctx) => dbAdmin.askUri(ctx, 'test'));
  bot.action('a:db:migrate:ask',  adminGuard, async (ctx) => dbAdmin.askUri(ctx, 'migrate'));
  bot.action('a:db:migrate:force',adminGuard, async (ctx) => dbAdmin.forceMigrate(ctx));
  bot.action('a:db:switch:yes',   adminGuard, async (ctx) => dbAdmin.confirmSwitch(ctx));
  bot.action('a:db:backup',       adminGuard, async (ctx) => dbAdmin.doBackup(ctx));
  bot.action('a:db:restore:list', adminGuard, async (ctx) => dbAdmin.showRestoreList(ctx));
  bot.action(/^a:db:restore:go:(.+)$/, adminGuard, async (ctx) => dbAdmin.doRestore(ctx, ctx.match[1]));

  // Content grouping
  bot.action('a:content:menu', adminGuard, async (ctx) => {
    const { contentMenu } = require('./keyboards/admin');
    const { safeEditText } = require('./utils/safeEdit');
    await safeEditText(ctx, '🎨 *CONTENT MANAGEMENT*\n\nPilih Banner atau Caption:', { parse_mode: 'Markdown', ...contentMenu() });
    await ctx.answerCbQuery().catch(()=>{});
  });

  // ===== 🏠 Kelola Home (edit realtime — no restart) =====
  // Simplified 2026-01: caption home hanya STATUS + STOCK + prompt. Field
  // homeTitle/Subtitle/Footer sudah tidak dirender → tombolnya dibuang, dan
  // regex callback dipersempit ke {homeMenuPrompt, homeActivationOverride}.
  bot.action('a:home:mgr', adminGuard, async (ctx) => {
    const { homeManageMenu } = require('./keyboards/admin');
    const { safeEditText } = require('./utils/safeEdit');
    const s = await require('./services/settingService').getSettings();
    const preview = [
      `*Menu Prompt:* ${s.homeMenuPrompt || '_(kosong)_'}`,
      `*Override Aktivasi:* ${s.homeActivationOverride || '_(otomatis dari catalog)_'}`,
    ].join('\n');
    await safeEditText(ctx,
      `🏠 *KELOLA HOME*\n\nCaption home ringkas: hanya STATUS LAYANAN + STOCK + prompt menu. Banner tetap fokus.\n\n${preview}`,
      { parse_mode: 'Markdown', ...homeManageMenu() });
    await ctx.answerCbQuery().catch(()=>{});
  });
  bot.action(/^a:home:e:(homeMenuPrompt|homeActivationOverride)$/, adminGuard, async (ctx) => {
    const field = ctx.match[1];
    const LABELS = {
      homeMenuPrompt: 'Teks Menu Prompt', homeActivationOverride: 'Override Estimasi Aktivasi',
    };
    const { safeEditText } = require('./utils/safeEdit');
    const { cancelKb } = require('./keyboards/admin');
    const { openInputSession } = require('./handlers/sessionStore');
    const s = await require('./services/settingService').getSettings();
    openInputSession(ctx, { action: 'admin_edit_caption', field, label: LABELS[field], returnTo: 'a:home:mgr' });
    const cur = String(s[field] || '').slice(0, 400);
    await safeEditText(ctx,
      `✏️ *EDIT ${LABELS[field].toUpperCase()}*\n\nSaat ini:\n\`\`\`\n${cur || '(kosong)'}\n\`\`\`\n\nKirim *teks baru* (Markdown didukung). Kirim tanda \`-\` untuk mengosongkan.`,
      { parse_mode: 'Markdown', ...cancelKb('a:home:mgr') });
    await ctx.answerCbQuery().catch(()=>{});
  });

  // ═══════════════════════════════════════════════════════════════════
  // 🎉 Promo Center — SIMPLIFIED (revisi 2026-01)
  // ─────────────────────────────────────────────────────────────────────
  // Callback routes:
  //   a:promo:home                → landing menu
  //   a:promo:list:active         → Status Promo (aktif)
  //   a:promo:list:inactive       → Non-Aktif list
  //   a:promo:list:all            → semua promo
  //   a:promo:add                 → wizard buat promo
  //   a:promo:add:voucher         → wizard buat voucher
  //   a:promo:edit:list           → pilih promo untuk edit
  //   a:promo:del:list            → pilih promo untuk hapus
  //   a:promo:d:<id>              → detail promo
  //   a:promo:edit:<id>           → menu edit field per promo
  //   a:promo:ef:<id>:<field>     → mulai edit satu field
  //   a:promo:tog:<id>            → toggle enabled
  //   a:promo:del:<id>            → konfirmasi hapus
  //   a:promo:delok:<id>          → hapus permanen
  // ═══════════════════════════════════════════════════════════════════
  const promoHandler = require('./handlers/promoAdminHandler');
  bot.action('a:promo:home',        adminGuard, (ctx) => promoHandler.showHome(ctx));
  bot.action('a:promo:list:active', adminGuard, (ctx) => promoHandler.showList(ctx, 'active'));
  bot.action('a:promo:list:inactive', adminGuard, (ctx) => promoHandler.showList(ctx, 'inactive'));
  bot.action('a:promo:list:all',    adminGuard, (ctx) => promoHandler.showList(ctx, 'all'));
  bot.action('a:promo:add',         adminGuard, (ctx) => promoHandler.startAdd(ctx, false));
  bot.action('a:promo:add:voucher', adminGuard, (ctx) => promoHandler.startAdd(ctx, true));
  bot.action('a:promo:edit:list',   adminGuard, (ctx) => promoHandler.showEditList(ctx));
  bot.action('a:promo:del:list',    adminGuard, (ctx) => promoHandler.showDeleteList(ctx));
  bot.action(/^a:promo:d:([a-f0-9]{24})$/i,           adminGuard, (ctx) => promoHandler.showDetail(ctx, ctx.match[1]));
  bot.action(/^a:promo:edit:([a-f0-9]{24})$/i,        adminGuard, (ctx) => promoHandler.startEdit(ctx, ctx.match[1]));
  bot.action(/^a:promo:ef:([a-f0-9]{24}):(name|description|type|value|targets)$/i,
                                                       adminGuard, (ctx) => promoHandler.startEditField(ctx, ctx.match[1], ctx.match[2]));
  bot.action(/^a:promo:tog:([a-f0-9]{24})$/i,          adminGuard, (ctx) => promoHandler.toggle(ctx, ctx.match[1]));
  bot.action(/^a:promo:del:([a-f0-9]{24})$/i,          adminGuard, (ctx) => promoHandler.confirmDel(ctx, ctx.match[1]));
  bot.action(/^a:promo:delok:([a-f0-9]{24})$/i,        adminGuard, (ctx) => promoHandler.doDelete(ctx, ctx.match[1]));

  // User Management (basic listing)
  bot.action('a:users:menu', adminGuard, async (ctx) => {
    const userService = require('./services/userService');
    const total = await userService.countUsers();
    const recent = await require('./models/User').find({}).sort({ createdAt: -1 }).limit(10).lean();
    const { Markup } = require('telegraf');
    const { safeEditText } = require('./utils/safeEdit');
    const lines = recent.map((u, i) => `${i+1}. \`${u.telegramId}\` @${u.username || '-'} • ${u.language || '-'}`).join('\n');
    await safeEditText(ctx,
      `👥 *USER MANAGEMENT*\n\nTotal user: *${total}*\n\n_Recent 10:_\n${lines || '(kosong)'}`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'a:home')]]) });
    await ctx.answerCbQuery().catch(()=>{});
  });

  // Credential Manager settings
  bot.action('a:credmgr:menu', adminGuard, async (ctx) => {
    const s = await require('./services/settingService').getSettings();
    const { credMgrMenu } = require('./keyboards/admin');
    const { safeEditText } = require('./utils/safeEdit');
    await safeEditText(ctx,
`🔐 *CREDENTIAL MANAGER*

Password Length : *${s.passwordLength || 12}* karakter
Exclude Ambig.  : ${(s.passwordExcludeAmbiguous || 'on') === 'on' ? '✅ Ya' : '❌ Tidak'}

_Password otomatis di-generate saat user memilih Password Mode dan digunakan konsisten selama provisioning._`,
      { parse_mode: 'Markdown', ...credMgrMenu(s) });
    await ctx.answerCbQuery().catch(()=>{});
  });
  bot.action(/^a:credmgr:len:(\d+)$/, adminGuard, async (ctx) => {
    const n = parseInt(ctx.match[1], 10);
    if (![8,10,12,16,24].includes(n)) { await ctx.answerCbQuery('Nilai tidak valid', { show_alert: true }); return; }
    await require('./services/settingService').updateSetting({ passwordLength: n });
    await ctx.answerCbQuery(`✅ Panjang → ${n} karakter`);
    // Re-render
    ctx.callbackQuery.data = 'a:credmgr:menu';
    // manual re-trigger
    const s = await require('./services/settingService').getSettings();
    const { credMgrMenu } = require('./keyboards/admin');
    const { safeEditText } = require('./utils/safeEdit');
    await safeEditText(ctx,
      `🔐 *CREDENTIAL MANAGER*\n\nPassword Length : *${s.passwordLength}* karakter\nExclude Ambig.  : ${(s.passwordExcludeAmbiguous || 'on') === 'on' ? '✅ Ya' : '❌ Tidak'}`,
      { parse_mode: 'Markdown', ...credMgrMenu(s) });
  });
  bot.action('a:credmgr:amb', adminGuard, async (ctx) => {
    const s = await require('./services/settingService').getSettings();
    const next = (s.passwordExcludeAmbiguous || 'on') === 'on' ? 'off' : 'on';
    await require('./services/settingService').updateSetting({ passwordExcludeAmbiguous: next });
    await ctx.answerCbQuery(`✅ Ambiguous → ${next}`);
    const s2 = await require('./services/settingService').getSettings();
    const { credMgrMenu } = require('./keyboards/admin');
    const { safeEditText } = require('./utils/safeEdit');
    await safeEditText(ctx,
      `🔐 *CREDENTIAL MANAGER*\n\nPassword Length : *${s2.passwordLength}* karakter\nExclude Ambig.  : ${(s2.passwordExcludeAmbiguous || 'on') === 'on' ? '✅ Ya' : '❌ Tidak'}`,
      { parse_mode: 'Markdown', ...credMgrMenu(s2) });
  });

  // ===== VPS MANAGEMENT =====
  const vps = require('./handlers/vpsManagementHandler');
  bot.action('v:home', adminGuard, vps.renderHome);
  bot.action(/^v:list:(\d+)$/, adminGuard, async (ctx) => vps.renderList(ctx, parseInt(ctx.match[1], 10)));
  bot.action(/^v:d:([a-f0-9]+)$/, adminGuard, async (ctx) => vps.renderDetail(ctx, ctx.match[1]));
  bot.action(/^v:a:(refresh|reboot|stop|start|delete):([a-f0-9]+)$/, adminGuard, async (ctx) => vps.doAction(ctx, ctx.match[1], ctx.match[2]));
  bot.action('v:search', adminGuard, vps.startSearch);
  bot.action('v:hc:settings', adminGuard, vps.renderHcSettings);
  bot.action(/^v:hc:set:(\d+)$/, adminGuard, async (ctx) => vps.setHcInterval(ctx, ctx.match[1]));
  bot.action('v:hc:tog', adminGuard, vps.toggleHc);
  bot.action('v:hc:run', adminGuard, vps.runHcNow);
  bot.action('v:hc:custom', adminGuard, vps.startCustomHc);

  // ===== RDP ORDERS (payment auto, delivery manual) =====
  const rdp = require('./handlers/rdpOrdersHandler');
  bot.action('r:home', adminGuard, rdp.renderHome);
  bot.action(/^r:list:(pending|processing|completed|cancelled):(\d+)$/, adminGuard, async (ctx) => rdp.renderList(ctx, ctx.match[1], parseInt(ctx.match[2], 10)));
  bot.action(/^r:d:([a-f0-9]+)$/, adminGuard, async (ctx) => rdp.renderDetail(ctx, ctx.match[1]));
  bot.action(/^r:proc:([a-f0-9]+)$/, adminGuard, async (ctx) => rdp.startProcessing(ctx, ctx.match[1]));
  bot.action(/^r:send:([a-f0-9]+)$/, adminGuard, async (ctx) => rdp.startSendDetail(ctx, ctx.match[1]));
  bot.action(/^r:confirm:([a-f0-9]+)$/, adminGuard, async (ctx) => rdp.confirmSend(ctx, ctx.match[1]));
  bot.action(/^r:cancel:([a-f0-9]+)$/, adminGuard, async (ctx) => rdp.startCancel(ctx, ctx.match[1]));

  // Multi-payment
  bot.action('a:pm:menu', adminGuard, async (ctx) => { await adminHandler.showPaymentMethodsMenu(ctx); });
  bot.action(/^a:pm:(qris|dana|ovo|gopay)$/, adminGuard, async (ctx) => { await adminHandler.showPaymentMethodEdit(ctx, ctx.match[1]); });
  bot.action(/^a:pm:(qris|dana|ovo|gopay):tog$/, adminGuard, async (ctx) => { await adminHandler.togglePaymentMethod(ctx, ctx.match[1]); });
  bot.action(/^a:pm:(qris|dana|ovo|gopay):img$/, adminGuard, async (ctx) => { await adminHandler.startEditPmImage(ctx, ctx.match[1]); });
  bot.action(/^a:pm:(qris|dana|ovo|gopay):cap$/, adminGuard, async (ctx) => { await adminHandler.startEditPmCaption(ctx, ctx.match[1]); });

  // Join gate
  bot.action('a:gate:menu', adminGuard, async (ctx) => { await adminHandler.showGateMenu(ctx); });
  bot.action('a:gate:tog', adminGuard, async (ctx) => { await adminHandler.toggleGate(ctx); });
  bot.action('a:gate:list', adminGuard, async (ctx) => { await adminHandler.startEditGateList(ctx); });

  // ===== ENTERPRISE (Auto VPS Provisioning, Payment Center, Currency, i18n, Audit, Backup) =====
  const ent = require('./handlers/enterpriseHandler');
  bot.action('e:home', adminGuard, ent.renderEnterpriseHome);
  bot.action('e:autoprov:tog', adminGuard, ent.toggleAutoProvisioning);

  bot.action('e:prov:menu', adminGuard, ent.showProviderMenu);
  bot.action(/^e:prov:add:(aws|digitalocean|linode|azure)$/, adminGuard, async (ctx) => ent.startAddProvider(ctx, ctx.match[1]));
  bot.action('e:prov:list', adminGuard, ent.listProviderApis);
  bot.action(/^e:prov:api:([a-f0-9]+)$/, adminGuard, async (ctx) => ent.showApiDetail(ctx, ctx.match[1]));
  bot.action(/^e:prov:tog:([a-f0-9]+)$/, adminGuard, async (ctx) => ent.toggleApi(ctx, ctx.match[1]));
  bot.action(/^e:prov:hc:([a-f0-9]+)$/, adminGuard, async (ctx) => ent.healthCheckOne(ctx, ctx.match[1]));
  bot.action(/^e:prov:del:([a-f0-9]+)$/, adminGuard, async (ctx) => ent.deleteApi(ctx, ctx.match[1]));
  bot.action('e:prov:healthall', adminGuard, ent.healthAll);
  bot.action('e:prov:reseterr', adminGuard, ent.resetErrors);

  bot.action('e:pay:menu', adminGuard, ent.showPayMenu);
  bot.action(/^e:pay:cfg:(autogopay|binancepay)$/, adminGuard, async (ctx) => ent.showPayConfig(ctx, ctx.match[1]));
  bot.action(/^e:pay:tog:(autogopay|binancepay)$/, adminGuard, async (ctx) => ent.togglePayment(ctx, ctx.match[1]));
  bot.action(/^e:pay:field:(autogopay|binancepay):([a-zA-Z]+)$/, adminGuard, async (ctx) => ent.startEditPayField(ctx, ctx.match[1], ctx.match[2]));
  bot.action(/^e:pay:test:(autogopay|binancepay)$/, adminGuard, async (ctx) => ent.testPayment(ctx, ctx.match[1]));
  bot.action('e:pay:monitor', adminGuard, ent.showWebhookMonitor);

  bot.action('e:cur:menu', adminGuard, ent.showCurrencyMenu);
  bot.action(/^e:cur:edit:([A-Z]{3})$/, adminGuard, async (ctx) => ent.editCurrency(ctx, ctx.match[1]));
  bot.action(/^e:cur:rate:([A-Z]{3})$/, adminGuard, async (ctx) => ent.startEditRate(ctx, ctx.match[1]));
  bot.action(/^e:cur:tog:([A-Z]{3})$/, adminGuard, async (ctx) => ent.toggleCurrency(ctx, ctx.match[1]));
  bot.action(/^e:cur:del:([A-Z]{3})$/, adminGuard, async (ctx) => ent.removeCurrency(ctx, ctx.match[1]));
  bot.action('e:cur:add', adminGuard, ent.startAddCurrency);
  bot.action('e:cur:mode', adminGuard, ent.toggleExchangeMode);
  bot.action('e:cur:sync', adminGuard, ent.syncCurrencies);

  bot.action('e:lang:menu', adminGuard, ent.showLangMenu);
  bot.action('e:lang:default', adminGuard, ent.toggleDefaultLang);
  bot.action('e:lang:list', adminGuard, async (ctx) => ent.listTranslations(ctx, 0));
  bot.action(/^e:lang:list:(\d+)$/, adminGuard, async (ctx) => ent.listTranslations(ctx, parseInt(ctx.match[1], 10)));
  bot.action(/^e:lang:edit:(.+)$/, adminGuard, async (ctx) => ent.startEditTranslation(ctx, ctx.match[1]));

  bot.action('e:dash:providers', adminGuard, ent.showProviderDashboard);

  bot.action('e:queue:menu', adminGuard, ent.showQueueDashboard);
  bot.action('e:queue:live', adminGuard, ent.showLiveProvisions);
  bot.action(/^e:queue:order:([a-f0-9]+)$/, adminGuard, async (ctx) => ent.showProvisionLog(ctx, ctx.match[1]));
  bot.action('e:queue:failed', adminGuard, ent.showQueueFailed);
  bot.action('e:queue:success', adminGuard, ent.showQueueSuccess);

  bot.action('e:audit:menu', adminGuard, async (ctx) => ent.showAuditMenu(ctx, 0));
  bot.action(/^e:audit:(\d+)$/, adminGuard, async (ctx) => ent.showAuditMenu(ctx, parseInt(ctx.match[1], 10)));

  bot.action('e:bak:menu', adminGuard, ent.showBackupMenu);
  bot.action('e:bak:export', adminGuard, ent.doExport);
  bot.action('e:bak:import', adminGuard, ent.startImport);

  // ===== USER SETTINGS (currency & language) =====
  const userSettings = require('./handlers/userSettingsHandler');
  bot.action('menu:settings', userSettings.showSettings);
  bot.action('u:cur:menu', userSettings.showCurrencyPicker);
  bot.action(/^u:cur:set:([A-Z]{3})$/, async (ctx) => userSettings.setCurrency(ctx, ctx.match[1]));
  bot.action('u:lang:menu', userSettings.showLanguagePicker);
  bot.action(/^u:lang:set:([a-z]{2})$/, async (ctx) => userSettings.setLanguage(ctx, ctx.match[1]));

  // ===== REWARD ECOSYSTEM (USER) =====
  const rewardH = require('./handlers/rewardHandler');
  bot.action('rw:menu', async (ctx) => { await rewardH.renderRewardMenu(ctx); await ctx.answerCbQuery().catch(()=>{}); });
  bot.action(/^rw:claim:([LR]\d+)$/, async (ctx) => { await rewardH.startClaim(ctx, ctx.match[1]); });
  bot.action('rf:menu', async (ctx) => { await rewardH.renderReferral(ctx); await ctx.answerCbQuery().catch(()=>{}); });
  bot.action('rf:detail', async (ctx) => { await rewardH.renderReferralDetail(ctx); await ctx.answerCbQuery().catch(()=>{}); });
  bot.action('ach:menu', async (ctx) => { await rewardH.renderAchievement(ctx, 'all'); await ctx.answerCbQuery().catch(()=>{}); });
  bot.action('ach:vps', async (ctx) => { await rewardH.renderAchievement(ctx, 'vps'); await ctx.answerCbQuery().catch(()=>{}); });
  bot.action('ach:ref', async (ctx) => { await rewardH.renderAchievement(ctx, 'referral'); await ctx.answerCbQuery().catch(()=>{}); });
  bot.action('lb:menu', async (ctx) => { await rewardH.renderLeaderboard(ctx, 'buyer'); await ctx.answerCbQuery().catch(()=>{}); });
  bot.action('lb:buyer', async (ctx) => { await rewardH.renderLeaderboard(ctx, 'buyer'); await ctx.answerCbQuery().catch(()=>{}); });
  bot.action('lb:ref', async (ctx) => { await rewardH.renderLeaderboard(ctx, 'ref'); await ctx.answerCbQuery().catch(()=>{}); });
  bot.action('lb:badge', async (ctx) => { await rewardH.renderLeaderboard(ctx, 'badge'); await ctx.answerCbQuery().catch(()=>{}); });
  bot.action('lb:reward', async (ctx) => { await rewardH.renderLeaderboard(ctx, 'reward'); await ctx.answerCbQuery().catch(()=>{}); });
  bot.action('pf:show', async (ctx) => { await rewardH.renderProfile(ctx); await ctx.answerCbQuery().catch(()=>{}); });
  bot.action('pf:share', async (ctx) => { await rewardH.shareProfile(ctx); });

  // ===== REWARD ECOSYSTEM (ADMIN) =====
  const arwH = require('./handlers/adminRewardHandler');
  bot.action('a:rw:home', adminGuard, arwH.renderHome);
  bot.action('a:rw:dash', adminGuard, arwH.renderDashboard);
  bot.action('a:rw:loyalty', adminGuard, arwH.renderLoyalty);
  bot.action('a:rw:referral', adminGuard, arwH.renderReferral);
  bot.action('a:rw:loyalty:tog', adminGuard, async (ctx) => arwH.toggleFlag(ctx, 'loyaltyEnabled', 'a:rw:loyalty'));
  bot.action('a:rw:referral:tog', adminGuard, async (ctx) => arwH.toggleFlag(ctx, 'referralEnabled', 'a:rw:referral'));
  bot.action(/^a:rw:(loyalty|referral):e:(\d+)$/, adminGuard, async (ctx) => arwH.renderTierEdit(ctx, ctx.match[1], parseInt(ctx.match[2], 10)));
  bot.action(/^a:rw:(loyalty|referral):f:(\d+):(\w+)$/, adminGuard, async (ctx) => arwH.handleTierField(ctx, ctx.match[1], parseInt(ctx.match[2], 10), ctx.match[3]));
  bot.action('a:rw:badges', adminGuard, arwH.renderBadges);
  bot.action(/^a:rw:badges:e:(\d+)$/, adminGuard, async (ctx) => arwH.renderBadgeEdit(ctx, parseInt(ctx.match[1], 10)));
  bot.action(/^a:rw:badges:f:(\d+):(\w+)$/, adminGuard, async (ctx) => arwH.handleBadgeField(ctx, parseInt(ctx.match[1], 10), ctx.match[2]));
  bot.action(/^a:rw:badges:del:(\d+)$/, adminGuard, async (ctx) => arwH.deleteBadge(ctx, parseInt(ctx.match[1], 10)));
  bot.action('a:rw:badges:add', adminGuard, arwH.startAddBadge);
  bot.action('a:rw:frames', adminGuard, arwH.renderFrames);
  bot.action(/^a:rw:frames:e:(\d+)$/, adminGuard, async (ctx) => arwH.renderFrameEdit(ctx, parseInt(ctx.match[1], 10)));
  bot.action(/^a:rw:frames:f:(\d+):(\w+)$/, adminGuard, async (ctx) => arwH.handleFrameField(ctx, parseInt(ctx.match[1], 10), ctx.match[2]));
  bot.action('a:rw:settings', adminGuard, arwH.renderSettings);
  bot.action(/^a:rw:settings:f:(\w+)$/, adminGuard, async (ctx) => arwH.handleSettingField(ctx, ctx.match[1]));
  bot.action(/^a:rw:users:(\d+)$/, adminGuard, async (ctx) => arwH.renderUsers(ctx, parseInt(ctx.match[1], 10)));
  bot.action(/^a:rw:user:(\d+)$/, adminGuard, async (ctx) => arwH.renderUserDetail(ctx, ctx.match[1]));
  bot.action(/^a:rw:user:bl:(\d+)$/, adminGuard, async (ctx) => arwH.toggleBlacklist(ctx, ctx.match[1]));
  bot.action(/^a:rw:user:reset:(\d+)$/, adminGuard, async (ctx) => arwH.resetProgress(ctx, ctx.match[1]));
  bot.action(/^a:rw:history:(\d+)$/, adminGuard, async (ctx) => arwH.renderHistory(ctx, parseInt(ctx.match[1], 10)));
  bot.action('a:rw:lb', adminGuard, arwH.renderAdminLeaderboard);

  // ═══ MAINTENANCE MODE (Admin) ═════════════════════════════════════════
  bot.action('a:maint:menu',     adminGuard, async (ctx) => maintenanceH.renderPanel(ctx));
  bot.action('a:maint:enable',   adminGuard, async (ctx) => maintenanceH.doEnable(ctx, bot));
  bot.action('a:maint:disable',  adminGuard, async (ctx) => maintenanceH.doDisable(ctx, bot));
  bot.action('a:maint:eta:menu', adminGuard, async (ctx) => maintenanceH.renderEstimateMenu(ctx));
  bot.action(/^a:maint:eta:set:(\d+)$/, adminGuard, async (ctx) => maintenanceH.setEstimate(ctx, ctx.match[1]));
  bot.action('a:maint:eta:custom', adminGuard, async (ctx) => maintenanceH.startCustomEstimate(ctx));
  bot.action('a:maint:msg',      adminGuard, async (ctx) => maintenanceH.startEditMessage(ctx));
  bot.action('a:maint:testers',  adminGuard, async (ctx) => maintenanceH.renderTesterList(ctx));
  bot.action('a:maint:tester:add', adminGuard, async (ctx) => maintenanceH.startAddTester(ctx));
  bot.action(/^a:maint:tester:rm:(\d+)$/, adminGuard, async (ctx) => maintenanceH.removeTesterAction(ctx, ctx.match[1]));
  bot.action(/^a:maint:req:ok:(\d+)$/, adminGuard, async (ctx) => maintenanceH.approveRequest(ctx, bot, ctx.match[1]));
  bot.action(/^a:maint:req:no:(\d+)$/, adminGuard, async (ctx) => maintenanceH.rejectRequest(ctx, bot, ctx.match[1]));

  // ===== MESSAGE HANDLERS =====
  bot.on('photo', async (ctx) => {
    // Manual proof upload has been removed — all payments are auto-verified via webhook.
    if (await isAdmin(ctx.from.id)) await adminPhotoHandler.handleAdminPhoto(ctx);
  });

  bot.on('text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return;
    // Intercept SSH key input during buy flow (any user, session-guarded)
    const sshHandled = await orderHandler.handleSshInputText(ctx, ctx.message.text);
    if (sshHandled) return;
    if (await isAdmin(ctx.from.id)) {
      // Maintenance mode admin sessions (edit message/estimate/add tester)
      if (await maintenanceH.handleMaintenanceText(ctx)) return;
      // Reward admin sessions
      const arwH = require('./handlers/adminRewardHandler');
      if (await arwH.handleAdminRewardText(ctx)) return;
      // RDP Orders admin sessions (multi-step send / cancel reason)
      const rdpH = require('./handlers/rdpOrdersHandler');
      if (await rdpH.handleSendText(ctx, ctx.message.text)) return;
      if (await rdpH.handleCancelText(ctx, ctx.message.text)) return;
      // VPS management admin sessions (search / custom-hc)
      const vps2 = require('./handlers/vpsManagementHandler');
      if (await vps2.handleSearchText(ctx, ctx.message.text)) return;
      if (await vps2.handleCustomHcText(ctx, ctx.message.text)) return;
      // Enterprise text handler takes priority for e_* sessions
      const ent2 = require('./handlers/enterpriseHandler');
      const handled = await ent2.handleEnterpriseText(ctx);
      if (handled) return;
      await adminHandler.handleAdminText(ctx, bot);
    }
  });

  bot.on('document', async (ctx) => {
    if (await isAdmin(ctx.from.id)) {
      const ent2 = require('./handlers/enterpriseHandler');
      await ent2.handleEnterpriseDocument(ctx);
    }
  });

  return bot;
}

// Check if user is NOT a member of all required channels.
// channels: array of strings ('@username' or '-100...' or 'https://t.me/username' or invite link)
async function isUserBlocked(bot, channels, userId) {
  for (const ch of channels) {
    const target = resolveChannelTarget(ch);
    if (!target) {
      // Unresolvable (e.g. invite link) — safer to block so admin notices misconfig
      return true;
    }
    try {
      const m = await bot.telegram.getChatMember(target, userId);
      const status = m && m.status;
      if (!status || ['left', 'kicked', 'banned'].includes(status)) return true;
    } catch (e) {
      // If bot can't query (not admin in private channel, wrong id), treat as blocked
      return true;
    }
  }
  return false;
}

function resolveChannelTarget(ch) {
  if (!ch) return null;
  let t = String(ch).trim();
  if (!t) return null;
  // Numeric chat id (e.g. -100...)
  if (/^-?\d+$/.test(t)) return Number(t);
  // @username
  if (t.startsWith('@')) return t;
  // URL forms: https://t.me/username, http://t.me/username, t.me/username
  const urlMatch = t.match(/^(?:https?:\/\/)?t\.me\/([^/?#\s]+)/i);
  if (urlMatch) {
    const name = urlMatch[1];
    // Invite link (joinchat or +hash) — no public username, can't resolve via getChatMember
    if (name.toLowerCase() === 'joinchat' || name.startsWith('+')) return null;
    return '@' + name;
  }
  // Bare username without @
  if (/^[A-Za-z][A-Za-z0-9_]{3,}$/.test(t)) return '@' + t;
  return null;
}

module.exports = { buildBot, isUserBlocked };
