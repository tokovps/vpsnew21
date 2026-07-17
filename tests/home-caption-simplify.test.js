// HOME CAPTION SIMPLIFICATION TEST
// Verifies:
//   • Simplified caption only shows STATUS + STOCK + prompt (no welcome,
//     no promo block, no user info, no bot info, no footer).
//   • Banner still separate (photo message body — untouched).
//   • Realtime numbers still surfaced.
//   • Dead admin buttons (Judul/Deskripsi/Footer) removed.
//   • Callback regex narrowed so orphan callbacks don't leak.
const assert = require('assert');
const path = require('path');
const fs = require('fs');

// Stub catalog + PaymentConfig so we can build the caption without Mongo.
require.cache[require.resolve('../src/services/catalogService')] = {
  exports: {
    getStock: async () => ({ ready: 7, etaLine: 'Estimasi Aktivasi : ±1 Menit' }),
  },
};
require.cache[require.resolve('../src/models/PaymentConfig')] = {
  exports: { countDocuments: async () => 1 },
};
// Stub settingService to avoid Mongo touch.
const settingSvc = require(path.join(__dirname, '..', 'src', 'services', 'settingService.js'));
settingSvc.getSettings = async () => ({
  homeMenuPrompt: 'Silakan Pilih Menu Dibawah 👇',
  homeActivationOverride: '',
  homeTitle: 'IGNORED-should-not-appear',
  homeSubtitle: 'IGNORED-should-not-appear',
  homeFooter: 'IGNORED-should-not-appear',
});

const { buildHomeCaption } = require(path.join(__dirname, '..', 'src', 'services', 'homeCaptionService.js'));

async function testCaptionShape() {
  const caption = await buildHomeCaption({ from: { id: 1, first_name: 'X' } });
  // MUST include the 3 required sections.
  assert.ok(/STATUS LAYANAN/.test(caption), 'must include STATUS LAYANAN');
  assert.ok(/STOCK READY/.test(caption), 'must include STOCK READY');
  assert.ok(/Silakan Pilih Menu Dibawah/.test(caption), 'must include menu prompt');
  assert.ok(/☁\s*VPS\s*:.*Online/.test(caption), 'VPS status Online');
  assert.ok(/🖥\s*RDP\s*:.*Online/.test(caption), 'RDP status Online');
  assert.ok(/💳\s*Payment\s*:.*Online/.test(caption), 'Payment status Online');
  assert.ok(/☁\s*VPS\s*:\s*7/.test(caption), 'VPS stock realtime = 7');
  assert.ok(/🖥\s*RDP\s*:\s*7/.test(caption), 'RDP stock realtime = 7');
  assert.ok(/Estimasi Aktivasi\s*:\s*±1 Menit/.test(caption), 'ETA rendered');
  console.log('✅ caption contains STATUS + STOCK + prompt (all realtime)');
}

async function testCaptionExcludes() {
  const caption = await buildHomeCaption({ from: { id: 1 } });
  // MUST NOT include the removed sections.
  const forbidden = [
    /SELAMAT DATANG/i,
    /PROMO AKTIF/i,
    /INFORMASI USER/i,
    /INFORMASI BOT/i,
    /Total User/i,
    /Transaksi User/i,
    /Transaksi Sukses/i,
    /IGNORED-should-not-appear/,   // homeTitle/Subtitle/Footer values leaking
  ];
  for (const pat of forbidden) {
    assert.ok(!pat.test(caption), `caption must NOT contain ${pat}`);
  }
  console.log('✅ caption excludes Welcome / Promo block / User info / Bot info / Footer');
}

function testHomeManagerKeyboardCleaned() {
  const kb = require(path.join(__dirname, '..', 'src', 'keyboards', 'admin.js'));
  const cbs = kb.homeManageMenu().reply_markup.inline_keyboard.flat().map(b => b.callback_data);
  assert.ok(cbs.includes('a:banner:home'), 'Banner button retained');
  assert.ok(cbs.includes('a:home:e:homeMenuPrompt'), 'Menu Prompt edit retained');
  assert.ok(cbs.includes('a:home:e:homeActivationOverride'), 'ETA Override retained');
  ['a:home:e:homeTitle', 'a:home:e:homeSubtitle', 'a:home:e:homeFooter']
    .forEach(dead => assert.ok(!cbs.includes(dead),
      `dead callback ${dead} must be removed from homeManageMenu`));
  console.log('✅ homeManageMenu: dead buttons removed, only realtime-relevant ones remain');
}

function testBotRegexNarrowed() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'Bot.js'), 'utf8');
  assert.ok(/a:home:e:\(homeMenuPrompt\|homeActivationOverride\)/.test(src),
    'Bot.js callback regex must only accept the 2 fields still in use');
  assert.ok(!/homeTitle\|homeSubtitle\|homeFooter/.test(src),
    'Bot.js must no longer route to homeTitle/homeSubtitle/homeFooter (dead callbacks)');
  console.log('✅ Bot.js callback regex narrowed to the 2 active fields');
}

(async () => {
  try { await testCaptionShape(); }        catch (e) { console.error('FAIL shape:', e.message); process.exit(1); }
  try { await testCaptionExcludes(); }     catch (e) { console.error('FAIL exclude:', e.message); process.exit(1); }
  try { testHomeManagerKeyboardCleaned(); }catch (e) { console.error('FAIL kb:', e.message); process.exit(1); }
  try { testBotRegexNarrowed(); }          catch (e) { console.error('FAIL regex:', e.message); process.exit(1); }
  console.log('\n════════════════════════════════════════');
  console.log('HOME CAPTION SIMPLIFICATION — all assertions PASS.');
  console.log('════════════════════════════════════════');
})();
