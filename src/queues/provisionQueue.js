// Provisioning queues with concurrency limits to prevent race conditions and
// API abuse. VPS and RDP are isolated because a Windows reinstall can run far
// longer than a normal VPS create; one must never block the other.
class Queue {
  constructor(concurrency = 2) {
    this.concurrency = concurrency;
    this.running = 0;
    this.pending = [];
  }
  push(taskFn) {
    return new Promise((resolve, reject) => {
      this.pending.push({ taskFn, resolve, reject });
      try { require('../services/catalogService').scheduleUpdate(); } catch (_) {}
      this._drain();
    });
  }
  async _drain() {
    while (this.running < this.concurrency && this.pending.length) {
      const { taskFn, resolve, reject } = this.pending.shift();
      this.running++;
      Promise.resolve()
        .then(taskFn)
        .then(resolve, reject)
        .finally(() => {
          this.running--;
          try { require('../services/catalogService').scheduleUpdate(); } catch (_) {}
          this._drain();
        });
    }
  }
  stats() { return { running: this.running, pending: this.pending.length, concurrency: this.concurrency }; }
}

function readConcurrency(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  // A small hard ceiling keeps a bad environment value from overloading the
  // bot process or provider APIs. ProviderApi locks remain the second guard.
  return Number.isInteger(value) && value >= 1 && value <= 5 ? value : fallback;
}

// Defaults intentionally allow two fast VPS creates and three network-bound
// Windows RDP installs to progress independently. Operators
// may tune each lane without touching code.
const vpsProvisionQueue = new Queue(readConcurrency('VPS_PROVISION_CONCURRENCY', 2));
const rdpProvisionQueue = new Queue(readConcurrency('RDP_PROVISION_CONCURRENCY', 3));

function getProvisionQueueStats() {
  const vps = vpsProvisionQueue.stats();
  const rdp = rdpProvisionQueue.stats();
  return {
    running: vps.running + rdp.running,
    pending: vps.pending + rdp.pending,
    concurrency: vps.concurrency + rdp.concurrency,
    vps,
    rdp,
  };
}

// Backward-compatible aggregate facade for catalog/admin code that only needs
// queue statistics. New provisioning flows must choose their own lane above.
const provisionQueue = {
  push: (taskFn) => vpsProvisionQueue.push(taskFn),
  stats: getProvisionQueueStats,
};

module.exports = {
  Queue,
  provisionQueue,
  vpsProvisionQueue,
  rdpProvisionQueue,
  getProvisionQueueStats,
};
