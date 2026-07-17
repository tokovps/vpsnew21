// DATABASE MIGRATION MANAGER — retrofit verification (no live mongo needed).
// We prove: services & handlers export correctly, keyboards contain every
// required button, Bot.js wires every callback, and the pure-logic helpers
// (redactUri, timestamp, testUri URI validation) behave correctly.
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const svc = require(path.join(__dirname, '..', 'src', 'services', 'dbMigrationService.js'));
const kb  = require(path.join(__dirname, '..', 'src', 'keyboards', 'admin.js'));

function testServiceExports() {
  ['statusActive','testUri','backupActive','listBackups','migrate','switchActive','restoreFromFile','redactUri','timestamp']
    .forEach(k => assert.strictEqual(typeof svc[k], 'function', `dbMigrationService.${k} must be a function`));
  console.log('✅ dbMigrationService exports all 9 primitives');
}

function testRedaction() {
  assert.strictEqual(svc.redactUri('mongodb://alice:s3cret@host:27017/db'),
    'mongodb://alice:****@host:27017/db', 'password must be masked ****');
  assert.strictEqual(svc.redactUri('mongodb+srv://user:pw@cluster0.abc.mongodb.net/prod'),
    'mongodb+srv://user:****@cluster0.abc.mongodb.net/prod');
  assert.strictEqual(svc.redactUri('not-a-uri'), 'not-a-uri', 'non-URI passes through');
  console.log('✅ redactUri masks credentials safely (never echoes passwords)');
}

async function testUriValidation() {
  // Format check — must reject non-mongo URIs synchronously without contacting network.
  const bad = await svc.testUri('http://foo.bar/db');
  assert.strictEqual(bad.ok, false, 'http URI must be rejected');
  assert.ok(/Format URI/.test(bad.error), 'error must mention format');
  const empty = await svc.testUri('');
  assert.strictEqual(empty.ok, false, 'empty URI must be rejected');
  console.log('✅ testUri validates URI format before contacting network');
}

function testBackupDir() {
  assert.ok(svc.BACKUP_DIR && svc.BACKUP_DIR.length > 0, 'BACKUP_DIR must be defined');
  const stamp = svc.timestamp();
  assert.ok(/^\d{8}-\d{6}$/.test(stamp), `timestamp shape yyyymmdd-HHMMSS: ${stamp}`);
  const list = svc.listBackups();
  assert.ok(Array.isArray(list), 'listBackups returns array (may be empty)');
  console.log('✅ backup dir + timestamp + listBackups work (dir=' + svc.BACKUP_DIR + ')');
}

function testKeyboards() {
  ['dbManagerMenu', 'dbMigrateConfirmMenu', 'dbMigrateForceMenu']
    .forEach(k => assert.strictEqual(typeof kb[k], 'function', `keyboards/admin.${k} must be exported`));
  const main = kb.dbManagerMenu().reply_markup.inline_keyboard.flat().map(b => b.callback_data);
  ['a:db:status', 'a:db:migrate:ask', 'a:db:backup', 'a:db:restore:list', 'a:db:test:ask', 'a:home']
    .forEach(cb => assert.ok(main.includes(cb), `dbManagerMenu must have ${cb}`));
  const conf = kb.dbMigrateConfirmMenu().reply_markup.inline_keyboard.flat().map(b => b.callback_data);
  ['a:db:switch:yes', 'a:db:menu'].forEach(cb =>
    assert.ok(conf.includes(cb), `dbMigrateConfirmMenu must have ${cb}`));
  const force = kb.dbMigrateForceMenu().reply_markup.inline_keyboard.flat().map(b => b.callback_data);
  ['a:db:migrate:force', 'a:db:menu'].forEach(cb =>
    assert.ok(force.includes(cb), `dbMigrateForceMenu must have ${cb}`));
  const admMain = kb.adminMenu().reply_markup.inline_keyboard.flat().map(b => b.callback_data);
  assert.ok(admMain.includes('a:db:menu'), 'admin main menu must expose "🗄 Database Manager"');
  console.log('✅ keyboards: dbManagerMenu (6 buttons) + confirm + force + entry-point');
}

function testHandlerExports() {
  const h = require(path.join(__dirname, '..', 'src', 'handlers', 'dbAdminHandler.js'));
  ['showMenu','showStatus','askUri','handleUriInput','doBackup','showRestoreList','doRestore','forceMigrate','confirmSwitch']
    .forEach(k => assert.strictEqual(typeof h[k], 'function', `dbAdminHandler.${k} must be a function`));
  console.log('✅ dbAdminHandler exports all 9 panel functions');
}

function testBotWiring() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'Bot.js'), 'utf8');
  const expected = [
    "'a:db:menu'",
    "'a:db:status'",
    "'a:db:test:ask'",
    "'a:db:migrate:ask'",
    "'a:db:migrate:force'",
    "'a:db:switch:yes'",
    "'a:db:backup'",
    "'a:db:restore:list'",
    /a:db:restore:go:/,
  ];
  for (const e of expected) {
    const ok = e instanceof RegExp ? e.test(src) : src.includes(e);
    assert.ok(ok, `Bot.js must register ${e}`);
  }
  console.log('✅ Bot.js wired all 9 a:db:* callbacks');
  const admSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'handlers', 'adminHandler.js'), 'utf8');
  assert.ok(/admin_db_test_uri|admin_db_migrate_uri/.test(admSrc),
    'adminHandler must dispatch admin_db_test_uri / admin_db_migrate_uri sessions to dbAdminHandler');
  console.log('✅ adminHandler dispatches DB Manager URI sessions');
}

function testAnimationTitle() {
  const engine = require(path.join(__dirname, '..', 'src', 'ui', 'animatedEngine.js'));
  assert.ok(/DATABASE MANAGER/.test(engine.titleFor('a:db:menu')),
    'animation title for a:db:* must be "🗄 DATABASE MANAGER"');
  console.log('✅ animatedEngine: contextual title for a:db:*');
}

async function testMigrateArgumentShape() {
  // migrate() with an obviously-bad URI should ALWAYS produce { ok:false }
  // and never touch the active connection. This exercises the initial guard.
  const r = await svc.migrate('http://not-mongo/', {}).catch(e => ({ ok: false, error: e.message }));
  assert.strictEqual(r.ok, false, 'migrate must return ok:false for bad URI');
  console.log('✅ migrate() fails safely on non-mongo URI (no active-DB mutation)');
}

(async () => {
  try { testServiceExports(); }        catch (e) { console.error('FAIL exports:', e.message); process.exit(1); }
  try { testRedaction(); }             catch (e) { console.error('FAIL redact:', e.message); process.exit(1); }
  try { await testUriValidation(); }   catch (e) { console.error('FAIL validate:', e.message); process.exit(1); }
  try { testBackupDir(); }             catch (e) { console.error('FAIL backup:', e.message); process.exit(1); }
  try { testKeyboards(); }             catch (e) { console.error('FAIL kb:', e.message); process.exit(1); }
  try { testHandlerExports(); }        catch (e) { console.error('FAIL handler:', e.message); process.exit(1); }
  try { testBotWiring(); }             catch (e) { console.error('FAIL wiring:', e.message); process.exit(1); }
  try { testAnimationTitle(); }        catch (e) { console.error('FAIL anim:', e.message); process.exit(1); }
  try { await testMigrateArgumentShape(); } catch (e) { console.error('FAIL migrate-guard:', e.message); process.exit(1); }
  console.log('\n════════════════════════════════════════');
  console.log('DATABASE MANAGER RETROFIT — all assertions PASS.');
  console.log('════════════════════════════════════════');
})();
