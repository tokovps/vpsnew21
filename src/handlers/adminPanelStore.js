// Tracks the active admin panel message per admin so subsequent text/photo
// inputs edit that same message instead of creating new ones.
const panels = new Map(); // userId -> { chatId, messageId }

function setPanel(userId, chatId, messageId) {
  panels.set(String(userId), { chatId, messageId });
}
function getPanel(userId) { return panels.get(String(userId)) || null; }
function clearPanel(userId) { panels.delete(String(userId)); }

module.exports = { setPanel, getPanel, clearPanel };
