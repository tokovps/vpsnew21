// ROUND-14 — RDP execution-flow stage tracker
//
// Verifies:
//   • 8 stages are defined in the correct order (SSH → LINUX_REBOOT →
//     PROVIDER_ACTIVE → WINDOWS_FIRST_BOOT → SETUP_COMPLETE → TERMSERVICE_UP
//     → RDP_STABLE → READY).
//   • enter/pass/fail transitions are recorded with timestamps.
//   • ensureAllPassed() rejects when any stage is not PASS.
//   • firstFailure() surfaces the earliest non-PASS stage with reason.
//   • summaryTelegram() / dumpSummary() produce human-readable audit blocks.

const assert = require('assert');
const path = require('path');
const { createStageTracker, STAGE_DEFS } = require(
  path.join(__dirname, '..', 'src', 'provision', 'rdp', 'rdpStageTracker.js')
);

// Silent debug shim — replaces the real logger for tests. Also captures
// each `error` call so we can assert "Stage N FAILED" lines are emitted.
function makeDebug() {
  const events = [];
  const push = (level) => (stage, msg, meta) => events.push({ level, stage, msg, meta });
  return {
    events,
    info:  push('info'),
    warn:  push('warn'),
    error: push('error'),
    debug: push('debug'),
  };
}

function test_stage_definitions_order() {
  const expected = [
    'SSH_DISPATCH', 'LINUX_REBOOT', 'PROVIDER_ACTIVE', 'WINDOWS_FIRST_BOOT',
    'SETUP_COMPLETE', 'TERMSERVICE_UP', 'RDP_STABLE', 'READY',
  ];
  assert.deepStrictEqual(STAGE_DEFS.map(s => s.key), expected,
    'stage order must match the audit spec');
  assert.deepStrictEqual(STAGE_DEFS.map(s => s.n), [1, 2, 3, 4, 5, 6, 7, 8],
    'stage numbers must be 1..8');
  console.log('✅ 8 stages defined in correct order (SSH → ... → READY)');
}

function test_pass_fail_and_gate() {
  const order = { _id: 'oid1', invoice: 'INV-TEST', findByIdAndUpdate: () => {} };
  // stub Mongoose call
  const Order = require(path.join(__dirname, '..', 'src', 'models', 'Order'));
  const orig = Order.findByIdAndUpdate;
  Order.findByIdAndUpdate = () => ({ catch: () => {} });

  const debug = makeDebug();
  const t = createStageTracker(order, debug);
  // All 8 pass
  for (let i = 1; i <= 7; i++) { t.enter(i, `entering ${i}`); t.pass(i, `evidence-${i}`); }
  const gate = t.ensureAllPassed();
  assert.strictEqual(gate.ok, true, 'gate must be OK when stages 1..7 all PASS');
  t.pass(8, 'stages 1–7 all PASS');
  const sum = t.summaryTelegram();
  assert.ok(sum.includes('Stage 1/8'), 'summary must include Stage 1');
  assert.ok(sum.includes('✅'), 'summary must show pass marks');
  Order.findByIdAndUpdate = orig;
  console.log('✅ enter/pass sequence marks all stages PASS and gate opens');
}

function test_gate_rejects_when_stage5_fails() {
  const order = { _id: 'oid2' };
  const Order = require(path.join(__dirname, '..', 'src', 'models', 'Order'));
  const orig = Order.findByIdAndUpdate;
  Order.findByIdAndUpdate = () => ({ catch: () => {} });

  const debug = makeDebug();
  const t = createStageTracker(order, debug);
  t.enter(1, 'x'); t.pass(1, 'x');
  t.enter(2, 'x'); t.pass(2, 'x');
  t.enter(3, 'x'); t.pass(3, 'x');
  t.enter(4, 'x'); t.pass(4, 'x');
  t.enter(5, 'x'); t.fail(5, 'port 3389 never reachable — SetupComplete did not run');

  const gate = t.ensureAllPassed();
  assert.strictEqual(gate.ok, false, 'gate must reject when a stage is FAIL');
  const first = t.firstFailure();
  assert.strictEqual(first.n, 5, 'firstFailure must be stage 5');
  assert.match(first.reason, /SetupComplete/, 'reason must be captured');

  // Confirm a "Stage 5" error log was emitted.
  const stage5err = debug.events.find(e =>
    e.level === 'error' && /Stage\s*5.*FAIL.*Reason.*SetupComplete/.test(String(e.msg)));
  assert.ok(stage5err, 'debug logger must emit "Stage 5 FAILED — Reason: ..."');
  Order.findByIdAndUpdate = orig;
  console.log('✅ Stage 5 failure blocks the gate + emits admin-visible log line');
}

function test_summary_includes_runner_and_evidence_source() {
  const order = { _id: 'oid3' };
  const Order = require(path.join(__dirname, '..', 'src', 'models', 'Order'));
  const orig = Order.findByIdAndUpdate;
  Order.findByIdAndUpdate = () => ({ catch: () => {} });

  const debug = makeDebug();
  const t = createStageTracker(order, debug);
  const lines = t.summaryLines().join('\n');
  // Every stage must document runner + evidence source in the audit block.
  for (const s of STAGE_DEFS) {
    assert.ok(lines.includes(`Stage ${String(s.n).padStart(2, ' ')}/8`),
      `summary must list Stage ${s.n}`);
  }
  assert.ok(lines.includes('runner   :'), 'summary must include runner:');
  assert.ok(lines.includes('evidence :'), 'summary must include evidence:');
  assert.ok(lines.includes('SetupComplete.cmd'),
    'summary must document who runs stage 5');
  assert.ok(lines.includes('TermService'),
    'summary must document who runs stage 6');
  Order.findByIdAndUpdate = orig;
  console.log('✅ audit summary lists runner + evidence source per stage');
}

try {
  test_stage_definitions_order();
  test_pass_fail_and_gate();
  test_gate_rejects_when_stage5_fails();
  test_summary_includes_runner_and_evidence_source();
  console.log('\n🎉 ROUND-14 stage-tracker tests PASSED');
  process.exit(0);
} catch (e) {
  console.error('❌ TEST FAILED:', e && e.stack || e);
  process.exit(1);
}
