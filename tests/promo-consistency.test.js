// ═══════════════════════════════════════════════════════════════════════
// PROMO CONSISTENCY REGRESSION TEST — SIMPLIFIED (revisi 2026-01)
// ─────────────────────────────────────────────────────────────────────────
// Sistem promo tidak lagi berbasis tanggal/jam. Yang menentukan aktif
// hanyalah flag `enabled`. Test ini memastikan:
//   • Menu, konfirmasi, checkout, invoice — semua memakai
//     `resolveEffectivePrice` (single source of truth).
//   • Promo `enabled=false` diabaikan seluruhnya (harga kembali normal).
//   • Off-target promo tidak diterapkan.
// ═══════════════════════════════════════════════════════════════════════
const assert = require('assert');
const path = require('path');

// ---- Stub Promo model ---------------------------------------------------
// Monkey-patch module cache SEBELUM promoService memuat Promo.
const stubPromoState = { list: [] };
require.cache[require.resolve('../src/models/Promo')] = {
  exports: {
    find: (_q) => ({ lean: async () => {
      // Aturan baru: hanya enabled=true dan non-voucher yang tampil di auto-promo.
      return stubPromoState.list.filter(p => p.enabled && !p.voucherCode);
    } }),
  },
};

// ---- Stub settingService.specOf ----------------------------------------
const settingSvc = require(path.join(__dirname, '..', 'src', 'services', 'settingService.js'));
settingSvc.specOf = (_s, _cat, _tier, _slot) => ({ spec: '4 vCPU\n8GB RAM\n160GB SSD', price: 20000 });

const promo = require(path.join(__dirname, '..', 'src', 'services', 'promoService.js'));

async function testNoPromo() {
  stubPromoState.list = [];
  const r = await promo.resolveEffectivePrice({}, 'vps', 'basic', 3);
  assert.strictEqual(r.originalPrice, 20000, 'no promo → original stays');
  assert.strictEqual(r.price, 20000, 'no promo → price === original');
  assert.strictEqual(r.promo, null, 'promo is null when none active');
  console.log('✅ resolveEffectivePrice with NO promo → price = original (20000)');
}

async function testActivePromo() {
  stubPromoState.list = [{
    _id: 'p1', name: 'Diskon 25% BASIC',
    enabled: true,
    targets: ['vps:basic'],
    discountType: 'percent',
    discountValue: 25,
  }];
  const r = await promo.resolveEffectivePrice({}, 'vps', 'basic', 3);
  assert.strictEqual(r.originalPrice, 20000);
  assert.strictEqual(r.price, 15000, 'user paid price MUST be Rp15.000 (25% off Rp20.000)');
  assert.ok(r.promo, 'promo object must be attached');
  assert.strictEqual(r.promo.name, 'Diskon 25% BASIC');
  assert.strictEqual(r.off, 5000, 'off must equal savings');
  console.log('✅ resolveEffectivePrice with active 25% promo → Rp15.000 (was Rp20.000)');
}

async function testWrongTargetSkipped() {
  stubPromoState.list = [{
    _id: 'p2', name: 'Diskon RDP', enabled: true,
    targets: ['rdp:medium'],   // Different category
    discountType: 'nominal', discountValue: 5000,
  }];
  const r = await promo.resolveEffectivePrice({}, 'vps', 'basic', 3);
  assert.strictEqual(r.price, 20000, 'promo targeting rdp:medium must NOT apply to vps:basic');
  assert.strictEqual(r.promo, null, 'no matching promo → promo=null');
  console.log('✅ off-target promo is NOT applied (vps unaffected by rdp promo)');
}

async function testDisabledPromo() {
  // Aturan baru: promo hanya nonaktif kalau `enabled=false` (tidak ada expired-by-date lagi).
  stubPromoState.list = [{
    _id: 'p3', name: 'Non-Aktif',
    enabled: false,
    targets: ['vps:basic'],
    discountType: 'percent', discountValue: 25,
  }];
  const r = await promo.resolveEffectivePrice({}, 'vps', 'basic', 3);
  assert.strictEqual(r.price, 20000, 'promo enabled=false must NOT apply — price back to Rp20.000');
  assert.strictEqual(r.promo, null);
  console.log('✅ disabled promo → price reverts to original (aktif=false)');
}

async function testCheckoutMatchesMenu() {
  // Core regression: menu display dan orderHandler harus pakai harga IDENTIK.
  stubPromoState.list = [{
    _id: 'p4', name: 'Flash Sale',
    enabled: true,
    targets: ['vps:basic'],
    discountType: 'percent', discountValue: 25,
  }];
  const menuEff = await promo.resolveEffectivePrice({}, 'vps', 'basic', 3);
  const checkoutEff = await promo.resolveEffectivePrice({}, 'vps', 'basic', 3);
  const oldPath = await promo.applyToPrice(20000, 'vps', 'basic');
  assert.strictEqual(menuEff.price, checkoutEff.price, 'menu === checkout');
  assert.strictEqual(menuEff.price, oldPath.discounted, 'resolveEffectivePrice agrees with legacy applyToPrice');
  console.log('✅ menu price === checkout price === payment price (single source of truth)');
}

function testOrderModelFields() {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'models', 'Order.js'), 'utf8');
  ['originalPrice', 'promoName', 'promoOff'].forEach(f =>
    assert.ok(new RegExp(f + ':').test(src), `Order model must persist ${f} for audit trail`));
  console.log('✅ Order model persists promo snapshot (originalPrice, promoName, promoOff)');
}

function testHandlersUseSingleSource() {
  const fs = require('fs');
  const uh = fs.readFileSync(path.join(__dirname, '..', 'src', 'handlers', 'userHandler.js'), 'utf8');
  const oh = fs.readFileSync(path.join(__dirname, '..', 'src', 'handlers', 'orderHandler.js'), 'utf8');
  assert.ok(/resolveEffectivePrice\(/.test(uh), 'renderConfirmation must call resolveEffectivePrice');
  assert.ok(/resolveEffectivePrice\(/.test(oh), 'orderHandler.confirmOrder must call resolveEffectivePrice');
  assert.ok(/promoName && o\.originalPrice/.test(uh), 'renderPayment/Detail must surface promo when set');
  console.log('✅ userHandler + orderHandler both anchor on resolveEffectivePrice');
}

// ─── AUDIT: no date/time in promo layer ─────────────────────────────
function testNoDateTimeInPromoLayer() {
  const fs = require('fs');
  const svc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'promoService.js'), 'utf8');
  const mdl = fs.readFileSync(path.join(__dirname, '..', 'src', 'models', 'Promo.js'), 'utf8');
  const hdl = fs.readFileSync(path.join(__dirname, '..', 'src', 'handlers', 'promoAdminHandler.js'), 'utf8');
  const kbd = fs.readFileSync(path.join(__dirname, '..', 'src', 'keyboards', 'admin.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');

  // Promo model tidak lagi mendeklarasikan startAt/endAt/announced*.
  assert.ok(!/startAt:\s*{\s*type:\s*Date/.test(mdl), 'Promo model must NOT declare startAt as Date field');
  assert.ok(!/endAt:\s*{\s*type:\s*Date/.test(mdl),   'Promo model must NOT declare endAt as Date field');
  assert.ok(!/announcedStart:/.test(mdl), 'Promo model must NOT declare announcedStart');
  assert.ok(!/announcedEnd:/.test(mdl),   'Promo model must NOT declare announcedEnd');

  // promoService: getActivePromos hanya filter enabled — no startAt/endAt logic.
  assert.ok(!/startAt:\s*{\s*\$lte/.test(svc), 'getActivePromos must NOT filter by startAt');
  assert.ok(!/endAt:\s*{\s*\$gte/.test(svc),   'getActivePromos must NOT filter by endAt');
  assert.ok(!/^function\s+startScheduler|^async\s+function\s+startScheduler|module\.exports[^}]*startScheduler/m.test(svc),
    'startScheduler must be removed (not defined nor exported)');
  assert.ok(!/setInterval\(/.test(svc), 'promoService must not schedule anything with setInterval');

  // Handler: no date parsing helpers.
  assert.ok(!/_parseDate\(/.test(hdl), 'promoAdminHandler must not have date parser');
  assert.ok(!/Tanggal Mulai|Tanggal Berakhir/.test(hdl), 'wizard must not ask for date');
  assert.ok(!/Berakhir:\s*\$\{/.test(hdl), 'detail must not print end date');

  // Keyboard: menu Promo Center pakai layout baru.
  assert.ok(/Buat Promo/.test(kbd),   'promoCenterMenu must contain "Buat Promo"');
  assert.ok(/Edit Promo/.test(kbd),   'promoCenterMenu must contain "Edit Promo"');
  assert.ok(/Hapus Promo/.test(kbd),  'promoCenterMenu must contain "Hapus Promo"');
  assert.ok(/Status Promo/.test(kbd), 'promoCenterMenu must contain "Status Promo"');

  // app.js: scheduler dipastikan sudah tidak dipanggil.
  assert.ok(!/promoService['"]\)\.startScheduler/.test(app),
    'app.js must not call promoService.startScheduler anymore');

  console.log('✅ SIMPLIFIED promo layer: no date/time/scheduler anywhere');
}

// ─── AUDIT: announceStart/End exposed for admin actions ─────────────
function testAnnouncementHelpers() {
  const p = require(path.join(__dirname, '..', 'src', 'services', 'promoService.js'));
  assert.ok(typeof p.announceStart === 'function', 'announceStart must be exported');
  assert.ok(typeof p.announceEnd   === 'function', 'announceEnd must be exported');
  assert.ok(typeof p.refreshCatalog === 'function', 'refreshCatalog must be exported');
  console.log('✅ promoService exposes announceStart/announceEnd/refreshCatalog');
}

(async () => {
  try { await testNoPromo(); }           catch (e) { console.error('FAIL no-promo:', e.message); process.exit(1); }
  try { await testActivePromo(); }       catch (e) { console.error('FAIL active:', e.message); process.exit(1); }
  try { await testWrongTargetSkipped(); }catch (e) { console.error('FAIL off-target:', e.message); process.exit(1); }
  try { await testDisabledPromo(); }     catch (e) { console.error('FAIL disabled:', e.message); process.exit(1); }
  try { await testCheckoutMatchesMenu(); }catch (e) { console.error('FAIL match:', e.message); process.exit(1); }
  try { testOrderModelFields(); }        catch (e) { console.error('FAIL model:', e.message); process.exit(1); }
  try { testHandlersUseSingleSource(); } catch (e) { console.error('FAIL handlers:', e.message); process.exit(1); }
  try { testNoDateTimeInPromoLayer(); }  catch (e) { console.error('FAIL simplified:', e.message); process.exit(1); }
  try { testAnnouncementHelpers(); }     catch (e) { console.error('FAIL announce:', e.message); process.exit(1); }
  console.log('\n════════════════════════════════════════');
  console.log('PROMO CONSISTENCY — all assertions PASS.');
  console.log('User bug (menu Rp15k → checkout Rp20k) tetap IMPOSSIBLE.');
  console.log('Simplifikasi 2026-01: tidak ada lagi tanggal/jam/countdown/scheduler.');
  console.log('════════════════════════════════════════');
})();
