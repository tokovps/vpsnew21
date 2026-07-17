// VPS action helpers (reboot/stop/start/delete/getStatus) for each provider.
// Consumed by src/handlers/vpsManagementHandler.js and src/health/vpsHealth.js.
//
// Each function receives the ProviderApi document + the VpsInstance document
// (or a plain object with instanceId/region/raw). Return `{ ok, status?, error? }`.
//
// If a provider action isn't supported, returns `{ ok: false, error: 'unsupported' }`.
const axios = require('axios');

// ============ AWS ============
async function awsClient(api, region) {
  const { EC2Client } = require('@aws-sdk/client-ec2');
  return new EC2Client({
    region: region || api.awsRegion || 'us-east-1',
    credentials: { accessKeyId: api.awsAccessKey, secretAccessKey: api.awsSecretKey },
    maxAttempts: 3,
  });
}
const awsActions = {
  async getStatus(api, inst) {
    const { DescribeInstancesCommand } = require('@aws-sdk/client-ec2');
    const c = await awsClient(api, inst.region);
    try {
      const r = await c.send(new DescribeInstancesCommand({ InstanceIds: [inst.instanceId] }));
      const cur = r.Reservations && r.Reservations[0] && r.Reservations[0].Instances && r.Reservations[0].Instances[0];
      return { ok: true, status: mapAwsState((cur && cur.State && cur.State.Name) || 'unknown') };
    } catch (e) { return { ok: false, error: e.message }; }
  },
  async reboot(api, inst) {
    const { RebootInstancesCommand } = require('@aws-sdk/client-ec2');
    const c = await awsClient(api, inst.region);
    try { await c.send(new RebootInstancesCommand({ InstanceIds: [inst.instanceId] })); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  },
  async stop(api, inst) {
    const { StopInstancesCommand } = require('@aws-sdk/client-ec2');
    const c = await awsClient(api, inst.region);
    try { await c.send(new StopInstancesCommand({ InstanceIds: [inst.instanceId] })); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  },
  async start(api, inst) {
    const { StartInstancesCommand } = require('@aws-sdk/client-ec2');
    const c = await awsClient(api, inst.region);
    try { await c.send(new StartInstancesCommand({ InstanceIds: [inst.instanceId] })); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  },
  async del(api, inst) {
    const { TerminateInstancesCommand } = require('@aws-sdk/client-ec2');
    const c = await awsClient(api, inst.region);
    try { await c.send(new TerminateInstancesCommand({ InstanceIds: [inst.instanceId] })); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  },
};
function mapAwsState(s) {
  if (s === 'running') return 'running';
  if (s === 'stopped') return 'stopped';
  if (s === 'terminated' || s === 'shutting-down') return 'terminated';
  return s;
}

// ============ DigitalOcean ============
function doHttp(api) {
  return axios.create({
    baseURL: 'https://api.digitalocean.com/v2',
    headers: { Authorization: `Bearer ${api.doToken}`, 'Content-Type': 'application/json' },
    timeout: 30000,
  });
}
const doActions = {
  async getStatus(api, inst) {
    try {
      const r = await doHttp(api).get(`/droplets/${inst.instanceId}`);
      const st = r.data && r.data.droplet && r.data.droplet.status;
      return { ok: true, status: st === 'active' ? 'running' : st === 'off' ? 'stopped' : (st || 'unknown') };
    } catch (e) {
      if (e.response && e.response.status === 404) return { ok: true, status: 'terminated' };
      return { ok: false, error: e.message };
    }
  },
  reboot: (api, inst) => doHttp(api).post(`/droplets/${inst.instanceId}/actions`, { type: 'reboot' }).then(() => ({ ok: true })).catch(e => ({ ok: false, error: e.message })),
  stop:   (api, inst) => doHttp(api).post(`/droplets/${inst.instanceId}/actions`, { type: 'shutdown' }).then(() => ({ ok: true })).catch(e => ({ ok: false, error: e.message })),
  start:  (api, inst) => doHttp(api).post(`/droplets/${inst.instanceId}/actions`, { type: 'power_on' }).then(() => ({ ok: true })).catch(e => ({ ok: false, error: e.message })),
  del:    (api, inst) => doHttp(api).delete(`/droplets/${inst.instanceId}`).then(() => ({ ok: true })).catch(e => ({ ok: false, error: e.message })),
};

// ============ Linode ============
function linHttp(api) {
  return axios.create({
    baseURL: 'https://api.linode.com/v4',
    headers: { Authorization: `Bearer ${api.linodeToken}`, 'Content-Type': 'application/json' },
    timeout: 30000,
  });
}
const linodeActions = {
  async getStatus(api, inst) {
    try {
      const r = await linHttp(api).get(`/linode/instances/${inst.instanceId}`);
      const st = r.data && r.data.status;
      const map = { running: 'running', offline: 'stopped', stopped: 'stopped' };
      return { ok: true, status: map[st] || st || 'unknown' };
    } catch (e) {
      if (e.response && e.response.status === 404) return { ok: true, status: 'terminated' };
      return { ok: false, error: e.message };
    }
  },
  reboot: (api, inst) => linHttp(api).post(`/linode/instances/${inst.instanceId}/reboot`).then(() => ({ ok: true })).catch(e => ({ ok: false, error: e.message })),
  stop:   (api, inst) => linHttp(api).post(`/linode/instances/${inst.instanceId}/shutdown`).then(() => ({ ok: true })).catch(e => ({ ok: false, error: e.message })),
  start:  (api, inst) => linHttp(api).post(`/linode/instances/${inst.instanceId}/boot`).then(() => ({ ok: true })).catch(e => ({ ok: false, error: e.message })),
  del:    (api, inst) => linHttp(api).delete(`/linode/instances/${inst.instanceId}`).then(() => ({ ok: true })).catch(e => ({ ok: false, error: e.message })),
};

// ============ Azure ============
async function azToken(api) {
  const url = `https://login.microsoftonline.com/${api.azTenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: api.azClientId, client_secret: api.azClientSecret,
    scope: 'https://management.azure.com/.default',
  }).toString();
  const r = await axios.post(url, body, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 });
  return r.data.access_token;
}
function azBase(api, inst) {
  const rg = inst.raw && inst.raw.rg;
  const vm = inst.raw && inst.raw.vmName;
  return { rg, vm, sub: api.azSubscriptionId };
}
const azureActions = {
  async getStatus(api, inst) {
    try {
      const tok = await azToken(api);
      const { rg, vm, sub } = azBase(api, inst);
      if (!rg || !vm) return { ok: false, error: 'missing raw.rg/vmName' };
      const r = await axios.get(
        `https://management.azure.com/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Compute/virtualMachines/${vm}/instanceView?api-version=2023-09-01`,
        { headers: { Authorization: `Bearer ${tok}` } });
      const codes = ((r.data && r.data.statuses) || []).map(s => s.code || '').join(',');
      const st = codes.includes('PowerState/running') ? 'running'
              : codes.includes('PowerState/stopped') || codes.includes('PowerState/deallocated') ? 'stopped'
              : 'unknown';
      return { ok: true, status: st };
    } catch (e) {
      if (e.response && e.response.status === 404) return { ok: true, status: 'terminated' };
      return { ok: false, error: e.message };
    }
  },
  reboot: async (api, inst) => azOp(api, inst, 'restart'),
  stop:   async (api, inst) => azOp(api, inst, 'deallocate'),
  start:  async (api, inst) => azOp(api, inst, 'start'),
  del:    async (api, inst) => {
    try {
      const tok = await azToken(api);
      const { rg, sub } = azBase(api, inst);
      await axios.delete(`https://management.azure.com/subscriptions/${sub}/resourceGroups/${rg}?api-version=2021-04-01`,
        { headers: { Authorization: `Bearer ${tok}` } });
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  },
};
async function azOp(api, inst, op) {
  try {
    const tok = await azToken(api);
    const { rg, vm, sub } = azBase(api, inst);
    await axios.post(
      `https://management.azure.com/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Compute/virtualMachines/${vm}/${op}?api-version=2023-09-01`,
      {}, { headers: { Authorization: `Bearer ${tok}` } });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

const REGISTRY = {
  aws: awsActions,
  digitalocean: doActions,
  linode: linodeActions,
  azure: azureActions,
};

function forProvider(p) { return REGISTRY[p] || null; }

module.exports = { forProvider, REGISTRY };
