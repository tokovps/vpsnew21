// POST STOK — retrofit verification
const assert = require('assert');
const path = require('path');

function testSvcExports() {
  const svc = require(path.join(__dirname, '..', 'src', 'services', 'postStokService.js'));
  ['publishStok', 'previewStok', 'deleteLastStok', 'buildStokCard', 'resolveChannel']
    .forEach(k => assert.strictEqual(typeof svc[k], 'function', `postStokService.${k} must be a function`));
  console.log('✅ postStokService exports publish/preview/delete/build/resolve');
}

async function testBuildCard() {
  const svc = require(path.join(__dirname, '..', 'src', 'services', 'postStokService.js'));
  const catalog = require(path.join(__dirname, '..', 'src', 'services', 'catalogService.js'));
  const origGetBuy = catalog.getBuyMenuStock;
  catalog.getBuyMenuStock = async () => ({ stock: 128, statusLine: '', etaLine: '' });
  const bot = { telegram: { getMe: async () => ({ username: 'tokovps_bot' }) } };
  const card = await svc.buildStokCard(bot, 'vps');
  // Format matches user's exact spec.
  assert.ok(/🚀 TOKO VPS/.test(card.text), 'VPS header must match user spec');
  assert.ok(/📦 Ready Stock/.test(card.text), 'must show "Ready Stock" label');
  assert.ok(/\*\d+ VPS\*/.test(card.text), 'must render stock as bold "N VPS"');
  assert.ok(/🕒 Update:/.test(card.text), 'must show update timestamp label');
  assert.ok(/\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}/.test(card.text), 'timestamp must be dd/mm/yyyy HH:mm:ss');
  const btn = card.opts.reply_markup.inline_keyboard[0][0];
  assert.strictEqual(btn.text, '🛒 Buy VPS', 'button label must be "🛒 Buy VPS"');
  assert.strictEqual(btn.url, 'https://t.me/tokovps_bot?start=buy_vps', 'deep-link URL exact match');
  const cardR = await svc.buildStokCard(bot, 'rdp');
  assert.ok(/🖥 TOKO RDP/.test(cardR.text) && /\*\d+ RDP\*/.test(cardR.text));
  assert.strictEqual(cardR.opts.reply_markup.inline_keyboard[0][0].url,
    'https://t.me/tokovps_bot?start=buy_rdp', 'RDP deep-link URL exact match');
  catalog.getBuyMenuStock = origGetBuy;
  console.log('✅ buildStokCard produces exact-spec card (VPS + RDP, dd/mm/yyyy HH:mm:ss)');
}

async function testPublishFlow() {
  // Stub Setting: pretend admin already set stokChannelId=@testchan
  const path2 = require('path').join(__dirname, '..', 'src', 'services', 'settingService.js');
  const settingSvc = require(path2);
  const orig = { get: settingSvc.getSettings, up: settingSvc.updateSetting };
  const store = { stokChannelId: '@testchan', catalogChannelId: '', stokLastMsgIdVps: '', stokLastMsgIdRdp: '' };
  settingSvc.getSettings = async () => ({ ...store });
  settingSvc.updateSetting = async (patch) => {
    // Real service always receives an object; postStokService wraps (k,v) → {k:v}.
    if (patch && typeof patch === 'object') Object.assign(store, patch);
  };
  // Also stub catalogService.getBuyMenuStock to avoid Mongo.
  const catalog = require(path.join(__dirname, '..', 'src', 'services', 'catalogService.js'));
  const origGetBuy = catalog.getBuyMenuStock;
  catalog.getBuyMenuStock = async () => ({ stock: 42, statusLine: '', etaLine: '' });
  // Force cache reload if any
  const svc = require(path.join(__dirname, '..', 'src', 'services', 'postStokService.js'));
  let sent = null;
  const bot = {
    telegram: {
      getMe: async () => ({ username: 'tokovps_bot' }),
      sendMessage: async (chan, text, opts) => { sent = { chan, text, opts }; return { message_id: 4242 }; },
      deleteMessage: async (chan, mid) => { deleted = { chan, mid }; return true; },
    },
  };
  let deleted = null;
  const r = await svc.publishStok(bot, 'vps');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.messageId, 4242, 'must return sent message_id');
  assert.strictEqual(sent.chan, '@testchan', 'must publish to configured stokChannelId');
  assert.strictEqual(store.stokLastMsgIdVps, '4242', 'must persist stokLastMsgIdVps');
  console.log('✅ publishStok: send to configured channel + persist lastMessageId');

  const d = await svc.deleteLastStok(bot, 'vps');
  assert.strictEqual(d.ok, true, 'delete must succeed');
  assert.strictEqual(deleted.mid, 4242, 'must delete the stored message id');
  assert.strictEqual(store.stokLastMsgIdVps, '', 'stored id cleared after delete');
  console.log('✅ deleteLastStok: removes the stored last-message + clears state');

  // Fallback: no dedicated stokChannelId → uses catalogChannelId.
  store.stokChannelId = ''; store.catalogChannelId = '@catalog';
  const r2 = await svc.publishStok(bot, 'rdp');
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(sent.chan, '@catalog', 'fallback to catalogChannelId when stokChannelId empty');
  console.log('✅ fallback to catalogChannelId when stokChannelId not set');

  // Empty channel case → error, no crash.
  store.stokChannelId = ''; store.catalogChannelId = '';
  const r3 = await svc.publishStok(bot, 'vps');
  assert.strictEqual(r3.ok, false, 'must return ok:false with clear error when no channel');
  assert.ok(/Atur Channel|belum di-set/.test(r3.error), 'error message must guide admin');
  console.log('✅ publishStok gracefully errors when no channel configured');

  // Restore.
  settingSvc.getSettings = orig.get;
  settingSvc.updateSetting = orig.up;
}

function testKeyboardAndWiring() {
  const kb = require(path.join(__dirname, '..', 'src', 'keyboards', 'admin.js'));
  assert.ok(typeof kb.postStokMenu === 'function', 'postStokMenu must be exported');
  const rows = kb.postStokMenu().reply_markup.inline_keyboard;
  const flat = rows.flat().map(b => b.callback_data);
  ['a:stok:post:vps', 'a:stok:post:rdp', 'a:stok:setchan',
   'a:stok:prev:vps', 'a:stok:prev:rdp',
   'a:stok:del:vps',  'a:stok:del:rdp',  'a:home']
    .forEach(cb => assert.ok(flat.includes(cb), `postStokMenu must include ${cb}`));
  console.log('✅ postStokMenu keyboard has all 7 buttons + Back');

  const fs = require('fs');
  const bot = fs.readFileSync(path.join(__dirname, '..', 'src', 'Bot.js'), 'utf8');
  ['a:stok:menu', 'a:stok:setchan',
   /a:stok:post:\(vps\|rdp\)/, /a:stok:prev:\(vps\|rdp\)/, /a:stok:del:\(vps\|rdp\)/]
    .forEach(pat => {
      const ok = pat instanceof RegExp ? pat.test(bot) : bot.includes(pat);
      assert.ok(ok, `Bot.js must register ${pat}`);
    });
  console.log('✅ Bot.js registered all 5 a:stok:* callbacks (menu/setchan/post/prev/del)');

  const adminSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'handlers', 'adminHandler.js'), 'utf8');
  assert.ok(/admin_stok_channel/.test(adminSrc), 'adminHandler must handle admin_stok_channel session');
  assert.ok(/showPostStokMenu|startEditStokChannel/.test(adminSrc), 'adminHandler must expose stok panel funcs');
  console.log('✅ adminHandler: session handler + panel functions wired');

  const mainMenu = kb.adminMenu().reply_markup.inline_keyboard.flat().map(b => b.callback_data);
  assert.ok(mainMenu.includes('a:stok:menu'), 'main admin menu must have entry point to Post Stok');
  console.log('✅ admin main menu shows "📢 Post Stok" entry');
}

function testSettingFields() {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'models', 'Setting.js'), 'utf8');
  ['stokChannelId', 'stokLastMsgIdVps', 'stokLastMsgIdRdp']
    .forEach(k => assert.ok(new RegExp(`${k}:`).test(src), `Setting must define ${k}`));
  console.log('✅ Setting model has stokChannelId + stokLastMsgIdVps + stokLastMsgIdRdp');
}

(async () => {
  try { testSvcExports(); }             catch (e) { console.error('FAIL exports:', e.message); process.exit(1); }
  try { await testBuildCard(); }        catch (e) { console.error('FAIL buildCard:', e.message); process.exit(1); }
  try { await testPublishFlow(); }      catch (e) { console.error('FAIL publish:', e.message); process.exit(1); }
  try { testKeyboardAndWiring(); }      catch (e) { console.error('FAIL wiring:', e.message); process.exit(1); }
  try { testSettingFields(); }          catch (e) { console.error('FAIL setting:', e.message); process.exit(1); }
  console.log('\n════════════════════════════════════════');
  console.log('POST STOK RETROFIT — all assertions PASS.');
  console.log('════════════════════════════════════════');
})();
