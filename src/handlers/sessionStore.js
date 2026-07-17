// Simple in-memory session per user. Cleared on cancel/back.
// When set via `openInputSession`, also stores the anchor message
// (chatId + messageId of the current UI) so the text handler can edit
// that same message instead of spawning a new chat message.
const sessions = new Map();

function getSession(userId) { return sessions.get(String(userId)) || null; }
function setSession(userId, data) { sessions.set(String(userId), data); }
function clearSession(userId) { sessions.delete(String(userId)); }

// Convenience: start an input-collection session from a callback context.
// Records the anchor message so respondInSession() can edit it later.
function openInputSession(ctx, data) {
  const uid = String(ctx.from.id);
  // Determine anchor:
  //   - Priority 1: existing session anchor (so mid-wizard text updates preserve it)
  //   - Priority 2: current callbackQuery message (wizard entry via inline button)
  //   - Priority 3: admin panel anchor (from /admin command)
  //   - Priority 4: incoming edited/message reference (last resort)
  const prev = sessions.get(uid);
  let anchor = (data && data.__anchor) || (prev && prev.__anchor) || null;
  if (!anchor || !anchor.chatId) {
    const cbMsg = ctx.callbackQuery && ctx.callbackQuery.message;
    if (cbMsg) anchor = { chatId: cbMsg.chat.id, messageId: cbMsg.message_id };
  }
  if (!anchor || !anchor.chatId) {
    try {
      const { getPanel } = require('./adminPanelStore');
      const p = getPanel(uid);
      if (p) anchor = { chatId: p.chatId, messageId: p.messageId };
    } catch (_) {}
  }
  sessions.set(uid, { ...data, __anchor: anchor || {} });
}

function getAnchor(userId) {
  const s = sessions.get(String(userId));
  return (s && s.__anchor && s.__anchor.chatId) ? s.__anchor : null;
}

module.exports = { getSession, setSession, clearSession, openInputSession, getAnchor };
