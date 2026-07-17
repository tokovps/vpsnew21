// Centralised configuration for the RDP provisioning subsystem.
// Every knob can be overridden via ENV to avoid touching source code
// when tuning production behaviour.
//
// The Windows installer command template is expressed as a single string
// with `${...}` placeholders so operators can swap scripts (e.g. from
// bin456789/reinstall to another maintained fork) via env only.

// Prefer the local compatibility mirror whenever the application has a public
// URL. Previously the RDP compatibility patch existed but was silently OFF
// unless operators configured three separate variables by hand. Render
// deployments already define WEBHOOK_URL, so use it as the safe default while
// still respecting an explicit REINSTALL_SCRIPT_URL override.
const CONFHOME_MIRROR_PATH = (process.env.CONFHOME_MIRROR_PATH || '/reinstall-mirror')
  .replace(/\/+$/, '') || '/reinstall-mirror';
const CONFHOME_MIRROR_PUBLIC_URL = (process.env.CONFHOME_MIRROR_PUBLIC_URL
  || process.env.WEBHOOK_URL || '').replace(/\/+$/, '');
const UPSTREAM_REINSTALL_SCRIPT_URL =
  'https://raw.githubusercontent.com/bin456789/reinstall/main/reinstall.sh';
const REINSTALL_SCRIPT_URL = process.env.REINSTALL_SCRIPT_URL
  || (CONFHOME_MIRROR_PUBLIC_URL
    ? `${CONFHOME_MIRROR_PUBLIC_URL}${CONFHOME_MIRROR_PATH}/reinstall.sh`
    : UPSTREAM_REINSTALL_SCRIPT_URL);

// Mapping from user-facing Windows version to bin456789/reinstall args.
//
// Upstream (bin456789/reinstall as of 2026) accepts ONLY `windows` as the
// OS-type subcommand. Version selection is expressed EXCLUSIVELY through
// `--image-name`. Auto-search of ISO from massgrave.dev supports:
//   Windows 10, 11 and Server 2019, 2022, 2025.
// Server 2016 and 2012 R2 do NOT auto-search — user must specify --iso, so
// they are surfaced as UNSUPPORTED in `isAutoInstallSupported()`. The RDP
// orchestrator calls that preflight BEFORE creating any droplet so unpaid
// selections that will never work are caught immediately with a clear
// message instead of the historical silent 45-minute timeout.
//
// Source: https://github.com/bin456789/reinstall/blob/main/README.en.md
//   "Windows 11 Pro"
//   "Windows 10 Pro"
//   "Windows 11 Enterprise LTSC 2024"
//   "Windows Server 2025 SERVERDATACENTER"
const WINDOWS_IMAGE_MAP = {
  'server 2025':  { sub: 'windows', imageName: 'Windows Server 2025 SERVERSTANDARD' },
  'server 2022':  { sub: 'windows', imageName: 'Windows Server 2022 SERVERSTANDARD' },
  'server 2019':  { sub: 'windows', imageName: 'Windows Server 2019 SERVERSTANDARD' },
  'server 2016':  { sub: 'windows', imageName: 'Windows Server 2016 SERVERSTANDARD' },
  'server 2012':  { sub: 'windows', imageName: 'Windows Server 2012 R2 SERVERSTANDARD' },
  '2025':         { sub: 'windows', imageName: 'Windows Server 2025 SERVERSTANDARD' },
  '2022':         { sub: 'windows', imageName: 'Windows Server 2022 SERVERSTANDARD' },
  '2019':         { sub: 'windows', imageName: 'Windows Server 2019 SERVERSTANDARD' },
  '2016':         { sub: 'windows', imageName: 'Windows Server 2016 SERVERSTANDARD' },
  '2012':         { sub: 'windows', imageName: 'Windows Server 2012 R2 SERVERSTANDARD' },
  'win 11':       { sub: 'windows', imageName: 'Windows 11 Pro' },
  'win 10':       { sub: 'windows', imageName: 'Windows 10 Pro' },
  'windows 11':   { sub: 'windows', imageName: 'Windows 11 Pro' },
  'windows 10':   { sub: 'windows', imageName: 'Windows 10 Pro' },
  '11':           { sub: 'windows', imageName: 'Windows 11 Pro' },
  '10':           { sub: 'windows', imageName: 'Windows 10 Pro' },
};
const DEFAULT_WINDOWS = { sub: 'windows', imageName: 'Windows Server 2022 SERVERSTANDARD' };

function readDurationMs(name, fallbackMs, minimumMs = 1000) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallbackMs;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= minimumMs ? parsed : fallbackMs;
}

const REINSTALL_DISPATCH_TIMEOUT_MS = readDurationMs(
  'RDP_REINSTALL_DISPATCH_TIMEOUT_MS', 4 * 60 * 1000, 2 * 60 * 1000
);
const REINSTALL_MAX_TIMEOUT_MS = readDurationMs(
  'RDP_REINSTALL_MAX_TIMEOUT_MS', 20 * 60 * 1000, 15 * 60 * 1000
);
const REBOOT_HARD_LIMIT_MS = readDurationMs(
  'RDP_REBOOT_HARD_LIMIT_MS', 3 * 60 * 1000, 60 * 1000
);
const REBOOT_ESCALATION_GRACE_MS = readDurationMs(
  'RDP_REBOOT_ESCALATION_GRACE_MS', 30 * 1000, 10 * 1000
);
const ALPINE_STUCK_TIMEOUT_MS = readDurationMs(
  'RDP_ALPINE_STUCK_TIMEOUT_MS', 12 * 60 * 1000, 5 * 60 * 1000
);
const PORT_POLL_INTERVAL_MS = readDurationMs(
  'RDP_PORT_POLL_INTERVAL_MS', 5 * 1000, 2 * 1000
);

// ─────────────────────────────────────────────────────────────────────────
// AUTO-INSTALL SUPPORT MATRIX
// Historical version of this gate rejected Server 2012 R2 / 2016 because
// upstream reinstall.sh could not auto-search their ISOs on massgrave.dev.
// After the ROUND-4 fix we ALWAYS pass an explicit `--iso <URL>` resolved
// from operator ENV (see windowsInstaller.js). This eliminates the whole
// upstream auto-search failure mode, so the *real* gate is now:
//   "is the Windows version present in WINDOWS_MATRIX AND is its ENV set?"
// That check lives in `windowsInstaller.resolveWindowsTarget()` and is
// called by the orchestrator BEFORE any droplet is created.
//
// We keep these two helpers as backwards-compatible no-ops so any legacy
// caller (tests, admin diagnostics) doesn't crash. New code must call
// `resolveWindowsTarget` instead.
// ─────────────────────────────────────────────────────────────────────────
function isAutoInstallSupported(_osVersion = '') { return true; }
function autoInstallUnsupportedReason(_osVersion = '') { return ''; }

// ─────────────────────────────────────────────────────────────────────────
// WINDOWS PASSWORD POLICY VALIDATOR
// Default Windows complexity requirement:
//   - length ≥ 8 (kita paksa ≥ 12)
//   - mengandung minimal 3 dari 4 kategori: upper, lower, digit, symbol
//     (kita paksa keempatnya)
//   - tidak mengandung nama user (administrator)
// Selain itu untuk RDP:
//   - tidak boleh mengandung karakter yang menyulitkan shell-escaping
//     (', ", `, \, $, spasi)  ← passwordGen sudah aman, tapi kita cek lagi
// ─────────────────────────────────────────────────────────────────────────
function validateWindowsPassword(pwd = '', username = 'administrator') {
  const s = String(pwd || '');
  const errors = [];
  if (s.length < 12)          errors.push('length<12');
  if (!/[A-Z]/.test(s))        errors.push('no-uppercase');
  if (!/[a-z]/.test(s))        errors.push('no-lowercase');
  if (!/[0-9]/.test(s))        errors.push('no-digit');
  if (!/[!@#$%^&*\-_=+?()[\]{}]/.test(s)) errors.push('no-symbol');
  const uname = String(username || '').toLowerCase();
  if (uname && s.toLowerCase().includes(uname)) errors.push('contains-username');
  if (/[\s'"`\\$]/.test(s))    errors.push('contains-shell-hostile-char');
  return { ok: errors.length === 0, errors };
}

function resolveWindowsImage(osVersion = '') {
  const v = String(osVersion || '').toLowerCase();
  for (const key of Object.keys(WINDOWS_IMAGE_MAP)) {
    if (v.includes(key)) return WINDOWS_IMAGE_MAP[key];
  }
  return DEFAULT_WINDOWS;
}

// Build the shell command run over SSH to trigger Windows reinstall.
//
// Correct invocation (per upstream README line 100–101 + long-opts parser):
//   bash reinstall.sh windows \
//        --image-name "..." \
//        --iso        "http://xxx/xxx.iso" \
//        --lang       en-us \
//        --username   administrator \
//        --password   "..." \
//        [--rdp-port  N]
//
// 🔴 ROOT CAUSE FIX (this revision):
// Historical live-run failed with: "iso url is not set → Attempting to find
// it automatically → ISO Link is empty → script exit=1". Traced to
// reinstall.sh setos_windows() at line 1514–1552: when --iso is NOT given,
// the script scrapes massgrave.dev to guess a Microsoft signed URL, then
// runs test_url_grace(); if the guess is not directly downloadable (which
// is now common — MS signed URLs require session cookies) it falls back to
// an interactive `read -r -p "Direct Link: "`. Non-interactive SSH stdin
// = EOF → iso empty → error_and_exit → exit 1 → no DD staged → no reboot.
//
// We now pass `--iso` EXPLICITLY, resolved by windowsInstaller.js from
// operator ENV (WIN_ISO_SERVER_2022, WIN_ISO_WIN_11, etc.) BEFORE this
// command is built. If the URL is missing or unreachable, the orchestrator
// aborts BEFORE calling this function — the reinstall never runs at all.
//
// TWO-LAYER STDIN DEFENCE remains:
//   1. `--username administrator` bypasses upstream's interactive Username: prompt.
//   2. `printf '\n\n\n\n\n' | ...` keeps `read` alive if upstream adds a new prompt.
//
// The script calls `reboot` itself when DD payload is staged. We DO NOT add
// a blind reboot fallback (that historical bug rebooted even on errors).
function buildReinstallCommand({ sub, imageName, password, rdpPort, username, isoUrl }) {
  const safeSub = String(sub || DEFAULT_WINDOWS.sub);        // always 'windows'
  const safeImage = String(imageName || '').replace(/"/g, '');
  const safePwd = String(password || '').replace(/"/g, '\\"');
  const safeUser = String(username || 'administrator').replace(/[^A-Za-z0-9_.-]/g, '') || 'administrator';
  const rdp = Number(rdpPort) || 3389;
  const lang = process.env.REINSTALL_LANG || 'en-us';
  // The Ubuntu-side script only stages the Alpine installer. It should
  // finish (or reboot the VPS) within a few minutes; the multi-gigabyte ISO
  // download happens later inside Alpine. A bounded command prevents a
  // broken upstream prompt/download from leaving the order frozen at 35%
  // forever. Operators can still raise this for unusually slow providers.
  const dispatchTimeoutSec = Math.ceil(REINSTALL_DISPATCH_TIMEOUT_MS / 1000);
  const iso = String(isoUrl || '').trim();
  if (!iso || !/^https?:\/\//i.test(iso)) {
    // Refuse to construct a command that will inevitably hit the ISO auto-search
    // failure mode. Orchestrator MUST resolve isoUrl via windowsInstaller first.
    throw new Error('buildReinstallCommand: isoUrl kosong / bukan http(s) — orchestrator wajib resolve ISO URL sebelum memanggil ini.');
  }
  const safeIso = iso.replace(/"/g, '\\"');
  return [
    'set -o pipefail',
    'export DEBIAN_FRONTEND=noninteractive',
    // Install curl + xz if the image is minimal enough to be missing them.
    '(command -v curl >/dev/null 2>&1 || (apt-get update -y >/dev/null 2>&1; apt-get install -y curl xz-utils >/dev/null 2>&1) || (yum install -y curl xz >/dev/null 2>&1) || true)',
    // Print resolved params BEFORE anything else — makes log audit trivial.
    `echo "[rdp] === REINSTALL PARAMETERS ==="`,
    `echo "[rdp] image-name : ${safeImage}"`,
    `echo "[rdp] iso        : ${safeIso}"`,
    `echo "[rdp] lang       : ${lang}"`,
    `echo "[rdp] username   : ${safeUser}"`,
    `echo "[rdp] rdp-port   : ${rdp}"`,
    `echo "[rdp] script-url : ${REINSTALL_SCRIPT_URL}"`,
    `echo "[rdp] ============================"`,
    // Download reinstall.sh (should already exist from precheck, but re-download
    // to be safe — precheck may have run on a different SSH session).
    `curl -fsSL --max-time 30 -o /tmp/reinstall.sh "${REINSTALL_SCRIPT_URL}" 2>&1`,
    `SCRIPT_RC=$?; echo "[rdp] script download exit=$SCRIPT_RC size=$(wc -c </tmp/reinstall.sh 2>/dev/null || echo 0) bytes"`,
    `if [ $SCRIPT_RC -ne 0 ] || [ $(wc -c </tmp/reinstall.sh) -lt 50000 ]; then echo "[rdp] FATAL reinstall.sh download failed / too small"; exit 40; fi`,
    'chmod +x /tmp/reinstall.sh',
    // Announce the exact launch line (password masked).
    `echo "[rdp] launching: bash reinstall.sh ${safeSub} --image-name '${safeImage}' --iso '<url>' --lang ${lang} --username ${safeUser} --rdp-port ${rdp} --password ***"`,
    // Actual invocation. --iso is now MANDATORY — bypasses upstream's
    // massgrave.dev scrape AND the interactive Direct Link prompt.
    // `timeout` is part of coreutils on the Ubuntu bootstrap image. Keep a
    // fallback for custom images that omit it, while using the watchdog on
    // every normal deployment.
    `if command -v timeout >/dev/null 2>&1; then printf '\\n\\n\\n\\n\\n' | timeout --foreground ${dispatchTimeoutSec}s bash /tmp/reinstall.sh ${safeSub} --image-name "${safeImage}" --iso "${safeIso}" --lang ${lang} --username ${safeUser} --rdp-port ${rdp} --password "${safePwd}" 2>&1; else printf '\\n\\n\\n\\n\\n' | bash /tmp/reinstall.sh ${safeSub} --image-name "${safeImage}" --iso "${safeIso}" --lang ${lang} --username ${safeUser} --rdp-port ${rdp} --password "${safePwd}" 2>&1; fi`,
    'RC=$?',
    'echo "[rdp] script exit=$RC"',
    `if [ $RC -eq 124 ]; then echo "[rdp] REINSTALL DISPATCH TIMEOUT after ${dispatchTimeoutSec}s — aborting"; exit 124; fi`,
    // Fail-fast if the script errored. NO blind reboot fallback.
    'if [ $RC -ne 0 ]; then echo "[rdp] REINSTALL SCRIPT FAILED — aborting (no reboot)"; exit $RC; fi',
    'echo "[rdp] reinstall staged OK — box will reboot into Windows installer within ~30s"',
  ].join(' ; ');
}

module.exports = {
  REINSTALL_SCRIPT_URL,
  UPSTREAM_REINSTALL_SCRIPT_URL,
  CONFHOME_MIRROR_PATH,
  CONFHOME_MIRROR_PUBLIC_URL,
  WINDOWS_IMAGE_MAP,
  DEFAULT_WINDOWS,
  resolveWindowsImage,
  buildReinstallCommand,
  isAutoInstallSupported,
  autoInstallUnsupportedReason,
  validateWindowsPassword,

  // --- Timings (all overridable via env, minutes → ms internally) ---
  // ROUND-18 20-MINUTE TARGET (user report: 55-minute cap is too long):
  //   • REINSTALL_MAX is a TOTAL deadline measured from script dispatch,
  //     not a fresh timer started only after the script returns.
  //   • Ubuntu dispatch has its own 4-minute watchdog. The ISO download is
  //     performed by Alpine, so Ubuntu staging should never run for an hour.
  //   • Default dispatch-to-RDP cap is 20 minutes. Slow sources are rejected
  //     by the ISO throughput preflight instead of occupying a worker for an hour.
  //   • Alpine stage sanity gate — jika Alpine SSH terlihat > 12 min tanpa transisi ke
  //     Windows, orchestrator akan trigger power_cycle (lihat rdpOrchestrator).
  SSH_READY_TIMEOUT_MS:      Number(process.env.RDP_SSH_READY_TIMEOUT_MS      || 10 * 60 * 1000),  // 10 min
  SSH_CONNECT_TIMEOUT_MS:    Number(process.env.RDP_SSH_CONNECT_TIMEOUT_MS    || 30 * 1000),
  REINSTALL_DISPATCH_TIMEOUT_MS,
  REINSTALL_MAX_TIMEOUT_MS,  // total: dispatch → RDP port
  REBOOT_HARD_LIMIT_MS,
  REBOOT_ESCALATION_GRACE_MS,
  ALPINE_STUCK_TIMEOUT_MS,
  STALL_TIMEOUT_MS:          Number(process.env.RDP_STALL_TIMEOUT_MS          || 20 * 60 * 1000),  // no-progress kill
  PORT_POLL_INTERVAL_MS,
  PROGRESS_TICK_MS:          Number(process.env.RDP_PROGRESS_TICK_MS          || 6 * 1000),
  RDP_PORT:                  Number(process.env.RDP_PORT                      || 3389),
  // ROUND-11 FIX (Windows RDP readiness detection):
  //   Historical default (6 attempts × 10s = 60s) was too short — Windows
  //   Setup restart TermService setelah OOBE + policies apply → port 3389
  //   sempat open lalu close lagi. 6 attempts sering "berhasil" pada open
  //   pertama padahal RDP belum siap. Round-18 memakai 24 attempts × 5s
  //   = 2 menit, DAN wajib STABLE 3/3 berturut-turut.
  RDP_VALIDATE_ATTEMPTS:     Number(process.env.RDP_VALIDATE_ATTEMPTS         || 24),
  RDP_VALIDATE_INTERVAL_MS:  Number(process.env.RDP_VALIDATE_INTERVAL_MS      || 5 * 1000),
  // Berapa poll berturut-turut yang harus SEMUA lulus (port3389 open +
  // RDP_NEG_RSP valid + TLS handshake OK) sebelum kita anggap Windows READY.
  // Port 22 hanya telemetry karena Windows dapat menjalankan OpenSSH.
  // Setiap kegagalan me-reset counter ke 0 — mencegah "false ready" saat
  // TermService baru re-listen atau baru boot ke OOBE.
  RDP_READY_STABLE_REQUIRED: Number(process.env.RDP_READY_STABLE_REQUIRED     || 3),
  // After the first stable result, keep the VM alive through the common
  // post-OOBE/policy restart window, then run a second independent validation.
  // This prevents a listener that is only briefly available from releasing
  // credentials. Set to 0 only for controlled tests.
  RDP_POST_READY_SOAK_MS:    Number(process.env.RDP_POST_READY_SOAK_MS        || 45 * 1000),
  RDP_FINAL_VALIDATE_ATTEMPTS: Number(process.env.RDP_FINAL_VALIDATE_ATTEMPTS || 12),
  RDP_FINAL_STABLE_REQUIRED: Number(process.env.RDP_FINAL_STABLE_REQUIRED     || 3),
  // For a retail RDP product, a source-restricted DO Cloud Firewall can let
  // the bot's probe pass while blocking the customer. Fail before installing
  // Windows unless an attached firewall publicly permits the configured port.
  RDP_REQUIRE_PUBLIC_3389: String(process.env.RDP_REQUIRE_PUBLIC_3389 || 'true').toLowerCase() !== 'false',
  MAX_PROVIDER_ATTEMPTS:     Number(process.env.RDP_MAX_PROVIDER_ATTEMPTS     || 2),
};
