// Post-install Windows RDP readiness detector.
//
// A TCP connect or a bare X.224 Connection Confirm is NOT sufficient proof
// that an RDP client can connect. X.224 CC can legally carry RDP_NEG_FAILURE,
// and modern Windows then requires a TLS/CredSSP security negotiation. This
// module therefore validates the full TPKT/X.224 negotiation response and,
// for enhanced security protocols, completes the TLS handshake before a poll
// can count toward READY.
const net = require('net');
const tls = require('tls');
const cfg = require('./rdpConfig');
const { createNullLogger } = require('./rdpDebugLogger');

const PROTOCOL_RDP       = 0x00000000;
const PROTOCOL_SSL       = 0x00000001;
const PROTOCOL_HYBRID    = 0x00000002;
const PROTOCOL_HYBRID_EX = 0x00000008;
const REQUESTED_PROTOCOLS = PROTOCOL_SSL | PROTOCOL_HYBRID | PROTOCOL_HYBRID_EX;

const PROTOCOL_NAMES = {
  [PROTOCOL_RDP]: 'RDP',
  [PROTOCOL_SSL]: 'TLS',
  [PROTOCOL_HYBRID]: 'CredSSP',
  [PROTOCOL_HYBRID_EX]: 'CredSSP-EAR',
};

const NEG_FAILURE_NAMES = {
  0x00000001: 'SSL_REQUIRED_BY_SERVER',
  0x00000002: 'SSL_NOT_ALLOWED_BY_SERVER',
  0x00000003: 'SSL_CERT_NOT_ON_SERVER',
  0x00000004: 'INCONSISTENT_FLAGS',
  0x00000005: 'HYBRID_REQUIRED_BY_SERVER',
  0x00000006: 'SSL_WITH_USER_AUTH_REQUIRED_BY_SERVER',
  0x00000007: 'ENTRA_AUTH_REQUIRED_BY_SERVER',
};

// X.224 Connection Request + RDP Negotiation Request. The old implementation
// requested PROTOCOL_RDP=0, which does not model mstsc/modern clients. Request
// TLS, CredSSP and CredSSP-EAR so the server must select a usable modern mode.
const RDP_NEGOTIATION_REQUEST = Buffer.from([
  0x03, 0x00, 0x00, 0x13,
  0x0e, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x08, 0x00,
  REQUESTED_PROTOCOLS & 0xff,
  (REQUESTED_PROTOCOLS >>> 8) & 0xff,
  (REQUESTED_PROTOCOLS >>> 16) & 0xff,
  (REQUESTED_PROTOCOLS >>> 24) & 0xff,
]);

function tcpProbe(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { s.destroy(); } catch (_) {}
      resolve(ok);
    };
    s.setTimeout(timeoutMs);
    s.once('connect', () => finish(true));
    s.once('timeout', () => finish(false));
    s.once('error', () => finish(false));
    try { s.connect(port, host); } catch (_) { finish(false); }
  });
}

/**
 * Strictly parse a complete TPKT + X.224 Connection Confirm packet.
 * A Connection Confirm may contain either RDP_NEG_RSP (success) or
 * RDP_NEG_FAILURE. The historical bug accepted both because it only checked
 * byte 5 (0xD0).
 */
function parseRdpNegotiationResponse(input) {
  if (!Buffer.isBuffer(input) || input.length < 4) {
    return { ok: false, reason: 'tpkt-header-truncated' };
  }
  if (input[0] !== 0x03 || input[1] !== 0x00) {
    return { ok: false, reason: 'invalid-tpkt-header' };
  }

  const packetLength = input.readUInt16BE(2);
  if (packetLength < 11 || packetLength > 8192) {
    return { ok: false, reason: 'invalid-tpkt-length', packetLength };
  }
  if (input.length < packetLength) {
    return { ok: false, reason: 'tpkt-body-truncated', packetLength, received: input.length };
  }

  const packet = input.subarray(0, packetLength);
  if (packet[5] !== 0xd0) {
    return { ok: false, reason: 'not-x224-connection-confirm', x224Code: packet[5] };
  }

  // No negotiation data means legacy Standard RDP Security. The bot promises
  // compatibility with modern mstsc/Microsoft Remote Desktop, so fail closed
  // instead of certifying an unencrypted/legacy-only listener as READY.
  if (packetLength === 11) {
    return { ok: false, reason: 'legacy-rdp-security-only', selectedProtocol: PROTOCOL_RDP };
  }
  if (packetLength < 19) {
    return { ok: false, reason: 'rdp-negotiation-truncated', packetLength };
  }

  const type = packet[11];
  const structureLength = packet.readUInt16LE(13);
  if (structureLength !== 8 || 11 + structureLength > packetLength) {
    return { ok: false, reason: 'invalid-rdp-negotiation-length', structureLength, packetLength };
  }

  if (type === 0x03) {
    const failureCode = packet.readUInt32LE(15);
    const failureName = NEG_FAILURE_NAMES[failureCode] || `UNKNOWN_FAILURE_${failureCode}`;
    return {
      ok: false,
      reason: `rdp-negotiation-failure:${failureName}`,
      failureCode,
      failureName,
    };
  }
  if (type !== 0x02) {
    return { ok: false, reason: 'unexpected-rdp-negotiation-type', type };
  }

  const selectedProtocol = packet.readUInt32LE(15);
  if (![PROTOCOL_SSL, PROTOCOL_HYBRID, PROTOCOL_HYBRID_EX].includes(selectedProtocol)) {
    return {
      ok: false,
      reason: 'server-selected-unsupported-security-protocol',
      selectedProtocol,
    };
  }

  return {
    ok: true,
    phase: 'negotiation',
    selectedProtocol,
    selectedProtocolName: PROTOCOL_NAMES[selectedProtocol] || `0x${selectedProtocol.toString(16)}`,
    packetLength,
  };
}

/**
 * Perform RDP negotiation and then complete the selected TLS transport.
 * This intentionally does not claim to authenticate Administrator—CredSSP
 * credential verification requires a complete RDP client. It does prove that
 * the endpoint accepts a modern security mode and that its TLS stack works.
 */
function rdpHandshakeDetailed(host, port = 3389, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let activeSocket = socket;
    let done = false;
    let received = Buffer.alloc(0);

    const finish = (result) => {
      if (done) return;
      done = true;
      try { activeSocket.destroy(); } catch (_) {}
      if (activeSocket !== socket) {
        try { socket.destroy(); } catch (_) {}
      }
      resolve(result);
    };

    const fail = (reason, extra = {}) => finish({ ok: false, reason, ...extra });

    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => fail('rdp-negotiation-timeout'));
    socket.once('error', (err) => fail('rdp-negotiation-socket-error', { error: String(err && err.message || err) }));
    socket.once('end', () => fail('rdp-negotiation-ended-before-complete', { received: received.length }));
    socket.once('close', (hadError) => {
      if (!hadError) fail('rdp-negotiation-closed-before-complete', { received: received.length });
    });
    socket.once('connect', () => {
      try { socket.write(RDP_NEGOTIATION_REQUEST); }
      catch (err) { fail('rdp-negotiation-write-error', { error: String(err && err.message || err) }); }
    });

    socket.on('data', (chunk) => {
      if (done) return;
      received = Buffer.concat([received, chunk]);
      if (received.length > 8192) return fail('rdp-negotiation-response-too-large');
      if (received.length < 4) return;

      const expected = received.readUInt16BE(2);
      if (expected < 11 || expected > 8192) {
        return fail('invalid-tpkt-length', { packetLength: expected });
      }
      if (received.length < expected) return;

      const parsed = parseRdpNegotiationResponse(received.subarray(0, expected));
      if (!parsed.ok) return finish(parsed);

      // RDP enhanced security starts TLS on the SAME TCP connection directly
      // after the Connection Confirm. Completing secureConnect catches broken
      // certificates/providers and protocol mismatches that X.224 alone misses.
      socket.removeAllListeners('data');
      socket.removeAllListeners('timeout');
      socket.removeAllListeners('error');
      socket.removeAllListeners('end');
      socket.removeAllListeners('close');
      socket.setTimeout(0);

      const tlsOptions = {
        socket,
        rejectUnauthorized: false, // Windows RDP commonly uses a self-signed cert.
        minVersion: process.env.RDP_TLS_MIN_VERSION || 'TLSv1.2',
      };
      if (!net.isIP(host)) tlsOptions.servername = host;

      try {
        const secure = tls.connect(tlsOptions);
        activeSocket = secure;
        secure.setTimeout(timeoutMs);
        secure.once('secureConnect', () => finish({
          ...parsed,
          ok: true,
          phase: 'tls',
          tlsReady: true,
          tlsProtocol: secure.getProtocol ? secure.getProtocol() : '',
        }));
        secure.once('timeout', () => fail('rdp-tls-timeout', parsed));
        secure.once('error', (err) => fail('rdp-tls-handshake-failed', {
          ...parsed,
          error: String(err && err.message || err),
        }));
        secure.once('end', () => fail('rdp-tls-ended-before-secure-connect', parsed));
        secure.once('close', () => fail('rdp-tls-closed-before-secure-connect', parsed));
      } catch (err) {
        fail('rdp-tls-init-failed', { ...parsed, error: String(err && err.message || err) });
      }
    });

    try { socket.connect(port, host); }
    catch (err) { fail('rdp-negotiation-connect-error', { error: String(err && err.message || err) }); }
  });
}

async function rdpHandshake(host, port = 3389, timeoutMs = 10000) {
  const result = await rdpHandshakeDetailed(host, port, timeoutMs);
  return result.ok === true;
}

async function validateWindowsReady(host, {
  onCheck = () => {},
  attempts = cfg.RDP_VALIDATE_ATTEMPTS,
  intervalMs = cfg.RDP_VALIDATE_INTERVAL_MS,
  stableRequired = cfg.RDP_READY_STABLE_REQUIRED,
  rdpPort = cfg.RDP_PORT,
  debug = createNullLogger('validate'),
  // Dependency injection keeps unit tests deterministic and lets future
  // deployments swap in a full credential-capable probe without API changes.
  tcpProbeFn = tcpProbe,
  rdpHandshakeFn = rdpHandshakeDetailed,
} = {}) {
  attempts = Math.max(1, Math.floor(Number(attempts) || 1));
  intervalMs = Math.max(0, Number(intervalMs) || 0);
  stableRequired = Math.max(1, Math.floor(Number(stableRequired) || 1));

  const state = {
    linuxDown: false,
    portOpen: false,
    rdpService: false,
    tlsReady: false,
    booted: false,
    stableCount: 0,
    stableRequired,
    selectedProtocol: null,
    selectedProtocolName: '',
    negotiationFailure: '',
    lastFailReason: '',
  };

  debug.info('RDP_VALIDATE', 'Readiness detection started', {
    host, rdpPort, attempts, intervalMs, stableRequired,
  });
  debug.info('RDP_READY', 'Waiting Windows Boot', { host, rdpPort, attempts, stableRequired });

  for (let i = 1; i <= attempts; i++) {
    const [p3389, p22] = await Promise.all([
      tcpProbeFn(host, rdpPort, 4000),
      tcpProbeFn(host, 22, 3000),
    ]);

    state.booted = state.booted || p3389;
    state.linuxDown = !p22; // diagnostic context; Windows may intentionally run OpenSSH.
    state.portOpen = p3389;
    state.rdpService = false;
    state.tlsReady = false;
    state.selectedProtocol = null;
    state.selectedProtocolName = '';
    state.negotiationFailure = '';

    debug.debug('PING', `probe attempt=${i}`, { host, port22: p22, port3389: p3389 });
    debug.debug('PORT_22', `open=${p22}`, { host, attempt: i });
    debug.debug('PORT_3389', `open=${p3389}`, { host, attempt: i });
    debug.info('RDP_READY', p3389 ? '3389 Open' : '3389 Closed', { host, attempt: i });

    let handshake = { ok: false, reason: 'port3389-closed' };
    if (p3389) {
      const raw = await rdpHandshakeFn(host, rdpPort, 10000);
      // A legacy boolean probe cannot prove which security protocol was
      // selected or that TLS completed. Refuse to turn it into READY proof.
      handshake = typeof raw === 'boolean'
        ? { ok: false, tlsReady: false, reason: 'probe-returned-no-security-details' }
        : (raw || { ok: false, reason: 'empty-handshake-result' });
      state.rdpService = handshake.ok === true;
      state.tlsReady = handshake.tlsReady === true;
      state.selectedProtocol = handshake.selectedProtocol == null ? null : handshake.selectedProtocol;
      state.selectedProtocolName = handshake.selectedProtocolName || '';
      state.negotiationFailure = handshake.failureName || '';
      debug.info('RDP_VALIDATE', `handshake attempt=${i} ok=${state.rdpService}`, {
        host,
        phase: handshake.phase || '',
        selectedProtocol: state.selectedProtocolName,
        tlsReady: state.tlsReady,
        reason: handshake.reason || '',
        failure: state.negotiationFailure,
      });
    }

    const allOk = state.portOpen && state.rdpService && state.tlsReady;
    if (allOk) {
      state.stableCount++;
      state.lastFailReason = '';
      debug.info('RDP_READY', `3389 Stable (${state.stableCount}/${stableRequired})`, {
        host, attempt: i, security: state.selectedProtocolName,
      });
    } else {
      if (state.stableCount > 0) {
        debug.warn('RDP_VALIDATE', `Stability RESET (was ${state.stableCount}/${stableRequired})`, {
          attempt: i, host, port22: p22, port3389: p3389, handshake,
        });
      }
      state.stableCount = 0;
      state.lastFailReason = !state.portOpen
        ? 'port3389-closed (Windows boot / TermService belum siap)'
        : `rdp-security-not-ready (${handshake.reason || 'TLS/CredSSP negotiation failed'})`;
      debug.info('RDP_READY', 'Retry', { host, attempt: i, reason: state.lastFailReason });
    }

    try { await onCheck({ attempt: i, attempts, ...state }); } catch (_) {}

    if (state.stableCount >= stableRequired) {
      debug.info('RDP_READY', 'Windows READY', {
        host,
        attempt: i,
        stableCount: state.stableCount,
        stableRequired,
        security: state.selectedProtocolName,
        tlsReady: state.tlsReady,
      });
      return { ok: true, state };
    }
    if (i < attempts) await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  debug.error('RDP_VALIDATE',
    `TIMEOUT — Windows tidak mencapai stable ${stableRequired}/${stableRequired} dalam ${attempts} attempts`,
    { host, state, attempts });
  return { ok: false, reason: 'timeout', state };
}

module.exports = {
  PROTOCOL_RDP,
  PROTOCOL_SSL,
  PROTOCOL_HYBRID,
  PROTOCOL_HYBRID_EX,
  REQUESTED_PROTOCOLS,
  RDP_NEGOTIATION_REQUEST,
  NEG_FAILURE_NAMES,
  tcpProbe,
  parseRdpNegotiationResponse,
  rdpHandshakeDetailed,
  rdpHandshake,
  validateWindowsReady,
};
