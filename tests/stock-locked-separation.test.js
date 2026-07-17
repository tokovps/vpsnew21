// STOCK vs TOKEN-LOCKED SEPARATION — REGRESSION TEST
// -----------------------------------------------------------------
// Bug lama: provider dengan status='LOCKED' (sedang jalankan install
// Windows) TIDAK dihitung sebagai stock, sehingga menu Home menampilkan
// "VPS:0 RDP:0" dan tombol BUY memunculkan "STOCK KOSONG" padahal
// quotaAvailable masih ada.
//
// Fix: stock = SUM(quotaAvailable) untuk provider READY + LOCKED yang
// enabled. Bila stock > 0 tapi seluruh provider LOCKED → allBusy=true
// → user diarahkan ke halaman ANTRIAN, bukan STOCK KOSONG.
const assert = require('assert');

// Stub ProviderApi model BEFORE require catalogService.
const stubProviders = { rows: [] };
require.cache[require.resolve('../src/models/ProviderApi')] = {
  exports: {
    countDocuments: async () => stubProviders.rows.filter(r => r.enabled && r.status === 'READY').length,
    find: (filter, proj) => ({
      lean: async () => {
        // Mimic $in for status
        const statusIn = filter.status && filter.status.$in;
        return stubProviders.rows.filter(r => {
          if (filter.enabled !== undefined && r.enabled !== filter.enabled) return false;
          if (typeof filter.status === 'string' && r.status !== filter.status) return false;
          if (statusIn && !statusIn.includes(r.status)) return false;
          return true;
        }).map(r => ({ status: r.status, quotaAvailable: r.quotaAvailable }));
      },
    }),
  },
};

// Stub queue
require.cache[require.resolve('../src/queues/provisionQueue')] = {
  exports: { provisionQueue: { stats: () => ({ running: 0, pending: 0 }) } },
};

// Stub settingService (catalogService imports specOf etc.)
require.cache[require.resolve('../src/services/settingService')] = {
  exports: { getSettings: async () => ({}), updateSetting: async () => {}, specOf: () => ({ spec: '', price: 0 }) },
};

const catalog = require('../src/services/catalogService');

async function test_lockedCountsAsStock() {
  // Skenario: 3 provider — semua LOCKED (install Windows berjalan) tapi
  // masing-masing masih punya quotaAvailable=2. Total stock harus 6.
  stubProviders.rows = [
    { enabled: true, status: 'LOCKED', quotaAvailable: 2 },
    { enabled: true, status: 'LOCKED', quotaAvailable: 2 },
    { enabled: true, status: 'LOCKED', quotaAvailable: 2 },
  ];
  const st = await catalog.getBuyMenuStock();
  assert.strictEqual(st.stock, 6, 'Stock harus 6 walau semua LOCKED');
  assert.strictEqual(st.allBusy, true, 'allBusy=true → user masuk antrean');
  assert.strictEqual(st.lockedProviders, 3);
  assert.strictEqual(st.readyProviders, 0);
  console.log('✅ LOCKED ≠ STOCK HABIS  → Home tetap tampil VPS/RDP: 6');
}

async function test_mixedReadyAndLocked() {
  // 2 READY, 1 LOCKED — ada slot langsung siap → allBusy=false
  stubProviders.rows = [
    { enabled: true, status: 'READY',  quotaAvailable: 3 },
    { enabled: true, status: 'READY',  quotaAvailable: 2 },
    { enabled: true, status: 'LOCKED', quotaAvailable: 1 },
  ];
  const st = await catalog.getBuyMenuStock();
  assert.strictEqual(st.stock, 6);
  assert.strictEqual(st.allBusy, false, 'ada READY → user langsung boleh checkout');
  assert.strictEqual(st.readyProviders, 2);
  assert.strictEqual(st.lockedProviders, 1);
  console.log('✅ Mixed READY+LOCKED    → stock=6, tidak ada antrean');
}

async function test_trulyEmpty() {
  // Semua provider QUOTA_FULL → stock = 0 → STOCK KOSONG, bukan antrean
  stubProviders.rows = [
    { enabled: true, status: 'QUOTA_FULL', quotaAvailable: 0 },
    { enabled: true, status: 'ERROR',      quotaAvailable: 0 },
    { enabled: true, status: 'SUSPENDED',  quotaAvailable: 0 },
    { enabled: false, status: 'READY',     quotaAvailable: 5 }, // disabled, ignore
  ];
  const st = await catalog.getBuyMenuStock();
  assert.strictEqual(st.stock, 0);
  assert.strictEqual(st.allBusy, false, 'stock=0 → bukan antrean, tapi STOCK KOSONG');
  console.log('✅ Stock benar-benar 0   → STOCK KOSONG (bukan antrean)');
}

async function test_errorStatusExcluded() {
  // Provider ERROR tetap tidak dihitung — LOCKED saja yang di-whitelist bersama READY.
  stubProviders.rows = [
    { enabled: true, status: 'ERROR', quotaAvailable: 5 },
    { enabled: true, status: 'LOCKED', quotaAvailable: 3 },
  ];
  const st = await catalog.getBuyMenuStock();
  assert.strictEqual(st.stock, 3, 'hanya LOCKED yang dihitung, ERROR diabaikan');
  assert.strictEqual(st.allBusy, true, 'satu-satunya provider LOCKED → antrean');
  console.log('✅ ERROR/SUSPENDED tetap dikecualikan');
}

async function test_realtimeUnlock() {
  // Simulasi realtime: LOCKED → setelah install selesai → READY. Stock tetap 6
  // (angka tidak berubah), tapi allBusy berubah dari true → false.
  stubProviders.rows = [
    { enabled: true, status: 'LOCKED', quotaAvailable: 2 },
    { enabled: true, status: 'LOCKED', quotaAvailable: 2 },
    { enabled: true, status: 'LOCKED', quotaAvailable: 2 },
  ];
  let st = await catalog.getBuyMenuStock();
  assert.strictEqual(st.allBusy, true);
  // Salah satu provider selesai install → READY dengan quota berkurang 1.
  stubProviders.rows[0].status = 'READY';
  stubProviders.rows[0].quotaAvailable = 1;
  st = await catalog.getBuyMenuStock();
  assert.strictEqual(st.stock, 5, 'stock update realtime (2+2+1)');
  assert.strictEqual(st.allBusy, false, 'setelah salah satu unlock → boleh checkout');
  console.log('✅ Realtime: LOCKED → READY memperbarui allBusy tanpa restart');
}

(async () => {
  try {
    await test_lockedCountsAsStock();
    await test_mixedReadyAndLocked();
    await test_trulyEmpty();
    await test_errorStatusExcluded();
    await test_realtimeUnlock();
    console.log('\n🎉 SEMUA REGRESI STOCK vs LOCKED LULUS');
    process.exit(0);
  } catch (e) {
    console.error('\n❌ REGRESI GAGAL:', e.message, '\n', e.stack);
    process.exit(1);
  }
})();
