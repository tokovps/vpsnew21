# AUDIT REPORT — RAM Mismatch Bug (User Paid 8GB, Windows Shows 4GB)

**Tanggal audit:** 2026-01
**Ruang lingkup:** Seluruh flow Order → Payment → Provision → Detail VPS
**Status:** ✅ Akar masalah ditemukan & diperbaiki (5 bug kritis)

---

## 🎯 Ringkasan Kasus Nyata User
- User beli **MEDIUM Spec 3** (4 vCPU · 8 GB RAM · 160 GB SSD · Singapore · Windows 10 Pro).
- Detail VPS di bot menampilkan **RAM 8 GB** ✅
- Windows setelah login RDP membaca **RAM 4 GB** ❌
- Kesimpulan awal user: data tidak sinkron antara MongoDB / DO API / Windows.

---

## 🔍 AKAR MASALAH — 5 BUG YANG DITEMUKAN

### Bug #1 (CRITICAL) — `RDP_SIZE_TIER_MAP` hardcode 1 size per tier
**File:** `src/providers/digitalocean.js` (versi lama, baris 18–26)

```js
const RDP_SIZE_TIER_MAP = {
  low:    's-2vcpu-4gb',      // ← semua slot 1/2/3 di tier low = 4GB
  basic:  's-4vcpu-8gb',      // ← semua slot 1/2/3 di tier basic = 8GB
  medium: 's-8vcpu-16gb',     // ← semua slot 1/2/3 di tier medium = 16GB
};
```

Admin men-define 3 spec berbeda per tier (slot 1, 2, 3) tapi kode hanya melihat **tier**, mengabaikan **slot**. Semua user yang beli tier yang sama akan mendapat size DigitalOcean identik — apapun spec yang mereka pilih.

### Bug #2 (CRITICAL) — Silent fallback ke 4GB (SUMBER GEJALA 4GB USER)
**File:** `src/providers/digitalocean.js` (versi lama, baris 23–26, 98–114)

```js
const RDP_SIZE_FALLBACK = [
  's-2vcpu-4gb',              // ← fallback pertama = 4GB!
  's-4vcpu-8gb',
  's-8vcpu-16gb',
  ...
];
```

Ketika size hasil `RDP_SIZE_TIER_MAP[tier]` tidak available di region user (misalnya `s-8vcpu-16gb` sedang penuh di sgp1), kode diam-diam turun ke fallback list. **Fallback pertama = `s-2vcpu-4gb` = 4GB RAM.** Inilah yang user alami: bayar 8GB, DO membuat droplet 4GB, Windows baca 4GB.

### Bug #3 (CRITICAL) — Order tidak menyimpan spec numerik
**File:** `src/models/Order.js` + `src/services/orderService.js` (versi lama)

Order hanya menyimpan `description` (teks bebas admin). Tidak ada field `cpu`, `ramMb`, `diskGb`, `sizeSlug`. Referensi `order.sizeSlug` di `rdpOrchestrator.js` selalu string kosong. Bahkan jika kita ingin memaksa size, data tidak tersedia.

### Bug #4 (CRITICAL) — VPS flow (non-RDP) juga rusak
**File:** `src/provision/orchestrator.js` (versi lama, baris 112–121)

```js
const spec = {
  orderId, osFamily, osVersion, region,
  password, sshPublicKey,
  // ↑ TIDAK ada category/tier/sizeSlug
};
```

Adapter DO jatuh ke `SIZE_FALLBACK[0] = 's-1vcpu-1gb'`. **Setiap order VPS Linux di-provision dengan 1GB RAM apapun paketnya.**

### Bug #5 (CRITICAL) — Detail VPS baca dari DB, bukan DO API
**File:** `src/handlers/vpsManagementHandler.js` (versi lama, baris 108–142)

```js
const specLines = (o && o.description || '').split('\n')...
const ram = specLines.find(l => /ram/i.test(l)) || '-';   // ← dari teks admin
const cpu = specLines.find(l => /cpu|core/i.test(l)) || '-';
```

RAM / CPU / Disk di-parse dari `order.description` (teks admin). Selamanya menampilkan angka spec yang dijual, bukan RAM asli droplet. Itu sebabnya bot tampilkan "8GB" walau droplet asli 4GB.

### Bug #6 (VALIDASI HILANG) — Tidak ada post-create verification
Setelah `POST /v2/droplets` sukses, kode langsung lanjut install Windows tanpa memverifikasi bahwa droplet yang dibuat DO benar-benar sesuai spec. User request eksplisit meminta:
> Jika Droplet.size_slug TIDAK SAMA dengan Order.size_slug MAKA Batalkan proses. Hapus Droplet. Buat ulang.

Ini sekarang diimplementasikan.

---

## 🔧 PERBAIKAN YANG DILAKUKAN

### 1. Utilitas baru: `src/utils/specMapping.js`
- `parseSpecText(raw)` → parsing line-by-line yang tahan format admin apapun.
- `deriveDoSizeSlug({cpu, ramMb, diskGb})` → mapping deterministic ke DO slug (basic > intel > amd).
- `matchDropletToSize(droplet, expected)` → validator strict (sizeSlug + memory + vcpus + disk).
- `DO_SIZE_CATALOG` → tabel referensi 16 slug DO yang lazim dipakai.

### 2. `src/models/Order.js` — 8 field baru
```
cpu, ramMb, diskGb, bwTb, sizeSlug        ← snapshot spec yang dibayar user
verifiedSizeSlug, verifiedMemoryMb,        ← snapshot LIVE dari DO API
verifiedVcpus, verifiedDiskGb                   post-create verification
```

### 3. `src/services/orderService.js` — parsing di titik pembelian
Setiap `createOrder()` sekarang:
1. Parse `spec` text → cpu / ram / disk numerik.
2. Derive `sizeSlug` deterministic.
3. **Log lengkap:** package, spec, cpu, ram, disk, region, sizeSlug, windows.
4. Simpan ke Order.

### 4. `src/providers/digitalocean.js` — HARD ENFORCE, tidak downgrade
- `pickRegionSize` mode STRICT: kalau `spec.sizeSlug` di-set → wajib pakai slug itu. Kalau tidak tersedia di region user → **hop ke region lain yang punya slug tersebut**. Kalau tidak ada dimanapun → **throw** `DO_SIZE_UNAVAILABLE` / `DO_SIZE_REGION_UNAVAILABLE`. **Tidak pernah turun ke slug lebih kecil.**
- `createInstance` post-create: langsung panggil validator; kalau mismatch → **destroy droplet + throw `DO_SIZE_VERIFY_FAILED`** (persis permintaan user).
- `getInstance` extended: return `memory`, `vcpus`, `disk`, `sizeSlug`, `region` untuk konsumsi Detail VPS.
- Log terstruktur: `Selected Package/Spec/CPU/RAM/Disk/Region/Size Slug/Windows`, `API Request Size Slug`, `Droplet ID/Size Slug/Memory/CPU/Disk`.

### 5. `src/provision/rdp/rdpOrchestrator.js` — data-driven spec
- Baca `order.sizeSlug/cpu/ramMb/diskGb`; kalau kosong (order legacy) → re-parse dari description + derive slug + persist balik.
- Kalau spec masih tidak lengkap → **throw `ORDER_SPEC_INCOMPLETE`** (terminal, tidak retry provider).
- Setelah droplet created & verified → persist `verifiedSizeSlug/verifiedMemoryMb/verifiedVcpus/verifiedDiskGb` ke Order.
- Terminal codes baru ditambahkan agar tidak buang droplet ke provider lain untuk error yang sama.

### 6. `src/provision/orchestrator.js` (VPS non-RDP)
Sama seperti RDP: bangun spec penuh dengan sizeSlug/cpu/ram/disk. **Bug 1GB VPS Linux hilang** karena adapter tidak lagi jatuh ke `SIZE_FALLBACK[0]`.

### 7. `src/handlers/vpsManagementHandler.js` — LIVE READ dari DO API
`renderDetail()` sekarang:
1. Panggil `adapter.getInstance(api, instanceId)` → data LIVE.
2. Prioritas field: **LIVE → Order.verified* → Order.parsed → DB snapshot**.
3. Tampilkan **Size Slug live**, **RAM live** (dengan MB + GB), **CPU live**, **Disk live**, **Region live**, **Status live**.
4. Tambah baris **🛰 Sumber Data**: "LIVE dari DigitalOcean API" atau "Cache DB (Provider API tidak dapat dihubungi)".
5. Refresh DB snapshot secara oportunistis kalau status berubah.

---

## 🧪 REGRESSION TEST

File baru: `tests/spec-mismatch-fix.test.js` mem-verifikasi:
1. `parseSpecText` bekerja pada 4 format admin real-world.
2. `deriveDoSizeSlug({cpu:4, ramMb:8192, diskGb:160})` → `'s-4vcpu-8gb'` (SKENARIO USER).
3. `pickRegionSize` melempar error saat size tidak tersedia (tidak silent-downgrade).
4. `matchDropletToSize` mendeteksi droplet 4GB vs order 8GB.

Test lama `tests/rdp-fix-static.test.js` tetap PASS (tidak ada regresi).

```bash
$ node tests/spec-mismatch-fix.test.js
✅ parseSpecText: extracts cpu/ram/disk/bw from all admin formats
✅ deriveDoSizeSlug: user-paid spec → correct DO slug
✅ pickRegionSize: STRICT sizeSlug enforced (hops region instead of downsizing)
✅ pickRegionSize: throws when paid size unavailable
✅ matchDropletToSize: DETECTS the 4GB/8GB regression
✅ matchDropletToSize: correct droplet passes verification
```

---

## 🛡 GARANSI YANG DIBERIKAN
Setelah perbaikan ini:

1. **Order menyimpan cpu/ramMb/diskGb/sizeSlug** — spec user tidak hilang saat perjalanan.
2. **Adapter menolak downgrade** — kalau paket 8GB tidak available di region user, adapter pindah region, TIDAK mengecilkan RAM.
3. **Post-create verify wajib** — droplet dengan RAM salah langsung dihapus, provisioning dibatalkan, provider di-unlock, retry provider lain.
4. **Detail VPS live** — RAM/CPU/Disk yang ditampilkan bot = data LANGSUNG dari DigitalOcean, bukan cache/teks admin.
5. **Log terstruktur** persis permintaan user (Selected Package, ..., API Request Size Slug, Droplet ID/Size/Memory/CPU/Disk).

Skenario user "beli 8GB dapat 4GB" **secara arsitektural mustahil terjadi lagi**: bahkan jika DO regresi dan membuat droplet salah size, validator post-create akan mendeteksi & menghapus droplet sebelum install Windows berjalan.
