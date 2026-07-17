// Loading label resolver — map callback data (prefix) to a friendly loading
// text shown via ctx.answerCbQuery popup while the actual handler renders.
// Kept intentionally small & centralised so all callbacks feel responsive.

// Ordered rules: first matching prefix (string) or RegExp wins.
const RULES = [
  // ============ USER ============
  ['menu:home',        '🏠 Memuat Beranda...'],
  ['menu:vps',         '☁️ Menyiapkan katalog VPS...'],
  ['menu:rdp',         '🖥 Menyiapkan katalog RDP...'],
  ['menu:orders',      '📦 Memuat data pesanan...'],
  ['menu:contact',     '📞 Memuat CS...'],
  ['menu:settings',    '⚙️ Memuat Settings...'],
  [/^tier:/,           '📋 Memuat produk...'],
  [/^spec:/,           '🧩 Memuat spesifikasi...'],
  [/^reg:/,            '🌍 Memuat region...'],
  [/^osf:/,            '💿 Memuat OS...'],
  [/^osv:/,            '💿 Memuat versi OS...'],
  [/^rdpos:/,          '💿 Memuat OS RDP...'],
  [/^rdpv:/,           '💿 Memuat versi...'],
  [/^am:/,             '🔐 Menyiapkan otentikasi...'],
  [/^back:/,           '↩️ Kembali...'],
  ['confirm:order',    '📝 Membuat pesanan...'],
  [/^order:/,          '📄 Memuat detail pesanan...'],
  [/^pay:/,            '💳 Memeriksa pembayaran...'],
  [/^cancel:/,         '🚫 Membatalkan...'],
  [/^pm:/,             '💳 Menyiapkan pembayaran...'],
  [/^chgmethod:/,      '🔁 Mengganti metode...'],
  [/^u:cur:/,          '💱 Menyimpan mata uang...'],
  [/^u:lang:/,         '🌐 Menyimpan bahasa...'],

  // ============ REWARD (USER) ============
  ['rw:menu',          '🎁 Memuat Reward...'],
  [/^rw:claim:/,       '🎁 Memproses klaim...'],
  ['rf:menu',          '👥 Memuat Referral...'],
  ['rf:detail',        '👥 Memuat Detail Referral...'],
  [/^ach:/,            '🏅 Memuat Achievement...'],
  [/^lb:/,             '🏆 Mengambil Leaderboard...'],
  ['pf:show',          '👤 Memuat Profil...'],
  ['pf:share',         '🔗 Menyiapkan share...'],

  // ============ ADMIN ============
  ['a:home',           '🏠 Memuat Admin Panel...'],
  ['a:dashboard',      '📊 Memuat Dashboard...'],
  ['a:close',          '❎ Menutup panel...'],
  [/^a:banner:/,       '🖼 Memuat Banner...'],
  [/^a:caption:/,      '✏️ Memuat Caption...'],
  [/^a:price:/,        '💰 Memuat Harga...'],
  [/^a:spec:/,         '🧩 Memuat Spesifikasi...'],
  ['a:broadcast',      '📢 Menyiapkan Broadcast...'],
  [/^a:list:/,         '📋 Memuat Daftar...'],
  [/^a:osv:/,          '💿 Memuat OS Versi...'],
  [/^a:txt:/,          '✏️ Memuat Teks...'],
  [/^a:success:/,      '✅ Memproses sukses...'],
  [/^a:cred:/,         '🔑 Menyiapkan kredensial...'],
  ['a:adv:menu',       '⚙️ Memuat Advanced...'],
  ['a:autocancel',     '⏱ Memuat Auto Cancel...'],
  [/^a:receipt/,       '🧾 Memuat Channel Resi...'],
  [/^a:catalog:/,      '📚 Memuat Katalog...'],
  ['a:content:menu',   '🎨 Memuat Content...'],
  ['a:users:menu',     '👥 Memuat Data User...'],
  [/^a:credmgr/,       '🔐 Memuat Credential Manager...'],
  [/^a:pm:/,           '💳 Memuat Metode Pembayaran...'],
  [/^a:gate:/,         '🚪 Memuat Join Gate...'],
  [/^a:notifttl/,      '🔔 Memuat Notif TTL...'],

  // VPS mgmt admin
  ['v:home',           '☁️ Memuat VPS Management...'],
  [/^v:list:/,         '📋 Memuat daftar VPS...'],
  [/^v:d:/,            '📄 Memuat detail VPS...'],
  [/^v:a:refresh/,     '🔄 Menyegarkan status...'],
  [/^v:a:reboot/,      '🔁 Reboot VPS...'],
  [/^v:a:stop/,        '⏹ Menghentikan VPS...'],
  [/^v:a:start/,       '▶️ Menyalakan VPS...'],
  [/^v:a:delete/,      '🗑 Menghapus VPS...'],
  ['v:search',         '🔍 Menyiapkan pencarian...'],
  [/^v:hc/,            '❤️ Memuat Health Check...'],

  // RDP orders admin
  ['r:home',           '🖥 Memuat RDP Orders...'],
  [/^r:list:/,         '📋 Memuat daftar pesanan...'],
  [/^r:d:/,            '📄 Memuat detail pesanan...'],
  [/^r:proc:/,         '⚙️ Memproses pesanan...'],
  [/^r:send:/,         '📤 Menyiapkan pengiriman...'],
  [/^r:confirm:/,      '✅ Mengkonfirmasi...'],
  [/^r:cancel:/,       '🚫 Membatalkan...'],

  // Enterprise (providers, currency, i18n, backup, queue, audit)
  ['e:home',           '🏢 Memuat Enterprise...'],
  ['e:autoprov:tog',   '☁️ Menyimpan Auto Provision...'],
  ['e:prov:menu',      '☁️ Memuat Provider...'],
  [/^e:prov:add:/,     '🔑 Menyiapkan penambahan API...'],
  ['e:prov:list',      '📋 Memuat daftar API...'],
  [/^e:prov:api:/,     '📄 Memuat detail API...'],
  [/^e:prov:tog:/,     '🔁 Menyimpan status...'],
  [/^e:prov:hc:/,      '❤️ Memeriksa Health...'],
  [/^e:prov:del:/,     '🗑 Menghapus API...'],
  ['e:prov:healthall', '❤️ Health Check semua Provider...'],
  ['e:prov:reseterr',  '🔄 Reset error counters...'],
  ['e:pay:menu',       '💳 Memuat Payment Config...'],
  [/^e:pay:cfg:/,      '💳 Memuat konfigurasi...'],
  [/^e:pay:tog:/,      '🔁 Menyimpan status gateway...'],
  [/^e:pay:field:/,    '✏️ Memuat field...'],
  [/^e:pay:test:/,     '🧪 Menguji gateway...'],
  ['e:pay:monitor',    '📡 Memuat monitor webhook...'],
  ['e:cur:menu',       '💱 Memuat Currency...'],
  [/^e:cur:/,          '💱 Memproses Currency...'],
  ['e:lang:menu',      '🌐 Memuat Language...'],
  [/^e:lang:/,         '🌐 Memproses Language...'],
  ['e:dash:providers', '📊 Memuat Dashboard Provider...'],
  [/^e:queue:/,        '📥 Memuat Queue...'],
  [/^e:audit:/,        '🗂 Memuat Audit Log...'],
  [/^e:bak:/,          '💾 Memuat Backup...'],

  // Admin Reward Center
  ['a:rw:home',        '🎁 Memuat Reward Center...'],
  ['a:rw:dash',        '📊 Memuat Reward Dashboard...'],
  ['a:rw:loyalty',     '🎁 Memuat Loyalty...'],
  ['a:rw:referral',    '👥 Memuat Referral Config...'],
  [/^a:rw:loyalty:/,   '🎁 Memproses Loyalty...'],
  [/^a:rw:referral:/,  '👥 Memproses Referral...'],
  ['a:rw:badges',      '🏅 Memuat Badges...'],
  [/^a:rw:badges/,     '🏅 Memproses Badge...'],
  ['a:rw:frames',      '🖼 Memuat Frames...'],
  [/^a:rw:frames/,     '🖼 Memproses Frame...'],
  ['a:rw:settings',    '⚙️ Memuat Reward Settings...'],
  [/^a:rw:settings/,   '⚙️ Memproses setting...'],
  [/^a:rw:users/,      '👥 Memuat data user...'],
  [/^a:rw:user:/,      '👤 Memproses user...'],
  [/^a:rw:history/,    '🗂 Memuat riwayat...'],
  ['a:rw:lb',          '🏆 Memuat Leaderboard...'],

  // Join gate
  ['joingate:check',   '🔎 Memverifikasi keanggotaan...'],
];

// Callbacks that should NOT be pre-answered by middleware.
// Reason: their handler needs to send an ALERT (show_alert:true) which requires
// answerCbQuery not to have been consumed.
const SKIP_PREFIXES = ['joingate:', 'menu:vps', 'menu:rdp'];

function shouldSkip(data) {
  if (!data) return true;
  return SKIP_PREFIXES.some(p => data === p || data.startsWith(p));
}

function labelFor(data) {
  if (!data) return '⏳ Memproses...';
  for (const [pat, txt] of RULES) {
    if (typeof pat === 'string') { if (data === pat || data.startsWith(pat)) return txt; }
    else if (pat.test(data)) return txt;
  }
  return '⏳ Memproses...';
}

module.exports = { labelFor, shouldSkip };
