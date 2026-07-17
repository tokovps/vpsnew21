# PRD — Telegram VPS/RDP Store Bot

## Problem Statement (2026-01 revision)
Revisi Promo Center: simplifikasi sistem promo. Hilangkan seluruh
pengaturan jam / tanggal / countdown / expired time. Promo cukup punya
2 status (Aktif / Non-Aktif), langsung aktif saat dibuat, dan hanya
berakhir bila Admin menekan Hapus / Nonaktifkan.

## Architecture
- Node.js 18+, Telegraf 4.x, Express 4.x
- MongoDB (Mongoose 8.x)
- Deployment: Render / Procfile (`node src/app.js`)

## User personas
- **Admin**: mengelola produk, harga, promo, VPS/RDP, broadcast.
- **User**: browse katalog, checkout, terima kredensial.

## Core requirements (unchanged)
- Payment, Checkout, Provider, Queue, Auto Create VPS/RDP tetap.
- Single source of truth harga: `promoService.resolveEffectivePrice`.

## Implemented (rev 2026-01, Jan 2026)
- Promo Center disederhanakan (tidak ada tanggal/jam/countdown).
- Promo langsung aktif saat dibuat; berakhir hanya via Hapus/Nonaktifkan.
- Pengumuman channel: format baru profesional untuk mulai & berakhir.
- Menu Admin Panel Promo Center: Buat / Edit / Hapus / Status / Kembali.
- Regression: `tests/promo-consistency.test.js` diperbarui, PASS.

## Backlog
- Optional: cleanup script untuk menghapus field lama `startAt` / `endAt` /
  `announcedStart` / `announcedEnd` dari dokumen promo lama di MongoDB.

## Next tasks
- Deliver ZIP terbaru ke user (`/app/vpsnew13-main-revised.zip`).
