# Revisi RDP Round 16 — Anti False-Success

## Akar masalah yang ditemukan

Validator lama hanya memeriksa byte `0xD0` pada balasan X.224. Balasan
`RDP_NEG_FAILURE` juga memakai X.224 Connection Confirm yang sama, sehingga server
yang menolak mode keamanan klien tetap dianggap berhasil. Test lama bahkan hanya
mengirim enam byte awal paket yang terpotong.

Selain itu:

- status `LOGIN_TESTING` hanya nama UI; tidak pernah ada autentikasi kredensial penuh;
- compatibility mirror tidak aktif secara default pada deployment Render;
- DigitalOcean Cloud Firewall tidak diaudit;
- success dapat dilepas setelah satu jendela stabilitas singkat;
- script first-boot belum memaksa listener, firewall port aktual, dan `TermService`
  kembali aktif setelah OOBE/policy refresh.

## Perbaikan

1. Validator mem-parsing TPKT + X.224 + struktur negosiasi secara lengkap.
2. `RDP_NEG_FAILURE`, paket terpotong, legacy-only, dan selected protocol yang tidak
   didukung sekarang ditolak.
3. Request mengiklankan TLS, CredSSP, dan CredSSP-EAR (`requestedProtocols=0x0B`).
4. Setelah negosiasi berhasil, validator menyelesaikan TLS handshake pada koneksi TCP
   yang sama. TCP 3389 terbuka saja tidak cukup.
5. Tiga poll berturut-turut tetap wajib, dilanjutkan observasi 90 detik dan tiga poll
   final independen sebelum kartu “RDP berhasil” dikirim.
6. DigitalOcean Cloud Firewall yang menarget droplet/tag `tgbot` harus memiliki inbound
   TCP port RDP dari `0.0.0.0/0`. Jika tidak ada Cloud Firewall terpasang, guest firewall
   menjadi sumber aturan dan audit diluluskan.
7. Compatibility mirror otomatis menggunakan `WEBHOOK_URL`; explicit
   `REINSTALL_SCRIPT_URL` tetap menjadi override tertinggi.
8. Script first-boot mengaktifkan `fDenyTSConnections=0`, `fLogonDisabled=0`, membaca
   `PortNumber`, membuat firewall TCP/UDP persistent, serta menjalankan `TermService`.
9. UI diganti dari “Uji Login Administrator” menjadi “Finalisasi Kredensial” agar tidak
   mengklaim sesuatu yang tidak dilakukan.

## Batas validasi

Gate ini membuktikan endpoint publik menerima negosiasi RDP modern dan TLS secara stabil.
Ia tidak mengirim password melalui implementasi CredSSP penuh, sehingga autentikasi
`Administrator` end-to-end tetap dibuktikan saat pengguna melakukan login pertama.

## Environment produksi

`render.yaml` sudah menyertakan default berikut:

```text
CONFHOME_MIRROR_PATH=/reinstall-mirror
RDP_REQUIRE_PUBLIC_3389=true
RDP_POST_READY_SOAK_MS=90000
RDP_FINAL_VALIDATE_ATTEMPTS=18
RDP_FINAL_STABLE_REQUIRED=3
```

Pastikan `WEBHOOK_URL` berisi origin HTTPS aplikasi, misalnya
`https://bot-anda.onrender.com` tanpa path tambahan. Periksa status mirror melalui:

```text
GET https://bot-anda.onrender.com/reinstall-mirror/_status
```

Untuk deployment private/VPN yang memang membatasi RDP berdasarkan source IP, set
`RDP_REQUIRE_PUBLIC_3389=false` dan lakukan audit aturan jaringan sendiri. Membuka RDP
langsung ke internet meningkatkan risiko brute-force; gunakan password acak kuat,
rate-limiting/EDR, dan rotasi kredensial secara berkala.

## Test utama

```bash
npm run test:rdp
```

Test mencakup regresi `RDP_NEG_FAILURE`, paket terpotong, kewajiban TLS, reset stable
counter, audit Cloud Firewall, aktivasi mirror, route status, dan script repair Windows.
