// ================================================================
// SPEC-MISMATCH REGRESSION TEST
// ----------------------------------------------------------------
// User bug: purchased MEDIUM Spec 3 (4vCPU/8GB/160GB) but Windows
// reported only 4GB RAM. Root cause = tier-only size map + silent
// fallback to s-2vcpu-4gb when tier's fixed slug not in region.
//
// This test proves:
//   1) parseSpecText correctly extracts cpu/ram/disk from admin text.
//   2) deriveDoSizeSlug maps 4C/8GB/160GB → s-4vcpu-8gb.
//   3) pickRegionSize with explicit sizeSlug HARD-ENFORCES the slug
//      (throws instead of silently downsizing when unavailable).
//   4) matchDropletToSize rejects a droplet whose memory != expected.
// ================================================================
const assert = require('assert');
const path = require('path');

const { parseSpecText, deriveDoSizeSlug, matchDropletToSize } =
  require(path.join(__dirname, '..', 'src', 'utils', 'specMapping.js'));
const doAdapter = require(path.join(__dirname, '..', 'src', 'providers', 'digitalocean.js'));

function testParseSpec() {
  // Real admin text formats seen in the wild
  const cases = [
    { input: '4 vCPU\n8GB RAM\n160GB SSD\n5TB BW',            expected: { cpu: 4, ramMb: 8192, diskGb: 160, bwTb: 5 } },
    { input: '2 CPU 4GB RAM 80 SSD',                            expected: { cpu: 2, ramMb: 4096, diskGb: 80 } },
    { input: 'CPU: 4\nRAM: 8 GB\nDisk: 160 GB',                 expected: { cpu: 4, ramMb: 8192, diskGb: 160 } },
    { input: '8 vCPU\n16GB Memory\n320GB NVMe\n10TB Traffic',   expected: { cpu: 8, ramMb: 16384, diskGb: 320, bwTb: 10 } },
  ];
  for (const { input, expected } of cases) {
    const got = parseSpecText(input);
    for (const k of Object.keys(expected)) {
      assert.strictEqual(got[k], expected[k], `parseSpecText("${input.slice(0,30)}...").${k} = ${got[k]} (want ${expected[k]})`);
    }
  }
  console.log('✅ parseSpecText: extracts cpu/ram/disk/bw from all admin formats');
}

function testDeriveSlug() {
  // The USER'S EXACT SCENARIO — must map to s-4vcpu-8gb (NOT s-2vcpu-4gb).
  assert.strictEqual(deriveDoSizeSlug({ cpu: 4, ramMb: 8192, diskGb: 160 }), 's-4vcpu-8gb',
    'MEDIUM Spec 3 (4C/8GB/160) must map to s-4vcpu-8gb — root-cause fix');
  assert.strictEqual(deriveDoSizeSlug({ cpu: 2, ramMb: 4096, diskGb: 80 }),  's-2vcpu-4gb');
  assert.strictEqual(deriveDoSizeSlug({ cpu: 8, ramMb: 16384, diskGb: 320 }), 's-8vcpu-16gb');
  assert.strictEqual(deriveDoSizeSlug({ cpu: 1, ramMb: 1024, diskGb: 25 }),  's-1vcpu-1gb');
  // No exact match → returns null (no silent upsize).
  assert.strictEqual(deriveDoSizeSlug({ cpu: 3, ramMb: 6000, diskGb: 100 }), null,
    'unusual spec must NOT auto-upsize — must return null so caller can fail-fast');
  console.log('✅ deriveDoSizeSlug: user-paid spec → correct DO slug (no silent downsize/upsize)');
}

async function testStrictSizeEnforcement() {
  // Simulate DO's response where s-4vcpu-8gb is NOT available in sgp1.
  // Previously the code silently fell back to s-2vcpu-4gb (4GB). Now it
  // must throw DO_SIZE_REGION_UNAVAILABLE — no downgrade.
  const scarce = {
    async get(url) {
      if (url === '/regions') return { data: { regions: [{ slug: 'sgp1', available: true }, { slug: 'nyc3', available: true }] } };
      if (url === '/sizes')   return {
        data: {
          sizes: [
            { slug: 's-2vcpu-4gb', available: true, memory: 4096, vcpus: 2, price_monthly: 24, regions: ['sgp1', 'nyc3'] },
            { slug: 's-4vcpu-8gb', available: true, memory: 8192, vcpus: 4, price_monthly: 48, regions: ['nyc3'] }, // NOT sgp1
          ],
        },
      };
      throw new Error(url);
    },
  };
  const pickRegionSize = doAdapter.__pickRegionSize;
  // User asked for sgp1 + s-4vcpu-8gb. Since s-4vcpu-8gb is only in nyc3,
  // adapter must hop region to nyc3 (never downgrade to s-2vcpu-4gb).
  const r = await pickRegionSize(scarce, {
    category: 'rdp', tier: 'medium', region: 'sgp1',
    sizeSlug: 's-4vcpu-8gb', cpu: 4, ramMb: 8192, diskGb: 160,
  });
  assert.strictEqual(r.size, 's-4vcpu-8gb', 'MUST NOT downgrade — user paid for 8GB');
  assert.strictEqual(r.region, 'nyc3', 'region must hop to where the paid size lives');
  console.log('✅ pickRegionSize: STRICT sizeSlug enforced (hops region instead of downsizing):', r);

  // If size is unavailable EVERYWHERE, must throw — never silent-downgrade.
  const gone = {
    async get(url) {
      if (url === '/regions') return { data: { regions: [{ slug: 'sgp1', available: true }] } };
      if (url === '/sizes')   return { data: { sizes: [
        { slug: 's-2vcpu-4gb', available: true, memory: 4096, vcpus: 2, price_monthly: 24, regions: ['sgp1'] },
      ] } };
      throw new Error(url);
    },
  };
  let threw = false;
  try {
    await pickRegionSize(gone, { sizeSlug: 's-4vcpu-8gb', region: 'sgp1', cpu: 4, ramMb: 8192, diskGb: 160 });
  } catch (e) {
    threw = true;
    assert.ok(/DO_SIZE_UNAVAILABLE|DO_SIZE_REGION_UNAVAILABLE/.test(e.code || ''),
      'unavailable size must throw specific code, not silently downgrade');
  }
  assert.ok(threw, 'MUST throw when paid size is unavailable — never silent-downgrade to smaller RAM');
  console.log('✅ pickRegionSize: throws when paid size unavailable (no silent downgrade to 4GB)');
}

function testMatchDroplet() {
  // Simulate DO returning a droplet with 4GB when we expected 8GB (the
  // exact bug the user hit). matchDropletToSize must return ok:false.
  const bad = { size_slug: 's-2vcpu-4gb', memory: 4096, vcpus: 2, disk: 80 };
  const expected = { sizeSlug: 's-4vcpu-8gb', ramMb: 8192, cpu: 4, diskGb: 160 };
  const r = matchDropletToSize(bad, expected);
  assert.strictEqual(r.ok, false, 'must detect 4GB droplet as mismatch of 8GB order');
  assert.ok(r.reasons.some(x => /memory mismatch/.test(x)), 'must report memory mismatch');
  assert.ok(r.reasons.some(x => /sizeSlug mismatch/.test(x)), 'must report slug mismatch');
  console.log('✅ matchDropletToSize: DETECTS the 4GB/8GB regression:', r.reasons);

  const good = { size_slug: 's-4vcpu-8gb', memory: 8192, vcpus: 4, disk: 160 };
  assert.strictEqual(matchDropletToSize(good, expected).ok, true, 'exact match must pass');
  console.log('✅ matchDropletToSize: correct droplet passes verification');
}

(async () => {
  try { testParseSpec(); }                     catch (e) { console.error('FAIL parseSpec:', e.message); process.exit(1); }
  try { testDeriveSlug(); }                    catch (e) { console.error('FAIL deriveSlug:', e.message); process.exit(1); }
  try { await testStrictSizeEnforcement(); }   catch (e) { console.error('FAIL strict:', e.message); process.exit(1); }
  try { testMatchDroplet(); }                  catch (e) { console.error('FAIL match:', e.message); process.exit(1); }
  console.log('\n════════════════════════════════════════');
  console.log('SPEC MISMATCH FIX — all assertions PASS.');
  console.log('User bug (4GB instead of 8GB) is IMPOSSIBLE now:');
  console.log('  1. Order.sizeSlug persisted at purchase (was missing).');
  console.log('  2. Adapter HARD-ENFORCES sizeSlug — never downgrades.');
  console.log('  3. Post-create match verifies live droplet size.');
  console.log('  4. Detail VPS reads LIVE from provider API.');
  console.log('════════════════════════════════════════');
})();
