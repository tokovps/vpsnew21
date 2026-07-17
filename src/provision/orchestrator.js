// Orchestrator: run full auto VPS provisioning for a paid order.
// Single-message UX: reuses the invoice message (progressChatId/MessageId
// already persisted from renderPayment) and edits it through every step.
// Only NEW messages emitted: (1) the final "🔐 LOGIN INFO" copy-friendly
// message, (2) fatal errors, (3) private key if generated.
const Order = require('../models/Order');
const VpsInstance = require('../models/VpsInstance');
const providerService = require('../services/providerService');
const providers = require('../providers');
const audit = require('../services/auditService');
const { vpsProvisionQueue } = require('../queues/provisionQueue');

const STEPS = {
  PAYMENT_VERIFIED: '🟢 Payment Verified',
  SELECTING:        '🟢 Selecting Provider',
  CHECKING_API:     '🟢 Checking Provider API',
  CHECKING_REGION:  '🟢 Checking Region',
  CHECKING_IMAGE:   '🟢 Checking Image',
  CREATING:         '🟢 Creating Instance',
  WAITING_IP:       '🟢 Waiting Public IP',
  APPLYING_CREDS:   '🟢 Applying Credentials',
  FINAL_VALIDATION: '🟢 Final Validation',
  DONE:             '🟢 Completed',
};

function buildProgressBody(order, extra) {
  const steps = (order.provisionSteps || []).map(s => s).join('\n');
  return `━━━━━━━━━━━━━━━━━━
⚙ *AUTO PROVISION*

🧾 Invoice: \`${order.invoice}\`
🛍 Produk: ${order.productName}

${steps}${extra ? `\n🟡 ${extra} ...` : ''}
━━━━━━━━━━━━━━━━━━`;
}

// Try editing the invoice photo caption first (single-message UX); fallback
// to editMessageText if the target isn't a media message; last resort send
// a new message and re-persist the ids on the order.
async function pushProgress(bot, order, extra) {
  if (!bot) return;
  const text = buildProgressBody(order, extra);
  const opts = { parse_mode: 'Markdown' };
  const chatId = order.progressChatId;
  const msgId  = order.progressMessageId;
  if (chatId && msgId) {
    try {
      await bot.telegram.editMessageCaption(chatId, msgId, undefined, text, opts);
      return;
    } catch (_) {}
    try {
      await bot.telegram.editMessageText(chatId, msgId, undefined, text, opts);
      return;
    } catch (_) {}
  }
  // Fallback — no anchor available. Emit ONE new message and pin it as the
  // future progress anchor.
  try {
    const m = await bot.telegram.sendMessage(order.userId, text, opts);
    order.progressChatId = m.chat.id;
    order.progressMessageId = m.message_id;
    await Order.findByIdAndUpdate(order._id, { $set: { progressChatId: m.chat.id, progressMessageId: m.message_id } });
  } catch (e) { console.error('pushProgress fallback:', e.message); }
}

async function appendStep(bot, order, step) {
  order.provisionSteps = [...(order.provisionSteps || []), step];
  await Order.findByIdAndUpdate(order._id, { $set: { provisionSteps: order.provisionSteps, provisionStatus: step } });
  await pushProgress(bot, order);
}

async function pickBestApi(order, triedIds = []) {
  const apis = await providerService.findReadyApis();
  // Prefer the pool that was vetted at buy time (see VPS stock validation).
  const preferred = new Set((order && order.preferredApiIds) || []);
  if (preferred.size) {
    const first = apis.find(a => !triedIds.includes(String(a._id)) && preferred.has(String(a._id)));
    if (first) return first;
  }
  return apis.find(a => !triedIds.includes(String(a._id))) || null;
}

async function runOne(bot, order) {
  await appendStep(bot, order, STEPS.PAYMENT_VERIFIED);
  const triedIds = [];
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await appendStep(bot, order, `${STEPS.SELECTING}${attempt > 1 ? ` (try ${attempt})` : ''}`);
    const cand = await pickBestApi(order, triedIds);
    if (!cand) throw new Error('No READY provider API available');
    triedIds.push(String(cand._id));

    const locked = await providerService.tryLockApi(cand._id, order._id);
    if (!locked) continue;

    const attemptStart = Date.now();
    await appendStep(bot, order, `${STEPS.CHECKING_API} (${locked.provider})`);
    const health = await providers.healthCheck(locked);
    if (!health.ok) {
      await providerService.markError(locked._id, new Error(health.error));
      await providerService.unlockApi(locked._id, { reason: 'health fail' });
      await providerService.recordAttempt(locked._id, false, Date.now() - attemptStart);
      continue;
    }

    let createdResources = null;
    try {
      await appendStep(bot, order, STEPS.CHECKING_REGION);
      await appendStep(bot, order, STEPS.CHECKING_IMAGE);
      const adapter = providers.get(locked.provider);

      // ═══ STRUCTURED SPEC (root-cause fix for VPS 1GB regression) ══════
      // Same logic as RDP orchestrator: honour Order.sizeSlug / cpu / ram /
      // disk; if missing (legacy order) derive from description text. Never
      // let the adapter fall back to `s-1vcpu-1gb`.
      let effSizeSlug = order.sizeSlug || '';
      let effCpu = order.cpu || 0;
      let effRamMb = order.ramMb || 0;
      let effDiskGb = order.diskGb || 0;
      if (!effSizeSlug || !effCpu || !effRamMb || !effDiskGb) {
        const { parseSpecText, deriveDoSizeSlug } = require('../utils/specMapping');
        const parsed = parseSpecText(order.description);
        effCpu    = effCpu    || Number(parsed.cpu)    || 0;
        effRamMb  = effRamMb  || Number(parsed.ramMb)  || 0;
        effDiskGb = effDiskGb || Number(parsed.diskGb) || 0;
        effSizeSlug = effSizeSlug || deriveDoSizeSlug({ cpu: effCpu, ramMb: effRamMb, diskGb: effDiskGb }) || '';
        if (effSizeSlug || effCpu || effRamMb || effDiskGb) {
          await Order.findByIdAndUpdate(order._id, {
            $set: { cpu: effCpu, ramMb: effRamMb, diskGb: effDiskGb, sizeSlug: effSizeSlug },
          });
        }
      }
      if (!effSizeSlug) {
        throw new Error(
          `Order VPS spec tidak lengkap (cpu=${effCpu} ram=${effRamMb}MB disk=${effDiskGb}GB). ` +
          `Admin harus menuliskan spec dengan format eksplisit ("4 vCPU / 8GB RAM / 160GB SSD").`
        );
      }
      console.log('[vps-orch] SPEC_SELECTED', JSON.stringify({
        orderId: String(order._id),
        selectedPackage: `${order.category}/${order.tier}`,
        selectedCpu: effCpu, selectedRamMb: effRamMb, selectedDiskGb: effDiskGb,
        selectedSizeSlug: effSizeSlug, selectedRegion: order.region || '(auto)',
      }));

      const spec = {
        orderId: String(order._id),
        // ═══ WORKFLOW SEPARATION GUARANTEE ═══════════════════════════════
        // VPS Linux → droplet Ubuntu BARU dari adapter.createInstance().
        // TIDAK PERNAH menggunakan atau me-refer instance lama apapun
        // (termasuk droplet bekas RDP yang sudah di-delete oleh admin).
        // `category` sengaja TIDAK di-set 'rdp' — supaya di DO adapter
        // `isRdp` = false → tidak masuk RDP size-fallback / RDP-specific
        // path apapun. Ini yang menjamin "Buy VPS setelah RDP dihapus"
        // menghasilkan droplet Ubuntu bersih dengan SSH root+password
        // yang bisa langsung login.
        osFamily: order.osFamily || 'Ubuntu',
        osVersion: order.osVersion || '',
        region: order.region || '',
        sizeSlug: effSizeSlug,
        cpu:    effCpu,
        ramMb:  effRamMb,
        diskGb: effDiskGb,
        // IMPORTANT: use generatedPassword (created at confirm-order time),
        // not order.credentials which is populated AFTER provisioning.
        password: order.authMethod === 'password' ? (order.generatedPassword || '') : '',
        sshPublicKey: order.authMethod === 'ssh' ? (order.sshPublicKey || '') : '',
      };

      await appendStep(bot, order, STEPS.CREATING);
      const onProgress = async (m) => {
        // Fold minor "sub" progress into anchor without adding steps every call
        await pushProgress(bot, order, m);
      };
      const result = await adapter.createInstance(locked, spec, onProgress);
      createdResources = result;
      await appendStep(bot, order, STEPS.WAITING_IP);
      await appendStep(bot, order, STEPS.APPLYING_CREDS);
      await appendStep(bot, order, STEPS.FINAL_VALIDATION);

      // Password priority: explicit generatedPassword > provider-returned.
      const finalPassword = order.authMethod === 'password'
        ? (order.generatedPassword || result.password || '')
        : (result.password || '');

      const inst = await VpsInstance.create({
        orderId: String(order._id),
        userId: order.userId,
        provider: result.provider,
        apiId: String(locked._id),
        instanceId: result.instanceId,
        region: result.region,
        imageId: result.imageId,
        osLabel: result.osLabel,
        size: result.size,
        publicIp: result.publicIp,
        username: result.username,
        password: finalPassword,
        sshKeyName: result.sshKeyName,
        status: 'running',
        // LIFECYCLE MARKER: WAJIB 'vps'. Droplet ini adalah Ubuntu Linux baru
        // yang barusan dibuat via adapter.createInstance() → POST /droplets.
        // Tidak ada referensi ke instance lama apapun (termasuk droplet bekas
        // RDP yang sudah dihapus). Marker ini menjamin workflow VPS terpisah
        // penuh dari RDP walaupun berbagi Provider Token & Quota.
        lifecycle: 'vps',
        raw: result.raw || {},
      });

      const credentialSummary = [
        `IP: ${result.publicIp}`,
        `User: ${result.username}`,
        finalPassword ? `Password: ${finalPassword}` : null,
        result.sshKeyName ? `SSH Key: ${result.sshKeyName}` : null,
        result.privateKey ? `\n--- PRIVATE KEY ---\n${result.privateKey}` : null,
      ].filter(Boolean).join('\n');

      await Order.findByIdAndUpdate(order._id, {
        $set: {
          status: 'success',
          provisionStatus: 'success',
          providerUsed: result.provider,
          apiUsedId: String(locked._id),
          vpsInstanceId: String(inst._id),
          publicIp: result.publicIp,
          credentials: credentialSummary,
          verifiedSizeSlug: (result.verified && result.verified.sizeSlug) || '',
          verifiedMemoryMb: (result.verified && result.verified.memoryMb) || 0,
          verifiedVcpus:    (result.verified && result.verified.vcpus) || 0,
          verifiedDiskGb:   (result.verified && result.verified.diskGb) || 0,
        },
      });
      await providerService.markUsed(locked._id);
      await providerService.recordAttempt(locked._id, true, Date.now() - attemptStart);
      await appendStep(bot, order, STEPS.DONE);
      await audit.log('provision.success', { refId: order._id, message: `${result.provider} @ ${result.region} → ${result.publicIp}` });

      // Admin activity notify — VPS provisioned successfully
      try {
        require('../services/adminNotifyService').notifyActivity(
          { telegramId: order.userId, username: order.username, firstName: order.userName || '' },
          'VPS Berhasil Diprovision',
          {
            '☁️ Provider:': String(result.provider || '-').toUpperCase(),
            '🌍 Region:': result.region || '-',
            '🌐 IP:': `\`${result.publicIp || '-'}\``,
            '🧾 Invoice:': `\`${order.invoice}\``,
          },
        );
      } catch (_) {}


      // ===== REWARD ECOSYSTEM HOOKS (VPS only) =====
      try {
        const rewardService = require('../services/rewardService');
        const fresh2 = await Order.findById(order._id);
        await rewardService.onVpsProvisionSuccess(fresh2);
        await rewardService.onVpsSuccessLinkReferral(fresh2);
        if (fresh2.isRewardOrder) {
          const RewardClaim = require('../models/RewardClaim');
          await RewardClaim.findOneAndUpdate(
            { userId: String(fresh2.userId), kind: fresh2.rewardKind, threshold: fresh2.rewardThreshold, status: 'created' },
            { $set: { status: 'success', rewardOrderId: String(fresh2._id) } },
          );
        }
      } catch (e) { console.error('reward hook:', e.message); }

      // ===== FINAL EDIT — replace progress anchor with success card =====
      const createdAt = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false });
      const specLines = (order.description || '').split('\n').map(l => l.trim()).filter(Boolean);
      const ram = specLines.find(l => /ram/i.test(l)) || '-';
      const cpu = specLines.find(l => /cpu|core/i.test(l)) || '-';
      const ssd = specLines.find(l => /ssd|disk/i.test(l)) || '-';
      const bw  = specLines.find(l => /bw|bandwidth|tb/i.test(l)) || '-';
      // Combined success + LOGIN INFO card — single edit, no new chat message.
      const successCard =
`━━━━━━━━━━━━━━━━━━
🎉 *VPS BERHASIL DIBUAT*

📦 Invoice        : \`${order.invoice}\`
☁ Provider       : ${result.provider.toUpperCase()}
🌍 Region         : ${result.region}
🖥 OS             : ${result.osLabel}
⚡ CPU            : ${cpu}
💾 RAM            : ${ram}
💿 Disk           : ${ssd}
🌐 Bandwidth      : ${bw}
📍 Public IP      : \`${result.publicIp}\`
👤 Username       : \`${result.username}\`
${order.authMethod === 'ssh'
  ? '🗝 Login SSH     : SSH Public Key (dari Anda)'
  : `🔑 Password       : \`${finalPassword}\``}
🔌 SSH Port       : 22
🕒 Created        : ${createdAt}
━━━━━━━━━━━━━━━━━━

🔐 *INFORMASI LOGIN VPS*
\`\`\`
IP       : ${result.publicIp}
Username : ${result.username}
${order.authMethod === 'ssh' ? 'Auth     : SSH Public Key' : `Password : ${finalPassword}`}

SSH:
ssh ${result.username}@${result.publicIp}

Port: 22
\`\`\``;
      try {
        if (order.progressChatId && order.progressMessageId) {
          await bot.telegram.editMessageCaption(
            order.progressChatId, order.progressMessageId, undefined,
            successCard, { parse_mode: 'Markdown' },
          ).catch(async () => {
            await bot.telegram.editMessageText(
              order.progressChatId, order.progressMessageId, undefined,
              successCard, { parse_mode: 'Markdown' }).catch(() => {});
          });
        } else {
          // No anchor — fall back to ONE notification message (allowed per spec).
          await bot.telegram.sendMessage(order.userId, successCard, { parse_mode: 'Markdown' });
        }
      } catch (e) { console.error('final success edit:', e.message); }

      // SSH private key (when generated by us) is safety-critical — deliver
      // it as a separate notification chat message so the user can save it.
      if (result.privateKey && order.authMethod === 'ssh' && !order.sshPublicKey) {
        try {
          await bot.telegram.sendMessage(order.userId,
            `🔐 *SSH PRIVATE KEY* (simpan sebagai file .pem):\n\n\`\`\`\n${result.privateKey}\n\`\`\``,
            { parse_mode: 'Markdown' });
        } catch (_) {}
      }

      // Send receipt to channel (if configured) — reuse existing helper
      try {
        const { sendReceipt } = require('../handlers/adminHandler');
        const fresh = await Order.findById(order._id);
        await sendReceipt(bot, fresh, 'success');
      } catch (_) {}
      return { ok: true };
    } catch (err) {
      console.error('Provision attempt failed:', err.message);
      await audit.log('provision.fail', { refId: order._id, message: err.message, meta: { provider: locked.provider } });
      try {
        require('../services/adminNotifyService').notifyActivity(
          { telegramId: order.userId, username: order.username, firstName: order.userName || '' },
          'Provision VPS GAGAL',
          { '☁️ Provider:': String(locked.provider || '-').toUpperCase(), '⚠️ Error:': String(err.message).slice(0, 120) },
        );
      } catch (_) {}
      try {
        if (createdResources) {
          const adapter = providers.get(locked.provider);
          if (adapter.cleanup) await adapter.cleanup(locked, createdResources).catch(() => {});
        }
      } catch (_) {}
      await providerService.unlockApi(locked._id, { reason: 'create failed' });
      await providerService.markError(locked._id, err);
      await providerService.recordAttempt(locked._id, false, Date.now() - attemptStart);
      order.provisionRetryCount = (order.provisionRetryCount || 0) + 1;
      await Order.findByIdAndUpdate(order._id, { $inc: { provisionRetryCount: 1 }, $set: { provisionError: err.message.slice(0, 500) } });
      await appendStep(bot, order, `⚠️ Failed: ${err.message.slice(0, 80)} — retrying`);
    }
  }
  throw new Error('All providers exhausted');
}

async function provisionOrder(bot, order) {
  return vpsProvisionQueue.push(async () => {
    try {
      const fresh = await Order.findById(order._id);
      Object.assign(order, fresh.toObject());
      await runOne(bot, order);
    } catch (e) {
      console.error('provisionOrder final fail:', e.message);
      await Order.findByIdAndUpdate(order._id, { $set: { provisionStatus: 'failed', provisionError: e.message.slice(0, 500) } });
      await audit.log('provision.exhausted', { refId: order._id, message: e.message });

      // Refund flow — only if paid via auto gateway
      let refundNote = '';
      try {
        const fresh = await Order.findById(order._id);
        if (fresh && fresh.paymentGateway && fresh.paidAt) {
          const gw = fresh.paymentGateway;
          const mod = gw === 'autogopay' ? require('../payments/autogopay')
                    : gw === 'binancepay' ? require('../payments/binancepay') : null;
          if (mod && mod.refundInvoice) {
            const r = await mod.refundInvoice({ orderId: String(fresh._id), gatewayRef: fresh.paymentGatewayRef, amountIdr: fresh.total });
            refundNote = r.ok ? '\n\n💸 Refund otomatis diproses via gateway.' : `\n\n⚠️ Refund otomatis gagal (${(r.error || '').toString().slice(0, 80)}). Silakan hubungi admin.`;
            await audit.log(r.ok ? 'refund.ok' : 'refund.fail', { refId: fresh._id, message: gw + ' ' + (r.error || 'ok') });
            await Order.findByIdAndUpdate(fresh._id, { $set: { status: r.ok ? 'cancelled' : 'processing', rejectReason: r.ok ? 'auto-refunded (provisioning exhausted)' : 'refund failed' } });
          } else {
            refundNote = '\n\n_Pembayaran manual — silakan hubungi admin untuk refund._';
          }
        }
      } catch (rerr) {
        console.error('refund error:', rerr.message);
        refundNote = '\n\n⚠️ Refund error: ' + rerr.message.slice(0, 100);
      }

      try {
        await bot.telegram.sendMessage(order.userId,
          `❌ *Provisioning gagal.*\n\nInvoice: \`${order.invoice}\`\nSemua provider habis. ${refundNote}`,
          { parse_mode: 'Markdown' });
      } catch (_) {}
    }
  });
}

module.exports = { provisionOrder, STEPS };
