const { config } = require('../config');
const Admin = require('../models/Admin');
const { upsertUser } = require('../services/userService');

async function attachUser(ctx, next) {
  if (ctx.from && !ctx.from.is_bot) {
    try { ctx.state.user = await upsertUser(ctx.from); } catch (_) {}
    ctx.state.isAdmin = await isAdmin(ctx.from.id);
  }
  return next();
}

async function isAdmin(telegramId) {
  const id = String(telegramId);
  if (id === String(config.adminId)) return true;
  const a = await Admin.findOne({ telegramId: id });
  return !!a;
}

function adminOnly() {
  return async (ctx, next) => {
    if (!ctx.from) return;
    if (!(await isAdmin(ctx.from.id))) {
      // Silently ignore — admin panel must be hidden.
      return;
    }
    return next();
  };
}

module.exports = { attachUser, isAdmin, adminOnly };
