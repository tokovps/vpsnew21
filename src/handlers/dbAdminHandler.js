// ================================================================
// DB ADMIN HANDLER — panel & flow orchestration for the "🗄 Database
// Manager" menu. All heavy lifting lives in services/dbMigrationService.
// This module only:
//   • Renders the panels via safeEditText.
//   • Opens input sessions (admin_db_test_uri / admin_db_migrate_uri).
//   • Streams migration progress back to the same anchor message using
//     the existing safeEditText helper (so the animated UI still wraps
//     every callback and no new chat lines are created).
//   • Confirms the "gunakan database baru" switch.
// ================================================================
const { safeEditText } = require('../utils/safeEdit');
const { openInputSession, clearSession } = require('./sessionStore');
const admKb = require('../keyboards/admin');
const db = require('../services/dbMigrationService');

// Ephemeral in-memory context per admin — remembers the URI they typed
// through the migrate → confirm-switch flow. Not persisted (URIs contain
// credentials; keep out of DB).
const migrateCtx = new Map();

function backKb() {
  return admKb.dbManagerMenu();
}

function answer(ctx, text) { return ctx.answerCbQuery(text || '').catch(() => {}); }

async function showMenu(ctx) {
  await answer(ctx);
  return safeEditText(ctx,
`🗄 *DATABASE MANAGER*

Menu untuk operator: cek status DB aktif, backup penuh, migrasi ke MongoDB URI baru, dan restore.

⚠️ Menu ini berpotensi mengubah database aktif. Gunakan dengan hati-hati.`,
    { parse_mode: 'Markdown', ...admKb.dbManagerMenu() });
}

async function showStatus(ctx) {
  await answer(ctx, '📊 Loading...');
  let st;
  try { st = await db.statusActive(); }
  catch (e) { return safeEditText(ctx, `❌ Gagal ambil status: ${e.message}`, { parse_mode: 'Markdown', ...backKb() }); }
  if (!st.connected) {
    return safeEditText(ctx, `📊 *STATUS DATABASE*\n\n❌ *${st.state}*`,
      { parse_mode: 'Markdown', ...backKb() });
  }
  const topColl = st.collections.slice(0, 15)
    .map(c => `• \`${c.name}\` — ${c.count.toLocaleString('id-ID')} docs`).join('\n');
  const more = st.collections.length > 15 ? `\n_… +${st.collections.length - 15} collection lain_` : '';
  const text =
`📊 *STATUS DATABASE*

🟢 Connection : *${st.state}*
🖥 Host        : \`${st.host}:${st.port}\`
🗂 Database   : \`${st.name}\`
🏷 MongoDB    : v${st.version}

📦 Total Collection : *${st.totalCollections}*
📄 Total Document   : *${st.totalDocuments.toLocaleString('id-ID')}*

*Top Collection:*
${topColl}${more}`;
  return safeEditText(ctx, text, { parse_mode: 'Markdown', ...backKb() });
}

async function askUri(ctx, action /* 'test' | 'migrate' */) {
  await answer(ctx);
  const sessionAction = action === 'test' ? 'admin_db_test_uri' : 'admin_db_migrate_uri';
  openInputSession(ctx, { action: sessionAction, returnTo: 'a:db:menu' });
  const title = action === 'test' ? '🧪 *TEST KONEKSI DATABASE*' : '🔄 *MIGRASI DATABASE*';
  const desc  = action === 'test'
    ? 'Kirim MongoDB URI yang ingin diuji. Bot akan test *validasi URI, connect, read, & write permission* — tanpa mengganti database aktif.'
    : 'Kirim MongoDB URI *tujuan* migrasi.\n\nBot akan:\n1. Backup DB aktif ke `/app/backups`\n2. Copy SEMUA collection ke tujuan\n3. Validasi jumlah dokumen\n4. Meminta konfirmasi sebelum mengganti connection aktif.';
  const { Markup } = require('telegraf');
  return safeEditText(ctx,
`${title}

${desc}

Format:
\`mongodb+srv://user:pass@host/dbname\`
\`mongodb://user:pass@host:27017/dbname\`

_Jangan bagikan URI ke siapapun — mengandung kredensial._`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', 'a:db:menu')]]) });
}

async function handleUriInput(ctx, uri, action) {
  const { Markup } = require('telegraf');
  const backOnly = { parse_mode: 'Markdown', ...backKb() };
  if (action === 'test') {
    const msg = await ctx.reply('🧪 Menguji koneksi…', { parse_mode: 'Markdown' });
    const r = await db.testUri(uri);
    const text = r.ok
      ? `✅ *CONNECTION SUCCESS*\n\n🖥 Host: \`${r.host}:${r.port}\`\n🗂 Database: \`${r.name}\`\n🏷 MongoDB: v${r.version}\n📦 Collection: ${r.totalCollections}\n⏱ Elapsed: ${r.elapsedMs}ms\n\n_URI tidak disimpan. Untuk mengganti database aktif gunakan menu 🔄 Migrasi._`
      : `❌ *CONNECTION FAILED*\n\n${r.error}`;
    return ctx.telegram.editMessageText(msg.chat.id, msg.message_id, undefined, text,
      { parse_mode: 'Markdown', ...backKb() });
  }
  // action === 'migrate'
  const msg = await ctx.reply('🔍 Testing target…', { parse_mode: 'Markdown' });
  const test = await db.testUri(uri);
  if (!test.ok) {
    return ctx.telegram.editMessageText(msg.chat.id, msg.message_id, undefined,
      `❌ Target tidak bisa dipakai:\n${test.error}`, { parse_mode: 'Markdown', ...backKb() });
  }
  // Kick off migration with progress edits on the same message.
  const editor = async (text) => {
    try { await ctx.telegram.editMessageText(msg.chat.id, msg.message_id, undefined, text, { parse_mode: 'Markdown' }); } catch (_) {}
  };
  await editor('🔄 *Database Migration*\n\n📥 Backup DB aktif…');
  const runMigrate = async (allowNonEmpty) => {
    return db.migrate(uri, {
      allowNonEmpty,
      onProgress: async ({ phase, i, total, name }) => {
        const pct = total ? Math.floor((i / total) * 100) : 0;
        const bar = '█'.repeat(Math.min(20, Math.floor(pct / 5))) + '░'.repeat(20 - Math.min(20, Math.floor(pct / 5)));
        const label = phase === 'backup' ? 'Backup' : 'Migrating';
        await editor(`🔄 *Database Migration*\n\n${bar}\n${pct}%\n\n${label} \`${name}\` (${i}/${total})`);
      },
    });
  };
  const r = await runMigrate(false);
  if (!r.ok && r.code === 'TARGET_NOT_EMPTY') {
    migrateCtx.set(String(ctx.from.id), { uri, msgId: msg.message_id, chatId: msg.chat.id });
    return ctx.telegram.editMessageText(msg.chat.id, msg.message_id, undefined,
      `⚠️ *Target tidak kosong*\n\nTarget berisi ${r.targetDocs} dokumen di ${r.targetColls} collection.\n\nOverride?`,
      { parse_mode: 'Markdown', ...admKb.dbMigrateForceMenu() });
  }
  if (!r.ok) {
    return ctx.telegram.editMessageText(msg.chat.id, msg.message_id, undefined,
      `❌ *Migrasi gagal*\n\n${r.error}\n\n_Backup DB lama tersimpan sebagai_ \`${r.backupFile || '(none)'}\`_ — DB aktif tidak diubah._`,
      { parse_mode: 'Markdown', ...backKb() });
  }
  // Success — offer switch.
  migrateCtx.set(String(ctx.from.id), { uri, msgId: msg.message_id, chatId: msg.chat.id, elapsedMs: r.elapsedMs });
  return ctx.telegram.editMessageText(msg.chat.id, msg.message_id, undefined,
`✅ *Migration Success*

📦 Collection: ${r.copied}
📄 Total Document: ${r.totalDocuments.toLocaleString('id-ID')}
⏱ Elapsed: ${(r.elapsedMs / 1000).toFixed(1)}s
📥 Backup: \`${r.backupFile}\`

Ganti connection aktif ke DB baru sekarang?

_Semua service (User/Order/Provider/Payment/…) otomatis pindah tanpa restart bot._`,
    { parse_mode: 'Markdown', ...admKb.dbMigrateConfirmMenu() });
}

async function forceMigrate(ctx) {
  const rec = migrateCtx.get(String(ctx.from.id));
  if (!rec) { await answer(ctx, 'Sesi migrasi kadaluarsa', true); return showMenu(ctx); }
  await answer(ctx);
  const editor = async (text) => {
    try { await ctx.telegram.editMessageText(rec.chatId, rec.msgId, undefined, text, { parse_mode: 'Markdown' }); } catch (_) {}
  };
  await editor('🔄 *Database Migration* (override)\n\nMemulai copy…');
  const r = await db.migrate(rec.uri, {
    allowNonEmpty: true,
    onProgress: async ({ phase, i, total, name }) => {
      const pct = total ? Math.floor((i / total) * 100) : 0;
      const bar = '█'.repeat(Math.min(20, Math.floor(pct / 5))) + '░'.repeat(20 - Math.min(20, Math.floor(pct / 5)));
      const label = phase === 'backup' ? 'Backup' : 'Migrating';
      await editor(`🔄 *Database Migration*\n\n${bar}\n${pct}%\n\n${label} \`${name}\` (${i}/${total})`);
    },
  });
  if (!r.ok) {
    return ctx.telegram.editMessageText(rec.chatId, rec.msgId, undefined,
      `❌ Migrasi gagal (override): ${r.error}\n\nBackup: \`${r.backupFile || '(none)'}\``,
      { parse_mode: 'Markdown', ...backKb() });
  }
  migrateCtx.set(String(ctx.from.id), { ...rec, elapsedMs: r.elapsedMs });
  return ctx.telegram.editMessageText(rec.chatId, rec.msgId, undefined,
`✅ *Migration Success (override)*

📦 Collection: ${r.copied}
📄 Total Document: ${r.totalDocuments.toLocaleString('id-ID')}
📥 Backup: \`${r.backupFile}\`

Ganti connection aktif ke DB baru sekarang?`,
    { parse_mode: 'Markdown', ...admKb.dbMigrateConfirmMenu() });
}

async function confirmSwitch(ctx) {
  const rec = migrateCtx.get(String(ctx.from.id));
  if (!rec) { await answer(ctx, 'Sesi migrasi kadaluarsa', true); return showMenu(ctx); }
  await answer(ctx, '🔌 Switching…');
  const r = await db.switchActive(rec.uri);
  migrateCtx.delete(String(ctx.from.id));
  const text = r.ok
    ? `✅ *DATABASE ACTIVE BERHASIL DIPINDAHKAN*\n\nDari: \`${r.from}\`\nKe:   \`${r.to}\`\n\nSemua service tetap berjalan tanpa restart. Cek 📊 Status Database.`
    : `❌ *SWITCH GAGAL — sudah rollback ke DB lama*\n\n${r.error}`;
  return safeEditText(ctx, text, { parse_mode: 'Markdown', ...backKb() });
}

async function doBackup(ctx) {
  await answer(ctx, '📥 Backup…');
  const msg = await safeEditText(ctx, '📥 *BACKUP DATABASE*\n\nMemulai…', { parse_mode: 'Markdown' });
  let last = 0;
  const r = await db.backupActive({
    onProgress: async ({ i, total, name }) => {
      const now = Date.now();
      if (now - last < 400 && i !== total) return; // throttle edits
      last = now;
      const bar = '█'.repeat(Math.min(20, Math.floor((i / total) * 20))) + '░'.repeat(20 - Math.min(20, Math.floor((i / total) * 20)));
      const pct = Math.floor((i / total) * 100);
      try { await safeEditText(ctx, `📥 *BACKUP DATABASE*\n\n${bar}\n${pct}%\n\nDumping \`${name}\` (${i}/${total})`, { parse_mode: 'Markdown' }); } catch (_) {}
    },
  });
  if (!r.ok) return safeEditText(ctx, `❌ Backup gagal: ${r.error}`, { parse_mode: 'Markdown', ...backKb() });
  return safeEditText(ctx,
`✅ *BACKUP SUCCESS*

📄 File: \`${require('path').basename(r.file)}\`
📦 Collection: ${r.collections}
📄 Document: ${r.totalDocuments.toLocaleString('id-ID')}
💾 Size: ${(r.sizeBytes / 1024).toFixed(1)} KB

_Tersimpan di_ \`/app/backups\``,
    { parse_mode: 'Markdown', ...backKb() });
}

async function showRestoreList(ctx) {
  const { Markup } = require('telegraf');
  await answer(ctx);
  const list = db.listBackups().slice(0, 10);
  if (!list.length) {
    return safeEditText(ctx, '📤 *RESTORE DATABASE*\n\n_Belum ada file backup._\nGunakan 📥 Backup Database untuk membuat.',
      { parse_mode: 'Markdown', ...backKb() });
  }
  const rows = list.map(b => [Markup.button.callback(
    `${b.file} · ${(b.sizeBytes / 1024).toFixed(0)}KB`,
    `a:db:restore:go:${b.file}`,
  )]);
  rows.push([Markup.button.callback('🔙 Kembali', 'a:db:menu')]);
  return safeEditText(ctx,
`📤 *RESTORE DATABASE*

Pilih file backup yang akan direstore ke DB aktif.

⚠️ *Peringatan:* seluruh collection yang namanya sama akan di-drop lalu ditulis ulang dari file.`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
}

async function doRestore(ctx, file) {
  await answer(ctx, '📤 Restore…');
  const msg = await safeEditText(ctx, `📤 *RESTORE* \`${file}\`\n\nMemulai…`, { parse_mode: 'Markdown' });
  let last = 0;
  const r = await db.restoreFromFile(file, {
    onProgress: async ({ i, total, name }) => {
      const now = Date.now();
      if (now - last < 400 && i !== total) return;
      last = now;
      const bar = '█'.repeat(Math.min(20, Math.floor((i / total) * 20))) + '░'.repeat(20 - Math.min(20, Math.floor((i / total) * 20)));
      try { await safeEditText(ctx, `📤 *RESTORE*\n\n${bar}\nRestoring \`${name}\` (${i}/${total})`, { parse_mode: 'Markdown' }); } catch (_) {}
    },
  });
  if (!r.ok) return safeEditText(ctx, `❌ Restore gagal: ${r.error}`, { parse_mode: 'Markdown', ...backKb() });
  return safeEditText(ctx,
`✅ *RESTORE SUCCESS*

📦 Collection: ${r.restored}
📄 Document: ${r.totalDocuments.toLocaleString('id-ID')}`,
    { parse_mode: 'Markdown', ...backKb() });
}

module.exports = {
  showMenu, showStatus, askUri, handleUriInput,
  doBackup, showRestoreList, doRestore,
  forceMigrate, confirmSwitch,
};
