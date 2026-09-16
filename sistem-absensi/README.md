# Sistem Absensi Siswa — Madrasah (Multi-Kampus)

Aplikasi web untuk mencatat kehadiran siswa madrasah setiap hari, mendukung
**3 kampus/lokasi berbeda**, dengan pembagian akses bertingkat dan integrasi
pengiriman pesan WhatsApp ke orang tua.

## Peran pengguna

| Peran | Cakupan akses | Ditugaskan lewat |
|---|---|---|
| **Super Admin** | Semua kampus, semua data, kelola akun pengguna | — |
| **Admin** | Hanya kampus yang jadi tanggung jawabnya (bisa lebih dari 1 kampus, tetap/permanen) | Ditentukan Super Admin saat membuat akun (menu Akun Pengguna) |
| **Guru Piket** | Hanya kampus yang dijadwalkan untuknya **pada hari itu**, dan hanya untuk mencatat/melihat absensi hari berjalan | Dijadwalkan oleh Admin/Super Admin lewat menu Jadwal Piket, bisa berbeda kampus setiap hari |

Contoh struktur bawaan (seed data):
- **Admin Kampus 1 & 3** — satu akun mengelola dua kampus sekaligus
- **Admin Kampus 2** — mengelola kampus 2 saja
- **Guru Piket** — dijadwalkan berbeda-beda setiap hari, bisa di kampus mana saja sesuai jadwal

## Fitur

- Login berbasis sesi dengan tiga peran: `super_admin`, `admin`, `guru_piket`
- Kelola data kampus, kelas, dan siswa (dengan pembatasan akses otomatis sesuai kampus)
- Input absensi harian per kelas (status: Hadir, Sakit, Izin, Alpa)
- Laporan harian (dengan ringkasan jumlah per status) dan laporan bulanan
- Jadwal piket harian: menugaskan Guru Piket ke kampus tertentu per tanggal
- **Lapor terlambat mandiri via QR code** — siswa yang datang terlambat scan QR
  di gerbang/pos satpam, isi form singkat (kelas, nama, jam tiba, alasan) lewat
  HP mereka sendiri **tanpa perlu login**, dan datanya langsung masuk ke sistem
  absensi dengan status **Terlambat** — otomatis muncul di laporan harian &
  bulanan, tanpa admin perlu input manual satu-satu
- **Kirim pesan WhatsApp ke orang tua** lewat tautan `wa.me` (dibuka manual oleh
  admin/guru piket, gratis, tanpa risiko pemblokiran nomor)
- **Template pesan WA per kampus** yang bisa dibaca langsung dari **Google Sheet**
  via Google Apps Script — admin cukup mengedit teks di Sheet, sistem otomatis
  memakai versi terbaru tanpa perlu redeploy
- Manajemen akun pengguna & penugasan kampus (khusus Super Admin)
- **Import data siswa massal** dari file Excel/CSV — tambah/perbarui ratusan
  siswa sekaligus tanpa isi form satu per satu (menu **Import Siswa**)
- Dashboard ringkasan statistik, disesuaikan per peran

## Teknologi

- Backend: Node.js, Express, **`node:sqlite`** (modul database bawaan Node.js
  sejak v22.5 — tidak perlu instalasi database terpisah maupun kompilasi native)
- Frontend: HTML, CSS, JavaScript murni (tanpa framework)

> **Catatan versi Node.js:** karena memakai `node:sqlite`, pastikan Node.js versi
> **22.5 atau lebih baru** terpasang (disarankan versi LTS terbaru). Fitur ini masih
> berstatus "experimental" di Node.js sehingga akan muncul satu baris peringatan
> saat server dijalankan — ini normal dan tidak memengaruhi fungsi aplikasi.

## Cara menjalankan

1. Pastikan Node.js versi 22.5 ke atas sudah terpasang.
2. Buka terminal di folder ini, lalu jalankan:

   ```bash
   npm install
   npm start
   ```

3. Buka browser ke **http://localhost:3000**

## Akun contoh (seed)

| Peran | Username | Password | Cakupan |
|---|---|---|---|
| Super Admin | `superadmin` | `superadmin123` | Semua kampus |
| Admin | `adminkampus1` | `admin123` | Kampus 1 & Kampus 3 |
| Admin | `adminkampus2` | `admin123` | Kampus 2 |
| Guru Piket | `gurupiket` | `piket123` | Dijadwalkan (contoh: Kampus 1 hari ini) |

**Segera ganti semua password akun contoh setelah instalasi.**

## Import data siswa dari Excel/CSV

Menu **Import Siswa** (Admin/Super Admin) menerima file `.xlsx` atau `.csv`
dengan baris pertama berisi judul kolom berikut (urutan bebas):

| Kolom | Wajib? | Keterangan |
|---|---|---|
| NIS | Wajib | Harus unik; siswa dengan NIS yang sudah ada akan **diperbarui**, bukan diduplikasi |
| Nama | Wajib | Nama lengkap |
| Kelas | Wajib | Harus **persis sama** dengan nama kelas yang sudah dibuat di menu Data Kelas |
| Jenis Kelamin | Opsional | `L` / `Laki-laki` / `P` / `Perempuan` |
| Nama Ortu | Opsional | Nama orang tua/wali |
| No WA Ortu | Opsional | Nomor WhatsApp, format bebas |

Pastikan semua kelas yang dipakai di file sudah ada lebih dulu di menu
**Data Kelas** sebelum melakukan import — baris dengan nama kelas yang tidak
ditemukan akan dilaporkan gagal (beserta alasannya) tanpa membatalkan baris
lain yang berhasil.

## Menyiapkan QR Code Lapor Terlambat

1. Login sebagai Admin atau Super Admin, buka menu **Data Kampus**
2. Klik tombol **"Lihat QR"** pada baris kampus yang sesuai
3. Akan muncul gambar QR code beserta tautannya
4. **Screenshot atau cetak** gambar QR tersebut, tempel di pos satpam/gerbang kampus
5. Siswa yang terlambat tinggal scan QR itu dengan HP mereka, isi form singkat
   (kelas, nama, jam tiba, alasan), dan data langsung tersimpan ke sistem —
   tanpa perlu login atau instal aplikasi apa pun

Setiap kampus punya QR/tautan sendiri-sendiri (otomatis hanya menampilkan
kelas & siswa dari kampus tersebut), jadi pastikan QR yang dicetak di
Kampus 1 tidak tertukar dengan QR Kampus 2 atau 3.

**Catatan keamanan:** karena halaman ini bisa diakses siapa saja tanpa login
(supaya mudah dipakai siswa), data yang bisa dikirim dibatasi hanya status
"Terlambat" untuk tanggal hari itu saja — tidak bisa dipakai untuk mengubah
data absensi lain atau tanggal yang sudah lewat.

## Menyiapkan template pesan WA via Google Apps Script

Supaya admin bisa mengubah kalimat pesan WA cukup lewat Google Sheet (tanpa
masuk ke sistem), ikuti langkah berikut untuk setiap kampus:

1. Buat Google Sheet baru, isi salah satu sel (misal `A1`) dengan teks template,
   contoh:
   ```
   Yth. {{nama_ortu}}, ananda {{nama}} ({{nama_kelas}}) berstatus {{status}} pada {{tanggal}}.{{keterangan_baris}} — Admin Madrasah
   ```
2. Buka menu **Extensions → Apps Script** di Google Sheet tersebut, lalu tempel kode berikut:

   ```javascript
   function doGet(e) {
     const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Sheet1");
     const template = sheet.getRange("A1").getValue();
     return ContentService
       .createTextOutput(JSON.stringify({ template: template }))
       .setMimeType(ContentService.MimeType.JSON);
   }
   ```
3. Klik **Deploy → New deployment**, pilih tipe **Web app**, atur akses ke
   **"Anyone"** (agar server bisa mengaksesnya), lalu klik Deploy.
4. Salin URL Web App yang diberikan (formatnya
   `https://script.google.com/macros/s/xxxxx/exec`).
5. Di sistem ini, buka menu **Data Kampus**, klik **Ubah** pada kampus yang
   sesuai, lalu tempelkan URL tersebut ke kolom **URL Template Pesan (Google
   Apps Script)**.
6. Selesai — setiap kali tombol **Kirim WA** dipakai untuk kampus itu, sistem
   akan mengambil teks terbaru dari Google Sheet tersebut secara otomatis.
   Jika Google Sheet/GAS sedang tidak bisa diakses, sistem otomatis memakai
   template bawaan sebagai cadangan.

**Placeholder yang tersedia:** `{{nama_ortu}}`, `{{nama}}`, `{{status}}`,
`{{tanggal}}`, `{{nama_kelas}}`, `{{keterangan}}`, `{{keterangan_baris}}`
(otomatis berisi baris "Keterangan: ..." jika keterangan diisi, kosong jika tidak).

## Struktur folder

```
sistem-absensi/
├── server.js        # Server Express, seluruh API, & pembatasan akses per kampus
├── db.js             # Skema database & data awal (seed)
├── package.json
├── data/              # Berkas database SQLite (dibuat otomatis)
└── public/
    ├── index.html     # Halaman login
    ├── lapor-terlambat.html  # Halaman publik (tanpa login) untuk siswa lapor terlambat
    ├── css/style.css
    ├── js/app.js       # Helper API, sidebar navigasi, & logika template WA
    └── app/
        ├── dashboard.html
        ├── absensi.html
        ├── laporan.html
        ├── siswa.html
        ├── kelas.html
        ├── kampus.html   # + pengaturan URL template WA per kampus
        ├── piket.html    # Jadwal piket harian
        └── akun.html     # Khusus Super Admin, termasuk penugasan kampus admin
```

## Catatan untuk penggunaan produksi

- Ganti nilai `secret` pada `express-session` di `server.js` dengan string
  acak dan rahasia.
- Jalankan di belakang HTTPS dan set `cookie.secure = true` pada konfigurasi
  sesi untuk deployment publik.
- Backup berkala terhadap berkas `data/absensi.db`.
- Nomor WA orang tua disimpan di kolom `nomor_wa_ortu` pada data siswa —
  format bebas (boleh diawali `0`, `+62`, atau `62`), sistem akan menormalkan
  otomatis saat membuat tautan `wa.me`.

## Kemungkinan pengembangan lanjutan

- Absensi via QR Code / barcode untuk siswa
- Login mandiri untuk siswa/orang tua guna melihat rekap kehadiran anak
- Pengiriman WA otomatis (perlu WhatsApp Business API resmi berbayar, atau
  library tidak resmi dengan risiko pemblokiran nomor)
- Export laporan langsung ke format PDF
