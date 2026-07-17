// AWS EC2 provider adapter (Free Tier-oriented, auto-discovery).
// Uses @aws-sdk/client-ec2 (v3). Fully async, non-blocking.
const {
  EC2Client,
  DescribeRegionsCommand,
  DescribeImagesCommand,
  DescribeVpcsCommand,
  DescribeSubnetsCommand,
  DescribeSecurityGroupsCommand,
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
  ImportKeyPairCommand,
  DescribeKeyPairsCommand,
  CreateKeyPairCommand,
  RunInstancesCommand,
  DescribeInstancesCommand,
  DescribeInstanceTypeOfferingsCommand,
  DescribeAvailabilityZonesCommand,
} = require('@aws-sdk/client-ec2');

const DEFAULT_REGION_FALLBACK = [
  'ap-southeast-1', // Singapore
  'ap-northeast-1', // Tokyo
  'ap-east-1',      // Hong Kong
  'ap-southeast-2', // Sydney
  'us-east-1', 'us-west-2', 'eu-west-1', 'eu-central-1',
];

const FREE_TIER_INSTANCE_TYPES = ['t2.micro', 't3.micro', 't3a.micro', 't4g.small', 't2.small'];

function client(api, region) {
  return new EC2Client({
    region,
    credentials: { accessKeyId: api.awsAccessKey, secretAccessKey: api.awsSecretKey },
    maxAttempts: 3,
  });
}

// STEP 1 — validate credentials by listing regions
async function validate(api) {
  const region = api.awsRegion || 'us-east-1';
  const c = client(api, region);
  const out = await c.send(new DescribeRegionsCommand({ AllRegions: false }));
  return { ok: true, regions: (out.Regions || []).map(r => r.RegionName) };
}

// Pick best region: prefer user's saved region if valid, else fallback list intersected with account regions.
async function pickRegion(api, preferred) {
  const region = 'us-east-1';
  const c = client(api, region);
  const out = await c.send(new DescribeRegionsCommand({ AllRegions: false }));
  const enabled = (out.Regions || []).map(r => r.RegionName);
  if (preferred && enabled.includes(preferred)) return preferred;
  for (const r of DEFAULT_REGION_FALLBACK) if (enabled.includes(r)) return r;
  return enabled[0];
}

// Pick a supported free-tier instance type available in region
async function pickInstanceType(c) {
  const resp = await c.send(new DescribeInstanceTypeOfferingsCommand({
    LocationType: 'region',
    Filters: [{ Name: 'instance-type', Values: FREE_TIER_INSTANCE_TYPES }],
  }));
  const available = new Set((resp.InstanceTypeOfferings || []).map(o => o.InstanceType));
  for (const t of FREE_TIER_INSTANCE_TYPES) if (available.has(t)) return t;
  return null;
}

// Find AMI for requested OS family/version (auto fallback ubuntu 24 → 22 → 20 → any latest ubuntu)
async function pickAmi(c, osFamily = 'Ubuntu', osVersion = '') {
  // Canonical (099720109477) Ubuntu AMIs
  const owner = '099720109477';
  const versions = [];
  const v = String(osVersion || '').toLowerCase();
  if (/24/.test(v)) versions.push('24.04');
  if (/22/.test(v)) versions.push('22.04');
  if (/20/.test(v)) versions.push('20.04');
  if (!versions.length) versions.push('24.04', '22.04', '20.04');
  for (const ver of versions) {
    const out = await c.send(new DescribeImagesCommand({
      Owners: [owner],
      Filters: [
        { Name: 'name', Values: [`ubuntu/images/hvm-ssd/ubuntu-*${ver}*-amd64-server-*`, `ubuntu/images/hvm-ssd-gp3/ubuntu-*${ver}*-amd64-server-*`] },
        { Name: 'state', Values: ['available'] },
        { Name: 'architecture', Values: ['x86_64'] },
      ],
    }));
    const imgs = (out.Images || []).sort((a, b) => (b.CreationDate || '').localeCompare(a.CreationDate || ''));
    if (imgs.length) return { imageId: imgs[0].ImageId, name: imgs[0].Name, version: ver };
  }
  // Last resort: any ubuntu
  const out = await c.send(new DescribeImagesCommand({
    Owners: [owner],
    Filters: [{ Name: 'state', Values: ['available'] }, { Name: 'architecture', Values: ['x86_64'] }],
  }));
  const imgs = (out.Images || []).sort((a, b) => (b.CreationDate || '').localeCompare(a.CreationDate || ''));
  if (imgs.length) return { imageId: imgs[0].ImageId, name: imgs[0].Name, version: 'latest' };
  return null;
}

async function ensureDefaultVpcAndSubnet(c) {
  const vpcs = await c.send(new DescribeVpcsCommand({ Filters: [{ Name: 'isDefault', Values: ['true'] }] }));
  const vpc = (vpcs.Vpcs || [])[0];
  if (!vpc) throw new Error('No default VPC in region');
  const subnets = await c.send(new DescribeSubnetsCommand({ Filters: [{ Name: 'vpc-id', Values: [vpc.VpcId] }] }));
  const sub = (subnets.Subnets || []).find(s => s.MapPublicIpOnLaunch) || (subnets.Subnets || [])[0];
  if (!sub) throw new Error('No subnet in default VPC');
  return { vpcId: vpc.VpcId, subnetId: sub.SubnetId };
}

async function ensureSecurityGroup(c, vpcId) {
  const name = 'tgbot-vps-sg';
  const sg = await c.send(new DescribeSecurityGroupsCommand({
    Filters: [{ Name: 'group-name', Values: [name] }, { Name: 'vpc-id', Values: [vpcId] }],
  }));
  if ((sg.SecurityGroups || []).length) return sg.SecurityGroups[0].GroupId;
  const create = await c.send(new CreateSecurityGroupCommand({
    GroupName: name, Description: 'tgbot managed', VpcId: vpcId,
  }));
  const gid = create.GroupId;
  await c.send(new AuthorizeSecurityGroupIngressCommand({
    GroupId: gid,
    IpPermissions: [
      { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '0.0.0.0/0' }] },
      { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, IpRanges: [{ CidrIp: '0.0.0.0/0' }] },
      { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: '0.0.0.0/0' }] },
    ],
  })).catch(() => {});
  return gid;
}

async function ensureKeyPair(c, orderId, publicKey) {
  const keyName = `tgbot-${orderId}`.slice(0, 60);
  if (publicKey) {
    await c.send(new ImportKeyPairCommand({
      KeyName: keyName,
      PublicKeyMaterial: Buffer.from(publicKey),
    })).catch(() => {});
    return { keyName, privateKey: null };
  }
  // Create ephemeral key pair — return private key so it can be sent to user
  try {
    const kp = await c.send(new CreateKeyPairCommand({ KeyName: keyName }));
    return { keyName, privateKey: kp.KeyMaterial };
  } catch (e) {
    // If exists reuse
    const exist = await c.send(new DescribeKeyPairsCommand({ KeyNames: [keyName] })).catch(() => null);
    if (exist && exist.KeyPairs && exist.KeyPairs.length) return { keyName, privateKey: null };
    throw e;
  }
}

// Master create instance for an order
async function createInstance(api, spec, onProgress = () => {}) {
  await onProgress('Detecting region');
  const region = await pickRegion(api, api.awsRegion);
  const c = client(api, region);

  await onProgress('Checking availability zones');
  await c.send(new DescribeAvailabilityZonesCommand({})); // sanity

  await onProgress('Checking image');
  const ami = await pickAmi(c, spec.osFamily, spec.osVersion);
  if (!ami) throw new Error('No compatible AMI found');

  await onProgress('Checking instance type');
  const instanceType = await pickInstanceType(c);
  if (!instanceType) throw new Error('No free-tier instance type available in ' + region);

  await onProgress('Checking VPC & subnet');
  const { vpcId, subnetId } = await ensureDefaultVpcAndSubnet(c);

  await onProgress('Checking security group');
  const sgId = await ensureSecurityGroup(c, vpcId);

  await onProgress('Preparing key pair');
  // Password Mode → use cloud-init user_data to set password + enable
  // PasswordAuthentication. SSH Mode → import/create key pair as before.
  let kp = { keyName: '', privateKey: null };
  let userData = null;
  if (spec.sshPublicKey || !spec.password) {
    kp = await ensureKeyPair(c, spec.orderId, spec.sshPublicKey);
  } else {
    // Password mode — inject via cloud-init
    userData = Buffer.from(
`#cloud-config
ssh_pwauth: true
disable_root: false
chpasswd:
  list: |
    ubuntu:${spec.password}
    root:${spec.password}
  expire: false
runcmd:
  - sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
  - sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config
  - systemctl restart ssh || systemctl restart sshd || true
`).toString('base64');
  }

  await onProgress('Creating instance');
  const runInput = {
    ImageId: ami.imageId,
    InstanceType: instanceType,
    MinCount: 1, MaxCount: 1,
    NetworkInterfaces: [{
      DeviceIndex: 0, SubnetId: subnetId, AssociatePublicIpAddress: true, Groups: [sgId],
    }],
    TagSpecifications: [{
      ResourceType: 'instance',
      Tags: [{ Key: 'Name', Value: `tgbot-${spec.orderId}` }, { Key: 'managed-by', Value: 'tgbot' }],
    }],
  };
  if (kp.keyName) runInput.KeyName = kp.keyName;
  if (userData) runInput.UserData = userData;
  const run = await c.send(new RunInstancesCommand(runInput));
  const inst = run.Instances && run.Instances[0];
  if (!inst) throw new Error('RunInstances returned empty');

  await onProgress('Waiting public IP');
  let publicIp = '';
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 4000));
    const d = await c.send(new DescribeInstancesCommand({ InstanceIds: [inst.InstanceId] }));
    const cur = d.Reservations && d.Reservations[0] && d.Reservations[0].Instances && d.Reservations[0].Instances[0];
    if (cur && cur.PublicIpAddress) { publicIp = cur.PublicIpAddress; break; }
    if (cur && cur.State && cur.State.Name === 'terminated') throw new Error('Instance terminated');
  }
  if (!publicIp) throw new Error('Timeout waiting for public IP');

  return {
    provider: 'aws',
    region,
    instanceId: inst.InstanceId,
    imageId: ami.imageId,
    osLabel: `Ubuntu ${ami.version || ''}`.trim(),
    size: instanceType,
    publicIp,
    username: 'ubuntu',
    password: spec.password || '',
    sshKeyName: kp.keyName,
    privateKey: kp.privateKey || '',
    raw: { keyName: kp.keyName, region },
  };
}

async function cleanup(api, resources) {
  // resources: object from createInstance return (or partial if failed mid-way)
  if (!resources) return;
  const region = resources.region || api.awsRegion || 'us-east-1';
  const c = client(api, region);
  const { TerminateInstancesCommand, DeleteKeyPairCommand } = require('@aws-sdk/client-ec2');
  try {
    if (resources.instanceId) {
      await c.send(new TerminateInstancesCommand({ InstanceIds: [resources.instanceId] })).catch(() => {});
    }
    if (resources.sshKeyName && (resources.raw && resources.raw.keyName)) {
      // Only delete if we generated it (privateKey present) — imported keys keep
      if (resources.privateKey) {
        await c.send(new DeleteKeyPairCommand({ KeyName: resources.sshKeyName })).catch(() => {});
      }
    }
  } catch (e) { console.error('AWS cleanup:', e.message); }
}

module.exports = { validate, createInstance, cleanup, probe };

// ============ Smart deep-probe (validation pipeline for /add provider) ============
// Reports progress step-by-step via onProgress(step). Never mutates DB.
// Returns { ok, steps:[{label,ok,detail}], score } — caller decides to persist.
async function probe(api, onProgress = async () => {}) {
  const steps = [];
  const push = async (label, ok, detail = '') => { steps.push({ label, ok, detail }); await onProgress(steps); };

  // 1. Validate API + Authentication
  let region = api.awsRegion || 'us-east-1';
  let c;
  try {
    c = client(api, region);
    const out = await c.send(new DescribeRegionsCommand({ AllRegions: false }));
    const enabled = (out.Regions || []).map(r => r.RegionName);
    if (api.awsRegion && !enabled.includes(api.awsRegion)) region = enabled[0] || region;
    await push('API Valid', true);
    await push('Authentication OK', true, `regions: ${enabled.length}`);
  } catch (e) {
    await push('API Valid', false, e.message || 'invalid credentials');
    return { ok: false, steps, error: 'Invalid API Key / Authentication Failed' };
  }
  c = client(api, region);

  // 2. Billing (best-effort: describe account attributes fails when suspended)
  try {
    const { DescribeAccountAttributesCommand } = require('@aws-sdk/client-ec2');
    await c.send(new DescribeAccountAttributesCommand({}));
    await push('Billing Aktif', true);
  } catch (e) {
    await push('Billing Aktif', false, e.message);
    return { ok: false, steps, error: 'Billing Disabled / Account Suspended' };
  }

  // 3. Permission — DescribeInstances (read) + dry-run RunInstances (write)
  try {
    const { DescribeInstancesCommand } = require('@aws-sdk/client-ec2');
    await c.send(new DescribeInstancesCommand({}));
    await push('Permission Lengkap', true);
  } catch (e) {
    await push('Permission Lengkap', false, e.message);
    return { ok: false, steps, error: 'Permission Denied' };
  }

  // 4. Region
  try {
    const chosen = await pickRegion(api, api.awsRegion);
    if (!chosen) throw new Error('no enabled region');
    await push('Region Tersedia', true, chosen);
    region = chosen;
    c = client(api, region);
  } catch (e) {
    await push('Region Tersedia', false, e.message);
    return { ok: false, steps, error: 'Region Not Available' };
  }

  // 5. Image
  try {
    const ami = await pickAmi(c, 'Ubuntu', '');
    if (!ami) throw new Error('no ubuntu AMI');
    await push('Image Tersedia', true, ami.name || ami.imageId);
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
  } catch (e) {
    await push('Quota Tersedia', false, e.message);
    // Non-fatal: continue.
  }

  // 7. Provision Test — RunInstances with DryRun=true (AWS returns DryRunOperation on success)
  try {
    const { RunInstancesCommand } = require('@aws-sdk/client-ec2');
    const instanceType = await pickInstanceType(c);
    const { vpcId, subnetId } = await ensureDefaultVpcAndSubnet(c);
    const sgId = await ensureSecurityGroup(c, vpcId);
    const ami = await pickAmi(c, 'Ubuntu', '');
    try {
      await c.send(new RunInstancesCommand({
        DryRun: true, ImageId: ami.imageId, InstanceType: instanceType,
        MinCount: 1, MaxCount: 1,
        NetworkInterfaces: [{ DeviceIndex: 0, SubnetId: subnetId, AssociatePublicIpAddress: true, Groups: [sgId] }],
      }));
      // DryRun should NOT return success — it throws with DryRunOperation
      await push('Provision Test Berhasil', true);
    } catch (err) {
      const code = err && (err.Code || err.name || '');
      if (String(code).includes('DryRunOperation') || /DryRunOperation/i.test(err.message || '')) {
        await push('Provision Test Berhasil', true);
      } else {
        await push('Provision Test Berhasil', false, err.message);
        return { ok: false, steps, error: 'Provision Test Failed' };
      }
    }
  } catch (e) {
    await push('Provision Test Berhasil', false, e.message);
    return { ok: false, steps, error: 'Provision Test Failed' };
  }

  // 8. Health Score
  const score = Math.max(0, Math.min(100, 60 + (q.available > 0 ? 30 : 0) + (q.limit > 5 ? 10 : 0)));
  await push('Health Check Lulus', true, `score ${score}`);
  return { ok: true, steps, score, region, quota: q };
}
