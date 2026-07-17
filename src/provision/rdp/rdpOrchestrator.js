// ================================================================
// AUTO CREATE RDP — PRODUCTION ORCHESTRATOR
// ----------------------------------------------------------------
// Flow (single Telegram message, edit-only UX):
//
//   Payment Success
//     └─ Queue
//        └─ Smart Provider Selection (reuses VPS provider pool)
//           └─ Lock Provider
//              └─ Create Linux VPS (existing adapter.createInstance)
//                 └─ Wait Port 22
//                    └─ Wait SSH READY (login test)
//                       └─ SSH → run reinstall (bin456789/reinstall)
//                          └─ SSH disconnect (NORMAL — box is rebooting)
//                             └─ Monitor: wait Windows boot
//                                └─ Validate RDP handshake + service up
//                                   └─ Send credentials  ✅
//                                   └─ Order = SUCCESS
//
// Any failure BEFORE credentials-send:
//   - Release provider lock
//   - Attempt cleanup (destroy droplet)
//   - Retry next provider (up to MAX_PROVIDER_ATTEMPTS)
//   - On exhaustion: order=failed, refund (if gateway supports)
//
// This module does NOT touch the VPS `provision/orchestrator.js` file —
// it is a parallel pipeline exclusive to `category === 'rdp'`.
// ================================================================
const Order = require('../../models/Order');
const VpsInstance = require('../../models/VpsInstance');
const providerService = require('../../services/providerService');
const providers = require('../../providers');
const audit = require('../../services/auditService');
const { rdpProvisionQueue } = require('../../queues/provisionQueue');
const { generateAdminPassword } = require('../../utils/passwordGen');
const { createRdpProgress } = require('./rdpProgress');
const { waitForSSH, runReinstall, tcpPing, probeRebootState } = require('./rdpSSH');
const { validateWindowsReady } = require('./rdpValidator');
const { createRdpDebugLogger } = require('./rdpDebugLogger');
const cfg = require('./rdpConfig');
const winInstaller = require('./windowsInstaller');
const { createStageTracker } = require('./rdpStageTracker');
const { isPermanentProviderFailure } = require('../../services/providerFailureClassifier');

const log = (...args) => console.log('[rdp-orch]', ...args);

async function pickApi(order, tried) {
  // ─────────────────────────────────────────────────────────────────────
  // STRICT PARITY WITH AUTO CREATE VPS:
  // Use the SAME provider pool, SAME preferred-first ordering, SAME
  // findReadyApis()/tryLockApi()/markUsed() lifecycle. No RDP-specific
  // stock table, no separate quota, no separate health check.
  // The optional env `RDP_PROVIDER_ALLOWLIST` remains available as an
  // operator escape-hatch (e.g. for gradual rollouts), but defaults to
  // empty (= all providers allowed) so RDP mirrors VPS behaviour exactly.
  // ─────────────────────────────────────────────────────────────────────
  const apis = await providerService.findReadyApis();
  const raw = String(process.env.RDP_PROVIDER_ALLOWLIST || '').trim().toLowerCase();
  const allow = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
  const allowAll = allow.length === 0 || allow.includes('all') || allow.includes('*');
  const pool = allowAll ? apis : apis.filter(a => allow.includes(String(a.provider).toLowerCase()));
  const preferred = new Set(order.preferredApiIds || []);
  if (preferred.size) {
    const a = pool.find(x => !tried.includes(String(x._id)) && preferred.has(String(x._id)));
    if (a) return a;
  }
  return pool.find(x => !tried.includes(String(x._id))) || null;
}

function buildSuccessCard(order, data) {
  const created = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false });
  return `━━━━━━━━━━━━━━━━━━
🎉 *RDP BERHASIL DIBUAT*
━━━━━━━━━━━━━━━━━━

🧾 Invoice   : \`${order.invoice}\`
☁ Provider  : ${String(data.provider).toUpperCase()}
🌍 Region    : ${data.region}
🖥 Windows   : ${data.windowsImage}
🌐 IP        : \`${data.publicIp}\`
👤 Username  : \`Administrator\`
🔑 Password  : \`${data.password}\`
📡 Port      : \`${cfg.RDP_PORT}\`
🕒 Created   : ${created}

━━━━━━━━━━━━━━━━━━
🔐 *INFORMASI LOGIN RDP*
\`\`\`
Host     : ${data.publicIp}:${cfg.RDP_PORT}
Username : Administrator
Password : ${data.password}
\`\`\`
━━━━━━━━━━━━━━━━━━

*Cara Login:*
1. Buka *Remote Desktop Connection* (Windows) / *Microsoft Remote Desktop* (Mac/iOS/Android).
2. Isi Host : \`${data.publicIp}:${cfg.RDP_PORT}\`
3. Klik Connect → masukkan Username & Password di atas.

_Simpan detail login ini di tempat aman._`;
}

function buildFailCard(order, reason) {
  const tail = String(order.__reinstallLog || '').trim().slice(-700);
  const logBlock = tail
    ? `\n\n📜 *SSH Log (tail):*\n\`\`\`\n${tail.replace(/```/g, "'''")}\n\`\`\``
    : '';
  return `━━━━━━━━━━━━━━━━━━
❌ *AUTO CREATE RDP GAGAL*
━━━━━━━━━━━━━━━━━━

🧾 Invoice: \`${order.invoice}\`
📦 ${order.productName}

📝 Penyebab:
_${String(reason).slice(0, 400)}_${logBlock}

Provider telah dilepas & resource dibersihkan.
Silakan hubungi Admin untuk proses refund atau retry.
━━━━━━━━━━━━━━━━━━`;
}

// ROUND-11: separate card for readiness-timeout. VPS + Windows sudah jadi,
// hanya belum "menerima RDP" pada window kita. User TIDAK boleh dianggap
// gagal permanen — provider TIDAK dilepas & VPS TIDAK dihapus, karena
// beberapa menit lagi Windows biasanya sudah bisa dipakai.
function buildStillConfiguringCard(order, ctx) {
  const created = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false });
  const failed = ctx.failedStage
    ? `\n\n❌ *Berhenti di Stage ${ctx.failedStage.n}/8:* ${ctx.failedStage.label}\n📝 *Reason:* _${String(ctx.failedStage.reason || '-').slice(0, 200)}_`
    : '';
  const stageBlock = ctx.stageSummary
    ? `\n\n*Execution Flow:*\n\`\`\`\n${String(ctx.stageSummary).slice(0, 900)}\n\`\`\``
    : '';
  return `━━━━━━━━━━━━━━━━━━
⏳ *WINDOWS MASIH MELAKUKAN KONFIGURASI*
━━━━━━━━━━━━━━━━━━

🧾 Invoice   : \`${order.invoice}\`
🌐 IP        : \`${ctx.publicIp}\`
📡 Port      : \`${ctx.rdpPort}\`
🕒 Dicek     : ${created}

Windows sudah selesai diinstall, namun *layanan Remote Desktop belum siap menerima koneksi* saat pengecekan.

Ini normal terjadi pada tahap akhir setup (Getting devices ready / Applying policies).

📝 *Silakan tunggu beberapa menit lalu coba kembali.*
Jika setelah 10 menit RDP masih tidak bisa diakses, hubungi admin dengan menyertakan invoice di atas.${failed}${stageBlock}
━━━━━━━━━━━━━━━━━━`;
}


async function runOnce(bot, order, progress, debug, stages) {
  const tried = [];
  let lastError = null;

  for (let attempt = 1; attempt <= cfg.MAX_PROVIDER_ATTEMPTS; attempt++) {
    // Only set PROVIDER_SELECTING on the FIRST attempt. Subsequent retry
    // attempts (which happen mid-pipeline after e.g. a WINDOWS_INSTALLING
    // failure on the previous provider) must NOT rewind the visible state
    // back to "Memilih Provider Terbaik". The monotonic guard in rdpProgress
    // would refuse the transition anyway, but expressing the intent here
    // keeps the sub-status accurate.
    if (attempt === 1) {
      await progress.setState('PROVIDER_SELECTING');
    }
    progress.setSubStatus(attempt === 1
      ? `Mencari provider terbaik...`
      : `Provider gagal, mencoba provider lain (percobaan ke-${attempt})`);
    const cand = await pickApi(order, tried);
    if (!cand) {
      debug.error('PROVIDER_PICK', 'No READY provider available', { attempt, tried });
      throw new Error(lastError ? lastError.message : 'Tidak ada provider READY tersedia');
    }
    tried.push(String(cand._id));
    debug.info('PROVIDER_PICK', `Provider chosen: ${cand.provider}`, {
      attempt, apiId: String(cand._id), provider: cand.provider, region: cand.region || order.region || '',
    });

    // PROVIDER_LOCKED is fine to (re)assert only on first attempt — on retries
    // we keep the higher state and only reflect the swap via sub-status.
    if (attempt === 1) await progress.setState('PROVIDER_LOCKED');
    const locked = await providerService.tryLockApi(cand._id, order._id);
    if (!locked) { debug.warn('PROVIDER_PICK', 'lock lost, retry', { apiId: String(cand._id) }); log('lock lost, retry'); continue; }
    debug.info('PROVIDER_PICK', 'Provider locked', { apiId: String(locked._id), provider: locked.provider });

    const attemptStart = Date.now();
    let created = null;
    let providerCapacityCommitted = false;
    const adapter = providers.get(locked.provider);

    try {
      // ---- Health check (no state change, just sub-status) ----
      progress.setSubStatus(`Cek health ${locked.provider}`);
      const health = await providers.healthCheck(locked);
      if (!health.ok) throw new Error('Health check gagal: ' + health.error);

      // Password digenerate SEKARANG (untuk cloud-init) tapi checklist item
      // `password_generated` BARU dinyalakan lewat state LOGIN_TESTING —
      // setelah endpoint melewati validasi RDP final dan kredensial aman
      // untuk dirilis. Bot tidak mengklaim melakukan login kredensial penuh;
      // verifikasi jaringan berhenti pada negosiasi modern + TLS.
      //
      // Password harus lolos Windows complexity policy. Meskipun generator
      // sudah include upper/lower/digit/symbol, kita validasi eksplisit dan
      // regen kalau ada regresi di generator (max 5 retry).
      let adminPassword = order.generatedPassword || generateAdminPassword(18);
      for (let i = 0; i < 5; i++) {
        const v = cfg.validateWindowsPassword(adminPassword, 'administrator');
        if (v.ok) break;
        debug.debug('PWD_POLICY', `regen: ${v.errors.join(',')}`);
        adminPassword = generateAdminPassword(18);
      }
      const finalCheck = cfg.validateWindowsPassword(adminPassword, 'administrator');
      if (!finalCheck.ok) {
        // Should be near-impossible with a decent generator, but fail fast
        // rather than deliver an unusable RDP.
        const e = new Error('Password generator tidak menghasilkan password valid Windows: ' + finalCheck.errors.join(','));
        e.code = 'PWD_POLICY';
        throw e;
      }
      if (!order.generatedPassword) {
        await Order.findByIdAndUpdate(order._id, { $set: { generatedPassword: adminPassword } });
      }

      // ---- Create Linux VPS ----
      await progress.setState('VPS_CREATING');
      // ═══ STRUCTURED SPEC (root-cause fix) ═══════════════════════════════
      // Build the DO create payload from Order's persisted numeric fields.
      // If the order was created BEFORE the structured-spec migration (all
      // zeros) we derive the slug now via specMapping and REFUSE to proceed
      // if the admin's free-form spec text is still ambiguous.
      let effSizeSlug = order.sizeSlug || '';
      let effCpu = order.cpu || 0;
      let effRamMb = order.ramMb || 0;
      let effDiskGb = order.diskGb || 0;
      if (!effSizeSlug || !effCpu || !effRamMb || !effDiskGb) {
        const { parseSpecText, deriveDoSizeSlug } = require('../../utils/specMapping');
        const parsed = parseSpecText(order.description);
        effCpu    = effCpu    || Number(parsed.cpu)    || 0;
        effRamMb  = effRamMb  || Number(parsed.ramMb)  || 0;
        effDiskGb = effDiskGb || Number(parsed.diskGb) || 0;
        effSizeSlug = effSizeSlug || deriveDoSizeSlug({ cpu: effCpu, ramMb: effRamMb, diskGb: effDiskGb }) || '';
        // Persist so subsequent retries / Detail VPS have the numeric snapshot.
        if (effSizeSlug || effCpu || effRamMb || effDiskGb) {
          await Order.findByIdAndUpdate(order._id, {
            $set: { cpu: effCpu, ramMb: effRamMb, diskGb: effDiskGb, sizeSlug: effSizeSlug },
          });
        }
      }
      if (!effSizeSlug || !effCpu || !effRamMb || !effDiskGb) {
        const err = new Error(
          `Order spec tidak lengkap: cpu=${effCpu} ram=${effRamMb}MB disk=${effDiskGb}GB slug="${effSizeSlug}". ` +
          `Admin harus menuliskan spec dengan format eksplisit (contoh: "4 vCPU\\n8GB RAM\\n160GB SSD") ` +
          `atau menset field cpu/ramMb/diskGb secara manual.`
        );
        err.code = 'ORDER_SPEC_INCOMPLETE';
        throw err;
      }
      debug.info('SPEC_SELECTED', 'User spec resolved', {
        selectedPackage: `${order.category}/${order.tier}`, selectedSlot: order.slot,
        selectedCpu: effCpu, selectedRamMb: effRamMb, selectedDiskGb: effDiskGb,
        selectedSizeSlug: effSizeSlug, selectedRegion: order.region || '(auto)',
        selectedWindows: order.osVersion || '(default)',
      });

      const spec = {
        orderId: String(order._id),
        osFamily: 'Ubuntu',
        osVersion: '22.04',
        // === RDP-specific hints for the provider adapter ===
        category: 'rdp',
        tier: String(order.tier || '').toLowerCase(),
        region: order.region || '',
        // STRICT: adapter must honour this or throw. No silent downsizing.
        sizeSlug: effSizeSlug,
        cpu:    effCpu,
        ramMb:  effRamMb,
        diskGb: effDiskGb,
        password: adminPassword,
        sshPublicKey: '',
      };
      created = await adapter.createInstance(locked, spec, async (m) => {
        progress.setSubStatus(String(m));
        debug.debug('VPS_CREATE', `adapter: ${String(m).slice(0, 200)}`);
      });
      await progress.setState('VPS_READY');
      progress.setSubStatus(`IP: ${created.publicIp}`);
      // Persist provisioning context — allows boot-sweep after crash to
      // release the provider lock and cleanup the orphan droplet.
      const verified = created.verified || {};
      await Order.findByIdAndUpdate(order._id, {
        $set: {
          rdpApiId: String(locked._id),
          rdpInstanceId: String(created.instanceId),
          rdpPublicIp: created.publicIp,
          verifiedSizeSlug: verified.sizeSlug || '',
          verifiedMemoryMb: verified.memoryMb || 0,
          verifiedVcpus:    verified.vcpus || 0,
          verifiedDiskGb:   verified.diskGb || 0,
        },
      });
      debug.info('VPS_CREATE', 'VPS created & size-verified', {
        provider: locked.provider, instanceId: created.instanceId, region: created.region,
        publicIp: created.publicIp,
        verifiedSizeSlug: verified.sizeSlug, verifiedMemoryMb: verified.memoryMb,
        verifiedVcpus: verified.vcpus, verifiedDiskGb: verified.diskGb,
      });
      debug.info('VPS_READY', `VPS ready at ${created.publicIp}`, { provider: locked.provider });

      // ---- Explicit provider-side ACTIVE verification (user requirement #3) ----
      // Use adapter.waitUntilActive() — the canonical helper that polls DO's
      // /droplets/:id every 10s until status==='active' (or destroyed/timeout).
      if (adapter && typeof adapter.waitUntilActive === 'function') {
        const final = await adapter.waitUntilActive(locked, created.instanceId, {
          timeoutMs: 3 * 60 * 1000,
          intervalMs: 10 * 1000,
          onTick: (st) => {
            debug.info('DROPLET_ACTIVE', `provider status=${st && st.status}`, {
              instanceId: created.instanceId, exists: st && st.exists, publicIp: st && st.publicIp,
            });
            progress.setSubStatus(`Menunggu Droplet ACTIVE (status=${st && st.status})`);
          },
        });
        if (final.status === 'destroyed' || final.exists === false) {
          throw new Error(`Droplet ${created.instanceId} tidak ditemukan di provider (status=${final.status})`);
        }
        if (final.status !== 'active') {
          throw new Error(`Droplet tidak pernah ACTIVE dalam 3 menit (status terakhir=${final.status})`);
        }
        debug.info('DROPLET_ACTIVE', 'Droplet ACTIVE confirmed via provider API', {
          instanceId: created.instanceId, provider: locked.provider, publicIp: final.publicIp,
        });
      }

      // A guest-level Windows firewall rule cannot override a DigitalOcean
      // Cloud Firewall. Audit every firewall attached directly or through the
      // `tgbot` tag before spending up to 20 minutes on the reinstall. This
      // specifically prevents the bot from certifying an endpoint that only
      // its own source IP can reach while the customer remains blocked.
      if (cfg.RDP_REQUIRE_PUBLIC_3389 && String(locked.provider).toLowerCase() === 'digitalocean') {
        if (!adapter || typeof adapter.auditRdpCloudFirewall !== 'function') {
          const e = new Error('Adapter DigitalOcean tidak menyediakan audit Cloud Firewall RDP.');
          e.code = 'RDP_CLOUD_FIREWALL_AUDIT_UNAVAILABLE';
          throw e;
        }
        progress.setSubStatus(`Audit Cloud Firewall TCP ${cfg.RDP_PORT}...`);
        const firewallAudit = await adapter.auditRdpCloudFirewall(locked, created.instanceId, {
          port: cfg.RDP_PORT,
          dropletTags: ['tgbot'],
        });
        debug.info('CLOUD_FIREWALL', firewallAudit.reason, firewallAudit);
        if (!firewallAudit.ok) {
          const e = new Error(firewallAudit.reason);
          e.code = 'RDP_CLOUD_FIREWALL_BLOCKED';
          throw e;
        }
      }

      // ---- Wait port 22 + SSH auth ----
      await progress.setState('SSH_CONNECTING');
      await waitForSSH(created.publicIp, {
        username: created.username || 'root',
        password: adminPassword,
      }, {
        onProgress: ({ attempt: a, phase }) =>
          progress.setSubStatus(`SSH ${phase} (try ${a})`),
        debug,
      });
      await progress.setState('SSH_READY');
      debug.info('SSH_LOGIN', 'SSH login verified', { host: created.publicIp });

      // ---- Run reinstall script ----
      progress.setSubStatus('Menyiapkan script reinstall...');
      // Resolve final target { imageName, isoUrl, displayName } — auto from
      // archive.org unless operator overrode via ENV. If unresolved this
      // throws → falls into the catch → provider cleanup and next-attempt
      // logic. But we ALREADY validated at pipeline start (see
      // provisionRdpOrder preflight) so this path should rarely throw.
      const winTarget = await winInstaller.resolveWindowsTarget(order.osVersion);
      debug.info('WIN_TARGET', 'Windows target resolved', winInstaller.summarizeTarget(winTarget));

      // ═══ SSH PRECHECK — internet / DNS / script / ISO URL / disk ═══════
      // Runs on the fresh Ubuntu 22.04. If ANY of these fail, we STOP
      // BEFORE the reinstall command executes. This is the guarantee the
      // user requested: no reinstall unless every parameter is verified.
      progress.setSubStatus('Preflight: cek internet, DNS, script, ISO URL...');
      const precheck = await winInstaller.precheckOnVps(
        created.publicIp,
        { username: created.username || 'root', password: adminPassword },
        winTarget,
        { debug },
      );
      debug.info('PRECHECK', 'Preflight PASSED — all resources verified', {
        results: precheck.results.map(r => ({ name: r.name, detail: r.detail })),
        localIsoPath: precheck.localIsoPath || null,
      });

      // The provider token is needed exclusively only until the Droplet has
      // been created and the preflight has passed. Commit one quota slot now
      // and release the API record back to READY while Windows installs.
      // This lets other paid orders start immediately instead of waiting up
      // to the full Windows installation time behind a single token lock.
      const capacity = await providerService.markUsed(locked._id);
      if (!capacity) {
        const e = new Error('Gagal mencatat pemakaian quota provider setelah Droplet dibuat.');
        e.code = 'PROVIDER_CAPACITY_COMMIT_FAILED';
        throw e;
      }
      providerCapacityCommitted = true;
      debug.info('PROVIDER_RELEASED', 'Provider slot committed; API token released during Windows install', {
        apiId: String(locked._id), remainingQuota: capacity.quotaAvailable,
        nextStatus: capacity.status,
      });

      const cmd = cfg.buildReinstallCommand({
        sub: 'windows',
        imageName: winTarget.imageName,
        password: adminPassword,
        rdpPort: cfg.RDP_PORT,
        username: 'administrator',
        isoUrl: winTarget.isoUrl,
      });
      debug.info('REINSTALL_CMD', `Prepared reinstall command`, {
        windowsVersion: winTarget.displayName,
        imageName: winTarget.imageName,
        isoUrl: winTarget.isoUrl,
        isoEnv: winTarget.isoEnv,
        osVersionRequested: order.osVersion || '(default)',
        cmdPreview: cmd.slice(0, 400),
        cmdLength: cmd.length,
      });

      await progress.setState('REINSTALL_STARTING');
      progress.setSubStatus(
        `Target: ${winTarget.imageName} • staging maksimal ${Math.round(cfg.REINSTALL_DISPATCH_TIMEOUT_MS / 60000)} menit`
      );
      const reinstallStart = Date.now();
      let reinstallLog = '';
      stages.enter(1, `bash reinstall.sh windows --image-name "${winTarget.imageName}"`);
      const rr = await runReinstall(created.publicIp, {
        username: created.username || 'root',
        password: adminPassword,
      }, cmd, {
        onLog: (chunk) => {
          reinstallLog += chunk;
          if (reinstallLog.length > 8000) reinstallLog = reinstallLog.slice(-6000);
          const s = String(chunk).trim().split('\n').pop() || '';
          if (s) progress.setSubStatus(s.slice(0, 120));
        },
        debug,
      });
      order.__reinstallLog = reinstallLog;
      debug.info('REINSTALL_EXIT', 'Reinstall dispatch result', {
        exitCode: rr.exitCode,
        disconnected: !!rr.disconnected,
        durationMs: Date.now() - reinstallStart,
        logTail: (reinstallLog || '').slice(-500),
      });
      if (rr.disconnected) {
        debug.info('SSH_DISCONNECT', 'SSH dropped during reinstall — reboot imminent', {
          host: created.publicIp,
        });
      }
      log('reinstall dispatched', {
        disconnected: !!rr.disconnected,
        exitCode: rr.exitCode,
        ms: Date.now() - reinstallStart,
        logTail: (reinstallLog || '').slice(-500),
      });

      // ═══ HARD GATE: script exit code ═══════════════════════════════════
      // If the script returned a non-zero exit code AND did NOT disconnect
      // (which is the "success by reboot" signal), it means the reinstall
      // script itself errored (wrong image name, unsupported OS, network
      // fetch failed, disk too small, etc.). Do NOT proceed to wait for a
      // reboot that will never happen — surface the log and fail fast so the
      // user sees the real reason instead of a 45-minute silent timeout.
      if (!rr.disconnected && rr.exitCode !== null && rr.exitCode !== 0) {
        const stdoutTail = (rr.stdout || '').slice(-1500);
        const stderrTail = (rr.stderr || '').slice(-800);
        stages.fail(1, `reinstall.sh exit=${rr.exitCode} (no reboot signal)`, {
          exitCode: rr.exitCode, stdoutTail, stderrTail,
        });
        debug.error('REINSTALL_EXIT', `Reinstall script FAILED exit=${rr.exitCode}`, {
          exitCode: rr.exitCode,
          windowsVersion: winTarget.displayName,
          imageName: winTarget.imageName,
          isoUrl: winTarget.isoUrl,
          stdoutTail, stderrTail,
        });
        // Derive a SPECIFIC user-visible reason from the log tail.
        const combined = (stdoutTail + '\n' + stderrTail).toLowerCase();
        let specific;
        if (rr.exitCode === 124) {
          specific = `Staging boot installer melewati batas ${Math.round(cfg.REINSTALL_DISPATCH_TIMEOUT_MS / 60000)} menit dan dihentikan otomatis.`;
        } else if (/iso link is empty|iso url is not set/.test(combined)) {
          specific = 'ISO Link kosong (script upstream tidak dapat menemukan ISO). Direct ISO URL harus di-set via ENV — cek konfigurasi.';
        } else if (/not support find this iso/.test(combined)) {
          specific = `--image-name "${winTarget.imageName}" tidak dikenal upstream reinstall.sh. Butuh update mapping WINDOWS_MATRIX di windowsInstaller.js.`;
        } else if (/no space left|disk full/.test(combined)) {
          specific = 'Disk VPS penuh saat staging ISO — pilih paket dengan disk lebih besar.';
        } else if (/could not resolve host|name resolution|temporary failure/.test(combined)) {
          specific = 'DNS gagal saat script berjalan — network VPS tidak stabil.';
        } else if (/curl:.*22|http\/[\d.]+ 4\d\d|http\/[\d.]+ 5\d\d/.test(combined)) {
          specific = `HTTP error saat unduh ISO / komponen. URL ISO mungkin expired atau butuh cookie. isoUrl=${winTarget.isoUrl}`;
        } else if (rr.exitCode === 40) {
          specific = 'Gagal unduh reinstall.sh dari mirror upstream — cek REINSTALL_SCRIPT_URL / DNS github.';
        } else {
          specific = `Script upstream error tidak dikenal (exit=${rr.exitCode}).`;
        }
        const reinstallErr = new Error(
          `Script reinstall GAGAL (exit=${rr.exitCode}) — ${specific}\n` +
          `[image-name] ${winTarget.imageName}\n` +
          `[iso-url]    ${winTarget.isoUrl}\n` +
          `[stdout tail]\n${stdoutTail}\n` +
          (stderrTail ? `[stderr tail]\n${stderrTail}` : '')
        );
        reinstallErr.code = rr.exitCode === 124
          ? 'RDP_REINSTALL_DISPATCH_TIMEOUT'
          : 'RDP_REINSTALL_SCRIPT_FAILED';
        throw reinstallErr;
      }

      // ═══ ROUND-6 MONITOR LOOP: multi-signal reboot detection ══════════
      // Stage 1 confirmed: reinstall.sh dispatched successfully (either exit 0
      // OR intentional SSH disconnect meaning the box is rebooting right now).
      stages.pass(1, {
        exitCode: rr.exitCode, disconnected: !!rr.disconnected,
        elapsedMs: Date.now() - reinstallStart,
      });
      stages.enter(2, 'menunggu port 22 tertutup / SSH host-key berubah / API reboot event');
      //
      // Bug being fixed: the historical loop treated port22-open ⇒ "linux is
      // still running / reboot didn't happen". But bin456789/reinstall.sh
      // for Windows works in TWO stages:
      //   Stage 1 (Ubuntu → Alpine staging):
      //     Ubuntu reboots, kernel/initrd is swapped to Alpine, Alpine boots,
      //     opens SSH on :22 (different host key, hostname, OS release).
      //     Stage 1 takes 30-60s (reboot itself), but Alpine then downloads
      //     the Windows ISO (5-15 min on a 4-6 GB ISO / 100 Mbps link).
      //   Stage 2 (Alpine → Windows Setup):
      //     Alpine writes the DD payload to disk, reboots again into WinPE /
      //     Windows Setup unattend. Port 22 CLOSES here (Windows doesn't run
      //     sshd), port 3389 comes up later after Setup completes.
      //
      // The old loop timed out during Stage 1 (Alpine staging with SSH open)
      // with "Reinstall tidak trigger reboot" — false alarm.
      //
      // New detection signals (any is enough to prove reboot happened):
      //   A. port 22 CLOSED (we still watch this — Stage 2 or transient window)
      //   B. SSH probe returns uptime < REBOOT_WINDOW_SEC — box was just booted
      //   C. SSH probe returns osFamily != 'ubuntu' — we're now on Alpine
      //   D. SSH probe fails auth (host key/creds changed — Alpine has its own)
      //   E. DO API /actions shows a completed 'reboot'/'power_cycle' AFTER
      //      reinstall_start_ts.
      //
      // Behaviour matrix after each poll:
      //   port22 down                           → linuxWentDown=true, state=INSTALLING
      //   port22 up + uptime<300s               → linuxWentDown=true (Alpine staging)
      //   port22 up + osFamily != ubuntu        → linuxWentDown=true (Alpine confirmed)
      //   port22 up + uptime>5min + osFamily==ubuntu + reinstall dispatched >5min ago
      //                                         → HARD FAIL "reboot did not fire"
      //   port22 down + port3389 up             → windowsUp=true → break
      //   status=off for >2 poll                → POWER_ON via API (retry once)
      //   status=off + power_on retry failed    → HARD FAIL
      //   status=destroyed/gone                 → HARD FAIL immediately
      // ═══════════════════════════════════════════════════════════════════
      await progress.setState('LINUX_REBOOTING');
      // One total deadline starts at dispatch. Previously a brand-new
      // long timeout window was started only AFTER runReinstall returned, so a
      // hung staging command plus monitor loop could exceed an hour by a
      // wide margin. Round-18 targets dispatch → externally reachable RDP
      // within 20 minutes and rejects slow ISO routes during preflight.
      const bootDeadline = reinstallStart + cfg.REINSTALL_MAX_TIMEOUT_MS;
      const REBOOT_HARD_LIMIT_MS = cfg.REBOOT_HARD_LIMIT_MS;
      const REBOOT_ESCALATION_GRACE_MS = cfg.REBOOT_ESCALATION_GRACE_MS;
      const REBOOT_WINDOW_SEC    = 300;  // "uptime < this" ⇒ recent boot
      let   rebootHardDeadline   = Date.now() + REBOOT_HARD_LIMIT_MS;
      await progress.setDeadline(Math.min(bootDeadline, rebootHardDeadline));
      let linuxWentDown       = false;
      let windowsUp           = false;
      let pollTick            = 0;
      let lastInstanceStatusAt = 0;
      let offCount            = 0;
      let powerOnTried        = false;
      let sshProbeErrorCount  = 0;
      let apiRebootDetected   = false;
      // Escalation ladder: 0=none, 1=reboot, 2=power_cycle, 3=power_off+power_on
      let forceRebootStage    = 0;
      // ROUND-7: Alpine stuck detector — bila linuxWentDown=true tapi port 22
      // masih terbuka > ALPINE_STUCK_TIMEOUT_MS (default 12 min), berarti Alpine
      // menggantung download ISO. Trigger power_cycle sekali.
      let alpineStuckAt       = 0;
      let alpineForcedCycled  = false;

      while (Date.now() < bootDeadline) {
        pollTick++;
        const p22   = await tcpPing(created.publicIp, 22, 4000);
        const p3389 = await tcpPing(created.publicIp, cfg.RDP_PORT, 4000);
        const pingLike = p22 || p3389;
        debug.debug('PING', `tick=${pollTick} port22=${p22} port3389=${p3389} reachable=${pingLike}`, {
          host: created.publicIp,
        });

        // ── (E) Provider API — status + recent actions ────────────────────
        let instStatus = null;
        if (Date.now() - lastInstanceStatusAt > 10000 && adapter && typeof adapter.getInstance === 'function') {
          lastInstanceStatusAt = Date.now();
          try {
            instStatus = await adapter.getInstance(locked, created.instanceId);
            debug.info('INSTANCE_STATUS', `provider=${locked.provider} status=${instStatus && instStatus.status}`, {
              instanceId: created.instanceId, status: instStatus && instStatus.status, exists: instStatus && instStatus.exists,
            });
            if (instStatus && (instStatus.status === 'destroyed' || instStatus.status === 'gone' || instStatus.exists === false)) {
              throw new Error(`Provider melaporkan VPS TIDAK ADA (status=${instStatus.status}). Kemungkinan di-destroy sistem provider atau salah instanceId.`);
            }
            // Check recent actions API for reboot/power_cycle completions AFTER reinstallStart
            if (!apiRebootDetected && typeof adapter.getRecentActions === 'function') {
              const acts = await adapter.getRecentActions(locked, created.instanceId, { limit: 8 }).catch(() => []);
              for (const a of acts) {
                const t = new Date(a.completed_at || a.started_at || 0).getTime();
                if (t > reinstallStart && /reboot|power_cycle|power_on/i.test(a.type || '') && (a.status === 'completed' || a.status === 'in-progress')) {
                  apiRebootDetected = true;
                  debug.info('REBOOT_DETECTED', `DO API confirms ${a.type} @ ${a.completed_at}`, { action: a.type, status: a.status });
                  break;
                }
              }
            }
            // Auto power-on if OFF for 2+ consecutive polls (user requirement)
            if (instStatus && (instStatus.status === 'off' || instStatus.status === 'offline' || instStatus.status === 'archive')) {
              offCount++;
              debug.info('INSTANCE_STATUS', `off count=${offCount} — will auto power-on at 2`, {});
              if (offCount >= 2 && !powerOnTried && typeof adapter.powerOn === 'function') {
                powerOnTried = true;
                debug.info('POWER_ON', 'VPS status=off — issuing power_on via DO API', { instanceId: created.instanceId });
                progress.setSubStatus('VPS OFF — power on via API...');
                const po = await adapter.powerOn(locked, created.instanceId).catch(e => ({ ok: false, error: e.message }));
                debug.info('POWER_ON', 'power_on result', po);
                if (!po.ok && !po.note) {
                  throw new Error(`VPS OFF dan power_on gagal: ${po.error || 'unknown'}. Provider mungkin lock akun.`);
                }
                offCount = 0; // reset — give it time to come back
              } else if (offCount >= 6) {
                throw new Error(`VPS status=${instStatus.status} selama >60 detik meski sudah power_on. VPS mati permanen.`);
              }
            } else {
              offCount = 0;
            }
          } catch (isErr) {
            if (/TIDAK ADA|VPS OFF dan power_on gagal|permanen/i.test(isErr.message)) throw isErr;
            debug.warn('INSTANCE_STATUS', 'getInstance/actions non-fatal error', { error: String(isErr && isErr.message) });
          }
        }

        // ── (A) Port 22 CLOSED — classic reboot signal ────────────────────
        if (!p22 && !linuxWentDown) {
          linuxWentDown = true;
          debug.info('REBOOT_DETECTED', 'Port 22 CLOSED — original Ubuntu shut down', {
            host: created.publicIp, sinceReinstallMs: Date.now() - reinstallStart, method: 'port22-closed',
          });
          stages.pass(2, `port 22 CLOSED after ${Math.round((Date.now() - reinstallStart) / 1000)}s`);
          await progress.setState('WINDOWS_INSTALLING');
        }

        // ── (B/C/D) SSH probe — differentiate Ubuntu vs Alpine staging ───
        // Only probe if we haven't yet confirmed reboot AND port 22 is up
        // (no point probing a closed port). Probe once every 2 ticks (~20s)
        // to keep the loop responsive.
        if (!linuxWentDown && p22 && (pollTick % 2 === 1)) {
          const probe = await probeRebootState(created.publicIp, {
            username: created.username || 'root', password: adminPassword,
          }, { debug }).catch(err => ({ reachable: false, sshError: err.message, uptimeSec: null, osFamily: 'unknown' }));
          debug.info('SSH_PROBE', `tick=${pollTick} probe result`, probe);
          if (probe.reachable && probe.uptimeSec != null) {
            const sinceReinstallSec = Math.floor((Date.now() - reinstallStart) / 1000);
            // Signal (B): uptime much smaller than time-since-reinstall → box rebooted
            if (probe.uptimeSec < REBOOT_WINDOW_SEC && probe.uptimeSec < sinceReinstallSec - 30) {
              linuxWentDown = true;
              debug.info('REBOOT_DETECTED', `Uptime probe confirms reboot: uptime=${probe.uptimeSec}s (reinstall was ${sinceReinstallSec}s ago)`, {
                method: 'uptime-check', uptimeSec: probe.uptimeSec, osFamily: probe.osFamily,
              });
              stages.pass(2, `uptime probe uptime=${probe.uptimeSec}s (osFamily=${probe.osFamily})`);
              await progress.setState('WINDOWS_INSTALLING');
              progress.setSubStatus(`Staging OS aktif: ${probe.osFamily} (uptime ${probe.uptimeSec}s) — Windows ISO sedang di-download`);
            }
            // Signal (C): OS changed from ubuntu
            else if (probe.osFamily && probe.osFamily !== 'ubuntu' && probe.osFamily !== 'unknown') {
              linuxWentDown = true;
              debug.info('REBOOT_DETECTED', `OS family changed to ${probe.osFamily} — Alpine/staging active`, {
                method: 'os-family-change', osFamily: probe.osFamily,
              });
              stages.pass(2, `SSH os-family switched to ${probe.osFamily}`);
              await progress.setState('WINDOWS_INSTALLING');
              progress.setSubStatus(`Staging OS: ${probe.osFamily} — Windows install sedang berjalan`);
            }
          } else if (probe.sshError) {
            // Signal (D): SSH auth failed / host key change → Alpine has different host key & creds
            if (/host key|auth|handshake|no matching|banner/i.test(probe.sshError)) {
              sshProbeErrorCount++;
              debug.info('SSH_PROBE', `ssh probe error #${sshProbeErrorCount}: ${probe.sshError}`, {});
              if (sshProbeErrorCount >= 2) {
                linuxWentDown = true;
                debug.info('REBOOT_DETECTED', 'SSH host key / auth changed on :22 → staging OS active', {
                  method: 'ssh-host-key-change', sshError: probe.sshError,
                });
                stages.pass(2, `SSH host-key changed (${probe.sshError.slice(0, 60)})`);
                await progress.setState('WINDOWS_INSTALLING');
                progress.setSubStatus('Staging SSH host-key berubah — reboot terkonfirmasi');
              }
            }
          }
        }

        // Signal (E): API confirmed reboot event
        if (!linuxWentDown && apiRebootDetected) {
          linuxWentDown = true;
          debug.info('REBOOT_DETECTED', 'Provider API confirmed reboot event', { method: 'do-api-actions' });
          stages.pass(2, 'provider API records reboot/power_cycle action');
          await progress.setState('WINDOWS_INSTALLING');
        }

        // ── WINDOWS UP: port 22 closed + port 3389 open ───────────────────
        // Port 22 is lifecycle telemetry only. Once 3389 accepts TCP, the
        // dedicated validator performs the sole READY decision with a stable
        // RDP protocol handshake gate before credentials can be sent.
        if (p3389) {
          // Re-check provider state at the exact moment Windows becomes
          // reachable. A stale ACTIVE result from before reinstall is not
          // sufficient evidence for Stage 3.
          if (adapter && typeof adapter.getInstance === 'function') {
            const activeNow = await adapter.getInstance(locked, created.instanceId);
            if (!activeNow || activeNow.status !== 'active') {
              debug.warn('INSTANCE_STATUS', '3389 open but provider not ACTIVE yet — keep polling', {
                instanceId: created.instanceId,
                status: activeNow && activeNow.status,
                exists: activeNow && activeNow.exists,
              });
              progress.setSubStatus(`3389 terbuka, menunggu provider ACTIVE (status=${activeNow && activeNow.status || 'unknown'})`);
              await new Promise(r => setTimeout(r, cfg.PORT_POLL_INTERVAL_MS));
              continue;
            }
            stages.enter(3, 'final provider-state check saat port 3389 terbuka');
            stages.pass(3, `adapter.getInstance() status=${activeNow.status}`);
          } else {
            // Legacy adapters do not expose a control-plane status endpoint.
            // Keep compatibility, but record the exact fallback evidence.
            stages.enter(3, 'provider adapter has no getInstance(); using external liveness fallback');
            stages.pass(3, 'external TCP response proves the instance is running (provider API unavailable)');
          }

          windowsUp = true;
          debug.info('PORT_3389', '3389 accepts TCP — entering stable RDP readiness validation', {
            host: created.publicIp, sinceReinstallMs: Date.now() - reinstallStart,
            port22Open: p22, method: 'port3389-open',
          });
          // Stage 4: first observable network activity from Windows.
          stages.pass(4, `port 3389 first accepted TCP at ${Math.round((Date.now() - reinstallStart) / 1000)}s after reinstall dispatch`);
          // Stage 5 (INFERRED): 3389 can only be externally reachable if the
          // SetupComplete.cmd → Machine Startup Script chain has (a) started
          // TermService, (b) opened the Windows Firewall, (c) cleared
          // fDenyTSConnections. There is no way to prove this from outside
          // more strongly than the port being reachable at all.
          stages.pass(5, 'external reachability of 3389 implies SetupComplete + Startup Script executed (firewall + TermService + fDenyTSConnections=0)');
          await progress.setState('WINDOWS_BOOTING');
          break;
        }

        // ── HARD FAIL: reboot did not fire within RDP_REBOOT_HARD_LIMIT_MS ─
        // Escalation ladder (3 tiers, each with a 30-second default grace):
        //   Stage 1: adapter.rebootDroplet()   — soft ACPI reboot
        //   Stage 2: adapter.powerCycle()      — hard power cycle
        //   Stage 3: powerOff() + powerOn()    — brute-force off then on
        // Only after Stage 3 fails do we hard-fail. Defaults: ~3 minutes
        // before escalation + ~90 seconds total grace.
        if (!linuxWentDown && Date.now() > rebootHardDeadline && forceRebootStage < 3) {
          forceRebootStage++;
          const elapsedMs = Date.now() - reinstallStart;
          let stageName = '', stageResult = null;
          try {
            if (forceRebootStage === 1 && typeof adapter.rebootDroplet === 'function') {
              stageName = 'reboot';
              debug.warn('FORCE_REBOOT', `Stage 1/3 — soft reboot via DO API`, { elapsedMs });
              progress.setSubStatus('Reboot tidak terjadi — Stage 1/3: soft reboot...');
              stageResult = await adapter.rebootDroplet(locked, created.instanceId).catch(e => ({ ok: false, error: e.message }));
            } else if (forceRebootStage === 2 && typeof adapter.powerCycle === 'function') {
              stageName = 'power_cycle';
              debug.warn('FORCE_REBOOT', `Stage 2/3 — hard power_cycle via DO API`, { elapsedMs });
              progress.setSubStatus('Stage 2/3: hard power_cycle...');
              stageResult = await adapter.powerCycle(locked, created.instanceId).catch(e => ({ ok: false, error: e.message }));
            } else if (forceRebootStage === 3 && typeof adapter.powerOff === 'function' && typeof adapter.powerOn === 'function') {
              stageName = 'power_off+power_on';
              debug.warn('FORCE_REBOOT', `Stage 3/3 — power_off then power_on via DO API`, { elapsedMs });
              progress.setSubStatus('Stage 3/3: power_off + power_on...');
              const off = await adapter.powerOff(locked, created.instanceId).catch(e => ({ ok: false, error: e.message }));
              debug.info('FORCE_REBOOT', 'power_off result', off);
              await new Promise(r => setTimeout(r, 15000));  // wait for shutdown to register
              const on = await adapter.powerOn(locked, created.instanceId).catch(e => ({ ok: false, error: e.message }));
              debug.info('FORCE_REBOOT', 'power_on result', on);
              stageResult = { ok: (off.ok || off.note) && (on.ok || on.note), off, on };
            }
          } catch (fe) {
            stageResult = { ok: false, error: fe.message };
          }
          debug.info('FORCE_REBOOT', `Stage ${forceRebootStage} (${stageName}) result`, stageResult);
          if (stageResult && (stageResult.ok || stageResult.note)) {
            // Short, configurable grace: provider power actions normally
            // become visible within seconds. One minute avoids three extra
            // two-minute waits on a bootstrap that is already broken.
            rebootHardDeadline = Date.now() + REBOOT_ESCALATION_GRACE_MS;
            progress.setSubStatus(
              `Force ${stageName} berhasil — menunggu reboot ${Math.round(REBOOT_ESCALATION_GRACE_MS / 60000)} menit...`
            );
          } else {
            // This stage's API call itself failed. Immediately try next stage on next tick.
            rebootHardDeadline = Date.now() + 5000;
          }
        } else if (!linuxWentDown && Date.now() > rebootHardDeadline && forceRebootStage >= 3) {
          const reinstallSec = Math.floor((Date.now() - reinstallStart) / 1000);
          const reason =
            `Reboot TIDAK terjadi dalam ${Math.round(REBOOT_HARD_LIMIT_MS / 60000)} menit ` +
            `(port 22 tetap terbuka, uptime menunjukkan Ubuntu asli, DO API tidak melaporkan reboot event). ` +
            `Escalation 3-tahap (reboot → power_cycle → power_off+power_on) semua tidak menghasilkan reboot. ` +
            `Kemungkinan: reinstall.sh gagal setup bootloader, atau kernel panic saat reboot. ` +
            `Elapsed: ${reinstallSec}s.`;
          debug.error('TIMEOUT', reason, {
            reinstallExitCode: rr.exitCode, disconnected: rr.disconnected,
            apiRebootDetected, forceRebootStage, logTail: reinstallLog.slice(-500),
          });
          stages.fail(2, `no reboot signal in ${reinstallSec}s after 3-stage force-reboot escalation`);
          const rebootErr = new Error(reason);
          rebootErr.code = 'RDP_REBOOT_TIMEOUT';
          throw rebootErr;
        }

        // ── ROUND-7 ALPINE STUCK DETECTOR ─────────────────────────────────
        // If linuxWentDown=true (reboot happened) BUT port 22 is STILL open
        // (Alpine staging active) AND we've been in this state > ALPINE_STUCK_TIMEOUT_MS,
        // Alpine is likely hung downloading the ISO. Force a power_cycle once
        // to kick it. If that doesn't help, monitor loop hard timeout kicks in.
        if (linuxWentDown && p22 && !windowsUp) {
          if (!alpineStuckAt) alpineStuckAt = Date.now();
          if (!alpineForcedCycled && (Date.now() - alpineStuckAt) > cfg.ALPINE_STUCK_TIMEOUT_MS
              && typeof adapter.powerCycle === 'function') {
            alpineForcedCycled = true;
            debug.warn('ALPINE_STUCK', `Alpine SSH terlihat > ${Math.round(cfg.ALPINE_STUCK_TIMEOUT_MS / 60000)} min tanpa transisi Windows — force power_cycle`, {
              stuckMs: Date.now() - alpineStuckAt,
            });
            progress.setSubStatus('Alpine stuck download ISO — force power_cycle...');
            const pc = await adapter.powerCycle(locked, created.instanceId).catch(e => ({ ok: false, error: e.message }));
            debug.info('ALPINE_STUCK', 'power_cycle result', pc);
          }
        } else if (!p22) {
          // Port 22 closed → Alpine transisi ke Windows Setup, reset stuck timer.
          alpineStuckAt = 0;
        }


        // ── Sub-status UI ─────────────────────────────────────────────────
        const elapsedMin = Math.floor((Date.now() - reinstallStart) / 60000);
        const remainingMin = Math.max(0, Math.ceil((bootDeadline - Date.now()) / 60000));
        const ssh   = p22   ? '✅' : '❌';
        const rdp   = p3389 ? '✅' : '⏳';
        const provTag = instStatus ? `[${instStatus.status}]` : '';
        if (!linuxWentDown) {
          progress.setSubStatus(`SSH:${ssh} 3389:${rdp} ${provTag} • Menunggu reboot • ${elapsedMin}m • batas ${remainingMin}m`);
        } else if (!p3389) {
          progress.setSubStatus(`SSH:${ssh} 3389:${rdp} ${provTag} • Windows install ${elapsedMin}m • sisa batas ${remainingMin}m`);
        }
        await new Promise(r => setTimeout(r, cfg.PORT_POLL_INTERVAL_MS));
      }
      if (!windowsUp) {
        const reason = 'Windows tidak siap dalam '
          + Math.round(cfg.REINSTALL_MAX_TIMEOUT_MS / 60000)
          + ' menit '
          + (linuxWentDown ? '(reboot terjadi tapi RDP 3389 tidak pernah up — Windows install gagal / masih running)' : '(reboot tidak terjadi)');
        debug.error('TIMEOUT', reason, {
          linuxWentDown, windowsUp, apiRebootDetected, forceRebootStage, alpineForcedCycled,
          reinstallExitCode: rr.exitCode, disconnected: rr.disconnected,
          totalMs: Date.now() - reinstallStart,
        });
        if (!linuxWentDown) {
          stages.fail(2, 'monitor loop expired without any reboot signal');
        } else {
          stages.fail(4, 'reboot happened but port 3389 never opened externally within the monitor window — SetupComplete or Machine Startup Script likely did not run');
        }
        const installErr = new Error(reason);
        installErr.code = linuxWentDown ? 'RDP_INSTALL_TIMEOUT' : 'RDP_REBOOT_TIMEOUT';
        throw installErr;
      }

      // ---- RDP configuring / validating / login-test ----
      await progress.setState('RDP_CONFIGURING');
      progress.setSubStatus('Menunggu service RDP siap');
      await new Promise(r => setTimeout(r, 10000)); // brief settle time

      await progress.setState('RDP_VALIDATING');
      progress.setSubStatus('Memvalidasi handshake RDP...');
      stages.enter(6, 'X.224 negotiation → valid RDP_NEG_RSP → TLS secureConnect');
      let stage6Done = false;
      let stage7Entered = false;
      const onRdpCheck = (s) => {
        if (!stage6Done && s.rdpService && s.tlsReady) {
          stage6Done = true;
          stages.pass(6, `modern RDP negotiation + TLS OK on validate attempt=${s.attempt} (${s.selectedProtocolName || 'enhanced security'})`);
          stages.enter(7, `waiting for ${s.stableRequired} consecutive stable polls`);
          stage7Entered = true;
        }
        const sshOk  = s.linuxDown ? '✅' : 'ℹ️';
        const rdpOk  = s.portOpen  ? '✅' : '⏳';
        const hsOk   = s.rdpService && s.tlsReady ? '✅' : '⏳';
        const stable = `Stable ${s.stableCount}/${s.stableRequired}`;
        const tail   = s.stableCount === 0 && s.lastFailReason
          ? ` • retry (${String(s.lastFailReason).slice(0, 60)})`
          : '';
        progress.setSubStatus(
          `Port22 diagnostic:${sshOk}  •  RDP ${cfg.RDP_PORT}:${rdpOk}  •  TLS/CredSSP:${hsOk}  •  ${stable}${tail}`
        );
      };
      let v = await validateWindowsReady(created.publicIp, {
        onCheck: onRdpCheck,
        debug,
      });

      // The first three good polls can still land in the brief interval
      // before OOBE/policy processing restarts TermService. Keep observing
      // the server, then require an independent stable TLS/CredSSP window.
      if (v.ok && cfg.RDP_POST_READY_SOAK_MS > 0) {
        const soakSeconds = Math.ceil(cfg.RDP_POST_READY_SOAK_MS / 1000);
        debug.info('RDP_SOAK', `Initial validation OK — observing for ${soakSeconds}s before final validation`, {
          initialState: v.state,
          soakMs: cfg.RDP_POST_READY_SOAK_MS,
        });
        progress.setSubStatus(`Handshake awal OK — observasi stabilitas ${soakSeconds} detik...`);
        await new Promise(r => setTimeout(r, cfg.RDP_POST_READY_SOAK_MS));
        progress.setSubStatus('Validasi final TLS/CredSSP setelah masa observasi...');
        v = await validateWindowsReady(created.publicIp, {
          attempts: cfg.RDP_FINAL_VALIDATE_ATTEMPTS,
          stableRequired: cfg.RDP_FINAL_STABLE_REQUIRED,
          onCheck: onRdpCheck,
          debug,
        });
        debug.info('RDP_SOAK', `Final post-soak validation ok=${v.ok}`, { state: v.state });
      }
      if (!v.ok) {
        // ROUND-14: pin down WHICH stage failed so admin dapat langsung
        // membaca "Stage 5 FAILED" atau "Stage 6 FAILED" tanpa harus baca
        // log validator mentah. STOP di stage yang pertama gagal.
        if (!v.state.portOpen) {
          stages.fail(5, 'port 3389 never reachable externally — SetupComplete.cmd / Machine Startup Script likely did not open firewall or start TermService');
        } else if (!v.state.rdpService || !v.state.tlsReady) {
          stages.fail(6, `port 3389 reachable but modern RDP security was not usable — ${v.state.lastFailReason || 'negotiation/TLS failed'}`);
        } else if (v.state.stableCount < v.state.stableRequired) {
          if (!stage7Entered) stages.enter(7, 'validator reported flapping before stable window');
          stages.fail(7, `only reached stable ${v.state.stableCount}/${v.state.stableRequired} — TermService flapping / restarted mid-check`);
        } else {
          stages.fail(6, 'unknown validator failure state');
        }
        debug.error('RDP_VALIDATE', 'Readiness detection TIMEOUT — Windows belum siap menerima RDP', {
          state: v.state, reason: v.reason, failedStage: stages.firstFailure(),
        });
        const e = new Error(
          'Windows masih melakukan konfigurasi. Silakan tunggu beberapa menit lalu coba kembali.'
        );
        e.code = 'RDP_NOT_READY_TIMEOUT';
        e.rdpTimeoutContext = {
          publicIp: created.publicIp,
          rdpPort: cfg.RDP_PORT,
          username: 'Administrator',
          password: adminPassword,
          state: v.state,
          failedStage: stages.firstFailure(),
          stageSummary: stages.summaryTelegram(),
        };
        throw e;
      }
      stages.pass(7, `post-observation stable ${v.state.stableCount}/${v.state.stableRequired} consecutive TLS polls`);
      debug.info('RDP_VALIDATE', 'Final RDP TLS validation OK — READY (stable)', { state: v.state });

      // ═══ ROUND-14 HARD GATE: refuse READY unless every stage PASS ═══════
      // This is the safety net: even if some future refactor accidentally
      // skips a stage, this gate will surface it and REFUSE to send
      // "🎉 RDP BERHASIL DIBUAT" — the very bug ROUND-14 targets.
      stages.enter(8, 'aggregate verification of stages 1–7');
      const gate = stages.ensureAllPassed();
      if (!gate.ok) {
        const failInfo = gate.failing.map(f => `Stage ${f.n} (${f.label}) status=${f.status}`).join('; ');
        stages.fail(8, `pre-READY gate rejected: ${failInfo}`);
        debug.error('STAGE', `READY GATE REJECTED — refusing to send credentials`, {
          failing: gate.failing,
        });
        const e = new Error(
          'Windows masih melakukan konfigurasi. Silakan tunggu beberapa menit lalu coba kembali.'
        );
        e.code = 'RDP_NOT_READY_TIMEOUT';
        e.rdpTimeoutContext = {
          publicIp: created.publicIp,
          rdpPort: cfg.RDP_PORT,
          username: 'Administrator',
          password: adminPassword,
          state: v.state,
          failedStage: stages.firstFailure(),
          stageSummary: stages.summaryTelegram(),
        };
        throw e;
      }
      stages.pass(8, 'stages 1–7 all PASS — clearing bot to send credentials');

      await progress.setState('LOGIN_TESTING');
      progress.setSubStatus('Kredensial Administrator siap dikirim setelah validasi ganda');

      // ---- Persist success ----
      const inst = await VpsInstance.create({
        orderId: String(order._id),
        userId: order.userId,
        provider: created.provider,
        apiId: String(locked._id),
        instanceId: created.instanceId,
        region: created.region,
        imageId: created.imageId,
        osLabel: winTarget.imageName,
        size: created.size,
        publicIp: created.publicIp,
        username: 'Administrator',
        password: adminPassword,
        sshKeyName: '',
        status: 'running',
        rdpLastReadyAt: new Date(),
        // LIFECYCLE MARKER: droplet ini sudah/sedang di-reinstall menjadi
        // Windows. TIDAK PERNAH boleh diperlakukan sebagai VPS Linux di masa
        // depan — walaupun VpsInstance ini di-delete, marker tetap tercatat
        // sebagai jejak audit bahwa provider slot ini sempat digunakan RDP.
        lifecycle: 'rdp',
        raw: { ...(created.raw || {}), category: 'rdp', reinstalledTo: winTarget.imageName },
      });

      const summary = [
        `IP: ${created.publicIp}`,
        `User: Administrator`,
        `Password: ${adminPassword}`,
        `Port: ${cfg.RDP_PORT}`,
        `Windows: ${winTarget.imageName}`,
      ].join('\n');

      await Order.findByIdAndUpdate(order._id, {
        $set: {
          status: 'success',
          provisionStatus: 'success',
          providerUsed: created.provider,
          apiUsedId: String(locked._id),
          vpsInstanceId: String(inst._id),
          publicIp: created.publicIp,
          credentials: summary,
        },
      });

      // Normally committed immediately after the preflight so another order
      // can use the same provider token in parallel. Keep a defensive guard
      // for future alternate provisioning paths that might skip that point.
      if (!providerCapacityCommitted) {
        await providerService.markUsed(locked._id);
        providerCapacityCommitted = true;
      }
      await providerService.recordAttempt(locked._id, true, Date.now() - attemptStart);
      await audit.log('rdp.success', {
        refId: order._id,
        message: `${created.provider}@${created.region} → ${created.publicIp}`,
      });

      // Admin notify (non-blocking)
      try {
        require('../../services/adminNotifyService').notifyActivity(
          { telegramId: order.userId, username: order.username, firstName: order.userName || '' },
          'RDP Berhasil Auto-Created',
          {
            '☁️ Provider:': String(created.provider).toUpperCase(),
            '🌍 Region:': created.region || '-',
            '🌐 IP:': `\`${created.publicIp}\``,
            '🖥 Windows:': winTarget.imageName,
            '🧾 Invoice:': `\`${order.invoice}\``,
          },
        );
      } catch (_) {}

      await progress.setState('COMPLETED');
      await progress.finalize(buildSuccessCard(order, {
        provider: created.provider,
        region: created.region,
        windowsImage: winTarget.imageName,
        publicIp: created.publicIp,
        password: adminPassword,
      }));

      // Receipt to channel (best-effort)
      try {
        const { sendReceipt } = require('../../handlers/adminHandler');
        const fresh = await Order.findById(order._id);
        await sendReceipt(bot, fresh, 'success');
      } catch (_) {}

      return { ok: true };
    } catch (err) {
      lastError = err;
      log('attempt failed', err.message);
      debug.error('ERROR', `attempt #${attempt} failed on provider ${locked.provider}`, {
        error: err.message, code: err.code || null,
      });
      // ─────────────────────────────────────────────────────────────────
      // ROUND-11: Readiness timeout is a distinct terminal outcome. VPS +
      // Windows sudah jadi & password valid — hanya RDP handshake belum
      // stabil dalam window. JANGAN cleanup droplet, JANGAN unlock provider,
      // JANGAN kirim success. Bubble di-finalize dengan pesan "masih
      // konfigurasi, tunggu beberapa menit". Order ditandai
      // provisionStatus='pending_ready' agar admin/UI tahu bedanya dengan
      // hard-failure.
      // ─────────────────────────────────────────────────────────────────
      if (err.code === 'RDP_NOT_READY_TIMEOUT') {
        const ctx = err.rdpTimeoutContext || {};
        await audit.log('rdp.readiness_timeout', {
          refId: order._id,
          message: err.message,
          meta: { provider: locked.provider, publicIp: ctx.publicIp },
        });
        // Persist credentials & IP so user/admin dapat retry manual nanti.
        await Order.findByIdAndUpdate(order._id, {
          $set: {
            provisionStatus: 'pending_ready',
            provisionError: err.message.slice(0, 500),
            rdpApiId: String(locked._id),
            rdpInstanceId: created ? String(created.instanceId) : '',
            rdpPublicIp: ctx.publicIp || (created && created.publicIp) || '',
          },
        });
        await progress.finalize(buildStillConfiguringCard(order, {
          publicIp: ctx.publicIp || (created && created.publicIp) || '-',
          rdpPort:  ctx.rdpPort  || cfg.RDP_PORT,
          failedStage:  ctx.failedStage || stages.firstFailure(),
          stageSummary: ctx.stageSummary || stages.summaryTelegram(),
        }));
        debug.finalize('PENDING_READY', err.message);
        // Dump the full stage audit block to the debug log — this is what
        // admin greps for to answer "berhenti di tahap mana?".
        stages.dumpSummary('PENDING_READY');
        // Signal to caller that this is a terminal readiness-timeout —
        // provisionRdpOrder must NOT trigger the generic "gagal" refund path.
        err.__readinessTimeout = true;
        throw err;
      }
      await audit.log('rdp.attempt_fail', {
        refId: order._id,
        message: err.message.slice(0, 200),
        meta: { provider: locked.provider, attempt },
      });
      // Cleanup droplet if we got that far
      try {
        if (created && adapter.cleanup) await adapter.cleanup(locked, created).catch(() => {});
      } catch (_) {}
      if (!providerCapacityCommitted) {
        await providerService.unlockApi(locked._id, { reason: 'rdp attempt failed before capacity commit' });
      }
      // A Windows/ISO timeout is not an invalid provider credential. Only a
      // permanent authentication/account failure should disable the shared
      // token, especially now that other installs may use it concurrently.
      if (isPermanentProviderFailure(err)) {
        await providerService.markError(locked._id, err);
      } else if (providerCapacityCommitted) {
        // Cleanup removed the failed Droplet; refresh live quota immediately
        // instead of under-counting stock until the five-minute health cron.
        try { await require('../../health/providerHealth').checkOne(locked._id); } catch (_) {}
      }
      await providerService.recordAttempt(locked._id, false, Date.now() - attemptStart);
      await Order.findByIdAndUpdate(order._id, {
        $inc: { provisionRetryCount: 1 },
        $set: { provisionError: err.message.slice(0, 500) },
      });
      // TERMINAL errors — retrying on a different provider will NOT fix
      // these because they are either configuration bugs (missing ENV) or
      // things intrinsic to the requested product (unsupported Windows
      // version, invalid image mapping). Fail-fast to avoid destroying
      // multiple droplets in a row for the same reason.
      const TERMINAL_CODES = new Set([
        'WIN_VERSION_UNSUPPORTED',
        'WIN_ISO_URL_MISSING',
        'WIN_ISO_URL_INVALID',
        'PRECHECK_ISO_URL_REACHABLE',
        // ROUND-10 FIX (BUG #1): requested language not present in the
        // archive.org collection — same on every provider, retrying a
        // different VPS provider cannot fix this.
        'WIN_ISO_LANGUAGE_NOT_FOUND',
        // ROUND-10 FIX (BUG #2): checksum mismatch means the resolved ISO
        // itself is bad (corrupted/truncated/swapped) — same source URL on
        // every provider, so retrying elsewhere would just repeat it.
        'PRECHECK_ISO_CHECKSUM',
        // Phase timeouts are already bounded and diagnosed. Retrying the
        // same paid order on multiple providers would multiply a 20-minute
        // wait and usually hit the same source/install problem again.
        'RDP_REINSTALL_DISPATCH_TIMEOUT',
        'RDP_REBOOT_TIMEOUT',
        'RDP_INSTALL_TIMEOUT',
        'PWD_POLICY',
        // Spec / size errors — no point retrying on another provider, same
        // order data will fail identically. Surface to user immediately.
        'ORDER_SPEC_INCOMPLETE',
        'DO_SIZE_UNAVAILABLE',
        'DO_SIZE_REGION_UNAVAILABLE',
        'DO_SIZE_VERIFY_FAILED',
      ]);
      if (TERMINAL_CODES.has(err.code)) {
        debug.error('ERROR', 'Terminal error — tidak retry provider lain', { code: err.code });
        throw err;
      }
      progress.setSubStatus(`Provider gagal (${err.message.slice(0, 80)}), fallback ke provider lain...`);
      // continue to next attempt
    }
  }
  throw new Error(lastError ? lastError.message : 'Semua provider gagal');
}

async function provisionRdpOrder(bot, order) {
  return rdpProvisionQueue.push(async () => {
    const fresh = await Order.findById(order._id);
    if (!fresh) return;
    // Duplicate-provision guard: if this order already has a non-terminal
    // rdpState AND provisioning is actively in-flight (rdpStateAt within the
    // last 5 minutes), a second orchestrator would race the first one and
    // could edit the same Telegram bubble concurrently. Skip.
    const TERMINAL = new Set(['', 'COMPLETED', 'FAILED']);
    const activeCutoff = Date.now() - 5 * 60 * 1000;
    if (fresh.rdpState && !TERMINAL.has(fresh.rdpState)
        && fresh.rdpStateAt && new Date(fresh.rdpStateAt).getTime() > activeCutoff) {
      console.warn('[rdp-orch] duplicate provision suppressed for', String(fresh._id),
        'state=', fresh.rdpState, 'at=', fresh.rdpStateAt);
      return;
    }
    Object.assign(order, fresh.toObject());

    const progress = createRdpProgress(bot, order);
    const debug = createRdpDebugLogger(order);
    const stages = createStageTracker(order, debug);
    debug.info('INFO', 'Auto Create RDP pipeline started', {
      invoice: order.invoice, productName: order.productName, osVersion: order.osVersion || '(default)',
      userId: order.userId, region: order.region || '',
    });
    // Preface the debug log with the 8-stage audit chart so any log reader
    // immediately sees which stages exist and how each is proven.
    debug.info('STAGE_AUDIT_CHART', 'RDP execution-flow stages (ROUND-14)',
      { stages: stages.STAGES.map(s => ({
        n: s.n, label: s.label, runner: s.runner,
        evidenceKind: s.evidenceKind, evidenceHow: s.evidenceHow,
      })) });
    await progress.setState('QUEUED');

    // ═════════════════════════════════════════════════════════════════
    // PREFLIGHT — fail-fast SEBELUM droplet dibuat.
    //
    // ROUND-4 fix: gate on `windowsInstaller.resolveWindowsTarget(osVersion)`.
    // This single call validates BOTH:
    //   1. Windows version di kenali (ada di WINDOWS_MATRIX).
    //   2. Direct ISO URL untuk versi tsb sudah di-set di ENV
    //      (WIN_ISO_SERVER_2022 / WIN_ISO_WIN_11 / dst.).
    // Kalau salah satu gagal → order gagal SEKARANG dengan pesan spesifik,
    // TIDAK ada droplet yang dibuat, TIDAK ada biaya provider terbuang.
    // ═════════════════════════════════════════════════════════════════
    let preflightTarget;
    try {
      preflightTarget = await winInstaller.resolveWindowsTarget(order.osVersion);
      debug.info('PREFLIGHT', 'Windows target validated at pipeline start',
        winInstaller.summarizeTarget(preflightTarget));
    } catch (e) {
      const reason = e.message;
      debug.error('PREFLIGHT', 'Windows target tidak valid — STOP', {
        code: e.code, osVersion: order.osVersion, reason,
      });
      try {
        await Order.findByIdAndUpdate(order._id, {
          $set: {
            status: 'failed',
            provisionStatus: 'failed',
            provisionError: reason.slice(0, 500),
            rdpState: 'FAILED',
            rdpStateAt: new Date(),
          },
        });
        await audit.log('rdp.preflight_failed', { refId: order._id, message: reason });
        await progress.finalize(buildFailCard(order, reason));
        debug.finalize('FAILED', reason);
      } catch (_) {}
      progress.dispose();
      return;
    }

    try {
      await runOnce(bot, order, progress, debug, stages);
      // Always emit the audit summary on success too — proof for admin.
      stages.dumpSummary('SUCCESS');
      debug.finalize('SUCCESS');
    } catch (e) {
      // ROUND-11: readiness-timeout already finalized the bubble with the
      // dedicated "masih konfigurasi" card. Skip the generic fail card and
      // refund path entirely — VPS masih hidup & mungkin siap 2-5 menit lagi.
      if (e && e.__readinessTimeout) {
        progress.dispose();
        return;
      }
      // For every other final failure — dump the stage audit so admin can
      // see the exact stage the pipeline stopped at.
      stages.dumpSummary('FAILED');
      log('final fail', e.message);
      debug.error('ERROR', 'Pipeline exhausted all providers', { error: e.message });
      await Order.findByIdAndUpdate(order._id, {
        $set: {
          status: 'failed',
          provisionStatus: 'failed',
          provisionError: e.message.slice(0, 500),
          rdpState: 'FAILED',
          rdpStateAt: new Date(),
        },
      });
      await audit.log('rdp.exhausted', { refId: order._id, message: e.message });

      // Refund (auto gateway only)
      let refundNote = '';
      try {
        const cur = await Order.findById(order._id);
        if (cur && cur.paymentGateway && cur.paidAt) {
          const gw = cur.paymentGateway;
          const mod = gw === 'autogopay' ? require('../../payments/autogopay')
                    : gw === 'binancepay' ? require('../../payments/binancepay') : null;
          if (mod && mod.refundInvoice) {
            const r = await mod.refundInvoice({
              orderId: String(cur._id),
              gatewayRef: cur.paymentGatewayRef,
              amountIdr: cur.total,
            });
            refundNote = r.ok
              ? '\n\n💸 Refund otomatis diproses.'
              : `\n\n⚠️ Refund otomatis gagal (${(r.error || '').toString().slice(0, 80)}).`;
            await Order.findByIdAndUpdate(cur._id, {
              $set: {
                status: r.ok ? 'cancelled' : 'processing',
                rejectReason: r.ok ? 'auto-refunded (rdp provisioning failed)' : 'refund failed',
              },
            });
          } else {
            refundNote = '\n\n_Pembayaran manual — silakan hubungi admin untuk refund._';
          }
        }
      } catch (rerr) {
        refundNote = '\n\n⚠️ Refund error: ' + rerr.message.slice(0, 100);
      }

      await progress.finalize(buildFailCard(order, e.message + refundNote));
      debug.finalize('FAILED', e.message);

      // Admin notify
      try {
        require('../../services/adminNotifyService').notifyActivity(
          { telegramId: order.userId, username: order.username, firstName: order.userName || '' },
          'Auto Create RDP GAGAL',
          { '🧾 Invoice:': `\`${order.invoice}\``, '⚠️ Error:': e.message.slice(0, 120) },
        );
      } catch (_) {}
    } finally {
      progress.dispose();
    }
  });
}

module.exports = { provisionRdpOrder };
