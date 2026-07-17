// REPLACE-TEXT PER PAKET REGRESSION TEST
// -----------------------------------------------------------------
// Verifikasi bahwa Replace Text sekarang bekerja PER PAKET
// (vps/rdp × low/basic/medium), bukan global. Fallback ke legacy
// `tierReplace` bila field per-paket kosong.
const assert = require('assert');
const { replaceOf } = require('../src/services/settingService');

// TEST 1-3: per-paket terisi → dipakai apa adanya
function testPerTier() {
  const s = {
    tierReplace: 'GLOBAL LEGACY',
    vpsLowReplace:    '1x',
    vpsBasicReplace:  '1x',
    vpsMediumReplace: '2x',
    rdpLowReplace:    '1x',
    rdpBasicReplace:  '1x',
    rdpMediumReplace: '2x',
  };
  assert.strictEqual(replaceOf(s, 'vps', 'low'),    '1x', 'TEST 1: VPS LOW = 1x');
  assert.strictEqual(replaceOf(s, 'vps', 'basic'),  '1x', 'VPS BASIC = 1x');
  assert.strictEqual(replaceOf(s, 'vps', 'medium'), '2x', 'TEST 2: VPS MEDIUM = 2x');
  assert.strictEqual(replaceOf(s, 'rdp', 'low'),    '1x', 'RDP LOW = 1x');
  assert.strictEqual(replaceOf(s, 'rdp', 'basic'),  '1x', 'TEST 3: RDP BASIC = 1x');
  assert.strictEqual(replaceOf(s, 'rdp', 'medium'), '2x', 'RDP MEDIUM = 2x');
  console.log('✅ TEST 1-3  Replace PER PAKET dibaca sesuai (category, tier)');
}

// TEST 4: perubahan realtime — admin ubah vpsMediumReplace, panggilan berikut mendapat nilai baru
function testRealtime() {
  const s = { tierReplace: 'GLOBAL', vpsMediumReplace: '2x' };
  assert.strictEqual(replaceOf(s, 'vps', 'medium'), '2x');
  s.vpsMediumReplace = '3x';
  assert.strictEqual(replaceOf(s, 'vps', 'medium'), '3x',
    'TEST 4: setelah admin ubah → langsung berlaku tanpa restart');
  console.log('✅ TEST 4  Realtime: perubahan Replace langsung berlaku');
}

// TEST 5: fallback ke legacy tierReplace bila per-paket kosong (backwards compat)
function testFallback() {
  const s = { tierReplace: 'FALLBACK GLOBAL' };
  assert.strictEqual(replaceOf(s, 'vps', 'low'),    'FALLBACK GLOBAL');
  assert.strictEqual(replaceOf(s, 'rdp', 'medium'), 'FALLBACK GLOBAL');
  const s2 = { tierReplace: 'FB', vpsBasicReplace: '' }; // string kosong → fallback juga
  assert.strictEqual(replaceOf(s2, 'vps', 'basic'), 'FB');
  const s3 = { tierReplace: 'FB', vpsBasicReplace: '   ' }; // whitespace-only → fallback
  assert.strictEqual(replaceOf(s3, 'vps', 'basic'), 'FB');
  console.log('✅ TEST 5  Fallback ke legacy tierReplace bila per-paket kosong');
}

// TEST 6: isolasi paket — mengubah VPS MEDIUM TIDAK mempengaruhi VPS LOW/BASIC
function testIsolation() {
  const s = {
    tierReplace: 'G',
    vpsLowReplace: '1x', vpsBasicReplace: '1x', vpsMediumReplace: '2x',
  };
  assert.strictEqual(replaceOf(s, 'vps', 'low'), '1x');
  s.vpsMediumReplace = '5x';
  assert.strictEqual(replaceOf(s, 'vps', 'low'), '1x', 'TEST 6: LOW tidak berubah');
  assert.strictEqual(replaceOf(s, 'vps', 'basic'), '1x', 'BASIC tidak berubah');
  assert.strictEqual(replaceOf(s, 'vps', 'medium'), '5x', 'MEDIUM ikut berubah');
  console.log('✅ TEST 6  Isolasi paket: perubahan MEDIUM tidak mempengaruhi LOW/BASIC');
}

// TEST 7: null / undefined settings — tidak throw
function testNoGlobal() {
  const s = {};
  assert.strictEqual(replaceOf(s, 'vps', 'low'), '');
  console.log('✅ TEST 7  Tanpa setting → return string kosong (aman)');
}

try {
  testPerTier();
  testRealtime();
  testFallback();
  testIsolation();
  testNoGlobal();
  console.log('\n🎉 SEMUA REGRESI REPLACE-PER-PAKET LULUS');
  process.exit(0);
} catch (e) {
  console.error('\n❌ REGRESI GAGAL:', e.message);
  process.exit(1);
}
