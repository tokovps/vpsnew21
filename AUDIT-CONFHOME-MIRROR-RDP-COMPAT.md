# AUDIT — Confhome Mirror & `windows-fix-rdp-compat.bat`

> Status Round 16: mirror sekarang aktif otomatis saat `WEBHOOK_URL` tersedia.
> Dokumen ini juga telah diperbarui untuk mencerminkan hardening validator,
> Cloud Firewall DigitalOcean, dan script first-boot terbaru.

## Permintaan

1. Gunakan mekanisme resmi `modify_windows()` milik upstream (bin456789/reinstall).
2. Tidak fork penuh repository, tidak juga host fork statis yang harus di-update manual.
3. Tambahkan `windows-fix-rdp-compat.bat` dengan mekanisme yang sama seperti
   `windows-allow-ping.bat` dan `windows-change-rdp-port.bat`.
4. Jangan mengubah control-flow upstream `reinstall.sh` atau Windows ISO pipeline.
5. Kalau perlu, buat mirror/proxy kecil yang selalu mengambil `trans.sh` terbaru lalu
   menerapkan patch minimal otomatis — bukan fork statis.
6. Idempotent. Audit registry sebelum menulis.

## Apa itu `modify_windows()`

`modify_windows()` adalah fungsi di **`trans.sh`** (bukan `reinstall.sh`) milik upstream
`bin456789/reinstall`. `trans.sh` berjalan di **Alpine Linux live environment** setelah VPS
reboot dari `reinstall.sh` — bukan di sesi SSH awal. Di dalam `modify_windows()`, upstream
mem-build daftar `.bat` (`bats="$bats ..."`) yang nanti dijalankan sekali di boot pertama
Windows lewat `SetupComplete.cmd` (jika `ImageState=IMAGE_STATE_COMPLETE`) atau lewat GPO
startup script (jika belum). `windows-allow-ping.bat` dan `windows-change-rdp-port.bat` sudah
memakai mekanisme persis ini di upstream:

```sh
# 2. 允许 ping
if is_allow_ping; then
    download $confhome/windows-allow-ping.bat $os_dir/windows-allow-ping.bat
    bats="$bats windows-allow-ping.bat"
fi
```

`windows-fix-rdp-compat.bat` yang kita tambahkan memakai pola identik.

## Kenapa bukan fork

Fork statis (baik penuh maupun cuma `trans.sh`) berarti setiap kali upstream memperbaiki bug,
menambah driver, atau mengubah `SCRIPT_VERSION` (dipakai upstream untuk cek kompatibilitas
`reinstall.sh` ↔ `trans.sh`), fork itu **basi** sampai ada yang manual sync ulang. Upstream
sendiri mendokumentasikan titik ekstensi resminya di README: *"Fork this repository. Modify
the confhome and confhome_cn at the beginning of reinstall.sh and reinstall.bat."* — intinya
hanya baris `confhome=` yang dimaksudkan untuk diubah; ini yang kita tiru, tapi secara dinamis.

## Yang diimplementasikan

Komponen mirror yang diimplementasikan:

```
src/provision/rdp/confhomeMirror/
├── index.js              — router Express: fetch upstream + cache singkat + patch + serve
├── transShPatch.js        — patch modify_windows() di trans.sh (idempotent, fail-open)
├── reinstallShPatch.js     — rewrite baris confhome=/confhome_cn= di reinstall.sh
└── assets/
    └── windows-fix-rdp-compat.bat   — script baru, milik kita, bukan proxy
```

Router didaftarkan di `src/app.js`. Round 16 juga menghubungkan mirror sebagai default
installer ketika `WEBHOOK_URL`/`CONFHOME_MIRROR_PUBLIC_URL` tersedia.

### Alur request

1. `rdpConfig.js` memilih `REINSTALL_SCRIPT_URL` eksplisit jika tersedia. Jika tidak,
   URL otomatis dibentuk dari `CONFHOME_MIRROR_PUBLIC_URL` atau `WEBHOOK_URL` ditambah
   `/reinstall-mirror/reinstall.sh`.
2. `rdpOrchestrator` men-download `reinstall.sh` dari URL itu seperti biasa, lalu
   menjalankannya di VPS.
3. Mirror kita fetch `reinstall.sh` **upstream asli** live, replace HANYA baris
   `confhome=`/`confhome_cn=` supaya mengarah balik ke mirror kita, lalu serve. Baris lain
   (termasuk `SCRIPT_VERSION`) 100% tidak disentuh.
4. Karena `confhome` sekarang menunjuk ke mirror kita, saat `reinstall.sh` (di titik yang SAMA
   PERSIS seperti upstream, tidak dimodifikasi) mem-boot ke Alpine dan menjalankan
   `$confhome/trans.sh`, request itu otomatis lewat mirror kita juga.
5. Mirror fetch `trans.sh` **upstream asli** live, sisipkan satu blok kecil setelah blok
   `windows-allow-ping.bat` di dalam `modify_windows()`, lalu serve.
6. Saat `trans.sh` men-download `$confhome/windows-fix-rdp-compat.bat`, mirror serve file
   statis milik kita sendiri (bukan proxy — karena ini file baru, bukan modifikasi upstream).
7. Semua file lain (`fix-eth-name.sh`, `logviewer.html`, `windows-resize.bat`, dst) — proxy
   pass-through 1:1 ke upstream, tanpa modifikasi apapun.

### Kenapa aman untuk instalasi yang sudah berjalan

`transShPatch.applyRdpCompatPatch()` mencari blok anchor (`is_allow_ping` +
`windows-allow-ping.bat`) dengan regex yang whitespace-tolerant tapi mengunci pada nama
fungsi/file yang stabil. **Jika upstream suatu saat merestrukturisasi `modify_windows()`
sampai anchor itu tidak ketemu, patch TIDAK diterapkan** — mirror tetap men-serve `trans.sh`
upstream yang asli, tanpa error, tanpa melempar exception. Efeknya cuma: fitur RDP-compat
untuk sementara tidak aktif sampai patch di-update, TAPI instalasi Windows customer tetap
jalan normal seperti sebelum perubahan ini ada. Status ini bisa dicek lewat
`GET <mount>/_status` (field `lastTransShPatch.applied` dan `.reason`).

Test `tests/confhome-mirror-rdp-compat.test.js` poin #3 memverifikasi persis skenario ini.

### Idempotency

- **Level patch teks**: `transShPatch` mengecek marker `PATCH-MARKER:windows-fix-rdp-compat-v1`
  sebelum menyisipkan — walau secara normal setiap request selalu mulai dari fetch upstream
  yang masih pristine (jadi sisipan ganda praktis tidak mungkin terjadi), pengecekan ini tetap
  ada sebagai pertahanan berlapis. `reinstallShPatch.rewriteConfhome()` memakai `String.replace`
  berbasis regex `^confhome=.*$` — hasil selalu sama untuk input yang sama (idempotent by
  construction), diverifikasi test #4.
- **Level registry di dalam Windows**: `windows-fix-rdp-compat.bat` men-`reg query` dulu setiap
  value sebelum memutuskan perlu `reg add` atau tidak (lihat bagian di bawah). Aman dipanggil
  berkali-kali — baik lewat `SetupComplete.cmd` yang mungkin ke-invoke ulang antar reboot, maupun
  kalau operator sengaja menjalankan ulang script-nya secara manual.

### Isi `windows-fix-rdp-compat.bat` dan alasan teknis

Dua masalah kompatibilitas RDP paling umum dilaporkan setelah instalasi via
bin456789/reinstall:

1. **`AllowEncryptionOracle`** (`HKLM\SOFTWARE\Policies\Microsoft\Windows\CredSSP\Parameters`) —
   default Windows modern adalah `0` (Force Updated Clients), sesuai kebijakan pasca
   CVE-2018-0886. Client RDP lama/belum terpatch akan gagal konek dengan pesan
   *"An authentication error has occurred... CredSSP encryption oracle remediation"*.
   Kita set ke `1` (Mitigated) — tetap menolak client yang benar-benar vulnerable (level `2`),
   hanya berhenti **mewajibkan** bukti patch dari client.
2. **`SecurityLayer`** pada `HKLM\SYSTEM\CurrentControlSet\Control\Terminal
   Server\WinStations\RDP-Tcp` — kalau dipaksa `2` (SSL/TLS only), client tanpa stack TLS modern
   gagal negosiasi sama sekali. Kita set ke `1` (Negotiate) — server tetap upgrade ke TLS kalau
   client mendukung, tapi tidak menolak yang tidak mendukung.
3. **`fDenyTSConnections`** (`HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server`) — audit
   defensif saja; hanya diubah ke `0` kalau ternyata RDP ter-disable di image tertentu.
4. **`fLogonDisabled`** pada listener `RDP-Tcp` — diubah ke `0` hanya jika listener menolak
   logon baru.
5. Script membaca `PortNumber` aktual, membuat inbound TCP/UDP dengan `profile=any`, lalu
   mengatur `TermService` ke automatic dan memastikan servicenya berjalan.

Yang **sengaja tidak diubah**: `UserAuthentication` (NLA) dan `MinEncryptionLevel` — dua ini
tidak disentuh karena melemahkannya adalah trade-off keamanan yang lebih besar daripada dua
fix di atas, dan bukan itu yang diminta ("compat", bukan "matikan semua proteksi").

Setiap value diaudit lebih dulu:

```bat
for /f "tokens=3" %%A in ('reg query "%KEY%" /v %VAL% 2^>nul ^| findstr /i /r /c:"%VAL%"') do set "CUR=%%A"
if /i not "%CUR%"=="0x%WANT%" (
    reg add "%KEY%" /v %VAL% /t REG_DWORD /d %WANT% /f
) else (
    rem sudah sesuai — dilewati, tidak ada write
)
```

Log audit ditulis ke `%SystemDrive%\windows-fix-rdp-compat.log` (pola sama seperti
`reinstall.log`), sehingga setiap keputusan "diubah" vs "dilewati karena sudah OK" tercatat.

## Batas perubahan installer upstream

| Item | Status |
|---|---|
| `reinstall.sh` (isinya) | Tidak diubah — hanya baris `confhome=`/`confhome_cn=` di-rewrite saat serve, dan itu pun titik ekstensi resmi upstream |
| `rdpOrchestrator.js` | Control-flow install tetap; Round 16 menambahkan audit firewall dan validasi TLS dua tahap sebelum success |
| Windows ISO pipeline (`windowsInstaller.js`) | Tidak disentuh sama sekali |
| Provider Adapter (`src/providers/*`) | DigitalOcean ditambah audit Cloud Firewall read-only sebelum reinstall |
| `rdpConfig.js` (`buildReinstallCommand`, dst) | Command builder tetap; pemilihan URL mirror sekarang otomatis dari public origin |

## Cara mengaktifkan

Pada deployment Render normal, cukup isi public origin yang memang sudah dipakai webhook:

```
WEBHOOK_URL=https://bot-anda.example.com
```

Override opsional: `CONFHOME_MIRROR_PUBLIC_URL`, `CONFHOME_MIRROR_PATH`, dan
`REINSTALL_SCRIPT_URL`. Tanpa public origin, sistem fallback ke installer upstream dan
readiness gate tetap menolak success sampai endpoint RDP modern + TLS benar-benar stabil.

## Cara verifikasi

```
GET /reinstall-mirror/_status
```

mengembalikan status patch terakhir yang di-apply (`lastTransShPatch`, `lastReinstallShPatch`),
termasuk alasan kalau gagal — tanpa perlu SSH ke VPS customer manapun.
