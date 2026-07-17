// Loading Feedback middleware.
// Purpose: give the user an INSTANT popup ("⏳ Memuat ...") the moment they tap
// any inline button, while the real handler renders in the background.
//
// Design (minimal-invasive):
//   1. Fire ctx.answerCbQuery(loadingText) IMMEDIATELY (no await) — Telegram
//      shows the popup right away.
//   2. Monkey-patch ctx.answerCbQuery so subsequent handler calls become no-ops
//      (Telegram only allows one answer per callback). This means we don't need
//      to edit ~180 existing handlers.
//   3. Skip a small allow-list of callbacks whose handler must send an ALERT.
//
// Existing handlers already end with:  await ctx.answerCbQuery().catch(()=>{})
// so overriding is 100% backward-compatible.

const { labelFor, shouldSkip } = require('../services/loadingLabels');

function loadingFeedback() {
  return async (ctx, next) => {
    if (ctx.callbackQuery) {
      const data = ctx.callbackQuery.data || '';
      const original = ctx.answerCbQuery.bind(ctx);
      let answered = false;

      // Wrap so only the FIRST answer wins.
      ctx.answerCbQuery = async (text, extra) => {
        if (answered) return; // silently no-op
        answered = true;
        try { return await original(text, extra); } catch (_) {}
      };

      if (!shouldSkip(data)) {
        // Fire-and-forget the loading popup.
        // Not awaited so the handler starts working immediately.
        ctx.answerCbQuery(labelFor(data));
      }
    }
    return next();
  };
}

module.exports = { loadingFeedback };
