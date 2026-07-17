// ═══════════════════════════════════════════════════════════════════════════
// RDP AUTO-CREATE STATE MACHINE — Single Source of Truth
// ---------------------------------------------------------------------------
// Every visible piece of information (progress %, ETA remaining, checklist)
// is derived EXCLUSIVELY from the current `rdpState`. There is no time-based
// math, no timer that mutates progress, no independent writer.
//
// Rules:
//   • Progress % is monotonically non-decreasing per order. If the code ever
//     tries to move backwards (bug in orchestrator), the renderer clamps to
//     the previous max.
//   • ETA is a lookup — NOT derived from elapsed time. When state doesn't
//     change for a while, ETA stays put; the animated spinner is the only
//     thing that changes, purely to signal liveness.
//   • Each state carries a fixed checklist bitmap: which checks are ✅ when
//     the state is reached. This prevents "Generate Password ✅" appearing
//     before the generated credential is ready to be released.
//   • State is persisted on every transition (rdpState/rdpStateAt/rdpProgressPct),
//     so bot restart or monitor restart cannot rewind the UI.
// ═══════════════════════════════════════════════════════════════════════════

// Checklist keys used by the UI. Order matters — this is display order.
const CHECK_KEYS = [
  'vps_ready',           // VPS Linux Berhasil Dibuat
  'ssh_ready',           // SSH Connected
  'reinstall_started',   // Script Reinstall Berjalan
  'windows_booting',     // Windows Sedang Diinstall
  'rdp_configured',      // Konfigurasi RDP
  'password_generated',  // Generate Password (only when Windows actually ready)
  'validation',          // Final Validation
];

// State table. Every state must have: label, pct, etaMin, checks[], phase.
// `checks` = list of check keys that turn ✅ upon reaching this state.
// pct is the guaranteed progress when we enter this state.
// etaMin = estimated MINUTES REMAINING once we enter this state (upper bound).
const STATES = {
  QUEUED:              { label: 'Masuk Antrian',                pct:  2, etaMin: 40, checks: [] },
  PROVIDER_SELECTING:  { label: 'Memilih Provider Terbaik',      pct:  5, etaMin: 40, checks: [] },
  PROVIDER_LOCKED:     { label: 'Mengunci Provider',             pct:  8, etaMin: 39, checks: [] },
  VPS_CREATING:        { label: 'Membuat VPS Linux',             pct: 15, etaMin: 38, checks: [] },
  VPS_READY:           { label: 'VPS Linux Siap',                pct: 22, etaMin: 35, checks: ['vps_ready'] },
  SSH_CONNECTING:      { label: 'Menghubungkan SSH',             pct: 25, etaMin: 34, checks: ['vps_ready'] },
  SSH_READY:           { label: 'SSH Connected',                 pct: 30, etaMin: 33, checks: ['vps_ready', 'ssh_ready'] },
  REINSTALL_STARTING:  { label: 'Menjalankan Script Reinstall',  pct: 35, etaMin: 32, checks: ['vps_ready', 'ssh_ready', 'reinstall_started'] },
  LINUX_REBOOTING:     { label: 'VPS Reboot ke Installer',       pct: 42, etaMin: 30, checks: ['vps_ready', 'ssh_ready', 'reinstall_started'] },
  WINDOWS_INSTALLING:  { label: 'Menginstall Windows',           pct: 60, etaMin: 20, checks: ['vps_ready', 'ssh_ready', 'reinstall_started', 'windows_booting'] },
  WINDOWS_BOOTING:     { label: 'Windows Booting',               pct: 80, etaMin:  6, checks: ['vps_ready', 'ssh_ready', 'reinstall_started', 'windows_booting'] },
  RDP_CONFIGURING:     { label: 'Konfigurasi RDP',               pct: 86, etaMin:  4, checks: ['vps_ready', 'ssh_ready', 'reinstall_started', 'windows_booting', 'rdp_configured'] },
  RDP_VALIDATING:      { label: 'Validasi RDP',                  pct: 92, etaMin:  2, checks: ['vps_ready', 'ssh_ready', 'reinstall_started', 'windows_booting', 'rdp_configured'] },
  // Internal key retained for backward compatibility with persisted orders.
  // This phase does not pretend to perform a full Administrator credential
  // login; it finalizes the secret only after the endpoint security gates pass.
  LOGIN_TESTING:       { label: 'Finalisasi Kredensial',          pct: 96, etaMin:  1, checks: ['vps_ready', 'ssh_ready', 'reinstall_started', 'windows_booting', 'rdp_configured', 'password_generated'] },
  COMPLETED:           { label: 'Selesai',                       pct: 100, etaMin: 0, checks: ['vps_ready', 'ssh_ready', 'reinstall_started', 'windows_booting', 'rdp_configured', 'password_generated', 'validation'] },
  FAILED:              { label: 'Gagal',                         pct: 100, etaMin: 0, checks: [] },
};

const STATE_KEYS = Object.keys(STATES);

// Ordinal for monotonic transitions. FAILED is a terminal that can be reached
// from anywhere; COMPLETED is only reached from LOGIN_TESTING. Any attempt to
// move to a state with a LOWER ordinal than the current one is REJECTED by
// the progress renderer (see rdpProgress.js). This is the single guard that
// prevents "state kembali ke Memilih Provider Terbaik" bugs.
const STATE_ORDINAL = STATE_KEYS.reduce((acc, k, i) => { acc[k] = i; return acc; }, {});

function isValidState(s) { return !!STATES[s]; }

/**
 * Can we transition from `curr` to `next` without violating monotonic order?
 * FAILED is always allowed (terminal). Otherwise `next` must be >= curr.
 * Empty/unknown curr is treated as ordinal 0 (start).
 */
function canAdvance(curr, next) {
  if (next === 'FAILED') return true;
  if (!STATES[next]) return false;
  const a = STATE_ORDINAL[curr] != null ? STATE_ORDINAL[curr] : -1;
  const b = STATE_ORDINAL[next];
  return b >= a;
}

function describe(state) {
  const def = STATES[state] || STATES.QUEUED;
  return {
    state,
    label: def.label,
    pct: def.pct,
    etaMin: def.etaMin,
    checks: new Set(def.checks),
  };
}

// Format ETA minutes → human string. No fractional minutes because the source
// value is a per-state constant, not an elapsed-derived estimate.
function formatEta(etaMin) {
  if (etaMin <= 0) return 'segera';
  if (etaMin === 1) return '± 1 menit lagi';
  return `± ${etaMin} menit lagi`;
}

module.exports = { STATES, STATE_KEYS, STATE_ORDINAL, CHECK_KEYS, isValidState, canAdvance, describe, formatEta };
