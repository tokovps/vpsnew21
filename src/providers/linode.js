// Linode (Akamai) provider adapter via REST API v4
const axios = require('axios');

const API = 'https://api.linode.com/v4';
const REGION_FALLBACK = ['ap-south', 'ap-southeast', 'ap-northeast', 'ap-west', 'us-east', 'us-west', 'eu-west', 'eu-central'];
const TYPE_FALLBACK = ['g6-nanode-1', 'g6-standard-1', 'g6-standard-2'];

function http(api) {
  return axios.create({
    baseURL: API,
    headers: { Authorization: `Bearer ${api.linodeToken}`, 'Content-Type': 'application/json' },
    timeout: 30000,
  });
}

async function validate(api) {
  const c = http(api);
  const r = await c.get('/account');
  return { ok: true, email: r.data && r.data.email };
}

async function pickRegionType(c) {
  const [r1, r2] = await Promise.all([c.get('/regions?page_size=100'), c.get('/linode/types?page_size=100')]);
  const regions = (r1.data.data || []).map(r => r.id);
  const types = (r2.data.data || []).map(t => t.id);
  const region = REGION_FALLBACK.find(r => regions.includes(r)) || regions[0];
  const type = TYPE_FALLBACK.find(t => types.includes(t)) || types[0];
  return { region, type };
}

async function pickImage(c, osFamily, osVersion) {
  const r = await c.get('/images?page_size=200');
  const list = (r.data.data || []).filter(i => !i.is_public === false); // public
  const fam = String(osFamily || 'ubuntu').toLowerCase();
  const ver = String(osVersion || '').replace(/[^0-9.]/g, '');
  const candidates = list.filter(i => (i.id || '').toLowerCase().includes(fam));
  const pick = ver ? candidates.find(i => (i.id || '').includes(ver.replace('.', ''))) : null;
  return (pick || candidates[0] || list.find(i => (i.id || '').startsWith('linode/ubuntu'))).id;
}

function randomPassword(len = 20) {
  const s = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  let out = '';
  for (let i = 0; i < len; i++) out += s[Math.floor(Math.random() * s.length)];
  return out;
}

async function createInstance(api, spec, onProgress = () => {}) {
  const c = http(api);
  await onProgress('Detecting region & type');
  const { region, type } = await pickRegionType(c);
  await onProgress('Checking image');
  const image = await pickImage(c, spec.osFamily, spec.osVersion);

  const rootPass = spec.password || randomPassword();
  const payload = {
    region, type, image,
    label: `tgbot-${spec.orderId}`.slice(0, 60),
    root_pass: rootPass,
    tags: ['tgbot'],
    booted: true,
  };
  if (spec.sshPublicKey) payload.authorized_keys = [spec.sshPublicKey];

  await onProgress('Creating instance');
  const cr = await c.post('/linode/instances', payload);
  const l = cr.data;

  await onProgress('Waiting public IP');
  let publicIp = '';
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 4000));
    const d = await c.get(`/linode/instances/${l.id}`);
    const ips = (d.data && d.data.ipv4) || [];
    if (ips[0]) { publicIp = ips[0]; break; }
  }
  if (!publicIp) throw new Error('Timeout waiting public IP');

  return {
    provider: 'linode', region,
    instanceId: String(l.id),
    imageId: image,
    osLabel: `${spec.osFamily} ${spec.osVersion}`.trim(),
    size: type, publicIp,
    username: 'root', password: rootPass,
    sshKeyName: '', privateKey: '',
    raw: { linodeId: l.id },
  };
}

async function getInstance(api, instanceId) {
  if (!instanceId) return { status: 'unknown', exists: false };
  try {
    const c = http(api);
    const r = await c.get(`/linode/instances/${instanceId}`);
    const l = r.data;
    if (!l) return { status: 'gone', exists: false };
    // Linode status: running | offline | booting | shutting_down | provisioning | deleting | migrating
    return {
      exists: true,
      status: l.status || 'unknown',
      powerState: l.status,
      publicIp: (l.ipv4 && l.ipv4[0]) || '',
      raw: { id: l.id, label: l.label, type: l.type },
    };
  } catch (e) {
    if (e.response && e.response.status === 404) {
      return { status: 'destroyed', exists: false };
    }
    return { status: 'unknown', exists: false, error: String(e && e.message) };
  }
}

async function cleanup(api, resources) {
  if (!resources || !resources.instanceId) return;
  try {
    const c = http(api);
    await c.delete(`/linode/instances/${resources.instanceId}`).catch(() => {});
  } catch (e) { console.error('Linode cleanup:', e.message); }
}

module.exports = { validate, createInstance, cleanup, probe, getInstance };

async function probe(api, onProgress = async () => {}) {
  const steps = [];
  const push = async (label, ok, detail = '') => { steps.push({ label, ok, detail }); await onProgress(steps); };
  const c = http(api);

  // 1. Validate + Auth
  let account;
  try {
    const r = await c.get('/account');
    account = r.data;
    if (!account || !account.email) throw new Error('empty account');
    await push('API Valid', true);
    await push('Authentication OK', true, account.email);
  } catch (e) {
    await push('API Valid', false, (e.response && e.response.status === 401) ? 'unauthorized' : e.message);
    return { ok: false, steps, error: 'Invalid API Key / Authentication Failed' };
  }

  // 2. Billing — Linode balance <= 0 with active_since older means paying
  try {
    const balance = account.balance;
    const active = !!account.active_since;
    const ok = active && (balance == null || balance >= -50); // -50 = grace
    await push('Billing Aktif', ok, `balance: ${balance}`);
    if (!ok) return { ok: false, steps, error: 'Billing Disabled' };
  } catch (e) { await push('Billing Aktif', false, e.message); return { ok: false, steps, error: 'Billing Check Failed' }; }

  // 3. Permission
  try {
    await c.get('/linode/instances?page_size=1');
    await push('Permission Lengkap', true);
  } catch (e) {
    await push('Permission Lengkap', false, e.message);
    return { ok: false, steps, error: 'Permission Denied' };
  }

  // 4. Region + Type + 5. Image
  let region, type, image;
  try {
    const rt = await pickRegionType(c);
    region = rt.region; type = rt.type;
    if (!region || !type) throw new Error('no region/type');
    await push('Region Tersedia', true, `${region} • ${type}`);
  } catch (e) {
    await push('Region Tersedia', false, e.message);
    return { ok: false, steps, error: 'Region Not Available' };
  }
  try {
    image = await pickImage(c, 'ubuntu', '');
    if (!image) throw new Error('no ubuntu image');
    await push('Image Tersedia', true, image);
  } catch (e) {
    await push('Image Tersedia', false, e.message);
    return { ok: false, steps, error: 'Image Not Available' };
  }

  // 6. Quota
  let q = { available: 0, used: 0, limit: 0 };
  try {
    const quota = require('./quota');
    q = await quota.forApi(api);
    if (q.limit > 0 && q.available <= 0) {
      await push('Quota Tersedia', false, `used ${q.used}/${q.limit}`);
      return { ok: false, steps, error: 'Quota Full' };
    }
    await push('Quota Tersedia', true, `available ${q.available}/${q.limit || '?'}`);
  } catch (e) { await push('Quota Tersedia', false, e.message); }

  // 7. Provision Test — Linode has no dry-run; probe /linode/types & region availability
  try {
    await c.get(`/linode/types/${type}`);
    await push('Provision Test Berhasil', true, 'type verified');
  } catch (e) {
    await push('Provision Test Berhasil', false, e.message);
    return { ok: false, steps, error: 'Provision Test Failed' };
  }

  // 8. Health Score
  const score = Math.max(0, Math.min(100, 60 + (q.available > 0 ? 30 : 0) + (q.limit > 5 ? 10 : 0)));
  await push('Health Check Lulus', true, `score ${score}`);
  return { ok: true, steps, score, region, quota: q };
}
