// Handle admin photo uploads → banner per scope, or QRIS image.
// Uses respondSaved so admin stays on context menu after save.
const { respondSaved } = require('../utils/safeEdit');
const { getSession, clearSession } = require('./sessionStore');
const { updateSetting } = require('../services/settingService');

function extractFileId(ctx) {
  const photos = ctx.message.photo;
  if (!photos || !photos.length) return null;
  return photos[photos.length - 1].file_id;
}

async function handleAdminPhoto(ctx) {
  const s = getSession(ctx.from.id);
  if (!s) return false;
  const returnTo = s.returnTo || 'a:home';

  if (s.action === 'admin_edit_banner') {
    const fid = extractFileId(ctx);
    if (!fid) return false;
    await updateSetting({ [s.field]: fid });
    clearSession(ctx.from.id);
    await respondSaved(ctx, `✅ Banner *${s.label}* berhasil diubah.`, returnTo);
    return true;
  }

  return false;
}

module.exports = { handleAdminPhoto };
