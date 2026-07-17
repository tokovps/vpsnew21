const mongoose = require('mongoose');

const DEFAULT_BANNER = 'https://files.catbox.moe/otlbu4.jpg';

const STRING_DEFAULTS = {
  qrisImage: DEFAULT_BANNER,

  homeBanner: DEFAULT_BANNER,
  paymentBanner: DEFAULT_BANNER,
  myOrdersBanner: DEFAULT_BANNER,

  // Tier banners (VPS)
  vpsLowBanner: DEFAULT_BANNER,
  vpsBasicBanner: DEFAULT_BANNER,
  vpsMediumBanner: DEFAULT_BANNER,
  // Tier banners (RDP)
  rdpLowBanner: DEFAULT_BANNER,
  rdpBasicBanner: DEFAULT_BANNER,
  rdpMediumBanner: DEFAULT_BANNER,

  homeCaption:
`🔥 *SELAMAT DATANG DI KANZ SHOP*
🥇 _Toko VPS & RDP Termurah_

_Silahkan Pilih Menu Dibawah:_`,

  // Home Manager — editable via Admin Panel → 🏠 Kelola Home
  // Home caption fields — SIMPLIFIED (2026-01):
  //   homeMenuPrompt & homeActivationOverride are the only two still used.
  //   homeTitle/homeSubtitle/homeFooter kept for backwards-compat with old
  //   installations but no longer rendered anywhere. Do not remove — some
  //   deployments may still hold data in these fields.
  homeTitle: '',
  homeSubtitle: '',
  homeFooter: '',
  homeMenuPrompt: 'Silakan Pilih Menu Dibawah 👇',
  homeActivationOverride: '', // if empty → pakai ETA dinamis dari catalogService

  paymentCaption:
`💳 *PEMBAYARAN QRIS*

Silakan scan QRIS di atas dan transfer sesuai total tagihan.
Setelah transfer, klik tombol *Kirim Bukti Transfer*.`,

  myOrdersCaption: `📋 *PESANAN SAYA*\n\n_Pesanan aktif Anda:_`,

  // VPS tier captions
  vpsLowCaption: `🖥️ *VPS LOW*\n\n_Paket VPS hemat. Garansi 7 hari._`,
  vpsBasicCaption: `🖥️ *VPS BASIC*\n\n_Paket VPS standar. Garansi 10 hari._`,
  vpsMediumCaption: `🖥️ *VPS MEDIUM*\n\n_Paket VPS performa tinggi. Garansi 15 hari._`,
  // RDP tier captions
  rdpLowCaption: `💻 *RDP LOW*\n\n_Paket RDP hemat. Garansi 7 hari._`,
  rdpBasicCaption: `💻 *RDP BASIC*\n\n_Paket RDP standar. Garansi 10 hari._`,
  rdpMediumCaption: `💻 *RDP MEDIUM*\n\n_Paket RDP performa tinggi. Garansi 15 hari._`,

  // Spec descriptions (shared across tiers within a category)
  vpsSpec1: `2GB RAM\n2 CPU\n60GB SSD\n3TB BW`,
  vpsSpec2: `4GB RAM\n2 CPU\n80GB SSD\n4TB BW`,
  vpsSpec3: `8GB RAM\n4 CPU\n160GB SSD\n5TB BW`,
  rdpSpec1: `4GB RAM\n2 CPU\n60GB SSD\n3TB BW`,
  rdpSpec2: `8GB RAM\n4 CPU\n80GB SSD\n4TB BW`,
  rdpSpec3: `16GB RAM\n8 CPU\n160GB SSD\n5TB BW`,

  // Caption-only scopes
  contactAdminCaption: `📞 *CS ADMIN*\n\nKlik tombol di bawah untuk chat admin secara langsung.`,
  joinChannelCaption:
`⚠️ Anda harus bergabung dengan channel/group wajib berikut untuk menggunakan bot ini.

Setelah bergabung, silakan klik tombol *✅ Saya Sudah Join* di bawah ini.`,
  successPaymentCaption:
`✅ *Pembayaran diterima.*

Pesanan sedang diproses oleh admin. Mohon ditunggu, admin akan menghubungi Anda.`,
  rejectPaymentCaption:
`🚫 *Pembayaran Anda ditolak.*

Silakan hubungi admin jika ada pertanyaan atau ingin melakukan pembayaran ulang.`,
  processingOrderCaption:
`⚙️ *Pesanan Anda sedang diproses.*

Mohon ditunggu, admin akan segera menyelesaikan pesanan Anda.`,

  // Garansi & Replace text (per tier)
  tierWarrantyLow: '7 Hari',
  tierWarrantyBasic: '10 Hari',
  tierWarrantyMedium: '15 Hari',
  tierReplace: '1x Replace selama masa garansi', // LEGACY — fallback bila per-paket kosong
  // Replace Text PER PAKET (VPS/RDP × LOW/BASIC/MEDIUM). Kosong = pakai legacy tierReplace.
  vpsLowReplace: '',
  vpsBasicReplace: '',
  vpsMediumReplace: '',
  rdpLowReplace: '',
  rdpBasicReplace: '',
  rdpMediumReplace: '',

  // Join gate
  joinGateEnabled: 'off', // 'on' | 'off'

  // Multi payment (toggle 'on'/'off' + image + caption per method)
  payQrisEnabled: 'on',
  payDanaEnabled: 'off',
  payDanaImage: DEFAULT_BANNER,
  payDanaCaption: '💳 *PEMBAYARAN DANA*\n\nTransfer ke nomor DANA berikut, lalu kirim bukti.',
  payOvoEnabled: 'off',
  payOvoImage: DEFAULT_BANNER,
  payOvoCaption: '💳 *PEMBAYARAN OVO*\n\nTransfer ke nomor OVO berikut, lalu kirim bukti.',
  payGopayEnabled: 'off',
  payGopayImage: DEFAULT_BANNER,
  payGopayCaption: '💳 *PEMBAYARAN GOPAY*\n\nTransfer ke nomor GoPay berikut, lalu kirim bukti.',

  // Receipt channel: '@username' atau numeric -100... Bot harus jadi admin di channel.
  receiptChannel: '',

  // ===== NEW: Global toggles for enterprise features =====
  autoProvisionEnabled: 'off',           // Turn on Full Auto VPS Provisioning globally
  defaultLanguage: 'id',                 // 'id' | 'en'
  exchangeMode: 'manual',                // 'manual' | 'auto'
  exchangeProvider: 'exchangerate-api',  // provider key
  exchangeApiKey: '',                    // free tier of exchangerate-api works without key too
  exchangeLastSyncAt: '',
  exchangeLastError: '',
  baseCurrency: 'USD',
  defaultCurrency: 'IDR',                // fallback if user has none
  passwordExcludeAmbiguous: 'on',        // 'on' | 'off'
  vpsHealthCheckEnabled: 'on',           // 'on' | 'off' — polling loop

  // ===== Catalog channel (auto-updated single-message post) =====
  catalogChannelId: '',                  // '@username' or numeric '-100...'
  catalogMessageId: '',                  // stored as string; empty when never posted yet
  // ═══ Post Stok — dedicated channel & per-category last-message tracking.
  // Kalau `stokChannelId` kosong, fallback ke `catalogChannelId` supaya admin
  // yang sudah men-set channel di catalog tidak perlu set ulang.
  stokChannelId: '',                     // '@username' or '-100...' (opsional; fallback catalogChannelId)
  stokLastMsgIdVps: '',                  // message_id (string) postingan terakhir VPS untuk dihapus
  stokLastMsgIdRdp: '',                  // message_id (string) postingan terakhir RDP untuk dihapus
};

// Additional booleans stored as string 'on'/'off' for consistency with existing pattern
// (currently informational — actual field types are String via STRING_DEFAULTS)
// const BOOL_ISH_KEYS = ['autoProvisionEnabled'];

// Per-tier prices. Each (category, tier, slot) memiliki harga sendiri.
// Default 0 → admin wajib mengisi manual via Admin Panel.
const TIER_PRICE_DEFAULTS = (() => {
  const out = {};
  for (const cat of ['vps', 'rdp']) {
    for (const tier of ['Low', 'Basic', 'Medium']) {
      for (const slot of [1, 2, 3]) {
        out[`${cat}${tier}Price${slot}`] = 0;
      }
    }
  }
  return out;
})();

const NUMBER_DEFAULTS = {
  ...TIER_PRICE_DEFAULTS,
  autoCancelMinutes: 30,
  // Credential Manager
  passwordLength: 12,                    // 8/10/12/16/24
  // Auto Health Check (VPS)
  healthCheckIntervalMinutes: 15,        // 5/10/15/30/60/custom
  // Admin activity notification auto-delete (seconds). 0 = never delete.
  adminNotifyTTL: 30,
};

// Array (list) defaults — editable by admin
const ARRAY_DEFAULTS = {
  vpsRegions: ['Singapore', 'New York', 'San Francisco', 'Amsterdam', 'London', 'Frankfurt', 'Toronto', 'Bangalore', 'Sydney', 'Atlanta'],
  rdpRegions: ['Singapore', 'New York', 'San Francisco', 'Amsterdam', 'London', 'Frankfurt', 'Toronto', 'Bangalore', 'Sydney', 'Atlanta'],
  vpsOsFamilies: ['Ubuntu', 'Debian', 'CentOS', 'AlmaLinux', 'Fedora', 'RockyLinux'],
  rdpWindowsVersions: [
    'Windows Server 2012 R2',
    'Windows 10 Original',
    'Windows 10 Superlite',
    'Windows 10 All In One',
    'Tiny10',
    'Windows 11 Original',
    'Windows 11 Superlite',
    'Windows 11 All In One',
    'Tiny11',
  ],
  rdpLinuxVersions: [
    'Ubuntu 22.04 LTS',
    'Ubuntu 24.04 LTS',
    'Debian 12',
    'Debian 13',
    'Linux Mint',
    'Pop OS',
    'Kali Linux',
  ],
  // Channel/Group wajib join. Format per item: '@username' atau 't.me/+abc' atau '-100xxxxxxxxx|@channelDisplay'
  requiredChannels: [],
};

// Map: family name -> list of versions (VPS)
const MIXED_DEFAULTS = {
  vpsOsVersions: {
    Ubuntu: ['Ubuntu 22.04', 'Ubuntu 24.04', 'Ubuntu 25.04'],
    Debian: ['Debian 11', 'Debian 12', 'Debian 13'],
    CentOS: ['CentOS 7', 'CentOS Stream 8', 'CentOS Stream 9'],
    AlmaLinux: ['AlmaLinux 8', 'AlmaLinux 9'],
    Fedora: ['Fedora 39', 'Fedora 40', 'Fedora 41'],
    RockyLinux: ['Rocky Linux 8', 'Rocky Linux 9'],
  },
};

const fields = { key: { type: String, default: 'global', unique: true } };
for (const k of Object.keys(STRING_DEFAULTS)) fields[k] = { type: String, default: STRING_DEFAULTS[k] };
for (const k of Object.keys(NUMBER_DEFAULTS)) fields[k] = { type: Number, default: NUMBER_DEFAULTS[k] };
for (const k of Object.keys(ARRAY_DEFAULTS)) fields[k] = { type: [String], default: () => [...ARRAY_DEFAULTS[k]] };
for (const k of Object.keys(MIXED_DEFAULTS)) fields[k] = { type: mongoose.Schema.Types.Mixed, default: () => JSON.parse(JSON.stringify(MIXED_DEFAULTS[k])) };

const settingSchema = new mongoose.Schema(fields, { timestamps: true, minimize: false });

module.exports = mongoose.model('Setting', settingSchema);
module.exports.STRING_DEFAULTS = STRING_DEFAULTS;
module.exports.NUMBER_DEFAULTS = NUMBER_DEFAULTS;
module.exports.ARRAY_DEFAULTS = ARRAY_DEFAULTS;
module.exports.MIXED_DEFAULTS = MIXED_DEFAULTS;
