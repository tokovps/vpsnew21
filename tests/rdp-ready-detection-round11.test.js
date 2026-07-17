// RDP readiness regression tests.
//
// These tests use the validator's injected probes, so they exercise stable
// counting and TLS requirements without monkey-patching Node's net/tls
// internals or accepting a truncated fake server response.
const assert = require('assert');
const {
  validateWindowsReady,
  parseRdpNegotiationResponse,
  RDP_NEGOTIATION_REQUEST,
  REQUESTED_PROTOCOLS,
  PROTOCOL_HYBRID,
} = require('../src/provision/rdp/rdpValidator');

function makeProbes(script) {
  let pollIndex = 0;
  let activePoll = null;

  return {
    tcpProbeFn: async (_host, port) => {
      const poll = script[pollIndex];
      assert.ok(poll, `unexpected probe after scripted poll ${pollIndex}`);
      activePoll = poll;
      if (port === 3389) return Boolean(poll.port3389);
      if (port === 22) {
        pollIndex += 1;
        return Boolean(poll.port22);
      }
      throw new Error(`unexpected port ${port}`);
    },
    rdpHandshakeFn: async () => {
      assert.ok(activePoll, 'handshake called before TCP probe');
      if (activePoll.handshake && typeof activePoll.handshake === 'object') {
        return activePoll.handshake;
      }
      if (activePoll.handshake === 'boolean-true') return true;
      if (activePoll.handshake === true) {
        return {
          ok: true,
          tlsReady: true,
          phase: 'tls',
          selectedProtocol: PROTOCOL_HYBRID,
          selectedProtocolName: 'CredSSP',
          tlsProtocol: 'TLSv1.3',
        };
      }
      return { ok: false, tlsReady: false, reason: 'mock-rdp-security-failed' };
    },
  };
}

async function run(script, options = {}) {
  const probes = makeProbes(script);
  return validateWindowsReady('192.0.2.10', {
    attempts: script.length,
    intervalMs: 0,
    stableRequired: 3,
    ...probes,
    ...options,
  });
}

function negotiationPacket(type, value) {
  const packet = Buffer.from([
    0x03, 0x00, 0x00, 0x13,
    0x0e, 0xd0, 0x00, 0x00, 0x00, 0x00, 0x00,
    type, 0x00, 0x08, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]);
  packet.writeUInt32LE(value, 15);
  return packet;
}

async function testStrictNegotiationParser() {
  const success = parseRdpNegotiationResponse(negotiationPacket(0x02, PROTOCOL_HYBRID));
  assert.strictEqual(success.ok, true);
  assert.strictEqual(success.selectedProtocolName, 'CredSSP');

  const failure = parseRdpNegotiationResponse(negotiationPacket(0x03, 0x00000005));
  assert.strictEqual(failure.ok, false, 'RDP_NEG_FAILURE must never be accepted as CC success');
  assert.strictEqual(failure.failureName, 'HYBRID_REQUIRED_BY_SERVER');

  const truncated = parseRdpNegotiationResponse(Buffer.from([0x03, 0x00, 0x00, 0x13, 0x0e, 0xd0]));
  assert.strictEqual(truncated.ok, false, 'six-byte CC prefix is not a complete response');
  assert.strictEqual(truncated.reason, 'tpkt-body-truncated');

  assert.strictEqual(RDP_NEGOTIATION_REQUEST.readUInt32LE(15), REQUESTED_PROTOCOLS);
  assert.strictEqual(REQUESTED_PROTOCOLS, 0x0b, 'request TLS + CredSSP + CredSSP-EAR');
  console.log('✅ Strict parser rejects RDP_NEG_FAILURE/truncation and requests modern security');
}

async function testNeedsThreeStableTlsPolls() {
  const seen = [];
  const result = await run([
    { port22: true, port3389: true, handshake: true },
    { port22: true, port3389: true, handshake: true },
    { port22: true, port3389: true, handshake: true },
  ], { onCheck: state => seen.push(state.stableCount) });

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(seen, [1, 2, 3]);
  assert.strictEqual(result.state.linuxDown, false, 'port 22 is diagnostic only');
  assert.strictEqual(result.state.tlsReady, true);
  console.log('✅ READY requires three consecutive modern RDP + TLS polls');
}

async function testFailureResetsCounter() {
  const seen = [];
  const result = await run([
    { port22: false, port3389: true, handshake: true },
    { port22: false, port3389: true, handshake: true },
    { port22: false, port3389: false, handshake: false },
    { port22: false, port3389: true, handshake: true },
    { port22: false, port3389: true, handshake: true },
    { port22: false, port3389: true, handshake: true },
  ], { onCheck: state => seen.push(state.stableCount) });

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(seen, [1, 2, 0, 1, 2, 3]);
  console.log('✅ A failed poll resets the stability counter');
}

async function testPortOpenWithoutTlsNeverPasses() {
  const noTls = { ok: true, tlsReady: false, phase: 'negotiation', selectedProtocolName: 'CredSSP' };
  const result = await run([
    { port22: false, port3389: true, handshake: noTls },
    { port22: false, port3389: true, handshake: noTls },
    { port22: false, port3389: true, handshake: noTls },
  ]);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.state.stableCount, 0);
  assert.match(result.state.lastFailReason, /rdp-security-not-ready/);
  console.log('✅ TCP/X.224 without a completed TLS handshake cannot become READY');
}

async function testLegacyBooleanProbeFailsClosed() {
  const result = await run([
    { port22: false, port3389: true, handshake: 'boolean-true' },
    { port22: false, port3389: true, handshake: 'boolean-true' },
    { port22: false, port3389: true, handshake: 'boolean-true' },
  ]);

  assert.strictEqual(result.ok, false);
  assert.match(result.state.lastFailReason, /probe-returned-no-security-details/);
  console.log('✅ Legacy boolean probes fail closed because they contain no TLS proof');
}

async function testTimeoutAndLogs() {
  const messages = [];
  const debug = {
    info: (_tag, message) => messages.push(message),
    debug: () => {},
    warn: () => {},
    error: () => {},
  };
  const result = await run([
    { port22: true, port3389: false, handshake: false },
    { port22: true, port3389: true, handshake: true },
    { port22: true, port3389: true, handshake: true },
  ], { debug });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'timeout');
  for (const expected of ['Waiting Windows Boot', '3389 Closed', 'Retry', '3389 Open']) {
    assert.ok(messages.includes(expected), `missing readiness log: ${expected}`);
  }
  console.log('✅ Timeout remains non-success and emits readiness diagnostics');
}

(async () => {
  try {
    await testStrictNegotiationParser();
    await testNeedsThreeStableTlsPolls();
    await testFailureResetsCounter();
    await testPortOpenWithoutTlsNeverPasses();
    await testLegacyBooleanProbeFailsClosed();
    await testTimeoutAndLogs();
    console.log('\n🎉 RDP readiness regression tests PASSED');
  } catch (error) {
    console.error('❌ TEST FAILED:', error && error.stack || error);
    process.exitCode = 1;
  }
})();
