const { safeEditMedia, answerCb } = require('../utils/safeEdit');
const { mainMenu, backHome, tierMenu, slotButtons, paymentActions, paymentMethodKeyboard, joinGateKeyboard, ordersList, orderActions, blockerMenu,
  regionKeyboard, osFamilyKeyboard, osVersionKeyboard, rdpOsTypeKeyboard, rdpVersionKeyboard, confirmKeyboard,
} = require('../keyboards/user');
const { getSettings, tierFields, specOf,
  regionsOf, vpsOsFamilies, vpsOsVersionsOf, rdpWindowsVersions, rdpLinuxVersions, warrantyOf, replaceOf,
  enabledPaymentMethods, paymentMethodByKey,
} = require('../services/settingService');
const orderService = require('../services/orderService');
const userService = require('../services/userService');
const { config } = require('../config');
const { rupiah, statusLabel } = require('../utils/format');
const { formatForUser } = require('../utils/priceFormat');

async function buildSpecList(settings, category, tier, ctx) {
  const divider = '━━━━━━━━━━━━━━━━━━━━';
  const promoSvc = require('../services/promoService');
  const blocks = await Promise.all([1, 2, 3].map(async i => {
    // ═══ STATUS PRODUK DITENTUKAN OLEH BASE PRICE (Setting → Edit Harga) ═══
    // Base Price > 0  → Aktif (spec normal, promo boleh diskon)
    // Base Price = 0  → Nonaktif (spec + harga strikethrough, tombol tetap tampil
    //                   tapi checkout diblokir di handleSpecSelect)
    // Promo TIDAK menentukan status; hanya menampilkan harga diskon.
    const { spec, price } = specOf(settings, category, tier, i);
    const specLines = spec.split('\n').map(l => l.trim()).filter(Boolean);
    if (!price || price <= 0) {
      // NONAKTIF — strikethrough seluruh spec + harga (Rp 0), plus label
      // "🚫 STOCK KOSONG" tepat di bawah spesifikasi agar user paham.
      const struckSpec = specLines.length
        ? specLines.map(l => `~~${l}~~`).join('\n')
        : '_Belum diatur_';
      const priceTxt = specLines.length ? '~~Rp 0~~' : '_Belum diatur_';
      return `[ ${i} ] ${struckSpec}\n└─➤ ${priceTxt}\n🚫 *STOCK KOSONG*`;
    }
    // AKTIF — harga normal + promo bila ada
    const r = await promoSvc.applyToPrice(price, category, tier);
    let priceTxt;
    if (r.promo && r.discounted !== r.original) {
      const oldTxt = await formatForUser(ctx, r.original);
      const newTxt = await formatForUser(ctx, r.discounted);
      priceTxt = `~~${oldTxt}~~  ${newTxt} 🔥`;
    } else {
      priceTxt = await formatForUser(ctx, price);
    }
    return `[ ${i} ] ${specLines.join('\n')}\n└─➤ ${priceTxt}`;
  }));
  return `${divider}\n${blocks.join(`\n${divider}\n`)}\n${divider}`;
}

// Halaman "Paket tidak tersedia" — ditampilkan bila user menekan Spec dengan
// Base Price = 0. TIDAK membuat Order, TIDAK membuat Invoice, TIDAK Checkout.
async function renderSpecUnavailable(ctx, category, tier) {
  const s = await getSettings();
  const { banner: bField } = tierFields(category, tier);
  const { Markup } = require('telegraf');
  const caption =
`━━━━━━━━━━━━━━━━━━

⚠️ *Mohon Maaf*

Paket ini sedang tidak tersedia.
Silakan pilih Spec lainnya.

━━━━━━━━━━━━━━━━━━`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('⬅️ Kembali', `tier:${category}:${tier}`)],
  ]);
  return safeEditMedia(ctx, {
    type: 'photo', media: s[bField],
    caption, parse_mode: 'Markdown',
  }, kb);
}

async function renderHome(ctx) {
  const s = await getSettings();
  const caption = await require('../services/homeCaptionService').buildHomeCaption(ctx);
  await safeEditMedia(ctx, {
    type: 'photo', media: s.homeBanner,
    caption, parse_mode: 'Markdown',
  }, mainMenu());
}

async function renderStockEmpty(ctx, category) {
  const s = await getSettings();
  const { Markup } = require('telegraf');
  const label = category === 'vps' ? 'VPS' : 'RDP';
  const caption =
`━━━━━━━━━━━━━━━━━━━━━━

❌ *STOCK ${label} SEDANG KOSONG*

━━━━━━━━━━━━━━━━━━━━━━

Mohon maaf, seluruh provider sedang penuh.
Silakan coba lagi beberapa saat lagi
atau hubungi Admin untuk info restock.

_Kami menjamin transaksi hanya berjalan bila stock benar-benar tersedia._`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.url('📞 Hubungi Admin', `https://t.me/${config.adminUsername}`)],
    [Markup.button.callback('⬅️ Kembali', 'menu:home')],
  ]);
  return safeEditMedia(ctx, {
    type: 'photo', media: s.homeBanner,
    caption, parse_mode: 'Markdown',
  }, kb);
}

// Halaman ANTRIAN — ditampilkan bila STOCK masih tersedia tetapi seluruh
// Provider sedang LOCKED (sibuk menjalankan install Windows/OS pelanggan lain).
// Berbeda dengan renderStockEmpty: user diberitahu untuk menunggu, bukan
// diberitahu stock habis.
async function renderBuyQueue(ctx, category) {
  const s = await getSettings();
  const catalog = require('../services/catalogService');
  const { Markup } = require('telegraf');
  const label = category === 'vps' ? 'VPS' : 'RDP';
  const av = await catalog.getBuyMenuStock();
  const running = (av.queue && av.queue.running) || av.lockedProviders || 1;
  const caption =
`━━━━━━━━━━━━━━━━━━━━━━

⏳ *MOHON MENUNGGU ANTREAN*

━━━━━━━━━━━━━━━━━━━━━━

Saat ini seluruh Server sedang menyelesaikan
proses instalasi pelanggan lain.

📦 *Stock ${label} masih tersedia : ${av.stock}*
Namun seluruh Provider sedang sibuk.
Silakan tunggu hingga salah satu proses
instalasi selesai.

⏱ *Estimasi waktu tunggu:*
20–45 Menit

Setelah proses selesai Anda dapat langsung
melakukan pembelian.

Terima kasih atas kesabarannya.

━━━━━━━━━━━━━━
📋 *STATUS ANTRIAN*

Sedang Diproses :
${running} Pelanggan

Posisi Anda :
Menunggu Slot

Estimasi :
20–45 Menit
━━━━━━━━━━━━━━`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Coba Lagi', `menu:${category}`)],
    [Markup.button.url('📞 Hubungi Admin', `https://t.me/${config.adminUsername}`)],
    [Markup.button.callback('⬅️ Kembali', 'menu:home')],
  ]);
  return safeEditMedia(ctx, {
    type: 'photo', media: s.homeBanner,
    caption, parse_mode: 'Markdown',
  }, kb);
}

async function renderTiers(ctx, category) {
  const s = await getSettings();
  const stock = await require('../services/catalogService').getBuyMenuStock();
  const caption =
`━━━━━━━━━━━━━━━━━━━━━━

🚀 *TOKO VPS & RDP*

${stock.statusLine}
${stock.stockLine}
${stock.etaLine}

━━━━━━━━━━━━━━━━━━━━━━

_Silakan pilih paket yang tersedia._`;
  await safeEditMedia(ctx, {
    type: 'photo', media: s.homeBanner,
    caption, parse_mode: 'Markdown',
  }, tierMenu(category));
}

async function renderTierProducts(ctx, category, tier) {
  const s = await getSettings();
  const { banner: bField, caption: cField } = tierFields(category, tier);
  const banner = s[bField];
  const header = s[cField];
  const label = category === 'vps' ? 'VPS' : 'RDP';

  const caption =
`${header}

🖥 *PILIH SPESIFIKASI ${label}*

${await buildSpecList(s, category, tier, ctx)}

_Silahkan pilih nomor spesifikasi._`;

  return safeEditMedia(ctx, {
    type: 'photo', media: banner,
    caption, parse_mode: 'Markdown',
  }, slotButtons(category, tier));
}

async function renderOrders(ctx) {
  const orders = await orderService.userActiveOrders(ctx.from.id);
  const s = await getSettings();
  if (!orders.length) {
    return safeEditMedia(ctx, {
      type: 'photo', media: s.myOrdersBanner,
      caption: `${s.myOrdersCaption}\n\n_Tidak ada pesanan aktif._`,
      parse_mode: 'Markdown',
    }, backHome());
  }
  return safeEditMedia(ctx, {
    type: 'photo', media: s.myOrdersBanner,
    caption: s.myOrdersCaption,
    parse_mode: 'Markdown',
  }, ordersList(orders));
}

async function renderOrderDetail(ctx, orderId) {
  const o = await orderService.getById(orderId);
  if (!o || String(o.userId) !== String(ctx.from.id)) {
    await answerCb(ctx, 'Pesanan tidak ditemukan', true);
    return renderOrders(ctx);
  }
  const s = await getSettings();
  // Promo snapshot from order (preserves the deal even if promo is disabled).
  const promoLine = (o.promoName && o.originalPrice && o.originalPrice > o.total)
    ? `\n🔥 Promo: *${o.promoName}* (hemat ${await formatForUser(ctx, o.originalPrice - o.total)})`
    : '';
  const caption =
`📦 *DETAIL PESANAN*

🧾 Invoice: \`${o.invoice}\`
🛍 Produk: ${o.productName}
${o.description ? `\n📝 Spesifikasi:\n${o.description}\n` : ''}${o.replace ? `🔁 Replace: ${o.replace}\n` : ''}💵 Harga: *${await formatForUser(ctx, o.total)}*${promoLine}
📌 Status: *${statusLabel(o.status)}*`;
  return safeEditMedia(ctx, {
    type: 'photo', media: s.myOrdersBanner,
    caption, parse_mode: 'Markdown',
  }, orderActions(o._id.toString()));
}

async function renderContact(ctx) {
  const s = await getSettings();
  const { Markup } = require('telegraf');
  const kb = Markup.inlineKeyboard([
    [Markup.button.url('💬 Chat Admin', `https://t.me/${config.adminUsername}`)],
    [Markup.button.callback('⬅️ Kembali', 'menu:home')],
  ]);
  return safeEditMedia(ctx, {
    type: 'photo', media: s.homeBanner,
    caption: s.contactAdminCaption,
    parse_mode: 'Markdown',
  }, kb);
}

async function renderPayment(ctx, orderId) {
  const o = await orderService.getById(orderId);
  if (!o || String(o.userId) !== String(ctx.from.id)) {
    await answerCb(ctx, 'Pesanan tidak ditemukan', true);
    return renderOrders(ctx);
  }
  const s = await getSettings();
  const enabled = await require('../services/settingService').enabledPaymentMethodsAsync(s);
  if (!enabled.length) {
    await answerCb(ctx, 'Metode pembayaran belum diaktifkan admin', true);
    return;
  }
  // If user has no method yet or chosen method is disabled, ask to pick first
  const method = await require('../services/settingService').paymentMethodByKeyAsync(s, o.paymentMethod);
  if (!method || !method.enabled) {
    return renderMethodSelector(ctx, orderId);
  }
  // ===== AUTO GATEWAY BRANCH =====
  if (method.auto) {
    return renderAutoGatewayPayment(ctx, o, method);
  }
  const detailLines = [
    o.region ? `🌍 Region: ${o.region}` : null,
    o.osFamily ? `💿 OS: ${o.osFamily}` : null,
    o.osVersion ? `📦 Versi: ${o.osVersion}` : null,
    o.warranty ? `🛡 Garansi: ${o.warranty}` : null,
    o.replace ? `🔁 Replace: ${o.replace}` : null,
  ].filter(Boolean).join('\n');
  const promoLine = (o.promoName && o.originalPrice && o.originalPrice > o.total)
    ? `\n🔥 Promo: *${o.promoName}* (hemat ${await formatForUser(ctx, o.originalPrice - o.total)})`
    : '';
  const caption =
`${method.caption}

━━━━━━━━━━━━━━━━━━━━
🧾 *INVOICE #${o.invoice}*
💳 Metode: *${method.label}*

Produk:
${o.productName}

Spesifikasi:
${o.description || '-'}
${detailLines ? `\n${detailLines}\n` : ''}
Harga:
*${await formatForUser(ctx, o.total)}*${promoLine}

📌 Status: *${statusLabel(o.status)}*
━━━━━━━━━━━━━━━━━━━━`;

  return safeEditMedia(ctx, {
    type: 'photo', media: method.image,
    caption, parse_mode: 'Markdown',
  }, paymentActions(o._id.toString()));
}

async function renderAutoGatewayPayment(ctx, o, method) {
  const { Markup } = require('telegraf');
  const s = await getSettings();
  const priceStr = await formatForUser(ctx, o.total);

  // Persist the invoice-message anchor so orchestrator can edit-in-place.
  try {
    const msg = ctx.callbackQuery && ctx.callbackQuery.message;
    if (msg && (o.progressChatId !== msg.chat.id || o.progressMessageId !== msg.message_id)) {
      await orderService.setStatus(o._id, o.status, {
        progressChatId: msg.chat.id, progressMessageId: msg.message_id,
      });
    }
  } catch (_) {}

  // Restore any invoice we've already created for this order (idempotent).
  let ref         = o.paymentGatewayRef || '';
  let qrUrl       = o.paymentQrUrl || '';
  let checkoutUrl = o.paymentCheckoutUrl || '';
  let expiry      = o.paymentExpiryTime || '';
  let errMsg      = '';

  if (!ref) {
    // Show a "Membuat Invoice..." loading state BEFORE hitting the gateway so
    // the user sees immediate feedback even if the API takes a few seconds.
    try {
      await safeEditMedia(ctx, {
        type: 'photo', media: s.homeBanner,
        caption:
`⏳ *Membuat Invoice ${method.label}...*

🧾 Invoice: \`${o.invoice}\`
💰 Total: *${priceStr}*

_Mohon tunggu, sedang menghubungi payment gateway..._`,
        parse_mode: 'Markdown',
      }, Markup.inlineKeyboard([[Markup.button.callback('❌ Batalkan Pesanan', `cancel:${o._id}`)]]));
    } catch (_) { /* best-effort */ }

    try {
      if (method.gateway === 'autogopay') {
        const r = await require('../payments/autogopay').createInvoice({
          orderId: String(o._id), amountIdr: o.total, description: o.productName,
        });
        if (!r.ok) throw new Error(String(r.error || 'unknown error'));
        const d = r.data || {};
        ref         = d.transaction_id || d.id || '';
        qrUrl       = d.qr_url || (ref ? `https://v1-gateway.autogopay.site/qris/${ref}/qr-code` : '');
        checkoutUrl = d.checkout_url || '';
        expiry      = d.expiry_time || '';
        if (!ref) throw new Error('Response AutoGoPay tidak mengandung transaction_id');
        await orderService.setStatus(o._id, 'waiting_payment', {
          paymentGateway: 'autogopay',
          paymentGatewayRef: ref,
          paymentQrUrl: qrUrl,
          paymentCheckoutUrl: checkoutUrl,
          paymentExpiryTime: expiry,
          autoProvision: true,
        });
      } else if (method.gateway === 'binancepay') {
        const { idrToUsd } = require('../utils/priceFormat');
        const usd = await idrToUsd(o.total);
        const r = await require('../payments/binancepay').createInvoice({
          orderId: String(o._id), amountUsd: usd.toFixed(2), description: o.productName,
        });
        if (!r.ok || (r.data && r.data.status !== 'SUCCESS')) {
          throw new Error(r.error ? (typeof r.error === 'string' ? r.error : JSON.stringify(r.error).slice(0, 200))
                                  : (r.data && r.data.errorMessage) || 'Binance Pay error');
        }
        const dd = r.data.data || {};
        checkoutUrl = dd.checkoutUrl || dd.universalUrl || '';
        ref         = dd.prepayId || '';
        qrUrl       = dd.qrcodeLink || ''; // Binance sometimes returns qrcodeLink
        expiry      = '';
        await orderService.setStatus(o._id, 'waiting_payment', {
          paymentGateway: 'binancepay',
          paymentGatewayRef: ref,
          paymentQrUrl: qrUrl,
          paymentCheckoutUrl: checkoutUrl,
          autoProvision: true,
        });
      }
    } catch (e) { errMsg = e.message; }
  }

  // Buttons
  const rows = [];
  if (checkoutUrl) rows.push([Markup.button.url('💳 Bayar via Link', checkoutUrl)]);
  rows.push([Markup.button.callback('🔄 Cek Status', `pay:${o._id}`)]);
  rows.push([Markup.button.callback('🔀 Ganti Metode', `chgmethod:${o._id}`)]);
  rows.push([Markup.button.callback('❌ Batalkan Pesanan', `cancel:${o._id}`)]);

  // The photo shown MUST be the dynamic QRIS returned by the gateway (not a
  // static local banner). Fall back to method.image only if the gateway did
  // not return a QR (e.g. Binance Pay checkout links).
  const displayImage = qrUrl || method.image || s.homeBanner;

  const caption = errMsg
    ? `⚠️ *Gagal membuat invoice ${method.label}*

🧾 Invoice: \`${o.invoice}\`
💰 Total: *${priceStr}*

_${errMsg}_

Silakan pilih metode lain atau hubungi admin.`
    : `⚡ *${method.label}*

━━━━━━━━━━━━━━━━━━━━
🧾 *INVOICE #${o.invoice}*
🛍 Produk: ${o.productName}
💰 Total: *${priceStr}*
${expiry ? `⏰ Expired: ${expiry}\n` : ''}${ref ? `🔖 Ref: \`${ref}\`\n` : ''}━━━━━━━━━━━━━━━━━━━━

${qrUrl ? '_Scan QRIS di atas untuk membayar._' : '_Klik tombol di bawah untuk melakukan pembayaran._'}
_Pesanan akan diproses otomatis setelah pembayaran diterima gateway._`;

  return safeEditMedia(ctx, {
    type: 'photo', media: displayImage,
    caption, parse_mode: 'Markdown',
  }, Markup.inlineKeyboard(rows));
}

async function renderMethodSelector(ctx, orderId) {
  const o = await orderService.getById(orderId);
  if (!o || String(o.userId) !== String(ctx.from.id)) {
    await answerCb(ctx, 'Pesanan tidak ditemukan', true);
    return renderOrders(ctx);
  }
  const s = await getSettings();
  const enabled = await require('../services/settingService').enabledPaymentMethodsAsync(s);
  if (!enabled.length) {
    await answerCb(ctx, 'Metode pembayaran belum diaktifkan admin', true);
    return;
  }
  const caption =
`💳 *PILIH METODE PEMBAYARAN*

🧾 Invoice: \`${o.invoice}\`
🛍 Produk: ${o.productName}
💰 Total: *${await formatForUser(ctx, o.total)}*

_Pilih metode pembayaran di bawah:_`;
  return safeEditMedia(ctx, {
    type: 'photo', media: s.homeBanner,
    caption, parse_mode: 'Markdown',
  }, paymentMethodKeyboard(enabled, o._id.toString()));
}

async function renderJoinGate(ctx) {
  const s = await getSettings();
  const channels = Array.isArray(s.requiredChannels) ? s.requiredChannels : [];
  const caption = s.joinChannelCaption || 'Mohon join channel terlebih dahulu.';
  try {
    if (ctx.callbackQuery) {
      return safeEditMedia(ctx, {
        type: 'photo', media: s.homeBanner,
        caption, parse_mode: 'Markdown',
      }, joinGateKeyboard(channels));
    }
    return ctx.replyWithPhoto(s.homeBanner, {
      caption, parse_mode: 'Markdown', ...joinGateKeyboard(channels),
    });
  } catch (_) {
    return ctx.reply(caption, { parse_mode: 'Markdown', ...joinGateKeyboard(channels) });
  }
}

async function renderActiveOrderBlocker(ctx) {
  const s = await getSettings();
  const caption =
`⚠️ *Anda masih memiliki transaksi yang belum selesai.*

Silakan selesaikan atau batalkan pesanan terlebih dahulu melalui menu *📋 Pesanan Saya*.`;
  return safeEditMedia(ctx, {
    type: 'photo', media: s.myOrdersBanner,
    caption, parse_mode: 'Markdown',
  }, blockerMenu());
}

// ===== NEW BUY FLOW RENDERERS =====
function numberedList(arr) {
  return arr.map((v, i) => `${i + 1}. ${v}`).join('\n');
}

async function renderRegion(ctx, sel) {
  // sel = { category, tier, slot }
  const s = await getSettings();
  const regions = regionsOf(s, sel.category);
  if (!regions.length) {
    await answerCb(ctx, 'Region belum diatur admin', true);
    return;
  }
  const { banner: bField } = tierFields(sel.category, sel.tier);
  const label = sel.category.toUpperCase();
  const caption =
`🌍 *PILIH REGION ${label}*

${numberedList(regions)}

_Silakan pilih nomor region._`;
  return safeEditMedia(ctx, {
    type: 'photo', media: s[bField],
    caption, parse_mode: 'Markdown',
  }, regionKeyboard(regions.length, `tier:${sel.category}:${sel.tier}`));
}

async function renderOsFamily(ctx, sel) {
  // VPS only
  const s = await getSettings();
  const families = vpsOsFamilies(s);
  if (!families.length) {
    await answerCb(ctx, 'OS belum diatur admin', true);
    return;
  }
  const { banner: bField } = tierFields(sel.category, sel.tier);
  const caption =
`💿 *PILIH OS IMAGE VPS*

${numberedList(families)}

_Silakan pilih nomor OS._`;
  return safeEditMedia(ctx, {
    type: 'photo', media: s[bField],
    caption, parse_mode: 'Markdown',
  }, osFamilyKeyboard(families.length, 'back:region'));
}

async function renderOsVersion(ctx, sel) {
  // VPS only
  const s = await getSettings();
  const versions = vpsOsVersionsOf(s, sel.osFamily);
  if (!versions.length) {
    await answerCb(ctx, 'Versi OS belum diatur admin', true);
    return;
  }
  const { banner: bField } = tierFields(sel.category, sel.tier);
  const caption =
`📦 *PILIH VERSI OS VPS*

OS: *${sel.osFamily}*

${numberedList(versions)}

_Silakan pilih nomor versi._`;
  return safeEditMedia(ctx, {
    type: 'photo', media: s[bField],
    caption, parse_mode: 'Markdown',
  }, osVersionKeyboard(versions.length, 'back:osf'));
}

async function renderRdpOsType(ctx, sel) {
  const s = await getSettings();
  const { banner: bField } = tierFields(sel.category, sel.tier);
  const caption =
`💿 *PILIH JENIS OS RDP*

🖥 WINDOWS
🐧 LINUX

_Silakan pilih jenis OS._`;
  return safeEditMedia(ctx, {
    type: 'photo', media: s[bField],
    caption, parse_mode: 'Markdown',
  }, rdpOsTypeKeyboard('back:region'));
}

async function renderRdpVersion(ctx, sel) {
  const s = await getSettings();
  const versions = sel.osType === 'windows' ? rdpWindowsVersions(s) : rdpLinuxVersions(s);
  if (!versions.length) {
    await answerCb(ctx, 'Versi OS belum diatur admin', true);
    return;
  }
  const { banner: bField } = tierFields(sel.category, sel.tier);
  const title = sel.osType === 'windows' ? 'PILIH WINDOWS VERSION' : 'PILIH LINUX VERSION';
  const caption =
`💿 *${title}*

${numberedList(versions)}

_Silakan pilih nomor versi._`;
  return safeEditMedia(ctx, {
    type: 'photo', media: s[bField],
    caption, parse_mode: 'Markdown',
  }, rdpVersionKeyboard(versions.length, 'back:rdpos'));
}

async function renderConfirmation(ctx, sel) {
  const s = await getSettings();
  // ═══ SINGLE SOURCE OF PRICE — resolveEffectivePrice honours active promo
  // so the number here MATCHES what checkout, invoice, payment, and DB use.
  const eff = await require('../services/promoService').resolveEffectivePrice(s, sel.category, sel.tier, sel.slot);
  const { spec, originalPrice, price, promo } = eff;
  const lines = spec.split('\n').map(l => l.trim()).filter(Boolean);
  const ram = lines.find(l => /ram/i.test(l)) || '-';
  const cpu = lines.find(l => /cpu|core/i.test(l)) || '-';
  const ssd = lines.find(l => /ssd|disk|gb/i.test(l) && !/ram/i.test(l)) || '-';
  const bw  = lines.find(l => /bw|bandwidth|tb/i.test(l)) || '-';
  const warranty = warrantyOf(s, sel.tier) || '-';
  // Replace text PER PAKET — tidak lagi memakai global tierReplace.
  const replaceTxt = replaceOf(s, sel.category, sel.tier) || '-';
  const osLabel = sel.category === 'vps'
    ? sel.osFamily
    : (sel.osType === 'windows' ? 'Windows' : 'Linux');
  const { banner: bField } = tierFields(sel.category, sel.tier);
  const priceStr = await formatForUser(ctx, price);
  const originalStr = await formatForUser(ctx, originalPrice);
  const authLabel = sel.authMethod === 'ssh' ? '🔐 SSH Key' : '🔑 Password';
  const isReward = !!sel.isReward;
  // Show strikethrough + fire emoji when promo is active — same visual as buildSpecList.
  const priceLine = isReward
    ? '🎁 *GRATIS (REWARD)*'
    : (promo ? `~~${originalStr}~~  *${priceStr}* 🔥 (Promo: ${promo.name})` : priceStr);
  const totalLine = isReward
    ? '🎁 GRATIS — Klaim Reward'
    : `💰 *Total Pembayaran: ${priceStr}*`;
  const caption =
`🧾 *KONFIRMASI ${isReward ? 'KLAIM REWARD' : 'PESANAN'}*

🖥 RAM        : ${ram}
⚙️ CPU        : ${cpu}
💾 SSD        : ${ssd}
🌐 Bandwidth  : ${bw}
🌍 Region     : ${sel.region}
💿 OS         : ${osLabel}
📦 Versi OS   : ${sel.osVersion}
📛 Paket      : ${sel.category.toUpperCase()} ${sel.tier.toUpperCase()}
🛡 Garansi    : ${warranty}
🔁 Replace    : ${replaceTxt}
🔐 Auth       : ${authLabel}
💵 Harga      : ${priceLine}

━━━━━━━━━━━━━━━━━━━━
${totalLine}
━━━━━━━━━━━━━━━━━━━━

_Tekan tombol di bawah untuk melanjutkan._`;

  const backCb = sel.category === 'vps' ? 'back:osv' : 'back:rdpv';
  const { Markup } = require('telegraf');
  const confirmKb = isReward
    ? Markup.inlineKeyboard([
        [Markup.button.callback('🎁 KLAIM SEKARANG', 'confirm:order')],
        [Markup.button.callback('↩ Kembali', backCb)],
      ])
    : confirmKeyboard(backCb);
  return safeEditMedia(ctx, {
    type: 'photo', media: s[bField],
    caption, parse_mode: 'Markdown',
  }, confirmKb);
}

async function renderAuthMethod(ctx, sel) {
  const s = await getSettings();
  const { banner: bField } = tierFields(sel.category, sel.tier);
  const { Markup } = require('telegraf');
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('🔑 Password', 'am:password')],
    [Markup.button.callback('🔐 SSH Public Key', 'am:ssh')],
    [Markup.button.callback('⬅️ Kembali', sel.category === 'vps' ? 'back:osv' : 'back:rdpv')],
  ]);
  return safeEditMedia(ctx, {
    type: 'photo', media: s[bField],
    caption: `🔐 *METODE AUTENTIKASI VPS*\n\nPilih cara login ke VPS Anda:\n\n🔑 *Password* — sistem membuatkan password random\n🔐 *SSH Public Key* — Anda kirim public key sendiri`,
    parse_mode: 'Markdown',
  }, kb);
}

async function renderSshInput(ctx, sel) {
  const s = await getSettings();
  const { banner: bField } = tierFields(sel.category, sel.tier);
  const { Markup } = require('telegraf');
  return safeEditMedia(ctx, {
    type: 'photo', media: s[bField],
    caption: `🔐 *KIRIM SSH PUBLIC KEY*\n\nSalin isi file \`~/.ssh/id_rsa.pub\` atau \`~/.ssh/id_ed25519.pub\` Anda lalu kirim sebagai pesan teks.\n\nContoh format:\n\`ssh-ed25519 AAAAC3Nz... user@host\``,
    parse_mode: 'Markdown',
  }, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'back:auth')]]));
}

module.exports = {
  renderHome, renderTiers, renderTierProducts, renderStockEmpty, renderBuyQueue,
  renderOrders, renderOrderDetail, renderContact, renderPayment,
  renderActiveOrderBlocker,
  renderRegion, renderOsFamily, renderOsVersion,
  renderRdpOsType, renderRdpVersion, renderConfirmation,
  renderMethodSelector, renderJoinGate,
  renderAuthMethod, renderSshInput,
  renderSpecUnavailable,
  handleCheckStatus,
};

// ---------------------------------------------------------------------------
// "Cek Status" button. Actively queries the payment gateway API — if the
// invoice is paid we route through the SAME processPaidOrder() the webhook
// uses, so provisioning is guaranteed to fire even when the webhook was
// missed / blocked. Otherwise we simply re-render the payment screen.
// ---------------------------------------------------------------------------
async function handleCheckStatus(ctx, orderId, bot) {
  const o = await orderService.getById(orderId);
  if (!o || String(o.userId) !== String(ctx.from.id)) {
    await answerCb(ctx, 'Pesanan tidak ditemukan', true);
    return renderOrders(ctx);
  }

  // Already past waiting_payment (paid / processing / success / cancelled).
  if (o.status !== 'waiting_payment') {
    await answerCb(ctx, `Status: ${o.status}`);
    return renderOrderDetail(ctx, orderId);
  }

  // No invoice created yet — just re-render the payment screen.
  if (!o.paymentGateway || !o.paymentGatewayRef) {
    await answerCb(ctx, 'Menunggu pembayaran...');
    return renderPayment(ctx, orderId);
  }

  await answerCb(ctx, '⏳ Mengecek status pembayaran ke gateway...');

  let paid = false;
  let statusLabel = '';
  try {
    if (o.paymentGateway === 'autogopay') {
      const autogopay = require('../payments/autogopay');
      const r = await autogopay.getStatus(o.paymentGatewayRef);
      if (r.ok) {
        const st = String((r.data && (r.data.status || r.data.transaction_status)) || '').toLowerCase();
        statusLabel = st;
        paid = ['settlement', 'paid', 'success', 'completed'].includes(st);
      } else {
        console.warn('[cekstatus:autogopay] error:', r.error);
      }
    } else if (o.paymentGateway === 'binancepay') {
      const binancepay = require('../payments/binancepay');
      if (typeof binancepay.getStatus === 'function') {
        const r = await binancepay.getStatus(o.paymentGatewayRef);
        if (r.ok) {
          const st = String((r.data && (r.data.status || r.data.data && r.data.data.status)) || '').toUpperCase();
          statusLabel = st;
          paid = ['PAID', 'PAY_SUCCESS', 'SUCCESS', 'COMPLETED'].includes(st);
        }
      }
    }
  } catch (e) {
    console.error('[cekstatus] error:', e.message);
  }

  if (paid) {
    const { processPaidOrder } = require('../services/paymentProcessor');
    const b = bot || (ctx.telegram && { telegram: ctx.telegram });
    const result = await processPaidOrder(b, o._id, {
      gateway: o.paymentGateway,
      gatewayRef: o.paymentGatewayRef,
      actor: 'cekstatus:' + o.paymentGateway,
    });
    if (result.status === 'processed' || result.status === 'already') {
      // Provisioning starts and will edit THIS same message (invoice anchor).
      // Just show a brief callback toast; no new chat message.
      try { await ctx.answerCbQuery('✅ Pembayaran terkonfirmasi — memproses...', { show_alert: false }); } catch (_) {}
      return;
    }
  }

  // Still not paid — re-render the invoice screen so the user sees the QRIS again.
  try {
    if (statusLabel) {
      await ctx.answerCbQuery(`Status gateway: ${statusLabel || 'pending'}`).catch(() => {});
    }
  } catch (_) { /* ignore */ }
  return renderPayment(ctx, orderId);
}
