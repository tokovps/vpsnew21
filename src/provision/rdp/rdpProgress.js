// ═══════════════════════════════════════════════════════════════════════════
// Single-writer progress renderer.
//
// The ONLY way to change what the user sees is `progress.setState(STATE)`.
// State is:
//   1. Persisted to Mongo (`rdpState`, `rdpStateAt`, `rdpProgressPct`).
//   2. Reflected in a single Telegram bubble via editMessage.
//
// A background "spinner ticker" runs but ONLY rotates a decorative icon;
// it never touches progress %, ETA, checklist, or state. If spinner tick
// occurs mid-transition it uses the LATEST persisted state — never stale.
//
// Monotonic progress: if code ever tries to move backwards (e.g. retry loop),
// the persisted pct is used as a floor. The progress bar cannot regress.
// ═══════════════════════════════════════════════════════════════════════════
const Order = require('../../models/Order');
const sm = require('./rdpStateMachine');

const SPINNERS = ['⏳', '⌛', '🔄', '🟡', '🟠'];
const BAR_LEN = 20;

function bar(pct) {
  const filled = Math.max(0, Math.min(BAR_LEN, Math.round((pct / 100) * BAR_LEN)));
  return '█'.repeat(filled) + '░'.repeat(BAR_LEN - filled);
}

function checklistLine(activeChecks, key, label) {
  const done = activeChecks.has(key);
  return `${done ? '✅' : '⬜'} ${label}`;
}

function createRdpProgress(bot, order) {
  const runtime = {
    // last rendered body — for deduplication
    lastBody: '',
    lastEditAt: 0,
    spinnerIdx: 0,
    ticker: null,
    disposed: false,
    finalBody: null,
    // subStatus is a purely informational suffix; it never changes progress %.
    subStatus: '',
    // cached description of the current state (recomputed on setState)
    current: sm.describe(order.rdpState || 'QUEUED'),
    // pct floor (monotonic guard)
    pctFloor: Number(order.rdpProgressPct || 0),
    // absolute deadline for current state's ETA — computed once on entry,
    // then countdown is derived from wall-clock (NOT from a resetting timer).
    finishBy: order.rdpFinishBy ? new Date(order.rdpFinishBy).getTime() : 0,
  };

  async function persist(state) {
    const desc = sm.describe(state);
    // Monotonic pct guard
    runtime.pctFloor = Math.max(runtime.pctFloor, desc.pct);
    // Compute absolute finishBy on state entry so ETA is a countdown,
    // not a static number that misleads user after the state stalls.
    const finishBy = Date.now() + Math.max(0, desc.etaMin) * 60 * 1000;
    runtime.finishBy = finishBy;
    const patch = {
      rdpState: state,
      rdpStateAt: new Date(),
      rdpProgressPct: runtime.pctFloor,
      rdpFinishBy: new Date(finishBy),
    };
    await Order.findByIdAndUpdate(order._id, { $set: patch }).catch((e) =>
      console.warn('[rdp-progress] persist state failed:', e && e.message));
    // Keep in-memory order in sync so subsequent reads (buildFailCard etc.)
    // see the latest state.
    Object.assign(order, patch);
    runtime.current = desc;
  }

  // Derive human-friendly ETA from absolute finishBy so it becomes a genuine
  // countdown. Once elapsed, we say "sebentar lagi" rather than showing a
  // frozen number that could be perceived as "ETA terus berubah".
  function etaLabel() {
    if (!runtime.finishBy) return sm.formatEta(runtime.current.etaMin);
    const remainMs = runtime.finishBy - Date.now();
    if (remainMs <= 0) return 'sebentar lagi';
    const remainMin = Math.max(1, Math.round(remainMs / 60000));
    return sm.formatEta(remainMin);
  }

  function render() {
    const cur = runtime.current;
    const displayedPct = Math.max(cur.pct, runtime.pctFloor);
    const spinner = SPINNERS[runtime.spinnerIdx % SPINNERS.length];
    const eta = etaLabel();

    return `━━━━━━━━━━━━━━━━━━
🖥 *AUTO CREATE RDP*

\`${bar(displayedPct)}\` *${displayedPct}%*

━━━━━━━━━━━━━━━━━━
${spinner} *${cur.label}*
${runtime.subStatus ? `_${runtime.subStatus}_\n` : ''}
⏱ Estimasi tahap: *${eta}*

━━━━━━━━━━━━━━━━━━
*Status:*

${checklistLine(cur.checks, 'vps_ready',         'VPS Linux Berhasil Dibuat')}
${checklistLine(cur.checks, 'ssh_ready',         'SSH Connected')}
${checklistLine(cur.checks, 'reinstall_started', 'Script Reinstall Berjalan')}
${checklistLine(cur.checks, 'windows_booting',   'Windows Sedang Diinstall')}
${checklistLine(cur.checks, 'rdp_configured',    'Konfigurasi RDP')}
${checklistLine(cur.checks, 'password_generated','Generate Password')}
${checklistLine(cur.checks, 'validation',        'Final Validation')}
━━━━━━━━━━━━━━━━━━

🧾 Invoice: \`${order.invoice}\`
📦 ${order.productName}`;
  }

  async function pushEdit(force = false) {
    if (runtime.disposed || runtime.finalBody) return;
    const body = render();
    if (!force && body === runtime.lastBody) return;
    if (!force && Date.now() - runtime.lastEditAt < 1500) return;
    runtime.lastBody = body;
    runtime.lastEditAt = Date.now();
    const chatId = order.progressChatId;
    const msgId = order.progressMessageId;
    const opts = { parse_mode: 'Markdown' };
    // ═════════════════════════════════════════════════════════════════
    // SINGLE-BUBBLE DISCIPLINE (must mirror VPS orchestrator):
    // While an anchor (chatId + msgId) exists, we only ever EDIT.
    // We DO NOT emit a fresh sendMessage on transient edit errors — that
    // is what causes the "menumpuk di layar Telegram" symptom the user
    // complained about. A new bubble is created ONLY when the anchor is
    // genuinely gone: the specific Telegram Bot API error
    //   400 Bad Request: message to edit not found
    // is the sole trigger. Every other error (rate-limit, "message is
    // not modified", flaky network) → swallow + retry on next tick.
    // ═════════════════════════════════════════════════════════════════
    const isAnchorLostErr = (err) => {
      if (!err) return false;
      const d = String(err.description || err.message || '');
      return /message to edit not found|message can't be edited|MESSAGE_ID_INVALID/i.test(d);
    };
    if (chatId && msgId) {
      // Try caption first (payment card is a photo caption on many flows).
      try {
        await bot.telegram.editMessageCaption(chatId, msgId, undefined, body, opts);
        return;
      } catch (err) {
        if (isAnchorLostErr(err)) {
          // fallthrough → re-anchor via sendMessage
        } else {
          // Caption edit failed for a non-fatal reason (e.g. anchor is a text
          // message, not a photo). Try text edit next.
          try {
            await bot.telegram.editMessageText(chatId, msgId, undefined, body, opts);
            return;
          } catch (err2) {
            if (isAnchorLostErr(err2)) {
              // fallthrough → re-anchor via sendMessage
            } else {
              // Both edits failed non-fatally (e.g. "not modified", rate-limit).
              // Swallow + let next tick retry. NEVER sendMessage here.
              return;
            }
          }
        }
      }
    }
    // Anchor is missing or truly gone — emit ONE fresh bubble and re-anchor.
    try {
      const m = await bot.telegram.sendMessage(order.userId, body, opts);
      order.progressChatId = m.chat.id;
      order.progressMessageId = m.message_id;
      await Order.findByIdAndUpdate(order._id, {
        $set: { progressChatId: m.chat.id, progressMessageId: m.message_id },
      });
    } catch (e) {
      console.warn('[rdp-progress] re-anchor failed:', e && (e.description || e.message));
    }
  }

  function startTicker() {
    if (runtime.ticker) return;
    // Spinner ONLY rotates the icon char. It never touches pct/ETA/checks.
    runtime.ticker = setInterval(() => {
      runtime.spinnerIdx++;
      pushEdit();
    }, 8000);
  }

  return {
    /** Transition to a new state. This is the ONLY way to change progress/ETA/checklist.
     *  Monotonic guard: any attempt to move to a state with a LOWER ordinal than the
     *  current one is IGNORED (with a warn log). This is what prevents the UI from
     *  ever rewinding to "Memilih Provider Terbaik" after Windows install started. */
    async setState(state) {
      if (!sm.isValidState(state)) {
        console.warn('[rdp-progress] invalid state:', state);
        return;
      }
      const curr = runtime.current && runtime.current.state;
      // Repeated evidence for the same lifecycle phase must not restart the
      // ETA countdown. The monitor can confirm reboot through port, SSH and
      // provider API in adjacent polls; persisting the same state for every
      // signal previously moved finishBy forward each time.
      if (curr === state) {
        await pushEdit(true);
        startTicker();
        return;
      }
      if (!sm.canAdvance(curr, state)) {
        console.warn(`[rdp-progress] REGRESSIVE state transition IGNORED: ${curr} → ${state}`);
        return;
      }
      await persist(state);
      runtime.subStatus = '';
      await pushEdit(true);
      startTicker();
    },
    /** Override only the ETA deadline, without changing phase/progress.
     *  Used by the installer monitor so the UI counts down to the same hard
     *  deadline enforced by the orchestrator instead of resetting per poll. */
    async setDeadline(timestampMs) {
      const value = Number(timestampMs);
      if (!Number.isFinite(value) || value <= 0) return;
      runtime.finishBy = value;
      const date = new Date(value);
      order.rdpFinishBy = date;
      await Order.findByIdAndUpdate(order._id, {
        $set: { rdpFinishBy: date },
      }).catch((e) => console.warn('[rdp-progress] persist deadline failed:', e && e.message));
      await pushEdit(true);
    },
    /** Purely informational sub-status text. Does NOT alter state/pct/ETA. */
    setSubStatus(text) {
      runtime.subStatus = String(text || '').slice(0, 200);
      pushEdit();
    },
    /** Current state (from in-memory cache — matches DB after last transition). */
    currentState() { return runtime.current.state; },
    /** Final terminal edit — turns off ticker and locks the bubble. */
    async finalize(finalBody) {
      runtime.finalBody = finalBody;
      runtime.disposed = true;
      if (runtime.ticker) { clearInterval(runtime.ticker); runtime.ticker = null; }
      const chatId = order.progressChatId;
      const msgId = order.progressMessageId;
      const opts = { parse_mode: 'Markdown' };
      const isAnchorLostErr = (err) => {
        if (!err) return false;
        const d = String(err.description || err.message || '');
        return /message to edit not found|message can't be edited|MESSAGE_ID_INVALID/i.test(d);
      };
      if (chatId && msgId) {
        try {
          await bot.telegram.editMessageCaption(chatId, msgId, undefined, finalBody, opts);
          return;
        } catch (err) {
          if (!isAnchorLostErr(err)) {
            try {
              await bot.telegram.editMessageText(chatId, msgId, undefined, finalBody, opts);
              return;
            } catch (err2) {
              if (!isAnchorLostErr(err2)) {
                // Final card cannot be delivered by editing — try ONE re-anchor.
              }
            }
          }
        }
      }
      try {
        await bot.telegram.sendMessage(order.userId, finalBody, opts);
      } catch (e) {
        console.error('[rdp-progress] finalize failed:', e && (e.description || e.message));
      }
    },
    dispose() {
      runtime.disposed = true;
      if (runtime.ticker) { clearInterval(runtime.ticker); runtime.ticker = null; }
    },
  };
}

module.exports = { createRdpProgress };
