// Cleans up VpsInstance records belonging to a ProviderApi that is confirmed
// PERMANENTLY dead (unauthorized / invalid token / suspended / closed).
//
// This ONLY touches the bot database (VpsInstance.status). It NEVER attempts
// to call the provider API — that call is already known to be impossible,
// which is exactly why the records are stuck in the first place.
//
// Reuses the same "soft delete" convention already used everywhere else in
// VPS Management (status set to 'deleted' → hidden by HIDDEN_STATUSES /
// VISIBLE_FILTER in vpsManagementHandler.js). Order/transaction data is left
// untouched.
const VpsInstance = require('../models/VpsInstance');

const HIDDEN_STATUSES = ['deleted', 'terminated', 'destroyed', 'cancelled'];

// Remove every still-visible VPS tied to one dead ProviderApi from VPS
// Management. Idempotent: already-cleaned records simply won't match the
// filter on subsequent runs.
async function cleanupDeadProviderApi(apiId) {
  if (!apiId) return { cleaned: 0 };
  const filter = { apiId: String(apiId), status: { $nin: HIDDEN_STATUSES } };
  const r = await VpsInstance.updateMany(filter, {
    $set: {
      status: 'deleted',
      lastHealthAt: new Date(),
      lastHealthStatus: 'provider_dead',
    },
  });
  return { cleaned: (r && (r.modifiedCount || r.nModified)) || 0 };
}

module.exports = { cleanupDeadProviderApi };
