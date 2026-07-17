// Plugin-based Smart Provider Engine — auto-discovers adapters from filesystem.
// To add a new provider (e.g., Vultr / Hetzner / OCI): drop a `<name>.js` in this folder
// exporting { validate, createInstance, [cleanup] } and add credential fields to ProviderApi model.
const fs = require('fs');
const path = require('path');

const EXCLUDE = new Set(['index.js', 'quota.js', 'actions.js']);
const ADAPTERS = {};

for (const f of fs.readdirSync(__dirname)) {
  if (!f.endsWith('.js') || EXCLUDE.has(f)) continue;
  const name = f.replace(/\.js$/, '');
  try {
    const mod = require(path.join(__dirname, f));
    if (mod && typeof mod.validate === 'function' && typeof mod.createInstance === 'function') {
      ADAPTERS[name] = mod;
    }
  } catch (e) { console.error(`Plugin load failed: ${f}`, e.message); }
}

function get(provider) {
  const a = ADAPTERS[provider];
  if (!a) throw new Error('Unknown provider: ' + provider);
  return a;
}

function list() { return Object.keys(ADAPTERS); }

async function healthCheck(api) {
  const a = get(api.provider);
  try {
    const res = await a.validate(api);
    return { ok: true, res };
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
}

// Deep probe — reports step-by-step validation via onProgress(steps[]).
// Delegates to adapter.probe() if defined; otherwise runs generic validate+quota fallback.
// Never mutates DB. Use this BEFORE persisting a new provider API.
async function deepProbe(api, onProgress = async () => {}) {
  const a = get(api.provider);
  if (typeof a.probe === 'function') return a.probe(api, onProgress);
  // Fallback: validate + quota only
  const steps = [];
  const push = async (label, ok, detail = '') => { steps.push({ label, ok, detail }); await onProgress(steps); };
  try {
    await a.validate(api);
    await push('API Valid', true);
    await push('Authentication OK', true);
  } catch (e) {
    await push('API Valid', false, e.message);
    return { ok: false, steps, error: 'Invalid API Key / Authentication Failed' };
  }
  try {
    const q = await require('./quota').forApi(api);
    if (q.limit > 0 && q.available <= 0) {
      await push('Quota Tersedia', false, `used ${q.used}/${q.limit}`);
      return { ok: false, steps, error: 'Quota Full' };
    }
    await push('Quota Tersedia', true, `available ${q.available}/${q.limit || '?'}`);
    await push('Health Check Lulus', true);
    return { ok: true, steps, score: 60, quota: q };
  } catch (e) {
    await push('Quota Tersedia', false, e.message);
    return { ok: false, steps, error: 'Quota Check Failed' };
  }
}

module.exports = { get, list, healthCheck, deepProbe, ADAPTERS };
