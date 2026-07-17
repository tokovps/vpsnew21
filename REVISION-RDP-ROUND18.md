# RDP Round 18 — Target Aktivasi Sekitar 20 Menit

## Perubahan utama

- Batas dari dispatch installer sampai port RDP terbuka menjadi 20 menit.
- Staging Ubuntu dibatasi 4 menit dan deteksi reboot mulai dipulihkan setelah
  3 menit.
- Preflight mengunduh sampel ISO 8 MiB dan mensyaratkan sedikitnya 40 Mbps.
  Rute lambat ditolak sebelum instalasi panjang dan dapat mencoba provider
  berikutnya.
- Polling port dan validasi RDP berjalan setiap 5 detik agar RDP yang sudah
  siap segera dikirim ke user.
- Observasi stabilitas RDP tetap dipertahankan selama 45 detik agar masalah
  login lama tidak kembali.
- Satu token provider tidak lagi dikunci selama Windows diinstall. Setelah
  Droplet dibuat, lolos preflight, dan satu quota dicatat, token dilepas agar
  order lain dapat mulai paralel.
- Queue RDP default menerima tiga pekerjaan paralel dan maksimal dua provider
  dicoba per order agar kegagalan tidak mengulang waktu tunggu panjang.

## Catatan operasional

Target 20 menit bergantung pada kecepatan ISO dan performa disk VPS. Preflight
kecepatan mencegah rute yang jelas tidak mungkin mencapai target. Untuk hasil
paling konsisten, isi `WIN_ISO_<VERSION>` dengan mirror ISO milik operator yang
berada dekat region VPS.

DigitalOcean tidak menyediakan atau mendukung image Windows resmi. Jalur ini
tetap memakai reinstall berbasis ISO, sehingga target waktu tidak dapat menjadi
jaminan absolut pada setiap region atau saat sumber ISO sedang padat.
