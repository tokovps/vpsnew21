// Classifies a provider API error as PERMANENT (account dead — unauthorized,
// invalid token, suspended, closed) vs TEMPORARY (timeout, DNS, rate limit,
// network outage, connection refused).
//
// Used by:
//  - src/health/providerHealth.js  → decide whether to mark a ProviderApi as
//    permanently dead and trigger automatic VPS DB cleanup.
//  - src/handlers/vpsManagementHandler.js → decide whether a failed manual
//    delete should fall back to a DB-only cleanup instead of surfacing an
//    error to the admin.
//
// IMPORTANT: this module only classifies. It never talks to Mongo or any
// provider API, so it is safe to reuse from both call sites without touching
// provider adapters, schemas, or the delete/health lifecycles themselves.

const PERMANENT_PATTERNS = [
  'unauthorized',
  'invalid token',
  'invalid api key',
  'invalid access token',
  'invalid credential',
  'authentication failed',
  'account closed',
  'account has been closed',
  'account suspended',
  'suspended',
  'forbidden',
  'access denied',
  'token expired',
  'token has expired',
  'status code 401',
  'status code 403',
];

function isPermanentProviderFailure(errorOrMessage) {
  if (!errorOrMessage) return false;

  // Prefer an HTTP status code when available (axios-style error objects).
  const status = errorOrMessage && errorOrMessage.response && errorOrMessage.response.status;
  if (status === 401 || status === 403) return true;

  const msg = String(
    (errorOrMessage && errorOrMessage.message) || errorOrMessage || ''
  ).toLowerCase();
  return PERMANENT_PATTERNS.some((p) => msg.includes(p));
}

module.exports = { isPermanentProviderFailure };
