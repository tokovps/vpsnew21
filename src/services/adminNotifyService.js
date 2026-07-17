// Admin Activity Notification service.
// Broadcasts short, important events to admin chats and auto-deletes them
// after a TTL (default 30s) so admin chat stays clean.
//
// Design goals:
//   - NEVER sends to user chats (Single-Message UI preserved).
//   - Fire-and-forget: callers should not await, and errors are swallowed.
//   - TTL configurable via Setting.adminNotifyTTL (seconds).
//   - Rate-limit safety: dedupe identical bursts within 2s.

const Admin = require('../models/Admin');
const { config } = require('../config');
const { getSettings } = require('./settingService');

let _bot = null;
function attachBot(bot) { _bot = bot; }

const _recent = new Map(); // hash -> ts
function _dedupe(key) {
  const now = Date.now();
  const prev = _recent.get(key);
  if (prev && (now - prev) < 2000) return true;
  _recent.set(key, now);
  if (_recent.size > 500) {
    // trim oldest
    const cutoff = now - 10000;
    for (const [k, v] of _recent) if (v < cutoff) _recent.delete(k);
  }
  return false;
}

async function _adminIds() {
  const ids = new Set();
  if (config.adminId) ids.add(String(config.adminId));
  try {
    const admins = await Admin.find({}, { telegramId: 1 }).lean();
    for (const a of admins) if (a.telegramId) ids.add(String(a.telegramId));
  } catch (_) {}
  return [...ids];
}

async function _ttl() {
  try {
    const s = await getSettings();
    const n = parseInt(s.adminNotifyTTL, 10);
    if (Number.isFinite(n) && n > 0) return n;
  } catch (_) {}
  return 30;
}

// Format helpers
function _clock() {
  const d = new Date(Date.now() + 7 * 3600 * 1000); // WIB
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} WIB`;
}
function _userLine(u) {
  if (!u) return '-';
  const name = u.firstName || u.first_name || u.name || '';
  const un = u.username ? ` (@${u.username})` : '';
  return `${name || 'User'}${un}`.trim();
}

// Core: send a raw text (Markdown) to all admins with auto-delete.
async function _sendRaw(text) {
  if (!_bot) return;
  const key = text.slice(0, 120);
  if (_dedupe(key)) return;
  const ttl = await _ttl();
  const ids = await _adminIds();
  for (const id of ids) {
    try {
      // Send as NEW message with normal (audible) notification.
      // Do NOT use disable_notification / editMessage — admin must hear the ping
      // even if the bot chat is closed.
      const m = await _bot.telegram.sendMessage(id, text, { parse_mode: 'Markdown' });
      if (ttl > 0 && m && m.message_id) {
        setTimeout(() => {
          _bot.telegram.deleteMessage(id, m.message_id).catch(() => {});
        }, ttl * 1000);
      }
    } catch (_) { /* admin blocked bot / invalid id — ignore */ }
  }
}

// Build "Aktivitas Bot" style block.
function buildActivity({ user, activity, extra }) {
  const uid = user && (user.telegramId || user.id) ? String(user.telegramId || user.id) : '-';
  const parts = [
    '━━━━━━━━━━━━━━',
    '🔔 *Aktivitas Bot*',
    '',
    `👤 *User:* ${_userLine(user)}`,
    `🆔 *ID:* \`${uid}\``,
    `⚡ *Aktivitas:* ${activity}`,
  ];
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined || v === null || v === '') continue;
      parts.push(`${k} ${v}`);
    }
  }
  parts.push(`🕒 ${_clock()}`);
  parts.push('━━━━━━━━━━━━━━');
  return parts.join('\n');
}

// Public helpers — each fire-and-forget from callers.
function notifyActivity(user, activity, extra) {
  return _sendRaw(buildActivity({ user, activity, extra })).catch(() => {});
}

function notifyRaw(text) { return _sendRaw(text).catch(() => {}); }

// Specialised: "User Membuka Katalog VPS/RDP" — matches spec exactly.
function notifyCatalogOpen(user, category /* 'vps' | 'rdp' */) {
  const cat = String(category).toUpperCase();
  const name = (user && (user.first_name || user.firstName || user.name)) || 'User';
  const uid = user && (user.id || user.telegramId) ? String(user.id || user.telegramId) : '-';
  const un = user && user.username ? `@${user.username}` : '-';
  const text =
`━━━━━━━━━━━━━━━━━━
🔔 *User Membuka Katalog ${cat}*

👤 *Nama:* ${name}
🆔 *ID:* \`${uid}\`
👤 *Username:* ${un}
🕒 *Waktu:* ${_clock()}
━━━━━━━━━━━━━━━━━━`;
  return _sendRaw(text).catch(() => {});
}

// Specialised: "🔔 User Masuk" — sent when a user issues /start.
function notifyStart(user, isNew) {
  const name = (user && (user.first_name || user.firstName || user.name)) || 'User';
  const uid = user && (user.id || user.telegramId) ? String(user.id || user.telegramId) : '-';
  const un = user && user.username ? ` (@${user.username})` : '';
  const status = isNew ? '🆕 User Baru' : '🔄 User Lama';
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  const p = (x) => String(x).padStart(2, '0');
  const time = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} WIB`;
  const text =
`🔔 *User Masuk*

👤 ${name}${un}
🆔 \`${uid}\`

${status}

🕒 ${time}`;
  return _sendRaw(text).catch(() => {});
}

module.exports = { attachBot, notifyActivity, notifyRaw, notifyCatalogOpen, notifyStart };
