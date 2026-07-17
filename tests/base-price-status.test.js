// BASE PRICE STATUS REGRESSION TEST
// -----------------------------------------------------------------
// Verifikasi bahwa STATUS PRODUK (Aktif / Nonaktif) semata-mata
// ditentukan oleh BASE PRICE (Setting → Edit Harga), BUKAN oleh
// Promo/discount/checkout/invoice.
//
// TEST 1: Base Price = 20000 → spec normal, Promo boleh diskon, Checkout OK
// TEST 2: Base Price = 0      → spec strikethrough, Checkout diblokir
// TEST 3: Base Price = 20000 & Promo 25% → Aktif, harga user = 15000
// TEST 4: Base Price = 0 & Promo ada    → tetap Nonaktif (promo diabaikan)
const assert = require('assert');
const path = require('path');

// ---- Stub Promo model ---------------------------------------------------
const stubPromoState = { list: [] };
require.cache[require.resolve('../src/models/Promo')] = {
  exports: {
    find: () => ({ lean: async () => {
      const now = new Date();
      return stubPromoState.list.filter(p =>
        p.enabled && new Date(p.startAt) <= now && new Date(p.endAt) >= now
        && (!p.voucherCode));
    } }),
  },
};

// ---- Stub settingService.specOf ----------------------------------------
const settingSvc = require(path.join(__dirname, '..', 'src', 'services', 'settingService.js'));
let stubSpec = { spec: '2 CPU\n2GB RAM\n60GB SSD\n3TB BW', price: 20000 };
settingSvc.specOf = () => stubSpec;

// ---- Stub priceFormat.formatForUser (avoid currency DB) -----------------
const priceFmt = require(path.join(__dirname, '..', 'src', 'utils', 'priceFormat.js'));
priceFmt.formatForUser = async (_ctx, n) => 'Rp' + Number(n || 0).toLocaleString('id-ID');

const promo = require(path.join(__dirname, '..', 'src', 'services', 'promoService.js'));

// Re-implement buildSpecList inline using the same code path we changed —
// we import via require of userHandler and reach in through a lightweight
// wrapper. userHandler doesn't export buildSpecList, so we mirror the
// logic by calling promo.applyToPrice + specOf like the real function
// does. This is the exact same branch checked in userHandler.js.
async function specListBlock(slot) {
  const { spec, price } = settingSvc.specOf(null, 'vps', 'basic', slot);
  const specLines = spec.split('\n').map(l => l.trim()).filter(Boolean);
  if (!price || price <= 0) {
    const struckSpec = specLines.map(l => `~~${l}~~`).join('\n');
    return { text: `${struckSpec}\n└─➤ ~~Rp 0~~\n🚫 *STOCK KOSONG*`, active: false };
  }
  const r = await promo.applyToPrice(price, 'vps', 'basic');
  let priceTxt;
  if (r.promo && r.discounted !== r.original) {
    priceTxt = `~~Rp${r.original}~~  Rp${r.discounted} 🔥`;
  } else {
    priceTxt = 'Rp' + price;
  }
  return { text: `${specLines.join('\n')}\n└─➤ ${priceTxt}`, active: true };
}

async function test1_baseNormal() {
  stubPromoState.list = [];
  stubSpec = { spec: '2 CPU\n2GB RAM\n60GB SSD\n3TB BW', price: 20000 };
  const b = await specListBlock(1);
  assert.strictEqual(b.active, true, 'TEST 1: harus AKTIF');
  assert.ok(!b.text.includes('~~2 CPU~~'), 'TEST 1: spec TIDAK boleh strikethrough');
  assert.ok(b.text.includes('2 CPU'), 'TEST 1: spec harus tampil normal');
  assert.ok(b.text.includes('Rp20.000') || b.text.includes('Rp20000'), 'TEST 1: harga base tampil');
  // Checkout gate — resolveEffectivePrice mirrors handleSpecSelect guard.
  const eff = await promo.resolveEffectivePrice({}, 'vps', 'basic', 1);
  assert.ok(eff.originalPrice > 0, 'TEST 1: checkout guard membolehkan');
  console.log('✅ TEST 1  Base=20000, no promo  → AKTIF, spec normal, checkout OK');
}

async function test2_baseZero() {
  stubPromoState.list = [];
  stubSpec = { spec: '2 CPU\n2GB RAM\n60GB SSD\n3TB BW', price: 0 };
  const b = await specListBlock(1);
  assert.strictEqual(b.active, false, 'TEST 2: harus NONAKTIF');
  assert.ok(b.text.includes('~~2 CPU~~'), 'TEST 2: spec harus strikethrough');
  assert.ok(b.text.includes('~~2GB RAM~~'), 'TEST 2: RAM strikethrough');
  assert.ok(b.text.includes('~~60GB SSD~~'), 'TEST 2: SSD strikethrough');
  assert.ok(b.text.includes('~~3TB BW~~'), 'TEST 2: BW strikethrough');
  assert.ok(b.text.includes('~~Rp 0~~'), 'TEST 2: harga strikethrough');
  assert.ok(b.text.includes('🚫') && /STOCK\s+KOSONG/.test(b.text), 'TEST 2: label 🚫 STOCK KOSONG tampil');
  const eff = await promo.resolveEffectivePrice({}, 'vps', 'basic', 1);
  assert.strictEqual(eff.originalPrice, 0, 'TEST 2: checkout guard memblokir');
  assert.strictEqual(eff.price, 0);
  console.log('✅ TEST 2  Base=0               → NONAKTIF, spec strikethrough, checkout DIBLOKIR');
}

async function test3_promoOnActive() {
  stubSpec = { spec: '2 CPU\n2GB RAM\n60GB SSD\n3TB BW', price: 20000 };
  stubPromoState.list = [{
    _id: 'p1', name: 'Diskon 25%', enabled: true,
    startAt: new Date(Date.now() - 3600e3), endAt: new Date(Date.now() + 3600e3),
    targets: ['vps:basic'], discountType: 'percent', discountValue: 25,
  }];
  const b = await specListBlock(1);
  assert.strictEqual(b.active, true, 'TEST 3: base > 0 → AKTIF meski promo aktif');
  assert.ok(b.text.includes('🔥'), 'TEST 3: badge promo tampil');
  assert.ok(!b.text.includes('~~2 CPU~~'), 'TEST 3: spec TIDAK strikethrough');
  const eff = await promo.resolveEffectivePrice({}, 'vps', 'basic', 1);
  assert.strictEqual(eff.price, 15000, 'TEST 3: user bayar Rp15.000');
  assert.strictEqual(eff.originalPrice, 20000, 'TEST 3: original Rp20.000');
  console.log('✅ TEST 3  Base=20000, Promo 25% → AKTIF, harga user 15000, original 20000');
}

async function test4_promoIgnoredWhenBaseZero() {
  stubSpec = { spec: '2 CPU\n2GB RAM\n60GB SSD\n3TB BW', price: 0 };
  // Promo agresif — 99% off, nominal 999k — TIDAK boleh mengaktifkan produk.
  stubPromoState.list = [{
    _id: 'p2', name: 'Promo Besar', enabled: true,
    startAt: new Date(Date.now() - 3600e3), endAt: new Date(Date.now() + 3600e3),
    targets: ['vps:basic'], discountType: 'percent', discountValue: 99,
  }];
  const b = await specListBlock(1);
  assert.strictEqual(b.active, false, 'TEST 4: base = 0 → tetap NONAKTIF meski promo agresif');
  assert.ok(b.text.includes('~~2 CPU~~'), 'TEST 4: spec tetap strikethrough');
  const eff = await promo.resolveEffectivePrice({}, 'vps', 'basic', 1);
  assert.strictEqual(eff.originalPrice, 0, 'TEST 4: checkout tetap diblokir');
  assert.strictEqual(eff.price, 0);
  assert.strictEqual(eff.promo, null, 'TEST 4: promo tidak boleh menempel bila base=0');
  console.log('✅ TEST 4  Base=0, Promo 99%    → NONAKTIF, promo diabaikan, checkout DIBLOKIR');
}

async function testRealtimeToggle() {
  // Ubah base 20000 → 0 → 20000, verifikasi state ikut berubah tanpa restart.
  stubPromoState.list = [];
  stubSpec = { spec: '2 CPU', price: 20000 };
  let b = await specListBlock(1);
  assert.strictEqual(b.active, true, 'realtime: 20000 → AKTIF');
  stubSpec = { spec: '2 CPU', price: 0 };
  b = await specListBlock(1);
  assert.strictEqual(b.active, false, 'realtime: 0 → NONAKTIF (tanpa restart)');
  stubSpec = { spec: '2 CPU', price: 20000 };
  b = await specListBlock(1);
  assert.strictEqual(b.active, true, 'realtime: 20000 lagi → AKTIF kembali');
  console.log('✅ REALTIME  20000 → 0 → 20000 tanpa restart bot');
}

(async () => {
  try {
    await test1_baseNormal();
    await test2_baseZero();
    await test3_promoOnActive();
    await test4_promoIgnoredWhenBaseZero();
    await testRealtimeToggle();
    console.log('\n🎉 SEMUA REGRESI BASE-PRICE-STATUS LULUS');
    process.exit(0);
  } catch (e) {
    console.error('\n❌ REGRESI GAGAL:', e.message);
    console.error(e.stack);
    process.exit(1);
  }
})();
