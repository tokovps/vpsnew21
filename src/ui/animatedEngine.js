// ================================================================
// ANIMATED UI ENGINE — global click → animate → transition → render
// ----------------------------------------------------------------
// Purpose: make the Telegram bot feel like an Android app. Every
// callback the user taps runs through this engine BEFORE the real
// handler executes. The engine plays a 3-frame progress-bar animation
// on the SAME message (edit-only, no chat spam) and then hands off to
// the handler which produces the final page.
//
// Retrofit strategy (do NOT invent a new UI stack):
//   • Global `bot.use()` middleware in Bot.js registers this engine.
//   • Uses telegram.editMessageCaption / editMessageText already used
//     everywhere via utils/safeEdit.js — same underlying primitives.
//   • Skips a small allow-list of callbacks (noop, joingate:*, quick
//     alert-style buttons) so alerts still surface via answerCbQuery.
//
// The engine is fire-and-await: middleware awaits the animation so
// the perceived flow is: tap → progress → done → next page. Total
// budget ≈ 800ms (3 frames × ~260ms). Skew short so the bot still
// feels snappy.
// ================================================================

const FRAMES = [
  { bar: '▱□□□□□□□□□', label: '🔄 Memuat menu...' },
  { bar: '▰▰▰▰▱□□□□□', label: '📦 Menyiapkan halaman...' },
  { bar: '▰▰▰▰▰▰▰▰▱□', label: '✨ Hampir selesai...' },
];
const FINAL_FRAME = { bar: '▰▰▰▰▰▰▰▰▰▰', label: '✅ Berhasil' };

const FRAME_DELAY_MS = Number(process.env.ANIM_FRAME_MS || 260);
const SHOW_FINAL_FRAME_MS = Number(process.env.ANIM_FINAL_MS || 180);

// Callbacks that must NOT animate (need instant popup / no visual pause).
const SKIP_EXACT = new Set([
  'noop',
  'joingate:check',
]);
const SKIP_PREFIX = [
  // Prefixes for interactive text-input answers where a redraw would race
  // the user's typing. Keep this list tight — the animation is desirable
  // almost everywhere else.
];

function shouldSkipAnimation(data) {
  if (!data) return true;
  if (SKIP_EXACT.has(data)) return true;
  for (const p of SKIP_PREFIX) if (data.startsWith(p)) return true;
  return false;
}

// Titles inferred from the callback prefix so animation feels contextual
// (not just a generic "Loading"). Keeps overhead near zero — pure lookup.
const TITLE_MAP = [
  [/^menu:vps$/,               '☁️ BUY VPS'],
  [/^menu:rdp$/,               '🖥 BUY RDP'],
  [/^menu:orders$/,            '📦 PESANAN SAYA'],
  [/^menu:contact$/,           '📞 HUBUNGI ADMIN'],
  [/^menu:settings$/,          '⚙️ PENGATURAN'],
  [/^menu:home$/,              '🏠 BERANDA'],
  [/^tier:/,                   '📋 MEMILIH PAKET'],
  [/^spec:/,                   '🧾 KONFIRMASI SPEC'],
  [/^reg:/,                    '🌍 MEMILIH REGION'],
  [/^osf:|^osv:|^rdpos:|^rdpv:/, '💿 MEMILIH OS'],
  [/^am:/,                     '🔐 METODE AUTH'],
  [/^order:/,                  '📄 DETAIL PESANAN'],
  [/^pay:/,                    '💳 CEK PEMBAYARAN'],
  [/^cancel:/,                 '❌ MEMBATALKAN'],
  [/^pm:/,                     '💳 METODE PEMBAYARAN'],
  [/^chgmethod:/,              '🔄 GANTI METODE'],
  [/^confirm:/,                '✅ MEMPROSES...'],
  [/^rw:|^rf:|^ach:|^lb:|^pf:/, '🎁 REWARD & PROFILE'],
  [/^u:cur:|^u:lang:/,         '⚙️ PREFERENSI'],
  [/^a:home$/,                 '👑 DASHBOARD ADMIN'],
  [/^a:dashboard$/,            '📊 STATISTIK'],
  [/^a:stock:/,                '📦 STOCK MANAGER'],
  [/^a:stok:/,                 '📢 POST STOK'],
  [/^a:db:/,                   '🗄 DATABASE MANAGER'],
  [/^a:broadcast/,             '📢 BROADCAST'],
  [/^a:content:|^a:banner:|^a:caption:/, '🎨 CONTENT'],
  [/^a:price:/,                '💰 HARGA'],
  [/^a:spec:/,                 '🧩 SPEC'],
  [/^a:list:|^a:osv:/,         '🌍 REGION & OS'],
  [/^a:pm:/,                   '💳 PAYMENT METHOD'],
  [/^a:promo:/,                '🎉 PROMO'],
  [/^a:rw:/,                   '🏆 REWARD ADMIN'],
  [/^a:gate:/,                 '🚪 JOIN GATE'],
  [/^a:catalog:/,              '📢 CATALOG CHANNEL'],
  [/^a:adv:|^a:autocancel|^a:receipt|^a:notifttl|^a:credmgr|^a:home:/, '🔧 ADVANCED'],
  [/^a:users:/,                '👥 USER MANAGEMENT'],
  [/^a:success:|^a:cred:/,     '✅ AKSI PESANAN'],
  [/^v:/,                      '🖥 VPS MANAGEMENT'],
  [/^r:/,                      '🖥 RDP ORDERS'],
  [/^e:/,                      '🚀 ENTERPRISE'],
  [/^back:/,                   '⬅️ KEMBALI'],
];

function titleFor(data) {
  for (const [re, label] of TITLE_MAP) if (re.test(data)) return label;
  return '⏳ MEMBUKA MENU';
}

function buildFrame(title, frame) {
  return `━━━━━━━━━━━━━━━━━━
${title}
━━━━━━━━━━━━━━━━━━

${frame.label}
${frame.bar}

━━━━━━━━━━━━━━━━━━`;
}

// Edit either the message text or the caption (photo/video messages) in-place.
// Never sends a new message. Silent on "message is not modified" and any other
// transient error — animation is best-effort; if it fails, the handler's own
// final render still lands.
async function editFrame(ctx, text) {
  const msg = ctx.callbackQuery && ctx.callbackQuery.message;
  if (!msg) return false;
  const opts = { parse_mode: 'Markdown' };
  try {
    if (msg.photo || msg.video || msg.document) {
      await ctx.editMessageCaption(text, opts);
    } else {
      await ctx.editMessageText(text, opts);
    }
    return true;
  } catch (err) {
    const d = err && err.description || '';
    if (/message is not modified/i.test(d)) return true;
    // Any other error (e.g. can't-be-edited, parse_mode) — degrade silently.
    return false;
  }
}

async function playAnimation(ctx, data) {
  const title = titleFor(data);
  // First frame — if the first edit fails (e.g. anchor gone) skip the rest.
  const ok = await editFrame(ctx, buildFrame(title, FRAMES[0]));
  if (!ok) return false;
  await new Promise(r => setTimeout(r, FRAME_DELAY_MS));
  await editFrame(ctx, buildFrame(title, FRAMES[1]));
  await new Promise(r => setTimeout(r, FRAME_DELAY_MS));
  await editFrame(ctx, buildFrame(title, FRAMES[2]));
  await new Promise(r => setTimeout(r, FRAME_DELAY_MS));
  await editFrame(ctx, buildFrame(title, FINAL_FRAME));
  await new Promise(r => setTimeout(r, SHOW_FINAL_FRAME_MS));
  return true;
}

// Global Telegraf middleware.
// Sits AFTER loadingFeedback (which silences the popup) and BEFORE the
// handler chain. Marks ctx.state.animPlayed so downstream code can inspect.
function globalMiddleware() {
  return async (ctx, next) => {
    // Only intercept callback taps.
    if (!ctx.callbackQuery) return next();
    const data = ctx.callbackQuery.data || '';
    if (shouldSkipAnimation(data)) return next();
    // Feature flag — operators can disable via env if debugging.
    if (String(process.env.ANIM_DISABLED || '').toLowerCase() === '1') return next();
    try {
      await playAnimation(ctx, data);
      ctx.state.animPlayed = true;
    } catch (e) {
      // Never block the handler because of animation issues.
      console.warn('[anim] play error (non-fatal):', e && e.message);
    }
    return next();
  };
}

module.exports = {
  globalMiddleware,
  playAnimation,
  shouldSkipAnimation,
  titleFor,
  buildFrame,
  FRAMES,
  FINAL_FRAME,
};
