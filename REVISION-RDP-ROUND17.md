# RDP Round 17 — Fast Provisioning

> Catatan: nilai timeout di dokumen ini adalah riwayat Round 17 dan sudah
> digantikan oleh target aktivasi Round 18 di `REVISION-RDP-ROUND18.md`.

## Akar masalah

Preflight lama mengunduh ISO Windows penuh (sekitar 4–6 GB) ke Ubuntu untuk
checksum. File itu tidak dapat dipakai oleh Alpine karena proses reinstall
melakukan reboot ke environment terpisah. Alpine kemudian mengunduh ISO yang
sama sekali lagi. Akibatnya waktu dan bandwidth menjadi dua kali lipat, dan
tahap sebelum reboot dapat menunggu sampai 45 menit.

## Perubahan

- Default production memakai fast preflight: URL, metadata ukuran, DNS,
  script, internet, dan kapasitas disk tetap diperiksa, tetapi ISO penuh tidak
  diunduh dua kali.
- Mode checksum penuh masih tersedia dengan
  `RDP_PREFLIGHT_FULL_ISO_CHECKSUM=true`.
- Script staging Ubuntu dibatasi 8 menit. Exit `124` dilaporkan sebagai
  `RDP_REINSTALL_DISPATCH_TIMEOUT` dan tidak menunggu provider lain.
- Deadline instalasi 55 menit dihitung sejak script dikirim, bukan dimulai
  ulang setelah script selesai.
- Deteksi reboot mulai eskalasi setelah 5 menit, dengan grace satu menit per
  aksi provider.
- Timeout staging, reboot, dan instalasi menjadi terminal agar satu order
  tidak mengulang penantian panjang hingga empat provider.
- ETA Telegram sekarang merupakan estimasi per tahap dan tidak di-reset oleh
  beberapa sinyal reboot untuk state yang sama.

## Environment default

```text
RDP_PREFLIGHT_FULL_ISO_CHECKSUM=false
RDP_REINSTALL_DISPATCH_TIMEOUT_MS=480000
RDP_REINSTALL_MAX_TIMEOUT_MS=3300000
RDP_REBOOT_HARD_LIMIT_MS=300000
RDP_REBOOT_ESCALATION_GRACE_MS=60000
```

Nilai dapat dinaikkan jika operator memakai mirror ISO pribadi yang memang
lambat. Untuk Render, gunakan instance berbayar untuk produksi karena Free
Web Service dapat tidur atau restart ketika provisioning Windows masih aktif.
