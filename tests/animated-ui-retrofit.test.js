// Static verification of AnimatedUIEngine + Stock guard retrofit.
// No network / mongo dependency — just prove the wiring is correct.
const assert = require('assert');
const path = require('path');

const engine = require(path.join(__dirname, '..', 'src', 'ui', 'animatedEngine.js'));

function testEngineExports() {
  assert.ok(typeof engine.globalMiddleware === 'function', 'globalMiddleware() must be exported');
  assert.ok(typeof engine.playAnimation === 'function',    'playAnimation() must be exported');
  assert.ok(typeof engine.shouldSkipAnimation === 'function', 'shouldSkipAnimation must be exported');
  assert.strictEqual(engine.FRAMES.length, 3, 'must have exactly 3 progress frames');
  assert.ok(engine.FINAL_FRAME && engine.FINAL_FRAME.bar.includes('▰▰▰▰▰▰▰▰▰▰'), 'final frame must be full bar');
  console.log('✅ engine exports OK (globalMiddleware, playAnimation, 3 frames + final)');
}

function testSkipList() {
  assert.strictEqual(engine.shouldSkipAnimation('noop'), true, 'noop must be skipped');
  assert.strictEqual(engine.shouldSkipAnimation('joingate:check'), true, 'joingate:check must be skipped');
  assert.strictEqual(engine.shouldSkipAnimation('menu:vps'), false, 'menu:vps must animate');
  assert.strictEqual(engine.shouldSkipAnimation('a:home'), false, 'admin home must animate');
  assert.strictEqual(engine.shouldSkipAnimation('v:d:65f'), false, 'v:d:* must animate');
  assert.strictEqual(engine.shouldSkipAnimation('e:queue:menu'), false, 'enterprise callbacks animate');
  console.log('✅ skip list correct — animation blocks only noop / joingate:check');
}

function testTitles() {
  const t = engine.titleFor.bind(engine);
  assert.ok(t('menu:vps').includes('BUY VPS'));
  assert.ok(t('menu:rdp').includes('BUY RDP'));
  assert.ok(t('a:home').includes('ADMIN'));
  assert.ok(t('a:stock:vps').includes('STOCK'));
  assert.ok(t('r:d:xyz').includes('RDP'));
  assert.ok(t('unknown:cb'), 'unknown callback gets a default title');
  console.log('✅ contextual titles map correctly (BUY VPS / STOCK / etc.)');
}

function testBotWiring() {
  const fs = require('fs');
  const botSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'Bot.js'), 'utf8');
  // Middleware must be registered.
  assert.ok(botSrc.includes("require('./ui/animatedEngine').globalMiddleware()"),
    'Bot.js must .use() the animatedEngine.globalMiddleware()');
  // Stock guard must be present on both menu:vps and menu:rdp.
  assert.ok(/menu:vps[\s\S]{0,600}getBuyMenuStock/.test(botSrc), 'menu:vps must call getBuyMenuStock');
  assert.ok(/menu:rdp[\s\S]{0,600}getBuyMenuStock/.test(botSrc), 'menu:rdp must call getBuyMenuStock');
  assert.ok(/renderStockEmpty\(ctx, 'vps'\)/.test(botSrc), 'menu:vps must renderStockEmpty when stock=0');
  assert.ok(/renderStockEmpty\(ctx, 'rdp'\)/.test(botSrc), 'menu:rdp must renderStockEmpty when stock=0');
  // Admin Update Stock callback must exist.
  assert.ok(/a:stock:\(vps\|rdp\)/.test(botSrc), 'a:stock:* callback must be registered');
  assert.ok(/fullStockRefresh\(bot, cat\)/.test(botSrc), 'admin button must call fullStockRefresh');
  console.log('✅ Bot.js wired: middleware + stock guard + admin update-stock button');
}

function testUserHandlerStockEmpty() {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'handlers', 'userHandler.js'), 'utf8');
  assert.ok(/async function renderStockEmpty/.test(src), 'renderStockEmpty function present');
  assert.ok(/Hubungi Admin/.test(src), 'stock-empty page must offer contact admin');
  assert.ok(/menu:home/.test(src), 'stock-empty page must offer back to home');
  assert.ok(/renderStockEmpty,/.test(src) || /renderStockEmpty }/.test(src), 'renderStockEmpty must be exported');
  console.log('✅ userHandler.renderStockEmpty implemented (with contact + back)');
}

function testCatalogAnnouncement() {
  const catalog = require(path.join(__dirname, '..', 'src', 'services', 'catalogService.js'));
  assert.ok(typeof catalog.publishStockAnnouncement === 'function', 'publishStockAnnouncement exported');
  assert.ok(typeof catalog.fullStockRefresh === 'function', 'fullStockRefresh exported');
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'catalogService.js'), 'utf8');
  assert.ok(/getBuyMenuStock\(\)/.test(src), 'announcement must read SAME source of truth (getBuyMenuStock)');
  assert.ok(/start=buy_vps|start=buy_rdp|start=\$\{/.test(src), 'must build deep-link URL');
  console.log('✅ catalogService: publishStockAnnouncement + fullStockRefresh + deep-link URL');
}

function testDeepLink() {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'commands', 'start.js'), 'utf8');
  assert.ok(/dl === 'buy_vps' \|\| dl === 'buy_rdp'/.test(src), 'start.js must handle deep-link payloads');
  assert.ok(/STOCK .{1,10} SEDANG KOSONG/.test(src), 'deep-link flow must handle stock-empty case inline');
  assert.ok(/getBuyMenuStock/.test(src), 'deep-link flow must check stock via single source of truth');
  assert.ok(/tierMenu\(category\)/.test(src), 'deep-link must send tier menu directly (single message, no home clutter)');
  console.log('✅ /start buy_vps + /start buy_rdp deep-link wired');
}

function testProviderPostSuccessHook() {
  // providerService.markUsed already triggers catalogService.scheduleUpdate()
  // → after a successful order the channel post is refreshed. Verify still true.
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'providerService.js'), 'utf8');
  assert.ok(/scheduleUpdate/.test(src), 'providerService must still schedule catalog update on markUsed');
  console.log('✅ post-order auto-refresh preserved (providerService.markUsed → catalog.scheduleUpdate)');
}

(async () => {
  try { testEngineExports(); }        catch (e) { console.error('FAIL engine:', e.message); process.exit(1); }
  try { testSkipList(); }             catch (e) { console.error('FAIL skip:', e.message); process.exit(1); }
  try { testTitles(); }               catch (e) { console.error('FAIL titles:', e.message); process.exit(1); }
  try { testBotWiring(); }            catch (e) { console.error('FAIL wiring:', e.message); process.exit(1); }
  try { testUserHandlerStockEmpty(); }catch (e) { console.error('FAIL stock-empty:', e.message); process.exit(1); }
  try { testCatalogAnnouncement(); }  catch (e) { console.error('FAIL catalog:', e.message); process.exit(1); }
  try { testDeepLink(); }             catch (e) { console.error('FAIL deep-link:', e.message); process.exit(1); }
  try { testProviderPostSuccessHook(); } catch (e) { console.error('FAIL hook:', e.message); process.exit(1); }
  console.log('\n════════════════════════════════════════');
  console.log('ANIMATED UI + STOCK RETROFIT — all assertions PASS.');
  console.log('════════════════════════════════════════');
})();
