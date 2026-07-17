# Auto Create RDP — Panduan Operasional

Dokumen ini menjelaskan sistem **Auto Create RDP** yang menggantikan flow manual admin-delivery lama. Payment RDP tetap otomatis, dan **delivery kini juga full otomatis** melalui pipeline reinstall Linux → Windows.

---

## 1. Arsitektur

```
Payment Success (webhook / cek status)
        │
        ▼
paymentProcessor.processPaidOrder()
        │
        ├─ category === 'vps' → provision/orchestrator.js       (unchanged)
        └─ category === 'rdp' → provision/rdp/rdpOrchestrator.js  ← BARU
```

RDP Orchestrator menggunakan **infrastruktur yang SAMA** dengan Auto VPS:
Provider Pool, Smart Selection, Lock, Health Check, Retry, Quota, Queue,
Error Handler, Refund. Tidak ada sistem provisioning terpisah.

## 2. File yang Ditambahkan / Dimodifikasi

| File | Peran |
|------|-------|
| `src/provision/rdp/rdpOrchestrator.js` | Full-flow orchestrator (queue → provider → SSH → reinstall → validate → deliver) |
| `src/provision/rdp/rdpProgress.js` | Single-message UI dengan progress bar, ETA dinamis, spinner animasi |
| `src/provision/rdp/rdpSSH.js` | `node-ssh` wrapper: `waitForSSH()`, `runReinstall()` (SSH disconnect = normal) |
| `src/provision/rdp/rdpValidator.js` | TCP probe + **X.224 RDP handshake** validasi service RDP benar-benar hidup |
| `src/provision/rdp/rdpConfig.js` | Timeouts, image map Windows, command builder — semua env-configurable |
| `src/utils/passwordGen.js` | Password Administrator random (18 char, Windows-policy safe) |
| `src/services/paymentProcessor.js` | RDP paid → route ke `rdpOrchestrator` (bukan `pending_admin`) |
| `src/models/Order.js` | Tambah status `failed` |
| `package.json` | Dependency `node-ssh@^13` |

## 3. Flow End-to-End

1. **Payment Success** → status = `rdp_processing`, `autoProvision=true`
2. **Queue** → gunakan `provisionQueue` shared dengan VPS (concurrency=2)
3. **Smart Provider Selection** → `providerService.findReadyApis()` sorted by score/quota
4. **Lock** → `providerService.tryLockApi()` (atomic READY → LOCKED)
5. **Create VPS Linux** → `adapter.createInstance()` dengan `osFamily=Ubuntu 22.04` + password random (juga akan dipakai untuk Administrator Windows)
6. **Open Port 22 + Wait SSH** → poll TCP:22 + coba auth
7. **SSH Login** → jalankan skrip reinstall via `bash <(curl ...)`
8. **Reinstall** → `bin456789/reinstall.sh windows --image-name "..." --password "..."`
9. **SSH Disconnect** → **normal**, orchestrator tidak menganggap error
10. **Monitor** → poll port 22 (harus CLOSED = Linux mati) + port 3389 (harus OPEN = Windows hidup)
11. **Validasi Ketat**:
    - Port 22 closed
    - Port 3389 open
    - X.224 RDP handshake sukses (bukti service RDP benar-benar berjalan, bukan port random)
12. **Kirim detail login** → single message edit → order `success`

**Kegagalan sebelum validasi:** cleanup droplet, release lock, mark error,
fallback ke provider berikutnya (sampai `MAX_PROVIDER_ATTEMPTS`).

**Kegagalan setelah semua provider exhausted:** order `failed`, auto-refund
(kalau gateway otomatis), notifikasi ke user & admin. **Detail login tidak
pernah dikirim jika validasi belum lengkap.**

## 4. Konfigurasi via ENV

Semua nilai berikut opsional (default sudah aman untuk produksi):

```bash
# Script reinstall — ganti jika ingin fork lain (tanpa ubah source code)
REINSTALL_SCRIPT_URL=https://raw.githubusercontent.com/bin456789/reinstall/main/reinstall.sh

# Timings (ms)
RDP_SSH_READY_TIMEOUT_MS=600000        # 10 menit menunggu cloud-init + SSH auth
RDP_SSH_CONNECT_TIMEOUT_MS=30000
RDP_REINSTALL_MAX_TIMEOUT_MS=2700000   # 45 menit total reinstall
RDP_STALL_TIMEOUT_MS=900000            # 15 menit tanpa perubahan state = stall
RDP_PORT_POLL_INTERVAL_MS=15000
RDP_PROGRESS_TICK_MS=6000
RDP_PORT=3389
RDP_VALIDATE_ATTEMPTS=6
RDP_VALIDATE_INTERVAL_MS=10000
RDP_MAX_PROVIDER_ATTEMPTS=4
```

### Windows image mapping (per versi menu)

`src/provision/rdp/windowsInstaller.js` (`WINDOWS_MATRIX`) memetakan setiap label
di menu "PILIH WINDOWS VERSION" (admin-editable via `Setting.rdpWindowsVersions`)
ke image installer. Semua ENV di bawah opsional — default sudah auto-resolve
ISO dari archive.org:

```bash
WIN_ISO_SERVER_2025, WIN_ISO_SERVER_2022, WIN_ISO_SERVER_2019, WIN_ISO_SERVER_2012
WIN_ISO_WIN_11, WIN_ISO_WIN_10
WIN_ISO_TINY11, WIN_ISO_TINY10                    # dedicated NTDEV image (default sudah di-set)
WIN_ISO_WIN11_SUPERLITE, WIN_ISO_WIN11_AIO        # default: fallback ke Windows 11 Pro
WIN_ISO_WIN10_SUPERLITE, WIN_ISO_WIN10_AIO        # default: fallback ke Windows 10 Pro
```

`Windows 10/11 Superlite` dan `All In One` TIDAK punya default image khusus —
build pihak ketiga yang beredar (mis. "Ghost Spectre") berasal dari uploader
tunggal tanpa checksum/versi yang konsisten, jadi tidak di-hardcode demi
keamanan supply-chain. Kalau tim sudah punya mirror ISO yang dipercaya, isi
ENV terkait; sebelum itu order untuk versi ini tetap berhasil dengan fallback
ke Windows Pro (bukan error). Saat bot start, `validateWindowsVersionMapping()`
mengecek seluruh versi di menu dan mencetak `console.error` kalau ada yang
tanpa mapping sama sekali.

## 5. Pemilihan Script Reinstall

**`bin456789/reinstall`** dipilih karena:
- Aktif dipelihara (commit terbaru dalam < 30 hari).
- Fork modern dari MoeClub, mendukung Debian/Ubuntu/CentOS/AlmaLinux/Rocky.
- Support Windows Server 2012/2016/2019/2022 dan Windows 10/11.
- Menggunakan cloud-init untuk auto-set Administrator password + auto-enable RDP + auto-open firewall (`netsh advfirewall firewall set rule group=…`).
- Provider-agnostic (bekerja di DO, Vultr, Linode, Hetzner, Contabo, dst).
- Komunitas & dokumentasi terbesar dibanding fork lain.

Fleksibilitas: URL script dapat diganti via `REINSTALL_SCRIPT_URL` tanpa
menyentuh source.

## 6. Single-Message UI

Seluruh proses **satu bubble Telegram**. `rdpProgress.js` melakukan:
- `editMessageCaption` (kalau anchor adalah photo invoice) atau `editMessageText`.
- Debounce 1.5 detik + skip render kalau body identik (hindari error 400).
- Spinner ticker (setInterval 6 detik) supaya user melihat proses hidup meski
  fase berjalan lama (mis. Windows install 25+ menit).
- ETA dinamis: `elapsed / pct * 100 - elapsed`, clamp 1–45 menit.
- **Tidak pernah** `sendMessage` selama proses berjalan (kecuali anchor
  benar-benar hilang, sebagai re-anchor terakhir).

## 7. Validasi Sebelum Kirim Detail

`validateWindowsReady()` **wajib** lulus semua:
- `linuxDown` — port 22 tidak lagi menerima koneksi (bukti sshd/Linux mati).
- `portOpen` — port 3389 terbuka.
- `rdpService` — respons X.224 Connection Confirm valid (bukti Windows RDP service benar-benar melayani, bukan sekedar port terbuka).

Jika salah satu belum lulus setelah `RDP_VALIDATE_ATTEMPTS` percobaan, order
dinyatakan gagal (tidak ada detail login yang dikirim).

## 8. Logging & Debugging

Semua log ke `console`, prefiks:
- `[rdp-orch]` — orchestrator lifecycle
- `[rdp-progress]` — UI edit failures
- `[rdp-ssh]` — SSH lifecycle
- `[processPaidOrder]` — routing awal

`auditService` events yang ditulis: `rdp.success`, `rdp.attempt_fail`, `rdp.exhausted`,
plus event provider standar (`api.lock`, `api.unlock`, `api.used`, `api.error`,
`api.suspended`).

## 9. Testing di Environment Anda

Karena real-provider testing perlu API token & billing nyata (di luar sandbox),
lakukan langkah berikut di server Anda:

1. Deploy build ini → restart bot.
2. Isi minimal 1 Provider API (DO/Vultr/Linode) via `/admin` → Providers.
3. Buat order RDP test (paket termurah) → bayar via QRIS.
4. Amati bubble progress: harus **satu pesan**, progress bar bergerak, ETA
   berkurang seiring waktu, checklist berubah ⬜ → ✅.
5. Verifikasi detail login **HANYA muncul** setelah semua validation ✅.
6. Coba login RDP dari klien Windows/Mac dengan Host = `IP:3389`.

Bila ada error, ambil log dari server (`journalctl -u <bot>` atau
`pm2 logs`) dan kirim ke tim untuk perbaikan iteratif.

## 10. Rollback Cepat

Kalau ingin sementara kembali ke flow manual admin, komentari import
`provisionRdpOrder` di `paymentProcessor.js` dan restore branch lama dari git.
Kode legacy admin (`rdpOrdersHandler.js`) masih ada dan tetap berfungsi untuk
order lama yang sudah di status `pending_admin`.
