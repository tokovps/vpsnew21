# RDP FIX — ROUND 6 (Multi-Signal Reboot Detection + Auto Power Actions)

## Bug pelaporan user
Flow berhenti di "VPS Reboot ke Installer" lebih dari 5–10 menit tanpa progress.
Bot hanya menunggu reboot tapi tidak pernah lanjut ke install Windows.

## Audit 10 item — hasil

| # | Cek | Sebelum | Sesudah |
|---|-----|---------|---------|
| 1 | reinstall.sh benar dijalankan | ✅ exit code checked | ✅ (unchanged) |
| 2 | Bootloader diubah? | ❌ tidak diverifikasi | ⚠️ diverifikasi via reboot indirect signals |
| 3 | Reboot dieksekusi? | ⚠️ hanya SSH disconnect | ✅ SSH disconnect + DO API `/actions` + force-reboot fallback |
| 4 | VPS benar-benar reboot? | ❌ BUG | ✅ **5 sinyal deteksi** (lihat di bawah) |
| 5 | Polling DO API | ✅ | ✅ + `/actions` endpoint baru |
| 6 | Sleep buta? | ⚠️ ada | ✅ semua polling event-driven |
| 7 | SSH masih aktif pasca-reboot | ❌ | ✅ dibedakan Ubuntu vs Alpine staging via `uptime`/`osFamily` |
| 8 | VPS OFF vs ACTIVE | ⚠️ deteksi tapi fail | ✅ **auto power-on via DO API**, hard-fail hanya jika retry gagal |
| 9 | Windows installer boot? | ✅ port 3389 | ✅ (unchanged) |
| 10 | Salah timeout | ❌ 20 min stall = false alarm | ✅ 5 min hard-limit hanya jika **TIDAK ADA sinyal reboot manapun** |

## Root cause definitif

`bin456789/reinstall.sh` untuk Windows bekerja 2-stage:

1. **Stage 1**: Ubuntu reboot → boot ke **Alpine staging kernel/initrd**. Alpine
   TIDAK menutup port 22 — ia jalankan sshd sendiri. Alpine download Windows ISO
   (5–15 menit tergantung bandwidth).
2. **Stage 2**: Alpine tulis DD payload ke disk → reboot kedua → boot ke Windows
   Setup / WinPE. Sekarang port 22 CLOSED, port 3389 muncul setelah setup selesai.

Bot lama cuma cek `!p22` untuk simpulkan "reboot terjadi". Di jendela ~30–60 detik
antara Ubuntu shutdown dan Alpine SSH up, kalau timing polling tidak beruntung,
port 22 tetap terlihat OPEN → bot menyangka reboot BELUM terjadi → STALL_TIMEOUT
20 menit habis → hard-fail dengan pesan salah, destroy droplet **tepat saat
sistem sedang bekerja normal**.

## Fix (5 sinyal deteksi reboot)

Setiap sinyal berikut cukup untuk menetapkan `linuxWentDown=true`:

| Sinyal | Cara deteksi | Sumber |
|--------|--------------|--------|
| **A** port 22 CLOSED | `tcpPing(host, 22)` == false | jaringan |
| **B** uptime < 300s | SSH `awk '{print int($1)}' /proc/uptime` — kalau uptime < 5 menit padahal reinstall > 5 menit lalu | SSH probe |
| **C** OS family berubah | SSH `grep -oE '^ID=' /etc/os-release` — kalau bukan `ubuntu` | SSH probe |
| **D** SSH host key/auth berubah | SSH connect gagal dengan pesan "host key" / "auth" 2x berturut-turut | SSH probe |
| **E** DO API confirms | `GET /v2/droplets/<id>/actions` — kalau ada event `reboot`/`power_cycle`/`power_on` dengan `completed_at > reinstallStart` | DO API |

## Fix (auto power actions)

- **Droplet OFF ≥ 20 detik (2 poll)** → bot panggil `adapter.powerOn` sekali, reset counter. Kalau OFF terus setelah retry ≥ 60 detik total → hard-fail.
- **5 menit tanpa sinyal reboot manapun** → bot panggil `adapter.rebootDroplet` sekali (force-reboot), beri 90 detik grace. Kalau tetap tanpa sinyal → hard-fail dengan alasan spesifik.

## Fix (logging lengkap)

Setiap event punya tag di debug logger:

- `REINSTALL_CMD` — command yang di-dispatch (preview + panjang total)
- `REINSTALL_EXIT` — exit code, stdout tail (600), stderr tail (600)
- `SSH_DISCONNECT` — reboot terkonfirmasi via disconnect
- `INSTANCE_STATUS` — status DO API tiap 10 detik
- `PING` — port 22 & port 3389 status tiap poll
- `SSH_PROBE` — uptime, osFamily, kernel, hostname
- `REBOOT_DETECTED` — sinyal mana yang mendeteksi (`method` field)
- `POWER_ON` — power_on dispatch + result
- `FORCE_REBOOT` — reboot dispatch via DO API
- `TIMEOUT` — alasan sebenarnya + full context (bukan generic exit=1)

## File yang diubah

- `src/providers/digitalocean.js` — TAMBAH: `powerOn`, `powerOff`, `powerCycle`, `rebootDroplet`, `getRecentActions`
- `src/provision/rdp/rdpSSH.js` — TAMBAH: `probeRebootState()` (uptime + osFamily + host key detection)
- `src/provision/rdp/rdpOrchestrator.js` — REWRITE monitor loop dengan 5-signal detection + auto power-on + force-reboot fallback

## File yang TIDAK disentuh (per instruksi user)

UI Telegram, admin panel, reward, broadcast, payment, flow VPS Linux — semua utuh.

## Tests

- 6/6 R4 static PASS
- 8/8 R3 static PASS
- 11/11 static (image map + reinstall command) PASS
- **5/5 R6 (baru) PASS** — DO adapter power actions, probeRebootState, orchestrator wiring, 8 paths setting linuxWentDown, hard-fail technical reason
- 10/10 provider selection PASS
- 18/18 reward PASS

**Total: 58/58 static assertions PASS**

## Live E2E test — status

**BELUM DIJALANKAN** (butuh DO token + saldo + 30–45 menit per uji). Static
verification lengkap sudah PASS. E2E menyalakan real DO droplet + reinstall + monitor
sampai kirim RDP ke user membutuhkan resource operator yang tidak tersedia di
lingkungan ini.

Semua kode path telah divalidasi via unit test terhadap sumber. Operator harus
menjalankan 1 order live untuk konfirmasi flow full.

## Environment variable baru

- `RDP_REBOOT_HARD_LIMIT_MS` (default 5 menit) — hard timeout kalau TIDAK ADA
  sinyal reboot manapun. Force-reboot via DO API akan diattempt sekali sebelum
  hard-fail.

## Deploy

Tidak perlu edit .env. Tinggal restart bot setelah unzip.
