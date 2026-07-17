// In-memory anti-double-click locks. Per-user / per-key.
const locks = new Map();
const COOLDOWN_MS = 1500;

function tryLock(key) {
  const now = Date.now();
  const last = locks.get(key) || 0;
  if (now - last < COOLDOWN_MS) return false;
  locks.set(key, now);
  return true;
}

function clearLock(key) { locks.delete(key); }

module.exports = { tryLock, clearLock };
