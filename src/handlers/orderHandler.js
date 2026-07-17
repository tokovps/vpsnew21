const orderService = require('../services/orderService');
const { setSession, getSession, clearSession, openInputSession } = require('./sessionStore');
const userHandler = require('./userHandler');
const { answerCb } = require('../utils/safeEdit');
const {
  getSettings, specOf,
  regionsOf, vpsOsFamilies, vpsOsVersionsOf,
  rdpWindowsVersions, rdpLinuxVersions, warrantyOf, replaceOf,
} = require('../services/settingService');
const { tryLock, clearLock } = require('../utils/locks');

// ============ NEW BUY FLOW ============
// Step 1: User picked spec → start flow (store in session, render region)
async function handleSpecSelect(ctx, category, tier, slot) {
  // ═══ STATUS PRODUK: BASE PRICE (Setting → Edit Harga) ADALAH SATU-SATUNYA
  //     PENENTU. Bila Base Price = 0 → produk NONAKTIF: tampilkan halaman
  //     "Paket tidak tersedia", JANGAN buat Order/Invoice/Checkout. Cek ini
  //     dilakukan PALING AWAL agar user tetap dapat melihat halaman info
  //     meskipun ia masih punya transaksi aktif. Realtime karena getSettings()
  //     selalu membaca fresh dari MongoDB.
  const s = await getSettings();
  const { price } = specOf(s, category, tier, slot);
  if (!price || price <= 0) {
    await answerCb(ctx);
    return userHandler.renderSpecUnavailable(ctx, category, tier);
  }
  const active = await orderService.userActiveOrders(ctx.from.id);
  if (active && active.length > 0) {
    await answerCb(ctx, '⚠️ Anda masih memiliki transaksi aktif', true);
    return userHandler.renderActiveOrderBlocker(ctx);
  }
  setSession(ctx.from.id, {
    action: 'buy_flow',
    step: 'region',
    category, tier, slot: parseInt(slot, 10),
  });
  // Admin notif — user memulai flow pembelian
  try { require('../services/adminNotifyService').notifyActivity(ctx.from, `Memulai Pembelian ${category.toUpperCase()}`, {
    '📦 Paket:': `${tier.toUpperCase()} #${slot}`,
    '💰 Harga:': String(price),
  }); } catch (_) {}
  await answerCb(ctx);
  return userHandler.renderRegion(ctx, getSession(ctx.from.id));
}

// Step 2: region selected
async function handleRegionSelect(ctx, idx) {
  const sel = getSession(ctx.from.id);
  if (!sel || sel.action !== 'buy_flow') { await answerCb(ctx, 'Sesi habis. Mulai ulang.', true); return userHandler.renderHome(ctx); }
  const s = await getSettings();
  const regions = regionsOf(s, sel.category);
  const region = regions[idx - 1];
  if (!region) { await answerCb(ctx, 'Region tidak valid', true); return; }
  sel.region = region;
  sel.step = sel.category === 'vps' ? 'osFamily' : 'osType';
  setSession(ctx.from.id, sel);
  await answerCb(ctx);
  if (sel.category === 'vps') return userHandler.renderOsFamily(ctx, sel);
  return userHandler.renderRdpOsType(ctx, sel);
}

// Step 3a (VPS): OS family selected
async function handleOsFamilySelect(ctx, idx) {
  const sel = getSession(ctx.from.id);
  if (!sel || sel.action !== 'buy_flow' || sel.category !== 'vps') { await answerCb(ctx, 'Sesi tidak valid', true); return; }
  const s = await getSettings();
  const families = vpsOsFamilies(s);
  const fam = families[idx - 1];
  if (!fam) { await answerCb(ctx, 'OS tidak valid', true); return; }
  sel.osFamily = fam;
  sel.step = 'osVersion';
  setSession(ctx.from.id, sel);
  await answerCb(ctx);
  return userHandler.renderOsVersion(ctx, sel);
}

// Step 3b (RDP): OS type selected
async function handleRdpOsTypeSelect(ctx, osType) {
  const sel = getSession(ctx.from.id);
  if (!sel || sel.action !== 'buy_flow' || sel.category !== 'rdp') { await answerCb(ctx, 'Sesi tidak valid', true); return; }
  if (!['windows', 'linux'].includes(osType)) { await answerCb(ctx, 'OS tidak valid', true); return; }
  sel.osType = osType;
  sel.osFamily = osType === 'windows' ? 'Windows' : 'Linux';
  sel.step = 'osVersion';
  setSession(ctx.from.id, sel);
  await answerCb(ctx);
  return userHandler.renderRdpVersion(ctx, sel);
}

// Step 4 (VPS): OS version selected → go to auth method picker
async function handleVpsOsVersionSelect(ctx, idx) {
  const sel = getSession(ctx.from.id);
  if (!sel || sel.action !== 'buy_flow' || sel.category !== 'vps') { await answerCb(ctx, 'Sesi tidak valid', true); return; }
  const s = await getSettings();
  const versions = vpsOsVersionsOf(s, sel.osFamily);
  const ver = versions[idx - 1];
  if (!ver) { await answerCb(ctx, 'Versi tidak valid', true); return; }
  sel.osVersion = ver;
  sel.step = 'authMethod';
  setSession(ctx.from.id, sel);
  await answerCb(ctx);
  return userHandler.renderAuthMethod(ctx, sel);
}

// Step 4 (RDP): version selected → auth picker (SSH only applies to Linux; still show for consistency)
async function handleRdpVersionSelect(ctx, idx) {
  const sel = getSession(ctx.from.id);
  if (!sel || sel.action !== 'buy_flow' || sel.category !== 'rdp') { await answerCb(ctx, 'Sesi tidak valid', true); return; }
  const s = await getSettings();
  const versions = sel.osType === 'windows' ? rdpWindowsVersions(s) : rdpLinuxVersions(s);
  const ver = versions[idx - 1];
  if (!ver) { await answerCb(ctx, 'Versi tidak valid', true); return; }
  sel.osVersion = ver;
  sel.step = 'authMethod';
  setSession(ctx.from.id, sel);
  await answerCb(ctx);
  return userHandler.renderAuthMethod(ctx, sel);
}

// Step 4b: auth method chosen
async function handleAuthMethodSelect(ctx, method) {
  const sel = getSession(ctx.from.id);
  if (!sel || sel.action !== 'buy_flow' || sel.step !== 'authMethod') { await answerCb(ctx, 'Sesi tidak valid', true); return; }
  sel.authMethod = method;
  if (method === 'ssh') {
    sel.step = 'sshInput';
    openInputSession(ctx, sel);
    await answerCb(ctx);
    return userHandler.renderSshInput(ctx, sel);
  }
  sel.step = 'confirm';
  setSession(ctx.from.id, sel);
  await answerCb(ctx);
  return userHandler.renderConfirmation(ctx, sel);
}

// Step 4c: SSH key text received
async function handleSshInputText(ctx, text) {
  const sel = getSession(ctx.from.id);
  if (!sel || sel.action !== 'buy_flow' || sel.step !== 'sshInput') return false;
  const key = String(text || '').trim();
  if (!/^(ssh-(rsa|ed25519|dss|ecdsa)|ecdsa-sha2)\s+\S+/.test(key)) {
    const { respondInSession } = require('../utils/safeEdit');
    await respondInSession(ctx, '⚠️ Format SSH public key tidak valid. Kirim ulang (harus diawali `ssh-rsa`, `ssh-ed25519`, dsb).', { parse_mode: 'Markdown' });
    return true;
  }
  sel.sshPublicKey = key;
  sel.step = 'confirm';
  setSession(ctx.from.id, sel);
  try { await ctx.deleteMessage(); } catch (_) {}
  // Re-render confirmation on the SAME anchor message (edit-in-place).
  const { getAnchor } = require('./sessionStore');
  const anchor = getAnchor(ctx.from.id);
  if (anchor && anchor.chatId && anchor.messageId) {
    // Build a synthetic ctx.callbackQuery so downstream safeEditText targets the anchor.
    ctx.callbackQuery = { message: { chat: { id: anchor.chatId }, message_id: anchor.messageId } };
  }
  await userHandler.renderConfirmation(ctx, sel);
  return true;
}

// Back navigation within buy flow
async function handleBack(ctx, where) {
  const sel = getSession(ctx.from.id);
  if (!sel || sel.action !== 'buy_flow') { await answerCb(ctx); return userHandler.renderHome(ctx); }
  await answerCb(ctx);
  if (where === 'region') {
    sel.step = 'region'; sel.osFamily = ''; sel.osType = ''; sel.osVersion = '';
    setSession(ctx.from.id, sel);
    return userHandler.renderRegion(ctx, sel);
  }
  if (where === 'osf') {
    sel.step = 'osFamily'; sel.osVersion = '';
    setSession(ctx.from.id, sel);
    return userHandler.renderOsFamily(ctx, sel);
  }
  if (where === 'rdpos') {
    sel.step = 'osType'; sel.osVersion = ''; sel.osType = '';
    setSession(ctx.from.id, sel);
    return userHandler.renderRdpOsType(ctx, sel);
  }
  if (where === 'osv') {
    sel.step = 'osVersion';
    setSession(ctx.from.id, sel);
    return userHandler.renderOsVersion(ctx, sel);
  }
  if (where === 'rdpv') {
    sel.step = 'osVersion';
    setSession(ctx.from.id, sel);
    return userHandler.renderRdpVersion(ctx, sel);
  }
  if (where === 'auth') {
    sel.step = 'authMethod'; sel.sshPublicKey = ''; sel.authMethod = '';
    setSession(ctx.from.id, sel);
    return userHandler.renderAuthMethod(ctx, sel);
  }
}

// Step 5: Confirm → create order → render payment
async function handleConfirmOrder(ctx) {
  const sel = getSession(ctx.from.id);
  if (!sel || sel.action !== 'buy_flow' || sel.step !== 'confirm') {
    await answerCb(ctx, 'Sesi tidak valid. Mulai ulang.', true);
    return userHandler.renderHome(ctx);
  }
  const lockKey = `buy:${ctx.from.id}:${sel.category}:${sel.tier}:${sel.slot}`;
  if (!tryLock(lockKey)) { await answerCb(ctx, '⏳ Memproses...'); return; }

  const active = await orderService.userActiveOrders(ctx.from.id);
  if (active && active.length > 0) {
    await answerCb(ctx, '⚠️ Anda masih memiliki transaksi aktif', true);
    return userHandler.renderActiveOrderBlocker(ctx);
  }

  const s = await getSettings();
  // ═══ SINGLE SOURCE OF PRICE — must match renderConfirmation exactly. ═══
  const promoSvc = require('../services/promoService');
  const eff = await promoSvc.resolveEffectivePrice(s, sel.category, sel.tier, sel.slot);
  const { spec, originalPrice, price, promo } = eff;
  if (!originalPrice || originalPrice <= 0) {
    // Admin mengubah Base Price → 0 di tengah flow. Batalkan sesi, tampilkan
    // halaman "Paket tidak tersedia" tanpa membuat Order/Invoice.
    clearLock(lockKey);
    clearSession(ctx.from.id);
    await answerCb(ctx);
    return userHandler.renderSpecUnavailable(ctx, sel.category, sel.tier);
  }
  const _promo = { discounted: price, original: originalPrice, promo, off: eff.off };

  const warranty = warrantyOf(s, sel.tier);

  // ═══ VPS STOCK VALIDATION — before invoice creation ═══
  // Only for VPS category; RDP delivery is manual so provider isn't required.
  // Runs a live health check across all READY providers. If pool empty → NO
  // invoice, NO payment, show "stock habis" message and abort.
  let preferredApiIds = [];
  if (sel.category === 'vps') {
    await answerCb(ctx, '🔎 Memeriksa ketersediaan provider...');
    const providerService = require('../services/providerService');
    try {
      const pool = await providerService.liveHealthCheckPool();
      if (!pool.length) {
        clearLock(lockKey);
        const { safeEditText } = require('../utils/safeEdit');
        const { Markup } = require('telegraf');
        return safeEditText(ctx,
`━━━━━━━━━━━━━━━━━━
❌ *STOK VPS TIDAK TERSEDIA*

Maaf, saat ini stok VPS sedang habis atau seluruh provider sedang tidak tersedia.

Mohon coba beberapa saat lagi, atau hubungi Admin untuk informasi lebih lanjut.
━━━━━━━━━━━━━━━━━━`,
          { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Coba Lagi', 'confirm:order')],
            [Markup.button.callback('⬅️ Menu Utama', 'menu:home')],
          ]) });
      }
      preferredApiIds = pool.map(a => String(a._id));
    } catch (e) {
      console.error('[buy] liveHealthCheckPool error:', e.message);
    }
  }

  const order = await orderService.createOrder({
    from: ctx.from,
    category: sel.category, tier: sel.tier, slot: sel.slot,
    spec, price,
    originalPrice: originalPrice,
    promoName: (promo && promo.name) || '',
    promoOff: eff.off || 0,
    region: sel.region,
    osType: sel.osType || '',
    osFamily: sel.osFamily,
    osVersion: sel.osVersion,
    warranty,
    replace: replaceOf(s, sel.category, sel.tier),
  });

  // ===== REWARD-ORDER FAST PATH =====
  if (sel.isReward) {
    const rewardService = require('../services/rewardService');
    const cfg = await rewardService.getConfig();
    const tier = (sel.rewardKind === 'loyalty' ? cfg.loyaltyTiers : cfg.referralTiers).find(t => t.threshold === sel.rewardThreshold);
    if (!tier || !tier.active) { clearLock(lockKey); await answerCb(ctx, 'Reward tier tidak aktif', true); return userHandler.renderHome(ctx); }
    const p = await rewardService.ensureProgress(ctx.from.id);
    const claimedList = sel.rewardKind === 'loyalty' ? p.claimedLoyalty : p.claimedReferral;
    if (claimedList.includes(sel.rewardThreshold)) { clearLock(lockKey); await answerCb(ctx, 'Sudah pernah diklaim', true); return userHandler.renderHome(ctx); }
    let genPass = '';
    if (sel.authMethod !== 'ssh') {
      const { generatePassword } = require('../utils/password');
      const len = parseInt(s.passwordLength, 10) || 12;
      const excludeAmbig = (s.passwordExcludeAmbiguous || 'on') === 'on';
      genPass = generatePassword(len, excludeAmbig);
    }
    await orderService.setStatus(order._id, 'processing', {
      authMethod: sel.authMethod === 'ssh' ? 'ssh' : 'password',
      sshPublicKey: sel.sshPublicKey || '',
      generatedPassword: genPass,
      preferredApiIds,
      isRewardOrder: true,
      rewardKind: sel.rewardKind,
      rewardThreshold: sel.rewardThreshold,
      total: 0, price: 0,
      autoProvision: true,
      paidAt: new Date(),
      paymentGateway: 'reward',
    });
    await rewardService.recordClaim(ctx.from.id, sel.rewardKind, tier);
    clearSession(ctx.from.id);
    clearLock(lockKey);
    await answerCb(ctx, '🎁 Reward diproses');
    const s2 = await getSettings();
    const { safeEditMedia } = require('../utils/safeEdit');
    const anchorMsg = ctx.callbackQuery && ctx.callbackQuery.message;
    const msg = await safeEditMedia(ctx, {
      type: 'photo', media: s2.homeBanner,
      caption:
`🎁 *KLAIM REWARD DIPROSES*

🧾 Invoice: \`${order.invoice}\`
🛍 Produk : ${order.productName}
🎯 Tier   : ${sel.rewardKind === 'loyalty' ? 'Loyalty' : 'Referral'} ${sel.rewardThreshold}

_Sistem sedang membuat VPS reward Anda..._`,
      parse_mode: 'Markdown',
    }, { reply_markup: { inline_keyboard: [] } });
    try {
      const chatId = anchorMsg ? anchorMsg.chat.id : ctx.from.id;
      const messageId = anchorMsg ? anchorMsg.message_id : (msg && msg.message_id);
      if (chatId && messageId) {
        await orderService.setStatus(order._id, 'processing', { progressChatId: chatId, progressMessageId: messageId });
      }
    } catch (_) {}
    const fresh = await orderService.getById(order._id);
    const bot = ctx.telegram && { telegram: ctx.telegram };
    require('../provision/orchestrator').provisionOrder(bot, fresh).catch(err =>
      console.error('reward provision:', err && err.message));
    return;
  }

  // Pre-generate strong password (Password mode) so the SAME string is
  // used during provisioning AND sent to the user. No re-generation after.
  let generatedPassword = '';
  if (sel.authMethod !== 'ssh') {
    const { generatePassword } = require('../utils/password');
    const len = parseInt(s.passwordLength, 10) || 12;
    const excludeAmbig = (s.passwordExcludeAmbiguous || 'on') === 'on';
    generatedPassword = generatePassword(len, excludeAmbig);
  }
  // Persist auth choice + vetted provider pool from stock validation.
  await orderService.setStatus(order._id, 'waiting_payment', {
    authMethod: sel.authMethod === 'ssh' ? 'ssh' : 'password',
    sshPublicKey: sel.sshPublicKey || '',
    generatedPassword,
    preferredApiIds,
  });
  clearSession(ctx.from.id);
  await answerCb(ctx, '✅ Invoice dibuat');

  // Route based on enabled payment methods
  const enabled = await require('../services/settingService').enabledPaymentMethodsAsync(s);
  if (!enabled.length) {
    await answerCb(ctx, 'Belum ada metode pembayaran aktif', true);
    return userHandler.renderOrderDetail(ctx, order._id.toString());
  }
  if (enabled.length === 1) {
    await orderService.setStatus(order._id, 'waiting_payment', { paymentMethod: enabled[0].key });
    return userHandler.renderPayment(ctx, order._id.toString());
  }
  return userHandler.renderMethodSelector(ctx, order._id.toString());
}

// User picks a payment method
async function handlePickMethod(ctx, key, orderId) {
  const o = await orderService.getById(orderId);
  if (!o || String(o.userId) !== String(ctx.from.id)) { await answerCb(ctx, 'Pesanan tidak ditemukan', true); return; }
  if (o.status !== 'waiting_payment') { await answerCb(ctx, 'Status tidak valid', true); return; }
  const s = await getSettings();
  const m = await require('../services/settingService').paymentMethodByKeyAsync(s, key);
  if (!m || !m.enabled) { await answerCb(ctx, 'Metode tidak tersedia', true); return; }
  // If switching to a different auto-gateway, drop cached invoice so a fresh
  // one is created for the new gateway (prevents stale QR/checkout leaking).
  const patch = { paymentMethod: key };
  if (o.paymentGateway && o.paymentGateway !== (m.gateway || '')) {
    patch.paymentGateway = '';
    patch.paymentGatewayRef = '';
    patch.paymentQrUrl = '';
    patch.paymentCheckoutUrl = '';
    patch.paymentExpiryTime = '';
  }
  await orderService.setStatus(o._id, 'waiting_payment', patch);
  await answerCb(ctx, `✅ Metode ${m.label} dipilih`);
  return userHandler.renderPayment(ctx, orderId);
}

// User wants to change method
async function handleChangeMethod(ctx, orderId) {
  await answerCb(ctx);
  return userHandler.renderMethodSelector(ctx, orderId);
}

// ============ CANCEL ============
async function handleCancel(ctx, orderId) {
  const o = await orderService.getById(orderId);
  if (!o || String(o.userId) !== String(ctx.from.id)) {
    await answerCb(ctx, 'Pesanan tidak ditemukan', true);
    return;
  }
  if (o.status !== 'waiting_payment') {
    await answerCb(ctx, 'Pesanan tidak dapat dibatalkan', true);
    return userHandler.renderOrderDetail(ctx, orderId);
  }
  await orderService.setStatus(o._id, 'cancelled');
  clearSession(ctx.from.id);
  await answerCb(ctx, '❌ Pesanan dibatalkan');
  return userHandler.renderOrders(ctx);
}

module.exports = {
  handleSpecSelect,
  handleRegionSelect,
  handleOsFamilySelect,
  handleRdpOsTypeSelect,
  handleVpsOsVersionSelect,
  handleRdpVersionSelect,
  handleAuthMethodSelect,
  handleSshInputText,
  handleBack,
  handleConfirmOrder,
  handlePickMethod,
  handleChangeMethod,
  handleCancel,
};
