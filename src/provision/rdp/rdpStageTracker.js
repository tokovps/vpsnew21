// ═══════════════════════════════════════════════════════════════════════════
// RDP EXECUTION-FLOW STAGE TRACKER  (ROUND-14)
// ---------------------------------------------------------------------------
// Purpose
//   The user reported that Microsoft Remote Desktop cannot connect even after
//   the bot sends "RDP BERHASIL DIBUAT". Root cause is a *false-ready*
//   decision: the pipeline reached the "send credentials" step before every
//   post-reinstall stage had been *proven* to complete.
//
//   ROUND-14 attacks this at the execution-flow level (not registry level).
//   We track EIGHT explicit stages between reinstall.sh dispatch and READY,
//   record who runs each, and — most importantly — which externally
//   observable EVIDENCE proves each stage completed.
//
// The 8 stages (audit output the user asked for)
//   1. SSH_DISPATCH        Bot runs SSH `reinstall.sh …`.
//                          Evidence: SSH exitCode==0 OR disconnect signal (reboot imminent).
//   2. LINUX_REBOOT        bin456789/reinstall.sh reboots the box; Alpine
//                          staging boots and lays down the Windows DD image
//                          (calls modify_windows() inside the initramfs).
//                          Evidence: port 22 CLOSED, or SSH host-key changed,
//                          or provider API records a `reboot`/`power_cycle` action.
//   3. PROVIDER_ACTIVE     Cloud provider (DO/etc.) reports the droplet as
//                          `status=active` after the reboot.
//                          Evidence: adapter.getInstance().status === 'active'.
//   4. WINDOWS_FIRST_BOOT  Windows Setup / OOBE completes to the point where
//                          the network stack is up.
//                          Evidence: FIRST TCP response on 3389 from Windows
//                          (this is when TermService is first started by the
//                          Machine Startup Script — see stage 5).
//   5. SETUP_COMPLETE      %WINDIR%\Setup\Scripts\SetupComplete.cmd runs at
//                          the end of specialize/OOBE. It invokes the Machine
//                          Startup Script and windows-fix-rdp-compat.bat which
//                          together (a) open the firewall for 3389, (b) start
//                          TermService, (c) set fDenyTSConnections=0.
//                          Evidence (INDIRECT/inferred): port 3389 opens
//                          externally — the only way 3389 becomes reachable
//                          from outside is if all three above happened.
//   6. TERMSERVICE_UP      TermService (svchost.exe -k termsvcs) is not just
//                          listening — it is accepting RDP handshakes.
//                          Evidence: a valid RDP_NEG_RSP selects enhanced
//                          security and TLS secureConnect completes.
//   7. RDP_STABLE          The service is not flapping (e.g. Setup restarts
//                          TermService while applying policies).
//                          Evidence: N consecutive full checks all pass
//                          (3389 open + modern negotiation + TLS OK).
//   8. READY               Bot may now send login credentials.
//                          Evidence: stages 1–7 all PASS.
//
// Guarantee
//   The tracker STOPS the pipeline at the FIRST stage that has no positive
//   evidence within its timeout. It refuses to advance to stage 8 unless
//   every prior stage is marked PASS. On failure the debug log gets a
//   compact `Stage N FAILED — Reason: …` block that admin can grep for.
// ═══════════════════════════════════════════════════════════════════════════

const Order = require('../../models/Order');

const STAGE_DEFS = [
  {
    n: 1, key: 'SSH_DISPATCH', label: 'SSH & reinstall dispatch',
    runner: 'Bot (rdpSSH.runReinstall over SSH)',
    evidenceKind: 'DIRECT',
    evidenceHow: 'SSH exit code / disconnect signal captured by node-ssh',
  },
  {
    n: 2, key: 'LINUX_REBOOT', label: 'Linux/Alpine reboot (trans.sh & modify_windows staged)',
    runner: 'bin456789 reinstall.sh → Alpine initramfs (modify_windows)',
    evidenceKind: 'DIRECT',
    evidenceHow: 'Port 22 CLOSED, SSH host-key change, or provider-API reboot event',
  },
  {
    n: 3, key: 'PROVIDER_ACTIVE', label: 'VPS provider ACTIVE post-reinstall',
    runner: 'Cloud provider control plane (DigitalOcean/etc.)',
    evidenceKind: 'DIRECT',
    evidenceHow: 'adapter.getInstance() → status === "active"',
  },
  {
    n: 4, key: 'WINDOWS_FIRST_BOOT', label: 'Windows first boot reachable',
    runner: 'Windows Setup / OOBE / Machine Startup Script',
    evidenceKind: 'DIRECT',
    evidenceHow: 'First TCP response on 3389 from Windows (external probe)',
  },
  {
    n: 5, key: 'SETUP_COMPLETE',
    label: 'SetupComplete.cmd → Machine Startup Script → windows-fix-rdp-compat.bat',
    runner: 'Windows Setup: %WINDIR%\\Setup\\Scripts\\SetupComplete.cmd',
    evidenceKind: 'INFERRED',
    evidenceHow: 'Port 3389 externally reachable — the only way this port is exposed is if the startup scripts opened the firewall AND started TermService AND set fDenyTSConnections=0',
  },
  {
    n: 6, key: 'TERMSERVICE_UP', label: 'TermService accepting RDP sessions',
    runner: 'Windows TermService (svchost.exe -k termsvcs)',
    evidenceKind: 'DIRECT',
    evidenceHow: 'X.224 Connection Request → RDP_NEG_RSP selects enhanced security → TLS secureConnect',
  },
  {
    n: 7, key: 'RDP_STABLE', label: 'Port 3389 STABLE — not flapping',
    runner: 'Windows TermService steady-state',
    evidenceKind: 'DIRECT',
    evidenceHow: 'N consecutive polls: 3389 accepts TCP + valid X.224 RDP handshake (port 22 diagnostic only)',
  },
  {
    n: 8, key: 'READY', label: 'READY — bot sends login credentials',
    runner: 'Bot',
    evidenceKind: 'AGGREGATE',
    evidenceHow: 'Stages 1–7 all PASS',
  },
];

const TOTAL = STAGE_DEFS.length;

function pad2(n) { return String(n).padStart(2, ' '); }

function createStageTracker(order, debug) {
  const state = new Map(); // n -> { status, at, evidence, reason }
  for (const s of STAGE_DEFS) state.set(s.n, { status: 'PENDING', at: null, evidence: null, reason: null });

  function def(n) { return STAGE_DEFS.find(s => s.n === n); }
  function fmt(n) { const d = def(n); const s = state.get(n);
    return `Stage ${pad2(n)}/${TOTAL} [${s.status.padEnd(7)}] ${d.label}`;
  }

  async function persist(currentN, extra = {}) {
    try {
      const s = state.get(currentN);
      const d = def(currentN);
      await Order.findByIdAndUpdate(order._id, {
        $set: {
          // These are additive fields — schema.strict:false in Mongoose keeps
          // them, but even without that Mongo persists $set of unknown paths.
          rdpFlowStage: currentN,
          rdpFlowStageLabel: d.label,
          rdpFlowStageStatus: s.status,
          rdpFlowStageAt: new Date(),
          rdpFlowStageReason: s.reason || '',
          ...extra,
        },
      }).catch(() => {});
    } catch (_) {}
  }

  function enter(n, subMsg) {
    const d = def(n);
    if (!d) return;
    state.set(n, { status: 'RUNNING', at: new Date().toISOString(), evidence: null, reason: null });
    const line = `${fmt(n)}${subMsg ? ' — ' + subMsg : ''}`;
    debug.info('STAGE', line, { stage: n, runner: d.runner, evidenceHow: d.evidenceHow });
    persist(n);
  }

  function pass(n, evidence) {
    const d = def(n);
    if (!d) return;
    const cur = state.get(n) || {};
    const rec = { status: 'PASS', at: new Date().toISOString(), evidence: evidence || null, reason: null };
    state.set(n, rec);
    const evStr = evidence ? ` — evidence: ${typeof evidence === 'string' ? evidence : JSON.stringify(evidence)}` : '';
    debug.info('STAGE', `${fmt(n)}${evStr}`, {
      stage: n, runner: d.runner, evidenceKind: d.evidenceKind, evidence,
    });
    persist(n);
  }

  function fail(n, reason, meta = {}) {
    const d = def(n);
    if (!d) return;
    const rec = { status: 'FAIL', at: new Date().toISOString(), evidence: null, reason: String(reason || '').slice(0, 400) };
    state.set(n, rec);
    debug.error('STAGE', `${fmt(n)} — Reason: ${rec.reason}`, {
      stage: n, runner: d.runner, evidenceHow: d.evidenceHow, ...meta,
    });
    persist(n);
  }

  function skip(n, why) {
    const d = def(n);
    if (!d) return;
    state.set(n, { status: 'SKIPPED', at: new Date().toISOString(), evidence: null, reason: String(why || '') });
    debug.warn('STAGE', `${fmt(n)} — skipped (${why || ''})`, { stage: n });
    persist(n);
  }

  function ensureAllPassed() {
    // Refuse to declare READY unless every non-aggregate stage is PASS.
    const failing = [];
    for (const s of STAGE_DEFS) {
      if (s.n === 8) continue;
      const st = state.get(s.n);
      if (!st || st.status !== 'PASS') failing.push({ n: s.n, label: s.label, status: st && st.status });
    }
    return { ok: failing.length === 0, failing };
  }

  function firstFailure() {
    for (const s of STAGE_DEFS) {
      const st = state.get(s.n);
      if (st && st.status === 'FAIL') return { n: s.n, label: s.label, reason: st.reason };
    }
    // pending / running counts as "did not reach"
    for (const s of STAGE_DEFS) {
      const st = state.get(s.n);
      if (st && (st.status === 'PENDING' || st.status === 'RUNNING')) {
        return { n: s.n, label: s.label, reason: st.status === 'RUNNING' ? 'stage running but never confirmed by evidence' : 'stage never reached' };
      }
    }
    return null;
  }

  function summaryLines() {
    const lines = [];
    lines.push('────────────────────────────────────────────────────────');
    lines.push('RDP EXECUTION-FLOW STAGE AUDIT');
    lines.push('────────────────────────────────────────────────────────');
    for (const s of STAGE_DEFS) {
      const st = state.get(s.n);
      const mark = st.status === 'PASS' ? '✅'
                 : st.status === 'FAIL' ? '❌'
                 : st.status === 'SKIPPED' ? '⏭️'
                 : st.status === 'RUNNING' ? '⏳' : '⬜';
      lines.push(`${mark} Stage ${pad2(s.n)}/${TOTAL}  ${s.label}`);
      lines.push(`      runner   : ${s.runner}`);
      lines.push(`      evidence : [${s.evidenceKind}] ${s.evidenceHow}`);
      if (st.evidence != null) {
        const ev = typeof st.evidence === 'string' ? st.evidence : JSON.stringify(st.evidence);
        lines.push(`      observed : ${ev}`);
      }
      if (st.reason) lines.push(`      REASON   : ${st.reason}`);
      if (st.at)     lines.push(`      at       : ${st.at}`);
    }
    lines.push('────────────────────────────────────────────────────────');
    return lines;
  }

  function dumpSummary(outcome) {
    const lines = summaryLines();
    lines.unshift(`FINAL OUTCOME: ${outcome}`);
    const block = lines.join('\n');
    debug.info('STAGE_SUMMARY', block, {});
    return block;
  }

  function summaryTelegram() {
    // Short (≤ 12 lines) summary safe to embed in a Telegram card.
    const rows = STAGE_DEFS.map(s => {
      const st = state.get(s.n);
      const mark = st.status === 'PASS' ? '✅'
                 : st.status === 'FAIL' ? '❌'
                 : st.status === 'RUNNING' ? '⏳'
                 : st.status === 'SKIPPED' ? '⏭️' : '⬜';
      return `${mark} Stage ${s.n}/${TOTAL}: ${s.label}`;
    });
    return rows.join('\n');
  }

  return {
    STAGES: STAGE_DEFS,
    TOTAL,
    enter, pass, fail, skip,
    ensureAllPassed, firstFailure,
    dumpSummary, summaryTelegram, summaryLines,
    stateSnapshot: () => Object.fromEntries([...state.entries()].map(([k, v]) => [k, { ...v }])),
  };
}

module.exports = { createStageTracker, STAGE_DEFS, TOTAL_STAGES: TOTAL };
