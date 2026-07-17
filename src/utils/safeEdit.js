// Safe edit helpers — always edit message instead of sending new one.
// Falls back to reply if editing fails (e.g., message too old / type mismatch).

async function safeEditText(ctx, text, extra = {}) {
  const isParseErr = (err) => err && err.description && /can't parse entities|Bad Request: can't parse/i.test(err.description);
  const extraNoParse = () => { const e = { ...extra }; delete e.parse_mode; return e; };
  // Resolve target: either callbackQuery.message OR session/panel anchor.
  const cbMsg = ctx.callbackQuery && ctx.callbackQuery.message;
  let anchor = null;
  if (!cbMsg) {
    try {
      const { getAnchor } = require('../handlers/sessionStore');
      const { getPanel } = require('../handlers/adminPanelStore');
      anchor = getAnchor(ctx.from && ctx.from.id);
      if (!anchor || !anchor.chatId) {
        const p = getPanel(ctx.from && ctx.from.id);
        if (p) anchor = { chatId: p.chatId, messageId: p.messageId };
      }
    } catch (_) {}
  }
  try {
    if (cbMsg) {
      if (cbMsg.photo || cbMsg.video || cbMsg.document) {
        try { return await ctx.editMessageCaption(text, extra); }
        catch (err) {
          if (isParseErr(err)) return await ctx.editMessageCaption(text, extraNoParse());
          throw err;
        }
      }
      try { return await ctx.editMessageText(text, extra); }
      catch (err) {
        if (isParseErr(err)) return await ctx.editMessageText(text, extraNoParse());
        throw err;
      }
    }
    if (anchor && anchor.chatId && anchor.messageId) {
      // Delete user's incoming text/photo message (if any) before editing anchor.
      try { if (ctx.message && ctx.message.message_id) await ctx.deleteMessage(ctx.message.message_id); } catch (_) {}
      try {
        return await ctx.telegram.editMessageText(anchor.chatId, anchor.messageId, undefined, text, extra);
      } catch (err) {
        if (isParseErr(err)) {
          try { return await ctx.telegram.editMessageText(anchor.chatId, anchor.messageId, undefined, text, extraNoParse()); } catch (_) {}
        }
        try { return await ctx.telegram.editMessageCaption(anchor.chatId, anchor.messageId, undefined, text, extra); } catch (_) {}
      }
    }
    return await ctx.reply(text, extra);
  } catch (err) {
    if (err && err.description && err.description.includes('message is not modified')) return;
    try {
      if (isParseErr(err)) return await ctx.reply(text, extraNoParse());
      return await ctx.reply(text, extra);
    } catch (_) {
      try { return await ctx.reply(text, extraNoParse()); } catch (__) { /* ignore */ }
    }
  }
}

async function safeEditMedia(ctx, media, extra = {}) {
  try {
    if (ctx.callbackQuery && ctx.callbackQuery.message) {
      const msg = ctx.callbackQuery.message;
      if (msg.photo || msg.video || msg.document) {
        return await ctx.editMessageMedia(media, extra);
      }
      // Previous message is text — delete & send photo
      try { await ctx.deleteMessage(); } catch (_) {}
      return await ctx.replyWithPhoto(media.media, { caption: media.caption, parse_mode: media.parse_mode, ...extra });
    }
    return await ctx.replyWithPhoto(media.media, { caption: media.caption, parse_mode: media.parse_mode, ...extra });
  } catch (err) {
    if (err && err.description && err.description.includes('message is not modified')) return;
    try { await ctx.deleteMessage(); } catch (_) {}
    try {
      return await ctx.replyWithPhoto(media.media, { caption: media.caption, parse_mode: media.parse_mode, ...extra });
    } catch (_) { /* ignore */ }
  }
}

async function answerCb(ctx, text = '', alert = false) {
  try { await ctx.answerCbQuery(text, { show_alert: alert }); } catch (_) {}
}

// Edit the session anchor message (single-message UI) after a text input.
// Deletes the user's typed message and updates the previously-shown UI.
// If no anchor available, falls back to ctx.reply.
async function respondInSession(ctx, text, extra = {}) {
  const { getAnchor } = require('../handlers/sessionStore');
  const { getPanel } = require('../handlers/adminPanelStore');
  let anchor = getAnchor(ctx.from.id);
  if (!anchor || !anchor.chatId) {
    const p = getPanel(ctx.from.id);
    if (p) anchor = { chatId: p.chatId, messageId: p.messageId };
  }
  try { if (ctx.message && ctx.message.message_id) await ctx.deleteMessage(ctx.message.message_id); } catch (_) {}
  if (anchor && anchor.chatId && anchor.messageId) {
    try {
      return await ctx.telegram.editMessageText(anchor.chatId, anchor.messageId, undefined, text, extra);
    } catch (err) {
      try {
        return await ctx.telegram.editMessageCaption(anchor.chatId, anchor.messageId, undefined, text, extra);
      } catch (_) {}
    }
  }
  // Last-resort fallback (should never happen in normal admin flow)
  try { return await ctx.reply(text, extra); } catch (_) {}
}

// Edit anchor with a "saved" message + a single "⬅️ Kembali" button that
// routes back to the caller's context menu (stay-on-page UX; no bounce to home).
async function respondSaved(ctx, text, returnTo = 'a:home', label = '⬅️ Kembali') {
  const { Markup } = require('telegraf');
  const { getAnchor } = require('../handlers/sessionStore');
  const { getPanel } = require('../handlers/adminPanelStore');
  let anchor = getAnchor(ctx.from.id);
  if (!anchor || !anchor.chatId) {
    const p = getPanel(ctx.from.id);
    if (p) anchor = { chatId: p.chatId, messageId: p.messageId };
  }
  try { if (ctx.message && ctx.message.message_id) await ctx.deleteMessage(ctx.message.message_id); } catch (_) {}
  const opts = { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback(label, returnTo)]]) };
  if (anchor && anchor.chatId && anchor.messageId) {
    try { return await ctx.telegram.editMessageText(anchor.chatId, anchor.messageId, undefined, text, opts); }
    catch (_) {
      try { return await ctx.telegram.editMessageCaption(anchor.chatId, anchor.messageId, undefined, text, opts); }
      catch (__) {}
    }
  }
  try { return await ctx.reply(text, opts); } catch (_) {}
}

module.exports = { safeEditText, safeEditMedia, answerCb, respondInSession, respondSaved };
