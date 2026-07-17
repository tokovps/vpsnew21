# AUDIT — REVISI PROMO CENTER (SIMPLIFIKASI SISTEM PROMO)
Tanggal: 2026-01
Scope   : HANYA Promo Center — sisa sistem tidak disentuh sesuai instruksi.

## RINGKASAN
Sistem Promo disederhanakan total:
- Tidak ada lagi pengaturan **Jam / Tanggal Mulai / Tanggal Berakhir / Countdown / Expired Time**.
- Promo hanya memiliki dua status: 🟢 **Aktif** dan 🔴 **Non-Aktif**.
- Saat Admin membuat promo → **langsung Aktif**, TANPA batas waktu.
- Promo hanya berakhir bila Admin menekan **Hapus** atau **Nonaktifkan**.
- Pengumuman promo (mulai / berakhir) dikirim otomatis ke channel katalog
  (menggunakan sistem broadcast existing) dengan format profesional.

## FILE YANG DIUBAH
- `src/models/Promo.js`  
  Field `startAt`, `endAt`, `announcedStart`, `announcedEnd` **DIHAPUS** dari schema.
  `strict: false` dipertahankan agar dokumen promo lama tidak error saat dibaca.

- `src/services/promoService.js`  
  • `getActivePromos` hanya memfilter `enabled: true`.  
  • Fungsi lama `startScheduler`, `runOnce`, `_allInWindow`, `_fmtDate`,
    `_fmtDateTime` **DIHAPUS**.  
  • Tambah `announceStart(bot, promo)` dan `announceEnd(bot, promo)` yang
    dipanggil eksplisit dari admin handler.  
  • Format pengumuman baru:
    ```
    ━━━━━━━━━━━━━━
    🎉 PROMO BARU TELAH DIMULAI
    🔥 Diskon: 50%
    📦 Berlaku untuk: ☁ VPS LOW, …
    Promo akan tetap berlangsung sampai Admin menghentikannya.
    ━━━━━━━━━━━━━━
    ```
    ```
    ━━━━━━━━━━━━━━
    📢 PROMO TELAH BERAKHIR
    Terima kasih …
    Harga kembali normal.
    ━━━━━━━━━━━━━━
    ```

- `src/handlers/promoAdminHandler.js`  
  • Wizard buat promo dipangkas dari 7 langkah → **5 langkah** (nama, deskripsi,
    jenis diskon, nilai, target).  
  • `showHome`: tampilkan counter Aktif / Non-Aktif (tanpa upcoming/expired).  
  • `showList` mendukung mode `active` / `inactive` / `all` / `edit` / `delete`.  
  • Tambah **Edit Promo** — admin dapat edit name / description / discountType /
    discountValue / targets per field.  
  • `toggle` & `doDelete` sekarang mengirim pengumuman channel otomatis
    dan me-refresh catalog channel.  

- `src/keyboards/admin.js` — `promoCenterMenu` diubah menjadi:
  ```
  📢 Buat Promo         🎟 Voucher Diskon
  📝 Edit Promo         🗑 Hapus Promo
  📊 Status Promo
  ⬅ Kembali
  ```

- `src/Bot.js` — route baru:  
  `a:promo:list:inactive`, `a:promo:edit:list`, `a:promo:del:list`,
  `a:promo:edit:<id>`, `a:promo:ef:<id>:<field>`.

- `src/handlers/adminHandler.js` — text-router juga meneruskan session
  `promo_edit` ke `promoAdminHandler.handleText`.

- `src/app.js` — panggilan `promoService.startScheduler(...)` **DIHAPUS**
  (sudah tidak ada scheduler lagi).

- `src/services/catalogService.js` — ekspor helper `getBot()` agar
  promoAdminHandler bisa memakai bot reference yang sama untuk mengirim
  pengumuman channel tanpa menyimpan referensi bot terpisah.

## FILE YANG TIDAK DISENTUH (per instruksi)
Payment, Checkout, Auto Create VPS, Auto Create RDP, Provider, Queue,
MongoDB, Callback, Animated UI, Stock, Product, dan seluruh Admin Panel
di luar Promo Center — semua utuh, tidak ada refactor.

Perhitungan diskon (`applyToPrice`, `discountFor`, `resolveEffectivePrice`)
juga tidak diubah — masih memakai jalur yang sama sehingga Order,
Invoice, Payment tetap konsisten.

## REGRESSION TEST
`tests/promo-consistency.test.js` diperbarui:
- Test "expired promo (date-based)" diganti "disabled promo (`enabled=false`)".
- Ditambah test statik yang memastikan:
  - Promo model tidak lagi mendeklarasikan `startAt` / `endAt` / `announced*`.
  - `getActivePromos` tidak memfilter berdasarkan tanggal.
  - `promoAdminHandler` tidak punya parser tanggal.
  - `promoCenterMenu` berisi 4 label baru (Buat / Edit / Hapus / Status).
  - `app.js` tidak memanggil `startScheduler` lagi.
  - `announceStart` / `announceEnd` / `refreshCatalog` diekspor.

Semua 9 test dalam `promo-consistency.test.js` **PASS**.
Test lain (`base-price-status`, `provider`, `reward`, dsb) tetap pass —
tidak ada regresi.

## CATATAN DATA MIGRATION
Data promo lama (yang memiliki field `startAt` / `endAt`) tetap tersimpan
di MongoDB. Karena `getActivePromos` sekarang hanya memfilter `enabled`,
promo lama otomatis diperlakukan menurut nilai `enabled` mereka:
- `enabled=true` → langsung aktif (tak terbatas waktu).
- `enabled=false` → non-aktif.

Field lama (`startAt`, `endAt`, `announcedStart`, `announcedEnd`) diabaikan
dan boleh dihapus manual bila diinginkan — tapi tidak perlu.
