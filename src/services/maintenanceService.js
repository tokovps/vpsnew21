// Maintenance Mode service — thin wrapper around MaintenanceState model.
// All state mutations MUST go through this service so we can add hooks
// (notifications, cache) in one place. Never mutates other collections.

const MaintenanceState = require('../models/MaintenanceState');
const User = require('../models/User');

const KEY = 'global';

// ── State ─────────────────────────────────────────────────────────────────
async function getState() {
  let s = await MaintenanceState.findOne({ key: KEY });
  if (!s) s = await MaintenanceState.create({ key: KEY });
  return s;
}

async function isEnabled() {
  const s = await getState();
  return !!s.enabled;
}

async function enable({ estimateMinutes, message } = {}) {
  const patch = {
    enabled: true,
    startedAt: new Date(),
    testers: [],
    requests: [],
    rejected: [],
  };
  if (Number.isFinite(estimateMinutes) && estimateMinutes >= 0) patch.estimateMinutes = estimateMinutes;
  if (typeof message === 'string' && message.trim()) patch.message = message;
  return MaintenanceState.findOneAndUpdate({ key: KEY }, patch, { new: true, upsert: true });
}

async function disable() {
  return MaintenanceState.findOneAndUpdate(
    { key: KEY },
    { enabled: false, testers: [], requests: [], rejected: [], startedAt: null },
    { new: true, upsert: true },
  );
}

async function updateEstimate(minutes) {
  return MaintenanceState.findOneAndUpdate(
    { key: KEY }, { estimateMinutes: minutes }, { new: true, upsert: true },
  );
}

async function updateMessage(text) {
  return MaintenanceState.findOneAndUpdate(
    { key: KEY }, { message: text }, { new: true, upsert: true },
  );
}

// ── Tester ops ────────────────────────────────────────────────────────────
async function isTester(telegramId) {
  const s = await getState();
  if (!s.enabled) return false;
  return s.testers.some(t => String(t.telegramId) === String(telegramId));
}

async function addTester({ telegramId, username, name }) {
  const s = await getState();
  const id = String(telegramId);
  if (s.testers.some(t => String(t.telegramId) === id)) return s;
  s.testers.push({ telegramId: id, username: username || '', name: name || '', approvedAt: new Date() });
  // Also remove from pending requests & rejected if present.
  s.requests = s.requests.filter(r => String(r.telegramId) !== id);
  s.rejected = s.rejected.filter(r => String(r) !== id);
  await s.save();
  return s;
}

async function removeTester(telegramId) {
  return MaintenanceState.findOneAndUpdate(
    { key: KEY },
    { $pull: { testers: { telegramId: String(telegramId) } } },
    { new: true, upsert: true },
  );
}

// ── Request ops ───────────────────────────────────────────────────────────
async function hasPendingRequest(telegramId) {
  const s = await getState();
  return s.requests.some(r => String(r.telegramId) === String(telegramId));
}

async function hasBeenRejected(telegramId) {
  const s = await getState();
  return s.rejected.some(r => String(r) === String(telegramId));
}

async function addRequest({ telegramId, username, name }) {
  const s = await getState();
  const id = String(telegramId);
  if (s.requests.some(r => String(r.telegramId) === id)) return s;
  s.requests.push({ telegramId: id, username: username || '', name: name || '', requestedAt: new Date() });
  await s.save();
  return s;
}

async function popRequest(telegramId) {
  const s = await getState();
  const id = String(telegramId);
  const req = s.requests.find(r => String(r.telegramId) === id);
  s.requests = s.requests.filter(r => String(r.telegramId) !== id);
  await s.save();
  return req || null;
}

async function saveRequestAdminMsg(telegramId, adminId, messageId) {
  const s = await getState();
  const req = s.requests.find(r => String(r.telegramId) === String(telegramId));
  if (!req) return;
  if (!req.adminMessageIds) req.adminMessageIds = new Map();
  req.adminMessageIds.set(String(adminId), Number(messageId));
  await s.save();
}

async function rejectRequest(telegramId) {
  const s = await getState();
  const id = String(telegramId);
  const req = s.requests.find(r => String(r.telegramId) === id);
  s.requests = s.requests.filter(r => String(r.telegramId) !== id);
  if (!s.rejected.includes(id)) s.rejected.push(id);
  await s.save();
  return req || null;
}

// ── Broadcast helpers (Maintenance ON/OFF) ────────────────────────────────
// Fire-and-forget from callers. Never throws.
async function broadcastToAllUsers(bot, text, opts = {}) {
  const users = await User.find({}, { telegramId: 1 }).lean();
  let sent = 0, failed = 0;
  for (const u of users) {
    if (!u.telegramId) continue;
    try {
      await bot.telegram.sendMessage(u.telegramId, text, { parse_mode: 'Markdown', ...opts });
      sent++;
    } catch (_) { failed++; }
    // 25ms throttle — mirrors existing broadcast handler.
    await new Promise(r => setTimeout(r, 25));
  }
  return { sent, failed };
}

// ── User-facing message builder ──────────────────────────────────────────
function formatEstimate(minutes) {
  const n = parseInt(minutes, 10);
  if (!Number.isFinite(n) || n <= 0) return '_belum ditentukan_';
  if (n < 60) return `${n} Menit`;
  if (n % 60 === 0) return `${n / 60} Jam`;
  const h = Math.floor(n / 60), m = n % 60;
  return `${h} Jam ${m} Menit`;
}

function buildUserMessage(state) {
  const base = (state && state.message)
    || `🛠 *BOT SEDANG MAINTENANCE*\n\nSaat ini Admin sedang melakukan maintenance.`;
  const eta = formatEstimate(state && state.estimateMinutes);
  return `${base}\n\n⏱ *Estimasi selesai:*\n${eta}`;
}

module.exports = {
  getState, isEnabled, enable, disable, updateEstimate, updateMessage,
  isTester, addTester, removeTester,
  hasPendingRequest, hasBeenRejected, addRequest, popRequest, rejectRequest,
  saveRequestAdminMsg,
  broadcastToAllUsers,
  formatEstimate, buildUserMessage,
};
