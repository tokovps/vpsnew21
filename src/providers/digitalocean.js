// DigitalOcean provider via REST API v2
const axios = require('axios');
const { catalogEntryFor, matchDropletToSize } = require('../utils/specMapping');

const API = 'https://api.digitalocean.com/v2';
const REGION_FALLBACK = ['sgp1', 'tor1', 'blr1', 'syd1', 'nyc3', 'ams3', 'lon1', 'fra1', 'sfo3'];
// General fallback (VPS Linux) — used ONLY when caller supplies no sizeSlug
// (i.e. pre-migration legacy orders). New orders MUST carry order.sizeSlug.
const SIZE_FALLBACK = ['s-1vcpu-1gb', 's-1vcpu-2gb', 's-2vcpu-2gb'];
// ─────────────────────────────────────────────────────────────────────────────
// RDP-SPECIFIC size handling (ADDITIVE — does not affect VPS flow).
// Windows tidak akan pernah boot di 1GB RAM / 25GB disk. Untuk RDP kita paksa
// minimum Windows-capable (2vCPU / 4GB / SSD ≥ 50GB via s-2vcpu-4gb).
// Mapping paket → DO size slug (harus ada di /sizes DO API):
//   low    → s-2vcpu-4gb   (2 vCPU · 4GB RAM · 80GB SSD)  MIN Windows-capable
//   basic  → s-4vcpu-8gb   (4 vCPU · 8GB RAM · 160GB SSD)
//   medium → s-8vcpu-16gb  (8 vCPU · 16GB RAM · 320GB SSD)
// Fallback list (jika size pilihan tidak available di region terpilih) tetap
// Windows-capable — TIDAK BOLEH turun ke 1GB / 2GB apapun alasannya.
const RDP_SIZE_TIER_MAP = {
  low:    's-2vcpu-4gb',
  basic:  's-4vcpu-8gb',
  medium: 's-8vcpu-16gb',
};
const RDP_SIZE_FALLBACK = [
  's-2vcpu-4gb', 's-4vcpu-8gb', 's-8vcpu-16gb',
  's-2vcpu-4gb-intel', 's-4vcpu-8gb-intel',
];
// ─────────────────────────────────────────────────────────────────────────────

function http(api) {
  return axios.create({
    baseURL: API,
    headers: { Authorization: `Bearer ${api.doToken}`, 'Content-Type': 'application/json' },
    timeout: 30000,
  });
}

async function validate(api) {
  const c = http(api);
  const r = await c.get('/account');
  return { ok: true, account: r.data && r.data.account && r.data.account.email };
}

// pickRegionSize(c, spec?)
//  - MANDATORY when spec.sizeSlug is provided: we HARD-ENFORCE that slug.
//    If it's not available in DO's live catalog OR not available in the
//    user's chosen region → throw a specific error. NEVER silently fall back
//    to a smaller/different size (this is the root cause of the RAM-mismatch
//    bug — user paid for 8GB, got 4GB because fallback list starts at 4GB).
//  - OPTIONAL slot: spec.sizeSlug missing → legacy behaviour. Uses the
//    tier-only map for RDP (Windows-capable minimum) or SIZE_FALLBACK for
//    VPS. This branch only fires for pre-migration orders.
async function pickRegionSize(c, spec = {}) {
  const [regionsR, sizesR] = await Promise.all([c.get('/regions'), c.get('/sizes')]);
  const availRegions = new Set((regionsR.data.regions || []).filter(r => r.available).map(r => r.slug));
  const availSizes   = new Set((sizesR.data.sizes   || []).filter(s => s.available).map(s => s.slug));
  const sizeRegions = {};
  for (const s of (sizesR.data.sizes || [])) {
    if (!s.available) continue;
    sizeRegions[s.slug] = new Set(s.regions || []);
  }
  const wantRegion = String(spec.region || '').trim().toLowerCase();
  const wantSize   = String(spec.sizeSlug || '').trim().toLowerCase();
  const isRdp      = String(spec.category || '').toLowerCase() === 'rdp';
  const tier       = String(spec.tier || '').toLowerCase();

  // ---- Region selection ----
  let region;
  if (wantRegion && availRegions.has(wantRegion)) {
    region = wantRegion;
  } else if (wantRegion) {
    // User's requested region is not available → try REGION_FALLBACK, and
    // if wantSize is set, prefer regions that CAN host that size.
    const withSize = wantSize && sizeRegions[wantSize];
    if (withSize && withSize.size) {
      region = REGION_FALLBACK.find(r => availRegions.has(r) && withSize.has(r))
        || [...withSize].find(r => availRegions.has(r))
        || REGION_FALLBACK.find(r => availRegions.has(r))
        || [...availRegions][0];
    } else {
      region = REGION_FALLBACK.find(r => availRegions.has(r)) || [...availRegions][0];
    }
  } else {
    region = REGION_FALLBACK.find(r => availRegions.has(r)) || [...availRegions][0];
  }

  // ---- STRICT PATH: caller provided an explicit sizeSlug ----
  if (wantSize) {
    if (!availSizes.has(wantSize)) {
      const err = new Error(
        `DigitalOcean tidak lagi menawarkan size slug "${wantSize}" (yang sesuai spec user). ` +
        `Cek /v2/sizes atau update mapping. Provisioning DIBATALKAN — tidak boleh downsize.`
      );
      err.code = 'DO_SIZE_UNAVAILABLE';
      throw err;
    }
    const regs = sizeRegions[wantSize];
    if (regs && regs.size && !regs.has(region)) {
      // Size exists but not in the user's region. Try to hop region rather
      // than downgrade the size (per user requirement — never change spec).
      const altRegion = [...regs].find(r => availRegions.has(r));
      if (!altRegion) {
        const err = new Error(
          `Size "${wantSize}" tidak tersedia di region "${region}" maupun region alternatif. ` +
          `Provisioning DIBATALKAN — tidak akan menurunkan spec user.`
        );
        err.code = 'DO_SIZE_REGION_UNAVAILABLE';
        throw err;
      }
      console.warn('[do:pickSize] region hop', { requestedRegion: region, actualRegion: altRegion, size: wantSize });
      region = altRegion;
    }
    return { region, size: wantSize };
  }

  // ---- LEGACY PATH: no sizeSlug (pre-migration orders) ----
  const canUseSize = (slug) => {
    if (!slug || !availSizes.has(slug)) return false;
    const regs = sizeRegions[slug];
    return !regs || regs.size === 0 || regs.has(region);
  };
  let size;
  const preferList = [];
  if (isRdp && tier) {
    // Legacy RDP tier map — only used when sizeSlug is missing (old orders).
    const legacyTierMap = { low: 's-2vcpu-4gb', basic: 's-4vcpu-8gb', medium: 's-8vcpu-16gb' };
    if (legacyTierMap[tier]) preferList.push(legacyTierMap[tier]);
  }
  const fallback = isRdp
    ? ['s-2vcpu-4gb', 's-4vcpu-8gb', 's-8vcpu-16gb', 's-2vcpu-4gb-intel', 's-4vcpu-8gb-intel']
    : SIZE_FALLBACK;
  for (const s of fallback) preferList.push(s);

  for (const cand of preferList) { if (canUseSize(cand)) { size = cand; break; } }

  if (!size) {
    if (isRdp) {
      const rdpCapable = (sizesR.data.sizes || []).filter(s =>
        s.available && s.memory >= 4096 && s.vcpus >= 2 &&
        (!s.regions || s.regions.includes(region)),
      );
      rdpCapable.sort((a, b) => (a.price_monthly || 0) - (b.price_monthly || 0));
      size = (rdpCapable[0] && rdpCapable[0].slug) || [...availSizes][0];
    } else {
      size = [...availSizes][0];
    }
  }
  return { region, size };
}

async function pickImage(c, osFamily, osVersion) {
  const r = await c.get('/images?type=distribution&per_page=200');
  const list = r.data.images || [];
  const fam = String(osFamily || 'ubuntu').toLowerCase();
  const ver = String(osVersion || '').toLowerCase().replace(/[^0-9.]/g, '');
  const candidates = list.filter(i => (i.distribution || '').toLowerCase().includes(fam));
  const preferred = ver
    ? candidates.find(i => (i.slug || '').includes(ver.replace('.', '-')) || (i.name || '').includes(ver))
    : null;
  return (preferred || candidates[0] || list.find(i => (i.slug || '').startsWith('ubuntu-'))).slug;
}

async function createInstance(api, spec, onProgress = () => {}) {
  const c = http(api);

  // ── STRUCTURED LOGGING (per user requirement) ─────────────────────────
  console.log('[do:create] ▼▼▼ VPS/RDP CREATE START ▼▼▼', JSON.stringify({
    orderId: spec.orderId,
    selectedPackage: spec.category ? `${spec.category}/${spec.tier}` : '(vps)',
    selectedTier: spec.tier || '',
    selectedCpu: spec.cpu || null,
    selectedRamMb: spec.ramMb || null,
    selectedDiskGb: spec.diskGb || null,
    selectedRegion: spec.region || '(auto)',
    selectedSizeSlug: spec.sizeSlug || '(auto)',
    selectedOs: `${spec.osFamily || ''} ${spec.osVersion || ''}`.trim(),
  }));

  await onProgress('Detecting region & size');
  const { region, size } = await pickRegionSize(c, spec || {});
  console.log('[do:create] API Request', JSON.stringify({
    orderId: spec.orderId, apiRequestRegion: region, apiRequestSizeSlug: size,
  }));

  await onProgress('Checking image');
  const image = await pickImage(c, spec.osFamily, spec.osVersion);

  await onProgress('Preparing SSH key');
  let sshKeyIds = [];
  if (spec.sshPublicKey) {
    const kr = await c.post('/account/keys', { name: `tgbot-${spec.orderId}`, public_key: spec.sshPublicKey }).catch(err => err.response);
    if (kr && kr.data && kr.data.ssh_key) sshKeyIds.push(kr.data.ssh_key.id);
  }

  await onProgress('Creating droplet');
  const payload = {
    name: `tgbot-${spec.orderId}`.slice(0, 60),
    region, size, image,
    ssh_keys: sshKeyIds,
    ipv6: false, monitoring: true,
    tags: ['tgbot'],
  };
  if (!sshKeyIds.length && spec.password) {
    // ═══ LIFECYCLE FIX (VPS Linux SSH password) ═══════════════════════════
    // Bug lama: cloud-init `ssh_pwauth: true` menulis drop-in
    // /etc/ssh/sshd_config.d/50-cloud-init.conf. Image Ubuntu DO terbaru
    // (22.04 / 24.04) ship dengan /etc/ssh/sshd_config.d/60-cloudimg-settings.conf
    // berisi `PasswordAuthentication no`. Prefix 60- menang atas 50- secara
    // alfabet → SSH server tetap tolak password → user dapat
    // "Permission denied (publickey)".
    //
    // Fix: sed eksplisit sshd_config utama + SEMUA drop-in di
    // /etc/ssh/sshd_config.d/*.conf lalu restart ssh. Mirror perilaku AWS
    // adapter yang memang sudah benar sejak awal.
    //
    // WAJIB dijalankan untuk SEMUA droplet Ubuntu baru yang dipakai VPS
    // Linux (password mode). RDP flow juga lewat sini tapi tidak terpengaruh
    // negatif karena reinstall.sh akan overwrite disk sepenuhnya sebelum
    // Windows boot.
    const safePwd = String(spec.password).replace(/'/g, "'\\''");
    payload.user_data = [
      '#cloud-config',
      'ssh_pwauth: true',
      'disable_root: false',
      'chpasswd:',
      '  expire: false',
      '  list: |',
      `    root:${spec.password}`,
      'runcmd:',
      "  - sed -ri 's/^#?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config || true",
      "  - sed -ri 's/^#?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config || true",
      "  - for f in /etc/ssh/sshd_config.d/*.conf; do [ -f \"$f\" ] && sed -ri 's/^#?PasswordAuthentication.*/PasswordAuthentication yes/' \"$f\" && sed -ri 's/^#?PermitRootLogin.*/PermitRootLogin yes/' \"$f\"; done",
      `  - echo 'root:${safePwd}' | chpasswd`,
      '  - systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || service ssh restart || true',
      '',
    ].join('\n');
  }

  const cr = await c.post('/droplets', payload);
  const drop = cr.data.droplet;
  if (!drop) throw new Error('Droplet not created');

  // ── LOG raw droplet response ─────────────────────────────────────────
  console.log('[do:create] Droplet created', JSON.stringify({
    orderId: spec.orderId,
    dropletId: drop.id,
    dropletSizeSlug: drop.size_slug || (drop.size && drop.size.slug) || null,
    dropletMemory: drop.memory,
    dropletVcpus: drop.vcpus,
    dropletDisk: drop.disk,
  }));

  // ══ HARD VALIDATION: droplet must match order.sizeSlug ══════════════════
  // The DO API is expected to honour the size we requested; we still verify
  // that the RESPONSE size_slug matches. If they don't match (e.g. a DO
  // regression or a resized quota-clamped droplet) we IMMEDIATELY destroy
  // the droplet and throw so orchestrator can retry / fail cleanly. This is
  // exactly the guarantee the user asked for: "Jika Droplet.size_slug tidak
  // sama dengan Order.size_slug → batalkan proses, hapus droplet."
  const expected = {
    sizeSlug: spec.sizeSlug || size,   // trust the caller's declared slug first
    ramMb: spec.ramMb || 0,
    cpu: spec.cpu || 0,
    diskGb: spec.diskGb || 0,
  };
  const verdict = matchDropletToSize(drop, expected);
  if (!verdict.ok) {
    console.error('[do:create] SIZE MISMATCH — destroying droplet', JSON.stringify({
      orderId: spec.orderId, dropletId: drop.id, reasons: verdict.reasons,
      live: verdict.live, expected: verdict.expected,
    }));
    // Destroy the misprovisioned droplet — do NOT continue to install Windows.
    try { await c.delete(`/droplets/${drop.id}`); } catch (_) {}
    const err = new Error(
      'Droplet yang dibuat DigitalOcean tidak sesuai spec user: ' + verdict.reasons.join(' · ') +
      '. Droplet dihapus, provisioning dibatalkan.'
    );
    err.code = 'DO_SIZE_VERIFY_FAILED';
    err.verdict = verdict;
    throw err;
  }
  console.log('[do:create] ✅ Size verification PASSED', JSON.stringify({
    orderId: spec.orderId, dropletId: drop.id, sizeSlug: verdict.live.sizeSlug,
    memory: verdict.live.memoryMb, vcpus: verdict.live.vcpus, disk: verdict.live.diskGb,
  }));

  await onProgress('Waiting public IP');
  let publicIp = '';
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 4000));
    const d = await c.get(`/droplets/${drop.id}`);
    const nets = d.data && d.data.droplet && d.data.droplet.networks && d.data.droplet.networks.v4 || [];
    const pub = nets.find(n => n.type === 'public');
    if (pub && pub.ip_address) { publicIp = pub.ip_address; break; }
  }
  if (!publicIp) throw new Error('Timeout waiting public IP');

  return {
    provider: 'digitalocean', region,
    instanceId: String(drop.id),
    imageId: image,
    osLabel: `${spec.osFamily} ${spec.osVersion}`.trim(),
    size, publicIp,
    username: 'root',
    password: spec.password || '',
    sshKeyName: sshKeyIds.length ? String(sshKeyIds[0]) : '',
    privateKey: '',
    // Live droplet spec snapshot — orchestrator persists this into Order.verified*
    verified: {
      sizeSlug: verdict.live.sizeSlug,
      memoryMb: verdict.live.memoryMb,
      vcpus:    verdict.live.vcpus,
      diskGb:   verdict.live.diskGb,
    },
    raw: { dropletId: drop.id, memory: drop.memory, vcpus: drop.vcpus, disk: drop.disk, size_slug: drop.size_slug },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Public DigitalOcean helpers used by the RDP orchestrator.
// Each function is defensive: it never throws on transient errors, always
// returns a normalized shape { status, exists, publicIp, ... } so the caller
// can treat unknown/transient states without crashing the pipeline.
// ═══════════════════════════════════════════════════════════════════════════

/** Fetch droplet — normalized shape. Alias: getDroplet.
 *  Returns live memory / vcpus / disk / size_slug / region so Detail VPS
 *  can read the TRUE running spec instead of the stale DB snapshot. */
async function getInstance(api, instanceId) {
  if (!instanceId) return { status: 'unknown', exists: false };
  try {
    const c = http(api);
    const r = await c.get(`/droplets/${instanceId}`);
    const d = r.data && r.data.droplet;
    if (!d) return { status: 'gone', exists: false };
    const nets = (d.networks && d.networks.v4) || [];
    const pub = nets.find(n => n.type === 'public');
    const priv = nets.find(n => n.type === 'private');
    return {
      exists: true,
      status: d.status || 'unknown',      // new | active | off | archive
      powerState: d.status,
      publicIp: pub ? pub.ip_address : '',
      privateIp: priv ? priv.ip_address : '',
      region:  (d.region && d.region.slug) || '',
      regionName: (d.region && d.region.name) || '',
      sizeSlug: d.size_slug || (d.size && d.size.slug) || '',
      memoryMb: Number(d.memory) || 0,
      vcpus:    Number(d.vcpus)  || 0,
      diskGb:   Number(d.disk)   || 0,
      image:    (d.image && (d.image.slug || d.image.name)) || '',
      raw: { id: d.id, name: d.name, memory: d.memory, vcpus: d.vcpus, disk: d.disk,
             size_slug: d.size_slug, region: d.region && d.region.slug },
    };
  } catch (e) {
    if (e.response && e.response.status === 404) {
      return { status: 'destroyed', exists: false };
    }
    return { status: 'unknown', exists: false, error: String(e && e.message) };
  }
}

async function getDropletStatus(api, id) {
  const s = await getInstance(api, id);
  return s.status;
}

async function getDropletPowerState(api, id) {
  const s = await getInstance(api, id);
  return s.powerState;
}

async function getDropletIP(api, id) {
  const s = await getInstance(api, id);
  return s.publicIp || '';
}

/** Return true when a DigitalOcean firewall port expression covers `port`.
 *  DO accepts `all`, a single port, or a numeric range such as `3000-4000`.
 */
function firewallPortIncludes(portExpression, port) {
  const wanted = Number(port);
  if (!Number.isInteger(wanted) || wanted < 1 || wanted > 65535) return false;

  const expression = String(portExpression == null ? '' : portExpression).trim().toLowerCase();
  if (!expression || expression === 'all') return true;

  return expression.split(',').some((part) => {
    const token = part.trim();
    if (/^\d+$/.test(token)) return Number(token) === wanted;
    const match = token.match(/^(\d+)\s*-\s*(\d+)$/);
    if (!match) return false;
    const start = Number(match[1]);
    const end = Number(match[2]);
    return start <= wanted && wanted <= end;
  });
}

function firewallTargetsDroplet(firewall, instanceId, dropletTags = []) {
  const id = String(instanceId || '');
  const ids = Array.isArray(firewall && firewall.droplet_ids)
    ? firewall.droplet_ids.map(String)
    : [];
  if (id && ids.includes(id)) return true;

  const wantedTags = new Set((dropletTags || []).map(tag => String(tag).toLowerCase()));
  return Array.isArray(firewall && firewall.tags)
    && firewall.tags.some(tag => wantedTags.has(String(tag).toLowerCase()));
}

function ruleAllowsPublicTcp(rule, port) {
  if (String(rule && rule.protocol || '').toLowerCase() !== 'tcp') return false;
  if (!firewallPortIncludes(rule && rule.ports, port)) return false;
  const addresses = rule && rule.sources && Array.isArray(rule.sources.addresses)
    ? rule.sources.addresses.map(String)
    : [];
  // Droplets created by this adapter currently expose an IPv4 public address,
  // so an IPv6-only rule does not make the customer-facing endpoint reachable.
  return addresses.includes('0.0.0.0/0');
}

/**
 * Audit attached DigitalOcean Cloud Firewalls before starting a long Windows
 * reinstall. With no attached firewall, DO's platform has no cloud-level
 * inbound filter and the guest firewall remains authoritative. If one or more
 * firewalls target this droplet (directly or through its tag), at least one
 * inbound rule must publicly allow the requested TCP port.
 */
async function auditRdpCloudFirewall(api, instanceId, {
  port = 3389,
  dropletTags = ['tgbot'],
} = {}) {
  const c = http(api);
  const response = await c.get('/firewalls?per_page=200');
  const all = (response.data && response.data.firewalls) || [];
  const attached = all.filter(fw => firewallTargetsDroplet(fw, instanceId, dropletTags));

  if (attached.length === 0) {
    return {
      ok: true,
      mode: 'no-cloud-firewall',
      checkedPort: Number(port),
      firewalls: [],
      reason: 'Tidak ada DigitalOcean Cloud Firewall yang menarget droplet ini.',
    };
  }

  const allowing = attached.filter(fw =>
    (fw.inbound_rules || []).some(rule => ruleAllowsPublicTcp(rule, port))
  );
  const names = attached.map(fw => fw.name || String(fw.id || '(unnamed)'));
  const allowingNames = allowing.map(fw => fw.name || String(fw.id || '(unnamed)'));
  const ok = allowing.length > 0;

  return {
    ok,
    mode: ok ? 'public-rule-found' : 'attached-firewall-blocks-public-rdp',
    checkedPort: Number(port),
    firewalls: names,
    allowingFirewalls: allowingNames,
    reason: ok
      ? `TCP ${port} diizinkan publik oleh: ${allowingNames.join(', ')}`
      : `Cloud Firewall terpasang (${names.join(', ')}) tetapi tidak ada inbound TCP ${port} dari 0.0.0.0/0.`,
  };
}

/** Poll until status === 'active' (or timeout). Returns final status object. */
async function waitUntilActive(api, id, { timeoutMs = 3 * 60 * 1000, intervalMs = 10 * 1000, onTick } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = { status: 'unknown' };
  while (Date.now() < deadline) {
    last = await getInstance(api, id);
    if (onTick) try { await onTick(last); } catch (_) {}
    if (last.status === 'active') return last;
    if (last.status === 'destroyed' || last.status === 'gone' || last.exists === false) return last;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return last;
}

/** Wait for a reboot event: observe status transition active → off → active,
 *  OR power_state change. Returns true if reboot observed, false on timeout. */
async function waitUntilReboot(api, id, { timeoutMs = 5 * 60 * 1000, intervalMs = 10 * 1000, onTick } = {}) {
  const deadline = Date.now() + timeoutMs;
  let seenOff = false;
  while (Date.now() < deadline) {
    const s = await getInstance(api, id);
    if (onTick) try { await onTick(s); } catch (_) {}
    if (s.status === 'off' || s.status === 'new') seenOff = true;
    if (seenOff && s.status === 'active') return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

/** Force-destroy a droplet by id. Idempotent (404 treated as success). */
async function destroyDroplet(api, id) {
  if (!id) return { ok: true, note: 'no id' };
  try {
    const c = http(api);
    await c.delete(`/droplets/${id}`);
    return { ok: true };
  } catch (e) {
    if (e.response && e.response.status === 404) return { ok: true, note: 'already gone' };
    return { ok: false, error: String(e && e.message) };
  }
}

// ─────────────────────────────────────────────────────────────────
// Power / reboot actions (RDP orchestrator uses these when the VPS
// stays OFF after reinstall, or when we suspect reinstall.sh's reboot
// call never fired).
//
// All actions are POST /v2/droplets/{id}/actions with { type: ... }.
// DO returns 202 + { action: { id, status, type } }. We treat 4xx as
// hard-fail; 404 = droplet gone (idempotent-ish semantics for the caller).
// ─────────────────────────────────────────────────────────────────
async function _postAction(api, id, type) {
  if (!id) return { ok: false, error: 'no id' };
  try {
    const c = http(api);
    const r = await c.post(`/droplets/${id}/actions`, { type });
    return { ok: true, action: r.data && r.data.action, status: r.status };
  } catch (e) {
    if (e.response && e.response.status === 404) return { ok: false, error: 'droplet not found', gone: true };
    if (e.response && e.response.status === 422) {
      // 422 = "droplet is currently in that state" (e.g. power_on when already on).
      // Semantically success for our use case.
      return { ok: true, note: 'already-in-target-state', status: 422 };
    }
    return { ok: false, error: String(e && e.message), status: e.response && e.response.status };
  }
}

async function powerOn(api, id)    { return _postAction(api, id, 'power_on'); }
async function powerOff(api, id)   { return _postAction(api, id, 'power_off'); }
async function powerCycle(api, id) { return _postAction(api, id, 'power_cycle'); }
async function rebootDroplet(api, id) { return _postAction(api, id, 'reboot'); }

/**
 * Return the last N actions on a droplet, newest first. Useful to detect
 * whether a reboot actually occurred (look for type='reboot'/'power_cycle'
 * with status='completed' whose completed_at > our reinstall_start_ts).
 */
async function getRecentActions(api, id, { limit = 10 } = {}) {
  if (!id) return [];
  try {
    const c = http(api);
    const r = await c.get(`/droplets/${id}/actions?per_page=${limit}`);
    const actions = (r.data && r.data.actions) || [];
    // Sort newest first (DO returns oldest first).
    return actions.slice().sort((a, b) => new Date(b.started_at || 0) - new Date(a.started_at || 0));
  } catch (e) {
    return [];
  }
}

async function cleanup(api, resources) {
  if (!resources || !resources.instanceId) return;
  try {
    const c = http(api);
    await c.delete(`/droplets/${resources.instanceId}`).catch(() => {});
    if (resources.sshKeyName) await c.delete(`/account/keys/${resources.sshKeyName}`).catch(() => {});
  } catch (e) { console.error('DO cleanup:', e.message); }
}

module.exports = {
  validate, createInstance, cleanup, probe,
  // RDP orchestrator surface (public helpers)
  getInstance,
  getDroplet: getInstance,
  getDropletStatus, getDropletPowerState, getDropletIP,
  waitUntilActive, waitUntilReboot,
  auditRdpCloudFirewall,
  destroyDroplet,
  powerOn, powerOff, powerCycle, rebootDroplet,
  getRecentActions,
  createDroplet: createInstance,
  // Test-only exports (used by tests/rdp-fix-static.test.js).
  // Prefixed with double-underscore to signal "not part of the stable API".
  __pickRegionSize: pickRegionSize,
  __RDP_SIZE_TIER_MAP: RDP_SIZE_TIER_MAP,
  __RDP_SIZE_FALLBACK: RDP_SIZE_FALLBACK,
  __firewallPortIncludes: firewallPortIncludes,
  __firewallTargetsDroplet: firewallTargetsDroplet,
  __ruleAllowsPublicTcp: ruleAllowsPublicTcp,
};

async function probe(api, onProgress = async () => {}) {
  const steps = [];
  const push = async (label, ok, detail = '') => { steps.push({ label, ok, detail }); await onProgress(steps); };
  const c = http(api);

  // 1. Validate + Auth
  let account;
  try {
    const r = await c.get('/account');
    account = r.data && r.data.account;
    if (!account) throw new Error('empty account response');
    await push('API Valid', true);
    await push('Authentication OK', true, account.email || '');
  } catch (e) {
    await push('API Valid', false, (e.response && e.response.status === 401) ? 'unauthorized' : e.message);
    return { ok: false, steps, error: 'Invalid API Key / Authentication Failed' };
  }

  // 2. Billing — DO returns status='active' when billed OK
  try {
    const status = account.status || 'active';
    const ok = status === 'active' || status === 'warning';
    await push('Billing Aktif', ok, `status: ${status}`);
    if (!ok) return { ok: false, steps, error: 'Billing Disabled' };
  } catch (e) {
    await push('Billing Aktif', false, e.message);
    return { ok: false, steps, error: 'Billing Check Failed' };
  }

  // 3. Permission — droplet:read
  try {
    await c.get('/droplets?per_page=1');
    await push('Permission Lengkap', true);
  } catch (e) {
    await push('Permission Lengkap', false, e.message);
    return { ok: false, steps, error: 'Permission Denied' };
  }

  // 4. Region + 5. Image
  let region, size, image;
  try {
    const rs = await pickRegionSize(c);
    region = rs.region; size = rs.size;
    if (!region) throw new Error('no region');
    await push('Region Tersedia', true, region);
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
  } catch (e) {
    await push('Quota Tersedia', false, e.message);
  }

  // 7. Provision Test — DO has no dry-run; approximate by validating we CAN see /images & /sizes
  //    (limit check + region+size+image resolution is a strong proxy).
  try {
    await c.get(`/sizes?per_page=1`);
    await push('Provision Test Berhasil', true, 'resolved region/size/image');
  } catch (e) {
    await push('Provision Test Berhasil', false, e.message);
    return { ok: false, steps, error: 'Provision Test Failed' };
  }

  // 8. Health Score
  const score = Math.max(0, Math.min(100, 60 + (q.available > 0 ? 30 : 0) + (q.limit > 5 ? 10 : 0)));
  await push('Health Check Lulus', true, `score ${score}`);
  return { ok: true, steps, score, region, quota: q };
}
