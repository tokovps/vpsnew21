// ROUND-15 — VPS/RDP queue isolation.
// A slow RDP install must not consume the same concurrency lane as a normal
// VPS create. This test uses held promises only; no provider, MongoDB, or
// network connection is involved.
const assert = require('assert');
const path = require('path');

const queuePath = require.resolve(path.join(__dirname, '..', 'src', 'queues', 'provisionQueue.js'));
const catalogPath = require.resolve(path.join(__dirname, '..', 'src', 'services', 'catalogService.js'));
const savedQueueModule = require.cache[queuePath];
const savedCatalogModule = require.cache[catalogPath];
const savedVpsConcurrency = process.env.VPS_PROVISION_CONCURRENCY;
const savedRdpConcurrency = process.env.RDP_PROVISION_CONCURRENCY;

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function restoreModule(modulePath, saved) {
  if (saved) require.cache[modulePath] = saved;
  else delete require.cache[modulePath];
}

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function testQueueIsolation() {
  // Keep Queue.push free of catalog/database side effects while asserting its
  // public concurrency behaviour.
  require.cache[catalogPath] = {
    id: catalogPath,
    filename: catalogPath,
    loaded: true,
    exports: { scheduleUpdate: () => {} },
  };
  delete require.cache[queuePath];
  process.env.VPS_PROVISION_CONCURRENCY = '2';
  process.env.RDP_PROVISION_CONCURRENCY = '2';

  const {
    provisionQueue, vpsProvisionQueue, rdpProvisionQueue,
  } = require(queuePath);
  assert.notStrictEqual(vpsProvisionQueue, rdpProvisionQueue, 'VPS and RDP must use separate queue instances');

  const releases = [];
  const hold = () => new Promise((resolve) => releases.push(resolve));
  const jobs = [
    vpsProvisionQueue.push(hold),
    vpsProvisionQueue.push(hold),
    rdpProvisionQueue.push(hold),
    rdpProvisionQueue.push(hold),
  ];
  await nextTick();
  await nextTick();

  assert.deepStrictEqual(vpsProvisionQueue.stats(), { running: 2, pending: 0, concurrency: 2 });
  assert.deepStrictEqual(rdpProvisionQueue.stats(), { running: 2, pending: 0, concurrency: 2 });
  assert.deepStrictEqual(provisionQueue.stats(), {
    running: 4,
    pending: 0,
    concurrency: 4,
    vps: { running: 2, pending: 0, concurrency: 2 },
    rdp: { running: 2, pending: 0, concurrency: 2 },
  });

  releases.forEach((release) => release());
  await Promise.all(jobs);
  await nextTick();
  assert.strictEqual(provisionQueue.stats().running, 0, 'aggregate queue must drain after all jobs complete');
  console.log('Queue isolation: 2 VPS + 2 RDP jobs run concurrently without sharing a lane');
}

(async () => {
  try {
    await testQueueIsolation();
    console.log('ROUND-15 queue isolation test PASSED');
  } finally {
    restoreEnv('VPS_PROVISION_CONCURRENCY', savedVpsConcurrency);
    restoreEnv('RDP_PROVISION_CONCURRENCY', savedRdpConcurrency);
    restoreModule(queuePath, savedQueueModule);
    restoreModule(catalogPath, savedCatalogModule);
  }
})().catch((err) => {
  console.error('ROUND-15 queue isolation test FAILED:', err && err.stack || err);
  process.exit(1);
});
