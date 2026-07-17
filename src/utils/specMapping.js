// ================================================================
// SPEC MAPPING — single source of truth for user Spec ↔ DO size slug
// ----------------------------------------------------------------
// The Auto Create RDP/VPS bug (user pays for 8GB, gets 4GB) was caused
// by two data-loss points:
//
//   1) The admin defines specs as free-form text (e.g. "4 vCPU\n8GB RAM\n
//      160GB SSD"). At order time this text was persisted to
//      Order.description but the numeric CPU / RAM / Disk fields were
//      NEVER extracted or stored.
//
//   2) The DigitalOcean adapter used a hardcoded tier-only map
//      (RDP_SIZE_TIER_MAP) that ignored the specific slot the user chose.
//      Fallback path silently dropped to `s-2vcpu-4gb` when the tier's
//      fixed slug wasn't available in a region → user got 4GB RAM.
//
// This module provides:
//   • parseSpecText(text)     → { cpu, ramMb, diskGb, bwTb }
//   • deriveDoSizeSlug(spec)  → 's-4vcpu-8gb' | null
//   • DO_SIZE_CATALOG         → static map of DO slug ↔ { vcpus, memory, disk }
//   • matchDropletToSize(...) → validate a live DO droplet matches order
//
// The DO catalog is intentionally hardcoded rather than fetched live: we
// only ever provision from a well-known SSD/Regular/Premium range and the
// slugs are stable. If DO renames or deprecates one we'll surface it via
// the post-create validator (the droplet's size.slug simply won't match).
// ================================================================

// DigitalOcean size catalog (as of 2026-01).
// Fields:
//   vcpus    — integer
//   memoryMb — RAM in MB (DO reports memory in MB via /v2/droplets)
//   diskGb   — SSD/NVMe in GB
//   family   — 'basic' | 'premium-intel' | 'premium-amd' | 'cpu-optimized' | 'memory-optimized'
// Only the slugs likely to be used for VPS / RDP self-service are listed.
// If order.sizeSlug isn't in this table we still forward it to DO — but
// post-create validation relies on the live droplet.size.slug returning the
// SAME string, so this list only affects DERIVATION from cpu/ram/disk.
const DO_SIZE_CATALOG = [
  // Basic (Regular) SSD
  { slug: 's-1vcpu-1gb',    vcpus: 1, memoryMb: 1024,  diskGb: 25,  family: 'basic' },
  { slug: 's-1vcpu-2gb',    vcpus: 1, memoryMb: 2048,  diskGb: 50,  family: 'basic' },
  { slug: 's-2vcpu-2gb',    vcpus: 2, memoryMb: 2048,  diskGb: 60,  family: 'basic' },
  { slug: 's-2vcpu-4gb',    vcpus: 2, memoryMb: 4096,  diskGb: 80,  family: 'basic' },
  { slug: 's-4vcpu-8gb',    vcpus: 4, memoryMb: 8192,  diskGb: 160, family: 'basic' },
  { slug: 's-8vcpu-16gb',   vcpus: 8, memoryMb: 16384, diskGb: 320, family: 'basic' },
  // Premium Intel
  { slug: 's-1vcpu-1gb-intel',  vcpus: 1, memoryMb: 1024,  diskGb: 25,  family: 'premium-intel' },
  { slug: 's-1vcpu-2gb-intel',  vcpus: 1, memoryMb: 2048,  diskGb: 50,  family: 'premium-intel' },
  { slug: 's-2vcpu-2gb-intel',  vcpus: 2, memoryMb: 2048,  diskGb: 60,  family: 'premium-intel' },
  { slug: 's-2vcpu-4gb-intel',  vcpus: 2, memoryMb: 4096,  diskGb: 80,  family: 'premium-intel' },
  { slug: 's-4vcpu-8gb-intel',  vcpus: 4, memoryMb: 8192,  diskGb: 160, family: 'premium-intel' },
  { slug: 's-8vcpu-16gb-intel', vcpus: 8, memoryMb: 16384, diskGb: 320, family: 'premium-intel' },
  // Premium AMD
  { slug: 's-1vcpu-2gb-amd',    vcpus: 1, memoryMb: 2048,  diskGb: 50,  family: 'premium-amd' },
  { slug: 's-2vcpu-4gb-amd',    vcpus: 2, memoryMb: 4096,  diskGb: 80,  family: 'premium-amd' },
  { slug: 's-4vcpu-8gb-amd',    vcpus: 4, memoryMb: 8192,  diskGb: 160, family: 'premium-amd' },
  { slug: 's-8vcpu-16gb-amd',   vcpus: 8, memoryMb: 16384, diskGb: 320, family: 'premium-amd' },
];

// Preference order when multiple slugs match (cheapest first: basic > intel > amd).
const FAMILY_PRIORITY = { 'basic': 0, 'premium-intel': 1, 'premium-amd': 2 };

/**
 * Parse a free-form admin spec string into a normalized numeric shape.
 * Examples accepted:
 *   "4 vCPU\n8GB RAM\n160GB SSD\n5TB BW"
 *   "8GB RAM 4 CPU 160 SSD"
 *   "CPU: 4\nRAM: 8 GB\nDisk: 160 GB"
 *
 * Returns partial object — fields not found remain undefined so callers can
 * detect "admin spec text is incomplete" and refuse to save the order.
 */
function parseSpecText(raw) {
  const original = String(raw || '').replace(/\r/g, '');
  // Extract each candidate field by scanning line-by-line first, then falling
  // back to whole-string regexes. Line-by-line prevents cross-line confusion
  // like "RAM: 8 GB\nDisk: 160" being parsed as "disk = 8".
  const lines = original.split(/[\n;]+/).map(l => l.trim()).filter(Boolean);
  let cpu, ramMb, diskGb, bwTb;
  const grab = (line, patterns) => {
    for (const re of patterns) { const m = line.match(re); if (m) return Number(m[1]); }
    return undefined;
  };
  for (const line of lines) {
    const l = line;
    // CPU
    if (cpu === undefined) {
      const v = grab(l, [
        /(\d+)\s*(?:v?cpu|vcore|cores?)\b/i,
        /\b(?:v?cpu|vcore|cores?)\s*[:=]?\s*(\d+)/i,
      ]);
      if (v !== undefined) cpu = v;
    }
    // RAM (line must mention ram/memory or be a bare "NGB" with no disk keyword)
    if (ramMb === undefined) {
      const isRamLine = /\b(ram|memory|mem)\b/i.test(l);
      const isDiskLine = /\b(ssd|nvme|disk|hdd|storage)\b/i.test(l);
      const isBwLine  = /\b(bw|bandwidth|traffic|transfer)\b/i.test(l);
      if (isRamLine && !isDiskLine && !isBwLine) {
        const g = grab(l, [
          /(\d+)\s*g\s*b?\s*(?:ram|memory|mem)/i,
          /\b(?:ram|memory|mem)\s*[:=]?\s*(\d+)\s*g?\s*b?/i,
          /(\d+)\s*gb\b/i,
        ]);
        if (g !== undefined) ramMb = g * 1024;
        const mb = grab(l, [/(\d+)\s*mb\s*(?:ram|memory|mem)/i]);
        if (mb !== undefined) ramMb = mb;
      }
    }
    // Disk
    if (diskGb === undefined) {
      const isDiskLine = /\b(ssd|nvme|disk|hdd|storage)\b/i.test(l);
      if (isDiskLine) {
        const v = grab(l, [
          /(\d+)\s*g\s*b?\s*(?:ssd|nvme|disk|hdd|storage)/i,
          /(\d+)\s+(?:ssd|nvme|disk|hdd|storage)\b/i,
          /\b(?:ssd|nvme|disk|hdd|storage)\s*[:=]?\s*(\d+)\s*g?\s*b?/i,
        ]);
        if (v !== undefined) diskGb = v;
      }
    }
    // Bandwidth
    if (bwTb === undefined) {
      const v = grab(l, [
        /(\d+)\s*t\s*b?\s*(?:bw|bandwidth|traffic|transfer)/i,
        /\b(?:bw|bandwidth|traffic|transfer)\s*[:=]?\s*(\d+)\s*t?\s*b?/i,
      ]);
      if (v !== undefined) bwTb = v;
    }
  }
  // Fallback: if RAM still missing, try whole-string bare "NGB" that isn't a disk/bw context.
  if (ramMb === undefined) {
    const flat = original.replace(/\s+/g, ' ');
    const m = flat.match(/(\d+)\s*gb\b(?![^a-z]*?(?:ssd|nvme|disk|hdd|storage|bw|bandwidth))/i);
    if (m) ramMb = Number(m[1]) * 1024;
  }
  return { cpu, ramMb, diskGb, bwTb };
}

/**
 * Given the user's chosen numeric spec, pick the smallest DO slug that
 * satisfies (vcpus >= cpu) AND (memoryMb >= ramMb) AND (diskGb >= diskGb).
 * "Exact match" is preferred (this is what user paid for); if none exact,
 * return null so callers can decide to fail-fast (recommended) instead of
 * silently upselling to a bigger droplet the user didn't pay for.
 *
 * We tolerate a 1MB memory rounding (DO reports 8192 MB for 8 GB) but do
 * NOT round CPU or disk — those must match exactly.
 */
function deriveDoSizeSlug({ cpu, ramMb, diskGb, family } = {}) {
  if (!cpu || !ramMb || !diskGb) return null;
  const wantFamily = String(family || '').toLowerCase() || null;
  const exact = DO_SIZE_CATALOG.filter(x =>
    x.vcpus === cpu &&
    Math.abs(x.memoryMb - ramMb) <= 1 &&
    x.diskGb === diskGb &&
    (wantFamily ? x.family === wantFamily : true),
  );
  if (exact.length) {
    exact.sort((a, b) => {
      const pa = (a.family in FAMILY_PRIORITY) ? FAMILY_PRIORITY[a.family] : 9;
      const pb = (b.family in FAMILY_PRIORITY) ? FAMILY_PRIORITY[b.family] : 9;
      return pa - pb;
    });
    return exact[0].slug;
  }
  // No exact match — DO NOT auto-upsize. Return null; caller can log and
  // decide (throwing at order time surfaces a bad admin spec explicitly).
  return null;
}

function catalogEntryFor(slug) {
  if (!slug) return null;
  return DO_SIZE_CATALOG.find(x => x.slug === String(slug).toLowerCase()) || null;
}

/**
 * Verify a live DO droplet matches the order's expected spec.
 * Accepts the raw droplet object from `GET /v2/droplets/:id` (or the
 * `raw` field we normalise in getInstance()).
 *
 * Returns { ok, reasons: string[], live: {...}, expected: {...} }
 */
function matchDropletToSize(droplet, expected) {
  const reasons = [];
  const live = {
    sizeSlug: droplet && (droplet.size_slug || (droplet.size && droplet.size.slug) || null),
    memoryMb: droplet && Number(droplet.memory || 0),
    vcpus:    droplet && Number(droplet.vcpus  || 0),
    diskGb:   droplet && Number(droplet.disk   || 0),
  };
  const exp = expected || {};
  if (exp.sizeSlug && live.sizeSlug && exp.sizeSlug !== live.sizeSlug) {
    reasons.push(`sizeSlug mismatch: expected=${exp.sizeSlug} live=${live.sizeSlug}`);
  }
  if (exp.ramMb && live.memoryMb && Math.abs(live.memoryMb - exp.ramMb) > 1) {
    reasons.push(`memory mismatch: expected=${exp.ramMb}MB live=${live.memoryMb}MB`);
  }
  if (exp.cpu && live.vcpus && live.vcpus !== exp.cpu) {
    reasons.push(`vcpu mismatch: expected=${exp.cpu} live=${live.vcpus}`);
  }
  if (exp.diskGb && live.diskGb && live.diskGb !== exp.diskGb) {
    reasons.push(`disk mismatch: expected=${exp.diskGb}GB live=${live.diskGb}GB`);
  }
  return { ok: reasons.length === 0, reasons, live, expected: exp };
}

module.exports = {
  DO_SIZE_CATALOG,
  parseSpecText,
  deriveDoSizeSlug,
  catalogEntryFor,
  matchDropletToSize,
};
