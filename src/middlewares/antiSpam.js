const { tryLock } = require('../utils/locks');

// Throttle callback queries to prevent double-click spam.
function antiSpamCallback() {
  return async (ctx, next) => {
    if (ctx.callbackQuery) {
      const key = `cb:${ctx.from.id}:${ctx.callbackQuery.data}`;
      if (!tryLock(key)) {
        try { await ctx.answerCbQuery('⏳ Mohon tunggu sebentar...'); } catch (_) {}
        return;
      }
    }
    return next();
  };
}

module.exports = { antiSpamCallback };
