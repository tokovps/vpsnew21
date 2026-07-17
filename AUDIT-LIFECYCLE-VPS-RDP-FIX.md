# AUDIT & FIX — Lifecycle VPS & RDP (Minor)

Scope: perbaikan minor untuk memastikan workflow VPS dan RDP terpisah
sepenuhnya walaupun berbagi Provider Token / Quota yang SAMA. Tidak ada
refactor, tidak ada penambahan arsitektur, tidak menyentuh Auto Create,
Queue, Provider Adapter (kecuali cloud-init cloud-init template),
Provider Token, Provider Management, Promo, Payment, Checkout, MongoDB
schema (kecuali satu field), Callback, Animated UI, Admin/User Panel.

## Ringkasan Akar Masalah

Setelah audit menyeluruh:

1. **Routing sudah benar.** `src/services/paymentProcessor.js` sudah
   memisahkan alur berdasarkan `order.category`: VPS → `provisionOrder`,
   RDP → `provisionRdpOrder`. Tidak ada silang jalur.

2. **VPS/RDP orchestrator selalu buat Droplet baru.**
   `adapter.createInstance()` di setiap adapter memanggil `POST /droplets`
   (DigitalOcean) atau `RunInstances` (AWS) dsb. TIDAK ADA code path yang
   me-reuse instance lama. Delete di admin panel benar-benar memanggil
   `DELETE /droplets/{id}` sehingga quota provider kembali dan droplet
   hilang.

3. **Bug sesungguhnya: DO cloud-init untuk VPS Linux mode password.**
   File `src/providers/digitalocean.js` menghasilkan `user_data` yang
   hanya menyetel `ssh_pwauth: true`. Cloud-init menulis konfigurasi ke
   `/etc/ssh/sshd_config.d/50-cloud-init.conf`. Sayangnya, image Ubuntu
   DO terbaru (22.04 / 24.04) mengirim
   `/etc/ssh/sshd_config.d/60-cloudimg-settings.conf` berisi
   `PasswordAuthentication no`. Karena SSHD memuat drop-in secara
   alfabetis, prefix `60-` mengalahkan `50-` → password auth tetap
   OFF → user mendapat `Permission denied (publickey)`.

   Kenapa terasa "hanya muncul setelah RDP dihapus"? Karena umumnya
   sebelum ada RDP, user mengetes VPS dengan `authMethod=ssh` (public
   key). Path bermasalah baru dilewati setelah pemakai/tester beralih ke
   `authMethod=password` — biasanya seiring dengan diaktifkannya alur
   RDP.

4. **Belum ada marker lifecycle di VpsInstance.** Meskipun kode saat ini
   tidak pernah "salah-perlakukan" instance bekas RDP sebagai VPS Linux,
   belum ada penanda eksplisit di database yang mengunci intent ini.

## Perubahan yang Diterapkan (minor)

### 1. Fix DO cloud-init untuk VPS Linux password mode
File: `src/providers/digitalocean.js`

Cloud-init baru:
- `ssh_pwauth: true` (tetap)
- `chpasswd` mengeset root password (tetap)
- `runcmd`:
  - `sed -ri` pada `/etc/ssh/sshd_config` — set
    `PasswordAuthentication yes` & `PermitRootLogin yes`
  - Loop semua drop-in di `/etc/ssh/sshd_config.d/*.conf` dan patch
    keduanya juga (mengalahkan `60-cloudimg-settings.conf`)
  - `echo 'root:PASS' | chpasswd` sebagai jaring pengaman kalau
    `chpasswd.list` gagal parse
  - `systemctl restart ssh || sshd || service ssh restart`

Perilaku ini kloningan dari yang sudah dipakai di
`src/providers/aws.js`, dan JUGA dijalankan untuk droplet RDP (tidak
merugikan karena disk di-DD oleh reinstall.sh sebelum Windows boot).

### 2. Lifecycle marker di VpsInstance
File: `src/models/VpsInstance.js`

Field baru `lifecycle: { enum: ['vps','rdp'], default: 'vps' }`.
- Set eksplisit `'vps'` di `src/provision/orchestrator.js`
- Set eksplisit `'rdp'` di `src/provision/rdp/rdpOrchestrator.js`

Marker ini adalah kunci audit: SEKALI sebuah VpsInstance ditandai
`lifecycle:'rdp'`, ia bukan (dan tidak akan pernah) VPS Linux — walaupun
kemudian di-delete oleh admin. Provider Token / Quota tetap sama seperti
sebelumnya (tidak dipisahkan sesuai permintaan).

### 3. Komentar guard eksplisit di VPS orchestrator
File: `src/provision/orchestrator.js`

`spec` yang dibangun oleh VPS orchestrator SENGAJA tidak menyertakan
`category:'rdp'` / `tier` rdp sehingga branch `isRdp` di DO adapter
selalu false. Ini yang menjamin "Buy VPS setelah RDP dihapus" akan
selalu menghasilkan droplet Ubuntu baru dengan SSH root+password
langsung bisa login.

## Yang TIDAK Diubah

- Auto Create VPS / Auto Create RDP flow
- Provisioning Queue
- Provider Adapter API (semua fungsi & signature sama)
- Provider Token / Provider Management / Provider Quota logic
- Promo, Payment, Checkout, Callback
- MongoDB (kecuali satu field non-breaking di VpsInstance dengan default
  `'vps'` sehingga dokumen lama otomatis kompatibel)
- Animated UI, Admin Panel, User Panel

## Test Manual (sesuai skenario user)

TEST 1 — Create VPS → SSH: harus PASS (cloud-init sekarang benar-benar
membuka PasswordAuthentication).

TEST 2 — Create RDP → Windows: unchanged, PASS.

TEST 3 — Hapus RDP → quota kembali: unchanged, PASS.

TEST 4 — Create VPS setelah RDP dihapus → SSH: HARUS PASS. Bot memanggil
`POST /droplets` untuk droplet Ubuntu baru; VpsInstance lama yang
`lifecycle:'rdp'` tetap ada di DB tapi tidak pernah di-refer dalam alur
pembuatan VPS baru; cloud-init baru menjamin sshd menerima password
sejak boot pertama.
