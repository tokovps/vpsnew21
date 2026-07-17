// ================================================================
// RDP DEBUG LOGGER
// ----------------------------------------------------------------
// Structured, per-order debug logger for the Auto Create RDP flow.
//
// Every step of the pipeline emits an event with:
//   - timestamp (ISO)
//   - stage     (PROVIDER_PICK, VPS_CREATE, SSH_LOGIN, REINSTALL_CMD,
//                REINSTALL_EXIT, SSH_DISCONNECT, REBOOT_DETECTED,
//                INSTANCE_STATUS, PING, PORT_22, PORT_3389,
//                RDP_VALIDATE, TIMEOUT, SUMMARY, ERROR, INFO)
//   - level     (info | warn | error | debug)
//   - message
//   - meta      (arbitrary JSON payload — provider, ip, exitCode, etc.)
//
// Output:
//   1. Appended to /app/logs/rdp/<invoice>-<orderId>.log  (one file per order)
//   2. Mirrored to console with a `[RDP-DEBUG][<invoice>]` prefix so the
//      operator can `tail -f` supervisor logs and see exactly where the
//      pipeline stopped.
//   3. On finalize() the logger prints a compact SUMMARY block listing
//      every stage that was reached (or missed) — this is the piece the
//      operator uses to answer "di tahap mana proses berhenti?".
//
// The logger is intentionally dependency-free (only fs/path) so it works
// in any environment the bot runs in.
// ================================================================
const fs = require('fs');
const path = require('path');

const LOG_ROOT = process.env.RDP_DEBUG_LOG_DIR
  || path.join(process.cwd(), 'logs', 'rdp');

// Stages we expect to observe, in order. Used to produce the SUMMARY table.
const EXPECTED_STAGES = [
  'PROVIDER_PICK',
  'VPS_CREATE',
  'VPS_READY',
  'SSH_LOGIN',
  'REINSTALL_CMD',
  'REINSTALL_EXIT',
  'SSH_DISCONNECT',
  'REBOOT_DETECTED',
  'INSTANCE_STATUS',
  'PING',
  'PORT_22',
  'PORT_3389',
  'RDP_VALIDATE',
];

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

function safeStringify(obj) {
  try {
    return JSON.stringify(obj, (_k, v) => {
      if (v instanceof Error) return { name: v.name, message: v.message, code: v.code };
      if (typeof v === 'string' && v.length > 500) return v.slice(0, 500) + '...(truncated)';
      return v;
    });
  } catch (_) {
    return '"<unserialisable>"';
  }
}

function createRdpDebugLogger(order) {
  ensureDir(LOG_ROOT);
  const invoice = order.invoice || 'noinv';
  const oid = String(order._id || 'noid');
  const file = path.join(LOG_ROOT, `${invoice}-${oid}.log`);
  const tag = `[RDP-DEBUG][${invoice}]`;

  // Track first-seen timestamps per stage for the summary.
  const stagesSeen = new Map();
  const startedAt = Date.now();
  let terminated = false;

  // Preflight header — tells the operator this run has begun.
  const header = [
    '============================================================',
    `RDP Auto-Create Debug Log`,
    `Invoice : ${invoice}`,
    `OrderId : ${oid}`,
    `UserId  : ${order.userId || '-'}`,
    `Product : ${order.productName || '-'}`,
    `Started : ${new Date().toISOString()}`,
    '============================================================',
    '',
  ].join('\n');
  try { fs.appendFileSync(file, header); } catch (_) {}
  console.log(`${tag} log file → ${file}`);

  function write(entry) {
    const line = safeStringify(entry) + '\n';
    try { fs.appendFileSync(file, line); } catch (_) {}
  }

  function log(level, stage, message, meta = {}) {
    if (terminated) return;
    const t = new Date().toISOString();
    if (!stagesSeen.has(stage)) stagesSeen.set(stage, t);
    const entry = { t, level, stage, message, meta };
    write(entry);
    const consoleMsg = `${tag}[${stage}] ${message}${
      Object.keys(meta).length ? ' ' + safeStringify(meta) : ''
    }`;
    if (level === 'error')      console.error(consoleMsg);
    else if (level === 'warn')  console.warn(consoleMsg);
    else                        console.log(consoleMsg);
  }

  const api = {
    file,
    info:  (stage, msg, meta) => log('info',  stage, msg, meta),
    warn:  (stage, msg, meta) => log('warn',  stage, msg, meta),
    error: (stage, msg, meta) => log('error', stage, msg, meta),
    debug: (stage, msg, meta) => log('debug', stage, msg, meta),

    /**
     * Called once when the pipeline terminates (success OR failure).
     * Writes a table showing which expected stages fired and which did
     * not — the answer to "di mana proses berhenti?".
     */
    finalize(outcome, reason) {
      if (terminated) return;
      const durMs = Date.now() - startedAt;
      const lines = [];
      lines.push('');
      lines.push('------------------------------------------------------------');
      lines.push(`SUMMARY (${outcome})  duration=${(durMs / 1000).toFixed(1)}s`);
      if (reason) lines.push(`Reason : ${String(reason).slice(0, 500)}`);
      lines.push('Stages observed:');
      for (const s of EXPECTED_STAGES) {
        const at = stagesSeen.get(s);
        lines.push(`  ${at ? '[✓]' : '[ ]'} ${s.padEnd(18)} ${at || '-'}`);
      }
      const extra = [...stagesSeen.keys()].filter(k => !EXPECTED_STAGES.includes(k));
      if (extra.length) {
        lines.push('Other stages:');
        for (const s of extra) lines.push(`  [•] ${s.padEnd(18)} ${stagesSeen.get(s)}`);
      }
      lines.push('------------------------------------------------------------');
      const block = lines.join('\n') + '\n';
      try { fs.appendFileSync(file, block); } catch (_) {}
      console.log(`${tag} ${block}`);
      terminated = true;
    },
  };

  return api;
}

// Fallback logger for callers that don't have an order-scoped instance
// (e.g., helper modules invoked outside the orchestrator). It only logs
// to console; no file target.
function createNullLogger(prefix = 'RDP') {
  const p = `[RDP-DEBUG][${prefix}]`;
  const mk = (lvl) => (stage, msg, meta) => {
    const line = `${p}[${stage}] ${msg}${meta ? ' ' + safeStringify(meta) : ''}`;
    if (lvl === 'error') console.error(line);
    else if (lvl === 'warn') console.warn(line);
    else console.log(line);
  };
  return {
    file: null,
    info: mk('info'), warn: mk('warn'), error: mk('error'), debug: mk('debug'),
    finalize() {},
  };
}

module.exports = { createRdpDebugLogger, createNullLogger, EXPECTED_STAGES, LOG_ROOT };
