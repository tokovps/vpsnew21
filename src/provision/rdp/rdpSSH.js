// SSH helpers for the RDP provisioning flow.
//
// waitForSSH(host, cred, opts)  → polls TCP:22 then attempts login,
//                                  returns when auth succeeds (or timeout).
// runReinstall(host, cred, cmd) → opens a session, streams command output
//                                  to `onLog`, and treats *early disconnect*
//                                  as SUCCESS (the reinstall script reboots
//                                  the box which naturally kills SSH).
//
// All errors are wrapped with a stable `.code` field so the orchestrator can
// distinguish "auth failed" (fatal) from "connection refused" (retry).
//
// An optional `debug` logger (from rdpDebugLogger) may be passed in opts;
// when present it records every attempt, port state, exit code, and the
// disconnect classification. If omitted, a no-op logger is used so the
// helper remains usable outside the orchestrator.
const net = require('net');
const { NodeSSH } = require('node-ssh');
const cfg = require('./rdpConfig');
const { createNullLogger } = require('./rdpDebugLogger');

function tcpPing(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => { if (done) return; done = true; try { sock.destroy(); } catch (_) {} resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error',   () => finish(false));
    try { sock.connect(port, host); } catch (_) { finish(false); }
  });
}

async function waitForSSH(host, { username = 'root', password }, {
  timeoutMs = cfg.SSH_READY_TIMEOUT_MS,
  onProgress = () => {},
  logger = console,
  debug = createNullLogger('ssh'),
  // Grace window during which "authentication failed" is retried instead of
  // being classified as fatal. Cloud-init on DO often opens :22 BEFORE the
  // root password has been applied (chpasswd runs asynchronously), so the
  // first few SSH login attempts against a freshly-created droplet can
  // legitimately return "Authentication failed by all available methods".
  // Only treat auth-fail as fatal AFTER this window elapses.
  authGraceMs = Number(process.env.RDP_SSH_AUTH_GRACE_MS || 3 * 60 * 1000),
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  let attempt = 0;
  let firstAuthFailAt = 0;
  debug.info('SSH_LOGIN', `Waiting for SSH on ${host}:22`, {
    username, timeoutMs, authGraceMs,
  });
  while (Date.now() < deadline) {
    attempt++;
    const port22 = await tcpPing(host, 22, 4000);
    debug.debug('PORT_22', `attempt=${attempt} open=${port22}`, { host, port: 22 });
    await onProgress({ attempt, port22, phase: port22 ? 'auth' : 'tcp' });
    if (port22) {
      const ssh = new NodeSSH();
      try {
        await ssh.connect({
          host, username, password,
          port: 22,
          readyTimeout: cfg.SSH_CONNECT_TIMEOUT_MS,
          tryKeyboard: true,
        });
        const r = await ssh.execCommand('echo ok', { execOptions: { pty: false } });
        ssh.dispose();
        debug.info('SSH_LOGIN', 'SSH login OK', {
          host, attempt, echoCode: r && r.code, echoStdout: (r && r.stdout || '').trim(),
        });
        logger.info && logger.info(`[rdp-ssh] ready on ${host} after ${attempt} attempts`);
        return true;
      } catch (err) {
        const msg = String(err && err.message || err);
        const isAuth = /authentication|denied|permission/i.test(msg);
        if (isAuth) {
          // First auth failure — start the grace clock.
          if (!firstAuthFailAt) firstAuthFailAt = Date.now();
          const withinGrace = Date.now() - firstAuthFailAt < authGraceMs;
          const withinBootWindow = Date.now() - startedAt < authGraceMs;
          if (withinGrace || withinBootWindow) {
            // cloud-init may still be applying chpasswd. Retry silently.
            debug.debug('SSH_LOGIN', `auth failed (grace) — retrying: ${msg}`, {
              attempt,
              elapsedSinceFirstAuthFail: Date.now() - firstAuthFailAt,
              elapsedSinceStart: Date.now() - startedAt,
              graceMs: authGraceMs,
            });
            try { ssh.dispose(); } catch (_) {}
            await new Promise(r => setTimeout(r, 8000));
            continue;
          }
          debug.error('SSH_LOGIN', 'SSH auth failed after grace window — terminal', {
            host, error: msg, graceMs: authGraceMs,
            elapsedSinceFirstAuthFail: Date.now() - firstAuthFailAt,
          });
          const e = new Error('SSH auth failed (after grace): ' + msg);
          e.code = 'SSH_AUTH';
          throw e;
        }
        debug.debug('SSH_LOGIN', `retry (transient error): ${msg}`, { attempt });
        try { ssh.dispose(); } catch (_) {}
      }
    }
    await new Promise(r => setTimeout(r, 8000));
  }
  debug.error('SSH_LOGIN', 'SSH not ready — timeout', { host, timeoutMs, attempts: attempt });
  const e = new Error(`SSH not ready within ${Math.round(timeoutMs / 60000)}m`);
  e.code = 'SSH_TIMEOUT';
  throw e;
}

/**
 * Execute the Windows reinstall command over SSH.
 * The remote command detaches + reboots, so:
 *   - "connection closed" mid-execution == success signal
 *   - non-zero exit codes are OK if we already saw the "reboot" message
 * @returns {Promise<{ok: true, log: string, exitCode: number|null, disconnected: boolean}>}
 */
async function runReinstall(host, { username = 'root', password }, command, {
  onLog = () => {},
  logger = console,
  debug = createNullLogger('ssh'),
} = {}) {
  const ssh = new NodeSSH();
  debug.info('REINSTALL_CMD', 'Opening SSH session for reinstall', { host, username });
  await ssh.connect({
    host, username, password, port: 22,
    readyTimeout: cfg.SSH_CONNECT_TIMEOUT_MS,
  });
  let log = '';
  const append = (chunk) => {
    log += chunk;
    if (log.length > 20000) log = log.slice(-15000);
    try { onLog(chunk); } catch (_) {}
  };
  debug.info('REINSTALL_CMD', 'Dispatching reinstall command over SSH', {
    host,
    cmdPreview: String(command).slice(0, 400),
    cmdLen: String(command).length,
  });
  let stdoutBuf = '';
  let stderrBuf = '';
  try {
    const r = await ssh.execCommand(command, {
      execOptions: { pty: false },
      onStdout: (buf) => { const s = buf.toString(); stdoutBuf += s; append(s); },
      onStderr: (buf) => { const s = buf.toString(); stderrBuf += s; append(s); },
    });
    ssh.dispose();
    const exitCode = (r && typeof r.code === 'number') ? r.code : null;
    debug.info('REINSTALL_EXIT', `Reinstall command returned normally`, {
      host,
      exitCode,
      stdoutTail: stdoutBuf.slice(-600),
      stderrTail: stderrBuf.slice(-600),
      combinedLogTail: log.slice(-400),
    });
    return { ok: true, log, stdout: stdoutBuf, stderr: stderrBuf, exitCode, disconnected: false };
  } catch (err) {
    ssh.dispose();
    const msg = String(err && err.message || err);
    if (/closed|reset|disconnect|ECONNRESET|Connection lost/i.test(msg)) {
      debug.info('SSH_DISCONNECT', 'SSH disconnect during reinstall (expected — box rebooting)', {
        host, sshError: msg,
        stdoutTail: stdoutBuf.slice(-600),
        stderrTail: stderrBuf.slice(-600),
      });
      logger.info && logger.info('[rdp-ssh] disconnect during reinstall — expected');
      return { ok: true, log, stdout: stdoutBuf, stderr: stderrBuf, exitCode: null, disconnected: true };
    }
    debug.error('REINSTALL_EXIT', 'SSH exec failed (non-disconnect error)', {
      host, error: msg,
      stdoutTail: stdoutBuf.slice(-600),
      stderrTail: stderrBuf.slice(-600),
    });
    const e = new Error('SSH exec failed: ' + msg);
    e.code = 'SSH_EXEC';
    e.log = log;
    e.stdout = stdoutBuf;
    e.stderr = stderrBuf;
    throw e;
  }
}

module.exports = { tcpPing, waitForSSH, runReinstall, probeRebootState };

/**
 * Probe the box's current state via SSH — fast (single command, ~2s).
 * Returns { reachable, uptimeSec, osFamily, kernel, hostname, sshError }.
 *
 *   reachable=false → SSH port closed or auth failed (box down / different keys)
 *   uptimeSec       → seconds since last boot (from /proc/uptime)
 *   osFamily        → 'ubuntu' | 'debian' | 'alpine' | 'centos' | 'unknown'
 *
 * Used by the orchestrator to distinguish "box hasn't rebooted yet" from
 * "box rebooted into Alpine staging OS" (which ALSO has SSH open on :22).
 * The historical bug was assuming port22=open ⇒ Ubuntu is still running.
 * With uptime + osFamily we can tell:
 *   uptime < 5 min  AND osFamily != ubuntu  → reboot happened, in staging
 *   uptime > 5 min  AND osFamily == ubuntu → reboot did NOT happen
 *
 * We deliberately swallow all errors and return a well-formed result so the
 * orchestrator's polling loop is not derailed by transient SSH failures.
 */
async function probeRebootState(host, { username = 'root', password }, {
  timeoutMs = 8000,
  debug = createNullLogger('ssh'),
} = {}) {
  const result = {
    reachable: false, uptimeSec: null, osFamily: 'unknown',
    kernel: '', hostname: '', sshError: '',
  };
  if (!(await tcpPing(host, 22, 3000))) {
    result.sshError = 'port 22 closed';
    return result;
  }
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host, port: 22, username, password,
      readyTimeout: timeoutMs, algorithms: { serverHostKey: undefined },
      // Disable host-key checking so a fresh Alpine staging (new host key)
      // doesn't cause the connect to fail — we WANT to know it changed.
    });
    // Single line: uptime seconds | hostname | os | kernel
    const r = await ssh.execCommand(
      `awk '{print int($1)}' /proc/uptime; hostname; ` +
      `grep -oE '^ID=[a-z]+' /etc/os-release 2>/dev/null | cut -d= -f2 || echo unknown; ` +
      `uname -r`,
      { execOptions: { pty: false } },
    );
    ssh.dispose();
    const lines = String(r.stdout || '').split(/\r?\n/).filter(Boolean);
    result.reachable = true;
    result.uptimeSec = Number(lines[0]) || 0;
    result.hostname  = lines[1] || '';
    result.osFamily  = (lines[2] || 'unknown').toLowerCase();
    result.kernel    = lines[3] || '';
    debug.debug('SSH_PROBE', `uptime=${result.uptimeSec}s os=${result.osFamily} kernel=${result.kernel}`, {
      host, hostname: result.hostname,
    });
  } catch (e) {
    try { ssh.dispose(); } catch (_) {}
    result.sshError = String(e && e.message || e).slice(0, 200);
    debug.debug('SSH_PROBE', `ssh failed: ${result.sshError}`, { host });
  }
  return result;
}
