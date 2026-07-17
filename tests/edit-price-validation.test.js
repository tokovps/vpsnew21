// EDIT-HARGA VALIDATION REGRESSION TEST
// -----------------------------------------------------------------
// Sesuai revisi: menu "Edit Harga" WAJIB menerima 0 dan semua angka
// non-negatif; wajib menolak negatif, huruf, karakter khusus, kosong.
const assert = require('assert');

// Replicate the exact validation branch in adminHandler.js:
function validateEditPriceInput(text) {
  const raw = String(text || '').trim();
  if (!/^\d+$/.test(raw)) return { ok: false, reason: 'format' };
  const price = parseInt(raw, 10);
  if (!Number.isFinite(price) || price < 0) return { ok: false, reason: 'range' };
  return { ok: true, price };
}

const cases = [
  { input: '0',       expect: { ok: true, price: 0 } },
  { input: '1',       expect: { ok: true, price: 1 } },
  { input: '5000',    expect: { ok: true, price: 5000 } },
  { input: '20000',   expect: { ok: true, price: 20000 } },
  { input: ' 0 ',     expect: { ok: true, price: 0 } },      // trim whitespace
  { input: '-1',      expect: { ok: false } },               // negatif
  { input: '-100',    expect: { ok: false } },
  { input: 'abc',     expect: { ok: false } },               // huruf
  { input: '@',       expect: { ok: false } },               // karakter khusus
  { input: '10a',     expect: { ok: false } },               // mixed
  { input: '',        expect: { ok: false } },               // kosong
  { input: null,      expect: { ok: false } },               // null
  { input: undefined, expect: { ok: false } },
  { input: '  ',      expect: { ok: false } },
  { input: '1.5',     expect: { ok: false } },               // desimal ditolak (integer only)
];

let pass = 0, fail = 0;
for (const c of cases) {
  const r = validateEditPriceInput(c.input);
  const okMatch = r.ok === c.expect.ok;
  const priceMatch = !c.expect.ok || r.price === c.expect.price;
  const label = (JSON.stringify(c.input) || 'undefined').padEnd(14);
  if (okMatch && priceMatch) {
    console.log(`✅ input=${label} → ${r.ok ? 'PASS('+r.price+')' : 'FAIL('+r.reason+')'}`);
    pass++;
  } else {
    console.error(`❌ input=${JSON.stringify(c.input)} → got ${JSON.stringify(r)}, expected ${JSON.stringify(c.expect)}`);
    fail++;
  }
}

console.log(`\nSummary: ${pass} PASS / ${fail} FAIL`);
if (fail) process.exit(1);
console.log('🎉 SEMUA VALIDASI EDIT-HARGA LULUS');
