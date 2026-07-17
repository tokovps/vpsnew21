const express = require('express');
const path = require('path');
const fs = require('fs');
const { config, validateConfig } = require('./config');
const { connectDB } = require('./config/database');
const { buildBot } = require('./Bot');
const { cancelStaleOrders } = require('./services/orderService');
const { getSettings } = require('./services/settingService');
const currencyService = require('./services/currencyService');
const paymentConfig = require('./services/paymentConfigService');
const i18n = require('./services/i18nService');
const providerHealth = require('./health/providerHealth');
const webhooks = require('./webhooks');

async function main() {
  const missing = validateConfig();
  if (missing.length) {
    console.error('❌ Missing env vars:', missing.join(', '));
    console.error('   Copy .env.example to .env and fill in your credentials.');
    process.exit(1);
  }

  await connectDB();

  // Seed defaults (idempotent, safe to run on every boot)
  await Promise.all([
    currencyService.ensureSeed(),
    paymentConfig.ensureSeed(),
    i18n.ensureSeed(),
  ]);

  // Startup check: every Windows Version shown on the user-facing RDP menu
  // must resolve to an installer image mapping. Diagnostic only — logs to
  // console and never blocks boot. See windowsInstaller.validateWindowsVersionMapping.
  try {
    const winInstaller = require('./provision/rdp/windowsInstaller');
    const bootSettings = await getSettings();
    winInstaller.validateWindowsVersionMapping(bootSettings.rdpWindowsVersions || []);
  } catch (e) {
    console.error('[boot] Windows version mapping check error:', e && e.message);
  }

  const bot = buildBot();

  // Attach admin notify service so it can send to admin chats.
  require('./services/adminNotifyService').attachBot(bot);

  // Express keepalive + webhook endpoints
  const app = express();
  app.get('/', (_req, res) => res.send('🤖 Telegram VPS/RDP Store Bot (Enterprise) is running.'));
  app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

  // Source ZIP download — updated whenever `downloads/rdp-source.zip` is refreshed.
  app.get('/api/download/rdp-zip', (_req, res) => {
    const zipPath = path.join(__dirname, '..', 'downloads', 'rdp-source.zip');
    if (!fs.existsSync(zipPath)) {
      return res.status(404).json({ ok: false, error: 'rdp-source.zip not found' });
    }
    res.download(zipPath, 'lastupdate-rdp-auto-final.zip');
  });

  // Payment webhooks (AutoGoPay, Binance Pay)
  app.use('/', webhooks.router(bot));

  // Confhome mirror — minimal live-patch proxy of bin456789/reinstall.
  // WEBHOOK_URL automatically supplies the public origin on normal Render
  // deployments; CONFHOME_MIRROR_PUBLIC_URL remains an explicit override.
  const confhomeMirror = require('./provision/rdp/confhomeMirror');
  app.use(confhomeMirror.MOUNT_PATH, confhomeMirror.router());
  console.log('[boot] RDP compatibility mirror:', confhomeMirror.PUBLIC_URL
    ? `${confhomeMirror.PUBLIC_URL}${confhomeMirror.MOUNT_PATH}`
    : 'inactive (set WEBHOOK_URL or CONFHOME_MIRROR_PUBLIC_URL)');

  if (config.webhookUrl) {
    const secretPath = `/tg/${bot.secretPathComponent ? bot.secretPathComponent() : 'webhook'}`;
    app.use(express.json());
    app.use(bot.webhookCallback(secretPath));
    await bot.telegram.setWebhook(`${config.webhookUrl}${secretPath}`);
    console.log('✅ Webhook set:', `${config.webhookUrl}${secretPath}`);
  } else {
    await bot.telegram.deleteWebhook().catch(() => {});
    bot.launch();
    console.log('✅ Bot started in long-polling mode');
  }

  app.listen(config.port, '0.0.0.0', () => {
    console.log(`✅ HTTP server listening on :${config.port}`);
  });

  // Periodic jobs
  setInterval(async () => {
    try {
      const s = await getSettings();
      const n = parseInt(s.autoCancelMinutes, 10) || 0;
      if (n > 0) {
        const r = await cancelStaleOrders(n);
        if (r.cancelled > 0) console.log(`⏰ Auto-cancelled ${r.cancelled} stale orders (>${n}min)`);
      }
    } catch (e) { console.error('Auto-cancel cron error:', e.message); }
  }, 60 * 1000);

  // Referral qualification cron — checks pending referrals every hour.
  const rewardService = require('./services/rewardService');
  setInterval(async () => {
    try {
      const r = await rewardService.qualifyPendingReferrals();
      if (r.qualified > 0 || r.rejected > 0) {
        console.log(`🏆 Referral qualification: checked=${r.checked} qualified=${r.qualified} rejected=${r.rejected}`);
      }
    } catch (e) { console.error('Referral qualifier error:', e.message); }
  }, 60 * 60 * 1000);
  rewardService.qualifyPendingReferrals().catch(() => {});
  rewardService.getConfig().catch((e) => console.error('RewardConfig seed:', e.message));

  providerHealth.attachBot(bot);
  providerHealth.startPeriodic(5 * 60 * 1000);
  // Catalog channel auto-updater
  const catalog = require('./services/catalogService');
  catalog.attachBot(bot);
  catalog.startPeriodic(5 * 60 * 1000);
  // First render on boot (in case bot was restarted after changes)
  setTimeout(() => catalog.refreshChannel(bot).catch(() => {}), 5000);
  // Promo scheduler DIHAPUS (revisi 2026-01) — promo tidak lagi berbasis
  // tanggal/jam. Pengumuman promo dipublish langsung saat Admin
  // menekan Buat / Nonaktifkan / Hapus di Promo Center.
  currencyService.startAutoSync(6 * 60 * 60 * 1000);

  // VPS Auto Health Check — interval read from Setting.healthCheckIntervalMinutes
  const vpsHealth = require('./health/vpsHealth');
  vpsHealth.attachBot(bot);
  await vpsHealth.start();

  // ═══════════════════════════════════════════════════════════════════════
  // Boot sweep: RDP orders left in a non-terminal state after a crash/restart
  // ─────────────────────────────────────────────────────────────────────────
  // Any order stuck in `rdp_processing` with a non-terminal rdpState AND no
  // heartbeat (rdpStateAt) update in the last 20 minutes is considered
  // ORPHANED — a worker died mid-flight and there is no way to safely
  // resume the SSH/monitor pipeline (in-memory adapter handles are gone).
  // We mark those orders as FAILED, edit the existing progress bubble with
  // an honest failure card, and stop. This prevents:
  //   - Duplicate re-provision loops on the same VPS.
  //   - "Stuck 40+ minutes" ghost bubbles from a previous run.
  // ═══════════════════════════════════════════════════════════════════════
  try {
    const Order = require('./models/Order');
    const providerService = require('./services/providerService');
    const providers = require('./providers');
    const ProviderApi = require('./models/ProviderApi');

    // (1) Stale ProviderApi locks — if lockedAt > 30 min ago, force-unlock so
    //     the pool doesn't drain to zero after a crash.
    try {
      const staleLockCutoff = new Date(Date.now() - 30 * 60 * 1000);
      const staleLocked = await ProviderApi.find({ status: 'LOCKED', lockedAt: { $lt: staleLockCutoff } });
      for (const api of staleLocked) {
        console.warn(`[boot-sweep] force-unlocking stale provider ${api.provider}/${api._id} lockedAt=${api.lockedAt}`);
        await providerService.unlockApi(api._id, { reason: 'boot-sweep: stale lock >30m' });
      }
      if (staleLocked.length) console.log(`[boot-sweep] unlocked ${staleLocked.length} stale provider lock(s)`);
    } catch (e) { console.error('[boot-sweep] provider unlock error:', e && e.message); }

    // (2) Orphan RDP orders (>20 min no heartbeat) → FAILED + cleanup droplet.
    const cutoff = new Date(Date.now() - 20 * 60 * 1000);
    const orphaned = await Order.find({
      category: 'rdp',
      status: 'rdp_processing',
      rdpState: { $nin: ['', 'COMPLETED', 'FAILED'] },
      $or: [{ rdpStateAt: { $lt: cutoff } }, { rdpStateAt: null }],
    }).limit(100);
    for (const o of orphaned) {
      console.warn(`[boot-sweep] orphan RDP order ${o.invoice} @ ${o.rdpState}, marking FAILED`);
      // Attempt droplet cleanup + provider unlock using persisted context.
      if (o.rdpApiId && o.rdpInstanceId) {
        try {
          const api = await ProviderApi.findById(o.rdpApiId);
          if (api) {
            const adapter = providers.get(api.provider);
            if (adapter && adapter.cleanup) {
              await adapter.cleanup(api, { instanceId: o.rdpInstanceId }).catch(() => {});
              console.log(`[boot-sweep] cleaned orphan droplet ${o.rdpInstanceId} @ ${api.provider}`);
            }
            await providerService.unlockApi(o.rdpApiId, { reason: 'boot-sweep: orphan order' }).catch(() => {});
          }
        } catch (e) { console.error('[boot-sweep] cleanup error:', e && e.message); }
      }
      await Order.findByIdAndUpdate(o._id, {
        $set: {
          status: 'failed',
          provisionStatus: 'failed',
          provisionError: 'Worker interrupted (bot restart mid-provision). Silakan hubungi admin untuk refund.',
          rdpState: 'FAILED',
          rdpStateAt: new Date(),
        },
      });
      // Best-effort edit of existing progress bubble (no new chat spam)
      if (o.progressChatId && o.progressMessageId) {
        const failMsg = `━━━━━━━━━━━━━━━━━━
❌ *AUTO CREATE RDP GAGAL*
━━━━━━━━━━━━━━━━━━

🧾 Invoice: \`${o.invoice}\`
📦 ${o.productName}

📝 Penyebab:
_Worker terputus saat provisioning (bot restart). Silakan hubungi admin untuk refund._
━━━━━━━━━━━━━━━━━━`;
        try {
          await bot.telegram.editMessageCaption(o.progressChatId, o.progressMessageId, undefined, failMsg, { parse_mode: 'Markdown' });
        } catch (_) {
          try { await bot.telegram.editMessageText(o.progressChatId, o.progressMessageId, undefined, failMsg, { parse_mode: 'Markdown' }); } catch (__) {}
        }
      }
    }
    if (orphaned.length) console.log(`[boot-sweep] cleaned ${orphaned.length} orphan RDP order(s)`);
  } catch (e) { console.error('[boot-sweep] error:', e && e.message); }

  process.once('SIGINT', () => { bot.stop('SIGINT'); process.exit(0); });
  process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(0); });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
