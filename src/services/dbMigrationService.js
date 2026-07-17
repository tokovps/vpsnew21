// ================================================================
// DATABASE MIGRATION SERVICE
// ----------------------------------------------------------------
// Provides Admin Panel a way to test / backup / migrate the entire
// MongoDB database to a new URI without restarting the bot process.
//
// SAFETY-FIRST DESIGN
//   • We NEVER touch the active mongoose default connection until the
//     admin explicitly confirms the switch.
//   • Test / backup / migrate all use a SECONDARY connection created via
//     mongoose.createConnection(newUri) — completely isolated.
//   • Migration reads from the current (active) connection's DB directly
//     via its native driver, and writes into the secondary connection's
//     DB. Copies ALL collections (not just the mongoose-registered ones)
//     so nothing is left behind.
//   • Backup dumps every collection to a single gzip-compressed JSON file
//     under /app/backups. Naming: mongo-backup-YYYYmmdd-HHMMSS.json.gz.
//   • Restore reads that file back into the ACTIVE db (drop target
//     collections first for a clean restore — admin explicitly opts in).
//   • Live switch: mongoose.disconnect() → mongoose.connect(newUri). All
//     already-registered models automatically bind to the new connection.
//
// NOT AN OBJECTID.  Any doc `_id` is preserved verbatim (writeConcern: raw)
// so cross-refs (Order → User, VpsInstance → Order) keep working.
// ================================================================
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BACKUP_DIR = process.env.DB_BACKUP_DIR || '/app/backups';

function ensureBackupDir() {
  try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch (_) {}
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Redact user/password from URI so we never echo credentials back to admin.
function redactUri(uri) {
  try { return String(uri).replace(/:\/\/([^:]+):([^@]+)@/, '://$1:****@'); } catch (_) { return '(redacted)'; }
}

// -------- Live DB introspection (uses ACTIVE mongoose connection) --------
async function statusActive() {
  const conn = mongoose.connection;
  const stateMap = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };
  const state = stateMap[conn.readyState] || String(conn.readyState);
  if (conn.readyState !== 1) return { state, connected: false };
  const db = conn.db;
  const admin = db.admin();
  let version = 'unknown';
  try { const bi = await admin.buildInfo(); version = bi.version || 'unknown'; } catch (_) {}
  const collections = await db.listCollections().toArray();
  const perColl = [];
  let totalDocs = 0;
  for (const c of collections) {
    try {
      const n = await db.collection(c.name).estimatedDocumentCount();
      perColl.push({ name: c.name, count: n });
      totalDocs += n;
    } catch (_) { perColl.push({ name: c.name, count: -1 }); }
  }
  perColl.sort((a, b) => b.count - a.count);
  return {
    connected: true,
    state,
    host: conn.host,
    port: conn.port,
    name: conn.name,
    version,
    collections: perColl,
    totalCollections: perColl.length,
    totalDocuments: totalDocs,
  };
}

// -------- Test connection (secondary connection, disconnected after) -----
async function testUri(uri) {
  if (!uri || !/^mongodb(\+srv)?:\/\//i.test(uri)) {
    return { ok: false, error: 'Format URI tidak valid — harus diawali mongodb:// atau mongodb+srv://' };
  }
  let conn;
  const t0 = Date.now();
  try {
    conn = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 8000 }).asPromise();
  } catch (e) {
    return { ok: false, error: `Connect gagal: ${e.message}` };
  }
  try {
    // Read permission
    let collections = [];
    try { collections = await conn.db.listCollections().toArray(); }
    catch (e) { await conn.close().catch(()=>{}); return { ok: false, error: `Read permission ditolak: ${e.message}` }; }
    // Write permission (self-cleaning canary)
    const canaryName = `__migrate_probe_${Date.now()}`;
    try {
      const col = conn.db.collection(canaryName);
      await col.insertOne({ probe: true, ts: new Date() });
      await col.deleteMany({ probe: true });
      await conn.db.dropCollection(canaryName).catch(()=>{});
    } catch (e) {
      await conn.close().catch(()=>{});
      return { ok: false, error: `Write permission ditolak: ${e.message}` };
    }
    // Version
    let version = 'unknown';
    try { const bi = await conn.db.admin().buildInfo(); version = bi.version || 'unknown'; } catch (_) {}
    return {
      ok: true,
      elapsedMs: Date.now() - t0,
      name: conn.name,
      host: conn.host,
      port: conn.port,
      version,
      totalCollections: collections.length,
    };
  } finally {
    try { await conn.close(); } catch (_) {}
  }
}

// -------- Backup (dump active DB → gzip json) ----------------------------
async function backupActive({ onProgress } = {}) {
  ensureBackupDir();
  const db = mongoose.connection.db;
  if (!db) return { ok: false, error: 'DB aktif tidak terhubung' };
  const collections = (await db.listCollections().toArray()).filter(c => !/^system\./i.test(c.name));
  const dump = { meta: { createdAt: new Date().toISOString(), dbName: db.databaseName, collections: [] } };
  let totalDocs = 0;
  for (let i = 0; i < collections.length; i++) {
    const c = collections[i];
    const docs = await db.collection(c.name).find({}).toArray();
    dump[c.name] = docs;
    dump.meta.collections.push({ name: c.name, count: docs.length });
    totalDocs += docs.length;
    if (onProgress) await onProgress({ i: i + 1, total: collections.length, name: c.name, docs: docs.length });
  }
  const file = path.join(BACKUP_DIR, `mongo-backup-${timestamp()}.json.gz`);
  const json = JSON.stringify(dump);
  await new Promise((resolve, reject) => {
    zlib.gzip(json, (err, buf) => { if (err) reject(err); else fs.writeFile(file, buf, e => e ? reject(e) : resolve()); });
  });
  const stat = fs.statSync(file);
  return { ok: true, file, sizeBytes: stat.size, collections: collections.length, totalDocuments: totalDocs };
}

function listBackups() {
  ensureBackupDir();
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => /^mongo-backup-.+\.json\.gz$/.test(f))
    .map(f => {
      const p = path.join(BACKUP_DIR, f);
      const st = fs.statSync(p);
      return { file: f, path: p, sizeBytes: st.size, mtime: st.mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// -------- Migrate (active DB → secondary URI's DB) -----------------------
async function migrate(newUri, { onProgress, allowNonEmpty = false } = {}) {
  const t0 = Date.now();
  // 1. Backup active db first — insurance if anything goes wrong.
  const bk = await backupActive({ onProgress: async (p) => onProgress && onProgress({ phase: 'backup', ...p }) });
  if (!bk.ok) return { ok: false, error: `Backup gagal: ${bk.error}` };
  // 2. Connect to target.
  let target;
  try { target = await mongoose.createConnection(newUri, { serverSelectionTimeoutMS: 8000 }).asPromise(); }
  catch (e) { return { ok: false, error: `Connect target gagal: ${e.message}`, backupFile: bk.file }; }
  try {
    // 3. Audit target — refuse to overwrite unless allowNonEmpty.
    const tgtColls = await target.db.listCollections().toArray();
    let tgtDocs = 0;
    for (const c of tgtColls) {
      try { tgtDocs += await target.db.collection(c.name).estimatedDocumentCount(); } catch (_) {}
    }
    if (tgtDocs > 0 && !allowNonEmpty) {
      return { ok: false, code: 'TARGET_NOT_EMPTY',
        error: `Database tujuan berisi ${tgtDocs} dokumen di ${tgtColls.length} collection. Butuh konfirmasi override.`,
        targetDocs: tgtDocs, targetColls: tgtColls.length, backupFile: bk.file };
    }
    // 4. Audit source.
    const src = mongoose.connection.db;
    const srcColls = (await src.listCollections().toArray()).filter(c => !/^system\./i.test(c.name));
    // 5. Copy.
    const summary = [];
    let doneDocs = 0;
    for (let i = 0; i < srcColls.length; i++) {
      const name = srcColls[i].name;
      const docs = await src.collection(name).find({}).toArray();
      // Wipe target collection first so counts match on re-run.
      try { await target.db.collection(name).drop(); } catch (_) {}
      if (docs.length) {
        // Preserve _id verbatim.
        await target.db.collection(name).insertMany(docs, { ordered: false });
      }
      doneDocs += docs.length;
      summary.push({ name, count: docs.length });
      if (onProgress) await onProgress({ phase: 'copy', i: i + 1, total: srcColls.length, name, docs: docs.length });
    }
    // 6. Validate.
    const validate = [];
    for (const s of summary) {
      const live = await target.db.collection(s.name).countDocuments({});
      validate.push({ name: s.name, expected: s.count, actual: live, ok: live === s.count });
    }
    const badRows = validate.filter(v => !v.ok);
    if (badRows.length) {
      return { ok: false, code: 'VALIDATE_MISMATCH',
        error: `Validasi jumlah dokumen gagal pada ${badRows.length} collection`, validate, backupFile: bk.file };
    }
    return {
      ok: true, elapsedMs: Date.now() - t0,
      backupFile: bk.file,
      copied: summary.length, totalDocuments: doneDocs,
      validate,
    };
  } finally {
    try { await target.close(); } catch (_) {}
  }
}

// -------- Switch active mongoose connection to a new URI -----------------
// Post-migrate. Bot's already-registered models will follow.
async function switchActive(newUri) {
  const old = process.env.MONGO_URL;
  try {
    await mongoose.disconnect();
    await mongoose.connect(newUri, { serverSelectionTimeoutMS: 8000 });
    // Persist for next process launch (this won't survive container restart
    // unless the operator updates the env externally, but at least the
    // running process is on the new URI).
    process.env.MONGO_URL = newUri;
    return { ok: true, from: redactUri(old), to: redactUri(newUri) };
  } catch (e) {
    // Rollback — reconnect to old URI.
    try { await mongoose.disconnect(); } catch (_) {}
    try { await mongoose.connect(old); } catch (_) {}
    return { ok: false, error: `Gagal switch, reverted ke DB lama: ${e.message}` };
  }
}

// -------- Restore ---------------------------------------------------------
async function restoreFromFile(file, { onProgress } = {}) {
  const full = path.isAbsolute(file) ? file : path.join(BACKUP_DIR, file);
  if (!fs.existsSync(full)) return { ok: false, error: 'File backup tidak ditemukan' };
  const buf = fs.readFileSync(full);
  let json;
  try {
    const raw = await new Promise((resolve, reject) => zlib.gunzip(buf, (e, b) => e ? reject(e) : resolve(b)));
    json = JSON.parse(raw.toString('utf8'));
  } catch (e) { return { ok: false, error: `Gagal membaca backup: ${e.message}` }; }
  const db = mongoose.connection.db;
  const collNames = (json.meta && json.meta.collections || []).map(c => c.name);
  let doneDocs = 0;
  for (let i = 0; i < collNames.length; i++) {
    const name = collNames[i];
    const docs = json[name] || [];
    try { await db.collection(name).drop(); } catch (_) {}
    if (docs.length) await db.collection(name).insertMany(docs, { ordered: false });
    doneDocs += docs.length;
    if (onProgress) await onProgress({ i: i + 1, total: collNames.length, name, docs: docs.length });
  }
  return { ok: true, restored: collNames.length, totalDocuments: doneDocs };
}

module.exports = {
  BACKUP_DIR, redactUri, timestamp,
  statusActive, testUri, backupActive, listBackups,
  migrate, switchActive, restoreFromFile,
};
