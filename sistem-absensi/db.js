const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "absensi.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

// Helper transaksi sederhana (menggantikan db.transaction() milik better-sqlite3)
db.transaction = function (fn) {
  return (...args) => {
    db.exec("BEGIN");
    try {
      const result = fn(...args);
      db.exec("COMMIT");
      return result;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
};

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  nama TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','super_admin','guru_piket')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kampus (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nama_kampus TEXT NOT NULL,
  alamat TEXT,
  url_template_wa TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS admin_kampus (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kampus_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (kampus_id) REFERENCES kampus(id) ON DELETE CASCADE,
  UNIQUE(user_id, kampus_id)
);

CREATE TABLE IF NOT EXISTS kelas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nama_kelas TEXT NOT NULL,
  tingkat TEXT,
  wali_kelas TEXT,
  kampus_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (kampus_id) REFERENCES kampus(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS siswa (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nis TEXT UNIQUE NOT NULL,
  nama TEXT NOT NULL,
  jenis_kelamin TEXT CHECK (jenis_kelamin IN ('L','P')),
  kelas_id INTEGER NOT NULL,
  nama_ortu TEXT,
  nomor_wa_ortu TEXT,
  status_aktif INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (kelas_id) REFERENCES kelas(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS absensi (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  siswa_id INTEGER NOT NULL,
  tanggal TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Hadir','Sakit','Izin','Alpa','Terlambat')),
  keterangan TEXT,
  dicatat_oleh INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (siswa_id) REFERENCES siswa(id) ON DELETE CASCADE,
  FOREIGN KEY (dicatat_oleh) REFERENCES users(id),
  UNIQUE(siswa_id, tanggal)
);

CREATE TABLE IF NOT EXISTS piket_jadwal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kampus_id INTEGER NOT NULL,
  tanggal TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (kampus_id) REFERENCES kampus(id) ON DELETE CASCADE,
  UNIQUE(user_id, kampus_id, tanggal)
);
`);

// --- Migrasi: tambahkan status 'Terlambat' pada database lama yang sudah ada ---
// (SQLite tidak bisa ALTER CHECK constraint langsung, jadi tabel dibuat ulang jika perlu)
const absensiSchema = db
  .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'absensi'")
  .get();
if (absensiSchema && !absensiSchema.sql.includes("Terlambat")) {
  db.exec(`
    ALTER TABLE absensi RENAME TO absensi_lama;

    CREATE TABLE absensi (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      siswa_id INTEGER NOT NULL,
      tanggal TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('Hadir','Sakit','Izin','Alpa','Terlambat')),
      keterangan TEXT,
      dicatat_oleh INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (siswa_id) REFERENCES siswa(id) ON DELETE CASCADE,
      FOREIGN KEY (dicatat_oleh) REFERENCES users(id),
      UNIQUE(siswa_id, tanggal)
    );

    INSERT INTO absensi (id, siswa_id, tanggal, status, keterangan, dicatat_oleh, created_at)
      SELECT id, siswa_id, tanggal, status, keterangan, dicatat_oleh, created_at FROM absensi_lama;

    DROP TABLE absensi_lama;
  `);
  console.log("Migrasi selesai: status 'Terlambat' ditambahkan ke tabel absensi.");
}

// --- Seed awal (hanya jika kosong) ---
const kampusCount = db.prepare("SELECT COUNT(*) AS c FROM kampus").get().c;
let kampusIds = [];
if (kampusCount === 0) {
  const insertKampus = db.prepare(
    "INSERT INTO kampus (nama_kampus, alamat) VALUES (?, ?)"
  );
  kampusIds.push(insertKampus.run("Kampus 1", "Jl. Contoh Raya No. 1").lastInsertRowid);
  kampusIds.push(insertKampus.run("Kampus 2", "Jl. Contoh Raya No. 2").lastInsertRowid);
  kampusIds.push(insertKampus.run("Kampus 3", "Jl. Contoh Raya No. 3").lastInsertRowid);
  console.log("Seed data kampus dibuat");
} else {
  kampusIds = db.prepare("SELECT id FROM kampus ORDER BY id").all().map((r) => r.id);
}

const userCount = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
if (userCount === 0) {
  const insertUser = db.prepare(
    "INSERT INTO users (username, password_hash, nama, role) VALUES (?, ?, ?, ?)"
  );
  const superadminId = insertUser.run(
    "superadmin",
    bcrypt.hashSync("superadmin123", 10),
    "Super Admin",
    "super_admin"
  ).lastInsertRowid;

  const admin1Id = insertUser.run(
    "adminkampus1",
    bcrypt.hashSync("admin123", 10),
    "Admin Kampus 1 & 3",
    "admin"
  ).lastInsertRowid;

  const admin2Id = insertUser.run(
    "adminkampus2",
    bcrypt.hashSync("admin123", 10),
    "Admin Kampus 2",
    "admin"
  ).lastInsertRowid;

  insertUser.run(
    "gurupiket",
    bcrypt.hashSync("piket123", 10),
    "Ust. Budi (Guru Piket)",
    "guru_piket"
  );

  // Penugasan tetap admin ke kampus: Admin Kampus 1 menangani Kampus 1 & 3, Admin Kampus 2 hanya Kampus 2
  const insertAdminKampus = db.prepare(
    "INSERT INTO admin_kampus (user_id, kampus_id) VALUES (?, ?)"
  );
  insertAdminKampus.run(admin1Id, kampusIds[0]); // Kampus 1
  insertAdminKampus.run(admin1Id, kampusIds[2]); // Kampus 3
  insertAdminKampus.run(admin2Id, kampusIds[1]); // Kampus 2

  console.log(
    "Seed akun dibuat: superadmin/superadmin123, adminkampus1/admin123 (Kampus 1 & 3), adminkampus2/admin123 (Kampus 2), gurupiket/piket123"
  );
}

const kelasCount = db.prepare("SELECT COUNT(*) AS c FROM kelas").get().c;
if (kelasCount === 0) {
  const insertKelas = db.prepare(
    "INSERT INTO kelas (nama_kelas, tingkat, wali_kelas, kampus_id) VALUES (?, ?, ?, ?)"
  );
  const k1 = insertKelas.run("VII A", "VII", "Ust. Ahmad Fauzi", kampusIds[0]).lastInsertRowid;
  const k2 = insertKelas.run("VIII A", "VIII", "Usth. Siti Nurjanah", kampusIds[1]).lastInsertRowid;
  const k3 = insertKelas.run("IX A", "IX", "Ust. Hasan Basri", kampusIds[2]).lastInsertRowid;

  const insertSiswa = db.prepare(
    "INSERT INTO siswa (nis, nama, jenis_kelamin, kelas_id, nama_ortu, nomor_wa_ortu) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const contohSiswa = [
    ["2024001", "Ahmad Rizki Pratama", "L", k1, "Bpk. Slamet", "081234567001"],
    ["2024002", "Siti Aisyah", "P", k1, "Bpk. Herman", "081234567002"],
    ["2024003", "Muhammad Fajar", "L", k1, "Ibu Rina", "081234567003"],
    ["2024004", "Fatimah Az-Zahra", "P", k2, "Bpk. Yusuf", "081234567004"],
    ["2024005", "Umar Abdullah", "L", k2, "Ibu Dewi", "081234567005"],
    ["2024006", "Khadijah Putri", "P", k3, "Bpk. Iwan", "081234567006"],
  ];
  for (const s of contohSiswa) insertSiswa.run(...s);
  console.log("Seed data kelas & siswa contoh dibuat");

  // Contoh jadwal piket hari ini untuk akun gurupiket
  const guruPiket = db.prepare("SELECT id FROM users WHERE username = 'gurupiket'").get();
  if (guruPiket) {
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      "INSERT OR IGNORE INTO piket_jadwal (user_id, kampus_id, tanggal) VALUES (?, ?, ?)"
    ).run(guruPiket.id, kampusIds[0], today);
    console.log("Seed jadwal piket contoh dibuat untuk hari ini di Kampus 1");
  }
}

module.exports = db;
