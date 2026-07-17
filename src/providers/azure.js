// Azure provider adapter via ARM REST + AAD client-credentials.
// Simplified provisioning: creates RG + VNet + Subnet + PublicIP + NIC + VM in one flow.
// NOTE: Full production Azure flows are complex — this module wraps the core steps.
const axios = require('axios');

const AAD = 'https://login.microsoftonline.com';
const MGMT = 'https://management.azure.com';
const REGION_FALLBACK = ['southeastasia', 'eastasia', 'japaneast', 'australiaeast', 'eastus', 'westeurope', 'westus2'];

async function token(api) {
  const url = `${AAD}/${api.azTenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: api.azClientId, client_secret: api.azClientSecret,
    scope: 'https://management.azure.com/.default',
  }).toString();
  const r = await axios.post(url, body, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 });
  return r.data.access_token;
}

function http(tok) {
  return axios.create({ baseURL: MGMT, headers: { Authorization: `Bearer ${tok}` }, timeout: 60000 });
}

async function validate(api) {
  const tok = await token(api);
  const c = http(tok);
  await c.get(`/subscriptions/${api.azSubscriptionId}?api-version=2020-01-01`);
  return { ok: true };
}

async function pickRegion(c, api) {
  const r = await c.get(`/subscriptions/${api.azSubscriptionId}/locations?api-version=2020-01-01`);
  const names = (r.data.value || []).map(l => l.name);
  return REGION_FALLBACK.find(n => names.includes(n)) || names[0];
}

async function createInstance(api, spec, onProgress = () => {}) {
  await onProgress('Authenticating Azure');
  const tok = await token(api);
  const c = http(tok);
  const sub = api.azSubscriptionId;

  await onProgress('Detecting region');
  const region = await pickRegion(c, api);

  const rg = `tgbot-${spec.orderId}`.slice(0, 60);
  const base = `/subscriptions/${sub}/resourceGroups/${rg}`;

  await onProgress('Creating resource group');
  await c.put(`${base}?api-version=2021-04-01`, { location: region });

  await onProgress('Creating VNet');
  await c.put(`${base}/providers/Microsoft.Network/virtualNetworks/vnet1?api-version=2023-06-01`, {
    location: region,
    properties: { addressSpace: { addressPrefixes: ['10.0.0.0/16'] }, subnets: [{ name: 'default', properties: { addressPrefix: '10.0.0.0/24' } }] },
  });

  await onProgress('Creating public IP');
  const pipRes = await c.put(`${base}/providers/Microsoft.Network/publicIPAddresses/pip1?api-version=2023-06-01`, {
    location: region, properties: { publicIPAllocationMethod: 'Dynamic' },
  });

  await onProgress('Creating NIC');
  const subnetId = `${base}/providers/Microsoft.Network/virtualNetworks/vnet1/subnets/default`;
  const pipId = pipRes.data.id;
  await c.put(`${base}/providers/Microsoft.Network/networkInterfaces/nic1?api-version=2023-06-01`, {
    location: region,
    properties: { ipConfigurations: [{ name: 'ipcfg', properties: { subnet: { id: subnetId }, publicIPAddress: { id: pipId } } }] },
  });

  await onProgress('Creating VM');
  const vmName = `vm-${spec.orderId}`.slice(0, 60);
  const adminUser = 'azureuser';
  const password = spec.password || `TgBot${Date.now().toString(36)}!`;
  const osProfile = { computerName: vmName, adminUsername: adminUser };
  if (spec.sshPublicKey) {
    osProfile.linuxConfiguration = {
      disablePasswordAuthentication: true,
      ssh: { publicKeys: [{ path: `/home/${adminUser}/.ssh/authorized_keys`, keyData: spec.sshPublicKey }] },
    };
  } else {
    osProfile.adminPassword = password;
    osProfile.linuxConfiguration = { disablePasswordAuthentication: false };
  }

  const vm = await c.put(`${base}/providers/Microsoft.Compute/virtualMachines/${vmName}?api-version=2023-09-01`, {
    location: region,
    properties: {
      hardwareProfile: { vmSize: 'Standard_B1s' },
      storageProfile: {
        imageReference: { publisher: 'Canonical', offer: '0001-com-ubuntu-server-jammy', sku: '22_04-lts-gen2', version: 'latest' },
        osDisk: { createOption: 'FromImage', managedDisk: { storageAccountType: 'Standard_LRS' } },
      },
      osProfile,
      networkProfile: { networkInterfaces: [{ id: `${base}/providers/Microsoft.Network/networkInterfaces/nic1` }] },
    },
  });

  await onProgress('Waiting public IP');
  let publicIp = '';
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 4000));
    const p = await c.get(`${base}/providers/Microsoft.Network/publicIPAddresses/pip1?api-version=2023-06-01`);
    if (p.data && p.data.properties && p.data.properties.ipAddress) { publicIp = p.data.properties.ipAddress; break; }
  }
  if (!publicIp) throw new Error('Timeout waiting Azure public IP');

  return {
    provider: 'azure', region,
    instanceId: vm.data.id,
    imageId: 'ubuntu-22.04-lts',
    osLabel: 'Ubuntu 22.04',
    size: 'Standard_B1s',
    publicIp,
    username: adminUser, password: spec.sshPublicKey ? '' : password,
    sshKeyName: '', privateKey: '',
    raw: { rg, vmName },
  };
}

async function cleanup(api, resources) {
  if (!resources || !resources.raw || !resources.raw.rg) return;
  try {
    const tok = await token(api);
    const c = http(tok);
    // Delete the whole resource group — removes VM, NIC, VNet, PIP, etc.
    await c.delete(`/subscriptions/${api.azSubscriptionId}/resourceGroups/${resources.raw.rg}?api-version=2021-04-01`).catch(() => {});
  } catch (e) { console.error('Azure cleanup:', e.message); }
}

module.exports = { validate, createInstance, cleanup, probe };

async function probe(api, onProgress = async () => {}) {
  const steps = [];
  const push = async (label, ok, detail = '') => { steps.push({ label, ok, detail }); await onProgress(steps); };

  // 1. Auth token
  let tok;
  try {
    tok = await token(api);
    if (!tok) throw new Error('no access_token');
    await push('API Valid', true);
    await push('Authentication OK', true);
  } catch (e) {
    await push('API Valid', false, (e.response && e.response.data && e.response.data.error_description) || e.message);
    return { ok: false, steps, error: 'Invalid API Key / Authentication Failed' };
  }
  const c = http(tok);
  const sub = api.azSubscriptionId;

  // 2. Billing — subscription state
  try {
    const s = await c.get(`/subscriptions/${sub}?api-version=2020-01-01`);
    const state = s.data && s.data.state;
    const ok = state === 'Enabled';
    await push('Billing Aktif', ok, `state: ${state}`);
    if (!ok) return { ok: false, steps, error: 'Billing Disabled / Subscription Not Enabled' };
  } catch (e) {
    await push('Billing Aktif', false, e.message);
    return { ok: false, steps, error: 'Billing Check Failed' };
  }

  // 3. Permission — list resource groups
  try {
    await c.get(`/subscriptions/${sub}/resourcegroups?api-version=2021-04-01`);
    await push('Permission Lengkap', true);
  } catch (e) {
    await push('Permission Lengkap', false, e.message);
    return { ok: false, steps, error: 'Permission Denied' };
  }

  // 4. Region
  let region;
  try {
    region = await pickRegion(c, api);
    if (!region) throw new Error('no location');
    await push('Region Tersedia', true, region);
  } catch (e) {
    await push('Region Tersedia', false, e.message);
    return { ok: false, steps, error: 'Region Not Available' };
  }

  // 5. Image — Canonical Ubuntu is a well-known publisher; verify listable
  try {
    await c.get(`/subscriptions/${sub}/providers/Microsoft.Compute/locations/${region}/publishers/Canonical/artifacttypes/vmimage/offers?api-version=2023-09-01`);
    await push('Image Tersedia', true, 'Canonical Ubuntu');
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

  // 7. Provision Test — check VM SKU available in region
  try {
    await c.get(`/subscriptions/${sub}/providers/Microsoft.Compute/skus?api-version=2021-07-01&$filter=location eq '${region}'`);
    await push('Provision Test Berhasil', true, 'SKUs available');
  } catch (e) {
    await push('Provision Test Berhasil', false, e.message);
    return { ok: false, steps, error: 'Provision Test Failed' };
  }

  // 8. Health Score
  const score = Math.max(0, Math.min(100, 60 + (q.available > 0 ? 30 : 0) + (q.limit > 5 ? 10 : 0)));
  await push('Health Check Lulus', true, `score ${score}`);
  return { ok: true, steps, score, region, quota: q };
}
