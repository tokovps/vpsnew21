// Real quota introspection per provider.
// Returns { available: number, used: number, limit: number }.
// All methods are best-effort — fall back to reasonable defaults on API error.
const axios = require('axios');
const { EC2Client, DescribeInstancesCommand } = require('@aws-sdk/client-ec2');
const { ServiceQuotasClient, GetServiceQuotaCommand } = (() => {
  try { return require('@aws-sdk/client-service-quotas'); } catch { return {}; }
})();

async function aws(api) {
  const region = api.awsRegion || 'us-east-1';
  const creds = { accessKeyId: api.awsAccessKey, secretAccessKey: api.awsSecretKey };
  const ec2 = new EC2Client({ region, credentials: creds, maxAttempts: 2 });
  let limit = 5; // default on-demand small instance limit for new accounts
  try {
    if (ServiceQuotasClient) {
      const sq = new ServiceQuotasClient({ region, credentials: creds, maxAttempts: 2 });
      // "Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances" = L-1216C47A
      const q = await sq.send(new GetServiceQuotaCommand({ ServiceCode: 'ec2', QuotaCode: 'L-1216C47A' }));
      if (q.Quota && q.Quota.Value) limit = Math.floor(q.Quota.Value);
    }
  } catch (_) {}
  let used = 0;
  try {
    const r = await ec2.send(new DescribeInstancesCommand({
      Filters: [{ Name: 'instance-state-name', Values: ['pending', 'running'] }],
    }));
    for (const res of (r.Reservations || [])) used += (res.Instances || []).length;
  } catch (_) {}
  return { available: Math.max(0, limit - used), used, limit };
}

async function digitalocean(api) {
  try {
    const c = axios.create({ baseURL: 'https://api.digitalocean.com/v2', headers: { Authorization: `Bearer ${api.doToken}` }, timeout: 15000 });
    const a = await c.get('/account');
    const limit = a.data.account && a.data.account.droplet_limit || 10;
    const d = await c.get('/droplets?per_page=1');
    const used = (d.data && d.data.meta && d.data.meta.total) || 0;
    return { available: Math.max(0, limit - used), used, limit };
  } catch { return { available: 0, used: 0, limit: 0 }; }
}

async function linode(api) {
  try {
    const c = axios.create({ baseURL: 'https://api.linode.com/v4', headers: { Authorization: `Bearer ${api.linodeToken}` }, timeout: 15000 });
    const r = await c.get('/linode/instances?page_size=1');
    const used = (r.data && r.data.results) || 0;
    // Linode does not expose a strict "droplet limit"; use conservative default 25
    const limit = 25;
    return { available: Math.max(0, limit - used), used, limit };
  } catch { return { available: 0, used: 0, limit: 0 }; }
}

async function azure(api) {
  try {
    // Reuse the auth code from adapter
    const AAD = 'https://login.microsoftonline.com';
    const url = `${AAD}/${api.azTenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: api.azClientId, client_secret: api.azClientSecret,
      scope: 'https://management.azure.com/.default',
    }).toString();
    const tokR = await axios.post(url, body, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });
    const tok = tokR.data.access_token;
    const region = 'southeastasia';
    const u = await axios.get(
      `https://management.azure.com/subscriptions/${api.azSubscriptionId}/providers/Microsoft.Compute/locations/${region}/usages?api-version=2023-09-01`,
      { headers: { Authorization: `Bearer ${tok}` }, timeout: 15000 },
    );
    // Aggregate all quotas — pick "standardBSFamily" or "cores" as headline
    const rows = (u.data && u.data.value) || [];
    const cores = rows.find(r => r.name && r.name.value === 'cores') || rows[0];
    if (!cores) return { available: 0, used: 0, limit: 0 };
    const limit = cores.limit || 0, used = cores.currentValue || 0;
    return { available: Math.max(0, limit - used), used, limit };
  } catch { return { available: 0, used: 0, limit: 0 }; }
}

const map = { aws, digitalocean, linode, azure };

async function forApi(api) {
  const fn = map[api.provider];
  if (!fn) return { available: 0, used: 0, limit: 0 };
  return fn(api);
}

module.exports = { forApi };
