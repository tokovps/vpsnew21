const { Markup } = require('telegraf');

// Grouped, categorized admin main menu.
// Layout final (audit 2026-01, duplikat dihapus, dikelompokkan per kategori):
//
//   📊 Dashboard
//   📦 Product Management   • 🎨 Content
//   ☁ VPS Management       • 🖥 RDP Management
//   🌐 Provider Management  • 💳 Payment Center
//   🎉 Promo Center         • 🏆 Reward Center
//   👥 User Management      • 📢 Broadcast
//   📢 Post Stok            • 🏠 Kelola Home
//   🛠 Maintenance Mode     • ⚙ Settings
//   🚀 Enterprise Panel     • 🗄 Database Manager
//   ❌ Close
const adminMenu = () => Markup.inlineKeyboard([
  [Markup.button.callback('📊 Dashboard', 'a:dashboard')],
  [Markup.button.callback('📦 Product Management', 'a:price:menu'),
   Markup.button.callback('🎨 Content', 'a:content:menu')],
  [Markup.button.callback('☁ VPS Management', 'v:home'),
   Markup.button.callback('🖥 RDP Management', 'r:home')],
  [Markup.button.callback('🌐 Provider Management', 'e:prov:menu'),
   Markup.button.callback('💳 Payment Center', 'e:pay:menu')],
  [Markup.button.callback('🎉 Promo Center', 'a:promo:home'),
   Markup.button.callback('🏆 Reward Center', 'a:rw:home')],
  [Markup.button.callback('👥 User Management', 'a:users:menu'),
   Markup.button.callback('📢 Broadcast', 'a:broadcast')],
  [Markup.button.callback('📢 Post Stok', 'a:stok:menu'),
   Markup.button.callback('🏠 Kelola Home', 'a:home:mgr')],
  [Markup.button.callback('🛠 Maintenance Mode', 'a:maint:menu'),
   Markup.button.callback('⚙ Settings', 'a:adv:menu')],
  [Markup.button.callback('🚀 Enterprise Panel', 'e:home'),
   Markup.button.callback('🗄 Database Manager', 'a:db:menu')],
  [Markup.button.callback('❌ Close', 'a:close')],
]);

const adminBack = () => Markup.inlineKeyboard([
  [Markup.button.callback('⬅️ Back', 'a:home'), Markup.button.callback('❌ Cancel', 'a:close')],
]);

// Cancel-only keyboard for text-input prompt screens. `returnTo` = callback
// route to bounce back to when admin taps Cancel (stay on same context page).
const cancelKb = (returnTo = 'a:home') => Markup.inlineKeyboard([
  [Markup.button.callback('❌ Batal', returnTo)],
]);

// ===== Promo Center — SIMPLIFIED (revisi 2026-01) =====
// Tidak ada lagi menu berbau tanggal/jam/countdown/expired.
// Layout final: Buat / Edit / Hapus / Status / Kembali (+ voucher variant).
const promoCenterMenu = () => Markup.inlineKeyboard([
  [Markup.button.callback('📢 Buat Promo', 'a:promo:add'),
   Markup.button.callback('🎟 Voucher Diskon', 'a:promo:add:voucher')],
  [Markup.button.callback('📝 Edit Promo', 'a:promo:edit:list'),
   Markup.button.callback('🗑 Hapus Promo', 'a:promo:del:list')],
  [Markup.button.callback('📊 Status Promo', 'a:promo:list:active')],
  [Markup.button.callback('⬅️ Kembali', 'a:home')],
]);

// Home Manager — simplified 2026-01. Only realtime-relevant controls remain.
// Judul/Deskripsi/Footer removed from home caption per user's redesign, so
// their edit buttons are gone too (dead callbacks cleaned up).
const homeManageMenu = () => Markup.inlineKeyboard([
  [Markup.button.callback('🖼 Banner Home', 'a:banner:home')],
  [Markup.button.callback('✏️ Teks Menu Prompt', 'a:home:e:homeMenuPrompt')],
  [Markup.button.callback('⚡ Override Estimasi Aktivasi', 'a:home:e:homeActivationOverride')],
  [Markup.button.callback('⬅️ Back', 'a:home')],
]);

// Content (banner + caption) grouping menu
const contentMenu = () => Markup.inlineKeyboard([
  [Markup.button.callback('🖼 Banners', 'a:banner:menu')],
  [Markup.button.callback('📝 Captions', 'a:caption:menu')],
  [Markup.button.callback('⬅️ Back', 'a:home')],
]);

const bannerMenu = () => Markup.inlineKeyboard([
  [Markup.button.callback('🖼 Home', 'a:banner:home')],
  [Markup.button.callback('🖼 VPS LOW', 'a:banner:vpsLow'), Markup.button.callback('🖼 VPS BASIC', 'a:banner:vpsBasic'), Markup.button.callback('🖼 VPS MEDIUM', 'a:banner:vpsMedium')],
  [Markup.button.callback('🖼 RDP LOW', 'a:banner:rdpLow'), Markup.button.callback('🖼 RDP BASIC', 'a:banner:rdpBasic'), Markup.button.callback('🖼 RDP MEDIUM', 'a:banner:rdpMedium')],
  [Markup.button.callback('🖼 Payment', 'a:banner:payment'), Markup.button.callback('🖼 Orders', 'a:banner:orders')],
  [Markup.button.callback('⬅️ Back', 'a:content:menu')],
]);

const captionMenu = () => Markup.inlineKeyboard([
  [Markup.button.callback('📝 Home', 'a:caption:home')],
  [Markup.button.callback('📝 VPS LOW', 'a:caption:vpsLow'), Markup.button.callback('📝 VPS BASIC', 'a:caption:vpsBasic'), Markup.button.callback('📝 VPS MED', 'a:caption:vpsMedium')],
  [Markup.button.callback('📝 RDP LOW', 'a:caption:rdpLow'), Markup.button.callback('📝 RDP BASIC', 'a:caption:rdpBasic'), Markup.button.callback('📝 RDP MED', 'a:caption:rdpMedium')],
  [Markup.button.callback('📝 Payment', 'a:caption:payment'), Markup.button.callback('📝 Orders', 'a:caption:orders')],
  [Markup.button.callback('📝 CS Admin', 'a:caption:contactAdmin'), Markup.button.callback('📝 Join Channel', 'a:caption:joinChannel')],
  [Markup.button.callback('📝 Success Pay', 'a:caption:successPayment'), Markup.button.callback('📝 Reject Pay', 'a:caption:rejectPayment')],
  [Markup.button.callback('⬅️ Back', 'a:content:menu')],
]);

const priceMenu = () => Markup.inlineKeyboard([
  [Markup.button.callback('💰 Kelola Harga VPS', 'a:price:c:vps')],
  [Markup.button.callback('💰 Kelola Harga RDP', 'a:price:c:rdp')],
  [Markup.button.callback('📝 Ubah Spesifikasi', 'a:spec:menu')],
  [Markup.button.callback('🌍 Region / OS / Versi', 'a:list:menu')],
  [Markup.button.callback('⬅️ Back', 'a:home')],
]);

const priceTierMenu = (category) => Markup.inlineKeyboard([
  [Markup.button.callback('🔹 LOW',    `a:price:t:${category}:low`)],
  [Markup.button.callback('🔸 BASIC',  `a:price:t:${category}:basic`)],
  [Markup.button.callback('🔶 MEDIUM', `a:price:t:${category}:medium`)],
  [Markup.button.callback('⬅️ Back', 'a:price:menu')],
]);

const priceSlotMenu = (category, tier) => Markup.inlineKeyboard([
  [Markup.button.callback('💰 Spec 1', `a:price:e:${category}:${tier}:1`)],
  [Markup.button.callback('💰 Spec 2', `a:price:e:${category}:${tier}:2`)],
  [Markup.button.callback('💰 Spec 3', `a:price:e:${category}:${tier}:3`)],
  [Markup.button.callback('⬅️ Back', `a:price:c:${category}`)],
]);

const specMenu = () => Markup.inlineKeyboard([
  [Markup.button.callback('📝 VPS Spec 1', 'a:spec:e:vps:1'), Markup.button.callback('📝 VPS Spec 2', 'a:spec:e:vps:2'), Markup.button.callback('📝 VPS Spec 3', 'a:spec:e:vps:3')],
  [Markup.button.callback('📝 RDP Spec 1', 'a:spec:e:rdp:1'), Markup.button.callback('📝 RDP Spec 2', 'a:spec:e:rdp:2'), Markup.button.callback('📝 RDP Spec 3', 'a:spec:e:rdp:3')],
  [Markup.button.callback('⬅️ Back', 'a:price:menu')],
]);

const listMenu = () => Markup.inlineKeyboard([
  [Markup.button.callback('🌍 Region VPS', 'a:list:vpsRegions'), Markup.button.callback('🌍 Region RDP', 'a:list:rdpRegions')],
  [Markup.button.callback('💿 OS VPS (Family)', 'a:list:vpsOsFamilies')],
  [Markup.button.callback('📦 Versi OS VPS', 'a:osv:menu')],
  [Markup.button.callback('🪟 Versi Windows RDP', 'a:list:rdpWindowsVersions')],
  [Markup.button.callback('🐧 Versi Linux RDP', 'a:list:rdpLinuxVersions')],
  [Markup.button.callback('🛡 Garansi LOW', 'a:txt:tierWarrantyLow'), Markup.button.callback('🛡 BASIC', 'a:txt:tierWarrantyBasic'), Markup.button.callback('🛡 MEDIUM', 'a:txt:tierWarrantyMedium')],
  [Markup.button.callback('🔁 Replace Text', 'a:rep:menu')],
  [Markup.button.callback('⬅️ Back', 'a:price:menu')],
]);

const osvFamilyMenu = (families) => {
  const rows = families.map((f, i) => [Markup.button.callback(`📦 ${f}`, `a:osv:fam:${i}`)]);
  rows.push([Markup.button.callback('⬅️ Back', 'a:list:menu')]);
  return Markup.inlineKeyboard(rows);
};

// Replace-Text per paket — daftar paket VPS/RDP × LOW/BASIC/MEDIUM.
const replaceMenu = () => Markup.inlineKeyboard([
  [Markup.button.callback('☁ VPS LOW',    'a:rep:e:vps:low'),
   Markup.button.callback('☁ VPS BASIC',  'a:rep:e:vps:basic'),
   Markup.button.callback('☁ VPS MEDIUM', 'a:rep:e:vps:medium')],
  [Markup.button.callback('🖥 RDP LOW',    'a:rep:e:rdp:low'),
   Markup.button.callback('🖥 RDP BASIC',  'a:rep:e:rdp:basic'),
   Markup.button.callback('🖥 RDP MEDIUM', 'a:rep:e:rdp:medium')],
  [Markup.button.callback('⬅️ Back', 'a:list:menu')],
]);

const adminApproved = (orderId) => Markup.inlineKeyboard([
  [Markup.button.callback('📝 Kirim Kredensial', `a:cred:${orderId}`)],
  [Markup.button.callback('✅ Tandai Success', `a:success:${orderId}`)],
]);

const advancedMenu = () => Markup.inlineKeyboard([
  [Markup.button.callback('🔐 Credential Manager', 'a:credmgr:menu')],
  [Markup.button.callback('📢 Channel Wajib Join', 'a:gate:menu')],
  [Markup.button.callback('🧾 Channel Resi', 'a:receipt')],
  [Markup.button.callback('📣 Catalog Channel', 'a:catalog:menu')],
  [Markup.button.callback('⏰ Auto-Cancel Order', 'a:autocancel')],
  [Markup.button.callback('🔔 Admin Notify TTL', 'a:notifttl:menu')],
  [Markup.button.callback('⬅️ Back', 'a:home')],
]);
// Note (audit 2026-01): `❤️ Health Check Settings` (v:hc:settings) DIHAPUS
// dari Settings karena duplikat dengan tombol yang sama di menu
// `☁ VPS Management` (v:home). Callback tetap valid — tombolnya masih ada
// di VPS Management (konteks yang lebih tepat untuk health-check VPS).

const catalogMenu = (s) => Markup.inlineKeyboard([
  [Markup.button.callback('✏️ Set Channel ID', 'a:catalog:set')],
  [Markup.button.callback('🔄 Refresh Katalog Sekarang', 'a:catalog:refresh')],
  [Markup.button.callback('♻️ Reset Message ID (post ulang)', 'a:catalog:reset')],
  [Markup.button.callback('⬅️ Back', 'a:adv:menu')],
]);
// Note (audit 2026-01): dua tombol "Update Stock VPS/RDP" dengan callback
// `a:stock:vps` / `a:stock:rdp` dihapus dari menu ini karena TIDAK memiliki
// handler yang terdaftar di Bot.js (dead buttons). Fungsi "post stok ke
// channel" sudah tersedia lengkap via menu utama `📢 Post Stok`
// (`a:stok:menu` → `a:stok:post:vps` / `a:stok:post:rdp`) yang punya
// handler valid + preview + delete.

const credMgrMenu = (s) => {
  const rows = [8, 10, 12, 16, 24].map(n => [
    Markup.button.callback(`${s.passwordLength === n ? '✅ ' : ''}${n} karakter`, `a:credmgr:len:${n}`),
  ]);
  rows.push([Markup.button.callback(
    (s.passwordExcludeAmbiguous === 'on' ? '✅ ' : '❌ ') + 'Exclude Ambiguous (O/0, l/I/1)',
    'a:credmgr:amb',
  )]);
  rows.push([Markup.button.callback('⬅️ Back', 'a:adv:menu')]);
  return Markup.inlineKeyboard(rows);
};

const paymentMethodsMenu = (methods) => {
  const rows = methods.map(m => [
    Markup.button.callback(`${m.enabled ? '✅' : '❌'} ${m.label}`, `a:pm:${m.key}`),
  ]);
  rows.push([Markup.button.callback('⬅️ Back', 'a:adv:menu')]);
  return Markup.inlineKeyboard(rows);
};

const paymentMethodEdit = (m) => Markup.inlineKeyboard([
  [Markup.button.callback(m.enabled ? '🔴 Nonaktifkan' : '🟢 Aktifkan', `a:pm:${m.key}:tog`)],
  [Markup.button.callback('🖼 Edit Gambar', `a:pm:${m.key}:img`)],
  [Markup.button.callback('📝 Edit Caption', `a:pm:${m.key}:cap`)],
  [Markup.button.callback('⬅️ Back', 'a:pm:menu')],
]);

const gateMenu = (enabled) => Markup.inlineKeyboard([
  [Markup.button.callback(enabled ? '🔴 Nonaktifkan Gate' : '🟢 Aktifkan Gate', 'a:gate:tog')],
  [Markup.button.callback('📋 Edit Daftar Channel', 'a:gate:list')],
  [Markup.button.callback('⬅️ Back', 'a:adv:menu')],
]);

const postStokMenu = () => Markup.inlineKeyboard([
  [Markup.button.callback('🚀 Post Stok VPS', 'a:stok:post:vps'),
   Markup.button.callback('🖥 Post Stok RDP', 'a:stok:post:rdp')],
  [Markup.button.callback('📝 Atur Channel', 'a:stok:setchan')],
  [Markup.button.callback('👀 Preview VPS', 'a:stok:prev:vps'),
   Markup.button.callback('👀 Preview RDP', 'a:stok:prev:rdp')],
  [Markup.button.callback('🗑 Hapus Postingan VPS', 'a:stok:del:vps'),
   Markup.button.callback('🗑 Hapus Postingan RDP', 'a:stok:del:rdp')],
  [Markup.button.callback('🔙 Kembali', 'a:home')],
]);

// ═══ Database Manager — Super Admin only ══════════════════════════════
const dbManagerMenu = () => Markup.inlineKeyboard([
  [Markup.button.callback('📊 Status Database', 'a:db:status')],
  [Markup.button.callback('🔄 Migrasi Database', 'a:db:migrate:ask')],
  [Markup.button.callback('📥 Backup Database', 'a:db:backup')],
  [Markup.button.callback('📤 Restore Database', 'a:db:restore:list')],
  [Markup.button.callback('🧪 Test Koneksi', 'a:db:test:ask')],
  [Markup.button.callback('🔙 Kembali', 'a:home')],
]);
const dbMigrateConfirmMenu = () => Markup.inlineKeyboard([
  [Markup.button.callback('✅ Ya, Pakai Database Baru', 'a:db:switch:yes')],
  [Markup.button.callback('❌ Tidak, Tetap Pakai Yang Lama', 'a:db:menu')],
]);
const dbMigrateForceMenu = () => Markup.inlineKeyboard([
  [Markup.button.callback('⚠️ Ya, Override Target', 'a:db:migrate:force')],
  [Markup.button.callback('❌ Batal', 'a:db:menu')],
]);

module.exports = {
  adminMenu, adminBack, cancelKb, contentMenu, bannerMenu, captionMenu, homeManageMenu, promoCenterMenu,
  priceMenu, priceTierMenu, priceSlotMenu, specMenu, catalogMenu,
  listMenu, osvFamilyMenu, replaceMenu,
  adminApproved, advancedMenu, credMgrMenu,
  paymentMethodsMenu, paymentMethodEdit, gateMenu,
  postStokMenu,
  dbManagerMenu, dbMigrateConfirmMenu, dbMigrateForceMenu,
};
