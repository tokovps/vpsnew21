const fs = require('fs');
const path = require('path');
const Translation = require('../models/Translation');
const Setting = require('../models/Setting');

// Auto-discover language files. Drop `<code>.json` in this dir to add a language.
const LANGS = [];
const FILE_BUNDLES = {};   // { id: {key: 'value', ...}, en: {...} }
try {
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'i18n'))) {
    if (!f.endsWith('.json')) continue;
    const code = f.replace(/\.json$/, '');
    try {
      FILE_BUNDLES[code] = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'i18n', f), 'utf8'));
      LANGS.push(code);
    } catch (e) { console.error(`i18n load ${f}:`, e.message); }
  }
} catch (_) {}
if (!LANGS.length) LANGS.push('id', 'en');

// Legacy BUILTIN retained for very-old fallback path
const BUILTIN = {};
for (const code of Object.keys(FILE_BUNDLES)) {
  for (const [k, v] of Object.entries(FILE_BUNDLES[code])) {
    BUILTIN[k] = BUILTIN[k] || {};
    BUILTIN[k][code] = v;
  }
}

async function ensureSeed() {
  const c = await Translation.countDocuments();
  if (c > 0) return;
  await Translation.insertMany(Object.keys(BUILTIN).map(k => ({ key: k, values: BUILTIN[k] })));
}

// Return string for key & lang. Falls back en → id → key.
async function t(key, lang = 'id') {
  const doc = await Translation.findOne({ key }).lean();
  const v = doc && doc.values || BUILTIN[key] || {};
  return v[lang] || v.id || v.en || key;
}

async function tMap(keys, lang = 'id') {
  const docs = await Translation.find({ key: { $in: keys } }).lean();
  const m = Object.fromEntries(docs.map(d => [d.key, d.values || {}]));
  return Object.fromEntries(keys.map(k => {
    const v = m[k] || BUILTIN[k] || {};
    return [k, v[lang] || v.id || v.en || k];
  }));
}

async function userLang(user) {
  if (user && user.language && LANGS.includes(user.language)) return user.language;
  const s = await Setting.findOne({ key: 'global' });
  return (s && s.defaultLanguage) || 'id';
}

async function upsertKey(key, values) {
  return Translation.findOneAndUpdate({ key }, { $set: { values } }, { new: true, upsert: true });
}

async function listAll() { return Translation.find({}).sort({ key: 1 }).lean(); }

module.exports = { LANGS, t, tMap, userLang, ensureSeed, upsertKey, listAll };
