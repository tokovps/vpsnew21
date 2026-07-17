# RDP Round 19 — Persistent Listener dan Auto-Recovery

## Diagnosis

Endpoint RDP yang sebelumnya dikirim bot tidak lagi merespons pada port 3389.
Mirror installer terbukti aktif dan patch pertama berhasil diterapkan. Akar
masalah berikutnya ada pada siklus hidup patch Windows: batch perbaikan
menghapus dirinya setelah eksekusi pertama. Reboot akhir, OOBE, atau policy
refresh sesudah validasi dapat menutup listener tanpa mekanisme pemulihan.

## Perbaikan

- Batch menyalin dirinya ke `%ProgramData%\TokoVPS\rdp-watchdog.bat`.
- Scheduled Task SYSTEM menjalankan repair 30 detik setelah startup dan setiap
  dua menit.
- TermService memiliki tiga aksi recovery otomatis dan listener lokal
  diverifikasi dengan `netstat`.
- Firewall Windows dan rule TCP/UDP untuk port RDP aktual dipastikan aktif.
- Bot menguji TLS RDP setiap dua menit untuk seluruh instance ber-lifecycle
  `rdp` yang sudah dikirim ke user.
- Jika provider menyatakan instance mati, bot mengirim `power_on`.
- Jika provider aktif tetapi RDP gagal dua pemeriksaan, bot mengirim reboot
  agar watchdog Windows memulihkan listener.
- Repair dibatasi tiga kali dengan cooldown lima menit agar tidak terjadi
  reboot loop.

RDP yang sudah terlanjur dibuat dengan batch lama mungkin perlu power-on atau
reinstall satu kali. RDP baru akan membawa watchdog persisten secara otomatis.
