const path = require("path");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(
  session({
    secret: "kunci-rahasia-madrasah-ubah-ini-di-produksi",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 }, // 8 jam
  })
);
app.use(express.static(path.join(__dirname, "public")));

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ---------- Middleware ----------
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Belum login." });
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user || !roles.includes(req.session.user.role)) {
      return res.status(403).json({ error: "Anda tidak memiliki akses untuk aksi ini." });
    }
    next();
  };
}

// ---------- Pembatasan akses per kampus ----------
// Guru piket: kampus yang ditugaskan pada tanggal tertentu (jadwal harian)
function kampusDitugaskanPiket(userId, tanggal) {
  return db
    .prepare("SELECT kampus_id FROM piket_jadwal WHERE user_id = ? AND tanggal = ?")
    .all(userId, tanggal)
    .map((r) => r.kampus_id);
}

// Admin: kampus yang menjadi tanggung jawab tetapnya
function kampusAdminTetap(userId) {
  return db
    .prepare("SELECT kampus_id FROM admin_kampus WHERE user_id = ?")
    .all(userId)
    .map((r) => r.kampus_id);
}

// Mengembalikan null jika tidak ada pembatasan (super_admin),
// atau array kampus_id yang boleh diakses (admin / guru_piket).
function getAllowedKampus(user, tanggal) {
  if (user.role === "super_admin") return null;
  if (user.role === "admin") return kampusAdminTetap(user.id);
  if (user.role === "guru_piket") return kampusDitugaskanPiket(user.id, tanggal || todayStr());
  return [];
}

function kelasBerada(kelasId) {
  return db.prepare("SELECT * FROM kelas WHERE id = ?").get(kelasId);
}

// ---------- Auth ----------
app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Username dan password wajib diisi." });
  }
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Username atau password salah." });
  }
  req.session.user = { id: user.id, username: user.username, nama: user.nama, role: user.role };
  res.json({ user: req.session.user });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/auth/me", (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "Belum login." });
  res.json({ user: req.session.user });
});

// ---------- Kampus ----------
app.get("/api/kampus", requireAuth, (req, res) => {
  const allowed = getAllowedKampus(req.session.user, todayStr());
  let sql = `SELECT ka.*, (SELECT COUNT(*) FROM kelas k WHERE k.kampus_id = ka.id) AS jumlah_kelas
             FROM kampus ka`;
  const params = [];
  if (allowed !== null) {
    if (allowed.length === 0) return res.json([]);
    sql += ` WHERE ka.id IN (${allowed.map(() => "?").join(",")})`;
    params.push(...allowed);
  }
  sql += " ORDER BY ka.nama_kampus";
  res.json(db.prepare(sql).all(...params));
});

app.post("/api/kampus", requireAuth, requireRole("super_admin"), (req, res) => {
  const { nama_kampus, alamat, url_template_wa } = req.body || {};
  if (!nama_kampus) return res.status(400).json({ error: "Nama kampus wajib diisi." });
  const info = db
    .prepare("INSERT INTO kampus (nama_kampus, alamat, url_template_wa) VALUES (?, ?, ?)")
    .run(nama_kampus, alamat || null, url_template_wa || null);
  res.json({ id: info.lastInsertRowid });
});

// Super admin bisa mengubah semuanya; admin hanya boleh mengubah kampus yang jadi
// tanggung jawabnya, dan tidak boleh mengganti nama kampus (hanya alamat & URL template).
app.put("/api/kampus/:id", requireAuth, requireRole("admin", "super_admin"), (req, res) => {
  const kampus = db.prepare("SELECT * FROM kampus WHERE id = ?").get(req.params.id);
  if (!kampus) return res.status(404).json({ error: "Kampus tidak ditemukan." });

  if (req.session.user.role === "admin") {
    const allowed = kampusAdminTetap(req.session.user.id);
    if (!allowed.includes(kampus.id)) {
      return res.status(403).json({ error: "Anda tidak bertanggung jawab atas kampus ini." });
    }
    const { alamat, url_template_wa } = req.body || {};
    db.prepare("UPDATE kampus SET alamat = ?, url_template_wa = ? WHERE id = ?").run(
      alamat ?? kampus.alamat,
      url_template_wa ?? kampus.url_template_wa,
      kampus.id
    );
    return res.json({ ok: true });
  }

  // super_admin: bebas ubah semua field
  const { nama_kampus, alamat, url_template_wa } = req.body || {};
  db.prepare("UPDATE kampus SET nama_kampus = ?, alamat = ?, url_template_wa = ? WHERE id = ?").run(
    nama_kampus, alamat || null, url_template_wa || null, kampus.id
  );
  res.json({ ok: true });
});

app.delete("/api/kampus/:id", requireAuth, requireRole("super_admin"), (req, res) => {
  db.prepare("DELETE FROM kampus WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// Template pesan WA per kampus — dibaca dari Google Apps Script (Google Sheet)
// GAS diharapkan mengembalikan JSON: { "template": "Yth {{nama_ortu}}, ..." }
app.get("/api/template-pesan", requireAuth, async (req, res) => {
  const { kampus_id } = req.query;
  if (!kampus_id) return res.status(400).json({ error: "kampus_id wajib diisi." });

  const allowed = getAllowedKampus(req.session.user, todayStr());
  if (allowed !== null && !allowed.includes(Number(kampus_id))) {
    return res.status(403).json({ error: "Anda tidak memiliki akses ke kampus ini." });
  }

  const kampus = db.prepare("SELECT * FROM kampus WHERE id = ?").get(kampus_id);
  if (!kampus) return res.status(404).json({ error: "Kampus tidak ditemukan." });

  if (!kampus.url_template_wa) {
    return res.json({ template: null, sumber: "default" });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const r = await fetch(kampus.url_template_wa, { signal: controller.signal });
    clearTimeout(timeout);
    if (!r.ok) throw new Error("Respons GAS tidak OK");
    const data = await r.json();
    res.json({ template: data.template || null, sumber: "gas" });
  } catch (e) {
    res.json({
      template: null,
      sumber: "default",
      peringatan: "Gagal mengambil template dari Google Apps Script, memakai template bawaan.",
    });
  }
});

// ---------- Kelas ----------
app.get("/api/kelas", requireAuth, (req, res) => {
  const allowed = getAllowedKampus(req.session.user, todayStr());
  let sql = `SELECT k.*, ka.nama_kampus,
              (SELECT COUNT(*) FROM siswa s WHERE s.kelas_id = k.id AND s.status_aktif = 1) AS jumlah_siswa
       FROM kelas k JOIN kampus ka ON ka.id = k.kampus_id`;
  const params = [];
  if (allowed !== null) {
    if (allowed.length === 0) return res.json([]);
    sql += ` WHERE k.kampus_id IN (${allowed.map(() => "?").join(",")})`;
    params.push(...allowed);
  }
  sql += " ORDER BY ka.nama_kampus, k.nama_kelas";
  res.json(db.prepare(sql).all(...params));
});

app.post("/api/kelas", requireAuth, requireRole("admin", "super_admin"), (req, res) => {
  const { nama_kelas, tingkat, wali_kelas, kampus_id } = req.body || {};
  if (!nama_kelas || !kampus_id) {
    return res.status(400).json({ error: "Nama kelas dan kampus wajib diisi." });
  }
  const allowed = getAllowedKampus(req.session.user, todayStr());
  if (allowed !== null && !allowed.includes(Number(kampus_id))) {
    return res.status(403).json({ error: "Anda tidak bertanggung jawab atas kampus ini." });
  }
  const info = db
    .prepare("INSERT INTO kelas (nama_kelas, tingkat, wali_kelas, kampus_id) VALUES (?, ?, ?, ?)")
    .run(nama_kelas, tingkat || null, wali_kelas || null, kampus_id);
  res.json({ id: info.lastInsertRowid });
});

app.put("/api/kelas/:id", requireAuth, requireRole("admin", "super_admin"), (req, res) => {
  const kelas = kelasBerada(req.params.id);
  if (!kelas) return res.status(404).json({ error: "Kelas tidak ditemukan." });

  const { nama_kelas, tingkat, wali_kelas, kampus_id } = req.body || {};
  const allowed = getAllowedKampus(req.session.user, todayStr());
  if (allowed !== null && (!allowed.includes(kelas.kampus_id) || !allowed.includes(Number(kampus_id)))) {
    return res.status(403).json({ error: "Anda tidak bertanggung jawab atas kampus ini." });
  }
  db.prepare(
    "UPDATE kelas SET nama_kelas = ?, tingkat = ?, wali_kelas = ?, kampus_id = ? WHERE id = ?"
  ).run(nama_kelas, tingkat || null, wali_kelas || null, kampus_id, req.params.id);
  res.json({ ok: true });
});

app.delete("/api/kelas/:id", requireAuth, requireRole("admin", "super_admin"), (req, res) => {
  const kelas = kelasBerada(req.params.id);
  if (!kelas) return res.status(404).json({ error: "Kelas tidak ditemukan." });
  const allowed = getAllowedKampus(req.session.user, todayStr());
  if (allowed !== null && !allowed.includes(kelas.kampus_id)) {
    return res.status(403).json({ error: "Anda tidak bertanggung jawab atas kampus ini." });
  }
  db.prepare("DELETE FROM kelas WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// Memastikan sebuah kelas berada dalam kampus yang diizinkan bagi user saat ini
function kelasDiizinkan(req, kelasId, tanggal) {
  const kelas = kelasBerada(kelasId);
  if (!kelas) return false;
  const allowed = getAllowedKampus(req.session.user, tanggal);
  if (allowed === null) return true;
  return allowed.includes(kelas.kampus_id);
}

// ---------- Siswa ----------
app.get("/api/siswa", requireAuth, (req, res) => {
  const { kelas_id } = req.query;
  const allowed = getAllowedKampus(req.session.user, todayStr());

  if (kelas_id) {
    if (!kelasDiizinkan(req, kelas_id, todayStr())) {
      return res.status(403).json({ error: "Kelas ini di luar tanggung jawab Anda." });
    }
    const rows = db
      .prepare(
        `SELECT s.*, k.nama_kelas FROM siswa s JOIN kelas k ON k.id = s.kelas_id
         WHERE s.kelas_id = ? AND s.status_aktif = 1 ORDER BY s.nama`
      )
      .all(kelas_id);
    return res.json(rows);
  }

  let sql = `SELECT s.*, k.nama_kelas FROM siswa s JOIN kelas k ON k.id = s.kelas_id
             WHERE s.status_aktif = 1`;
  const params = [];
  if (allowed !== null) {
    if (allowed.length === 0) return res.json([]);
    sql += ` AND k.kampus_id IN (${allowed.map(() => "?").join(",")})`;
    params.push(...allowed);
  }
  sql += " ORDER BY k.nama_kelas, s.nama";
  res.json(db.prepare(sql).all(...params));
});

app.post("/api/siswa", requireAuth, requireRole("admin", "super_admin"), (req, res) => {
  const { nis, nama, jenis_kelamin, kelas_id, nama_ortu, nomor_wa_ortu } = req.body || {};
  if (!nis || !nama || !kelas_id) {
    return res.status(400).json({ error: "NIS, nama, dan kelas wajib diisi." });
  }
  if (!kelasDiizinkan(req, kelas_id, todayStr())) {
    return res.status(403).json({ error: "Kelas ini di luar tanggung jawab Anda." });
  }
  try {
    const info = db
      .prepare(
        `INSERT INTO siswa (nis, nama, jenis_kelamin, kelas_id, nama_ortu, nomor_wa_ortu)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(nis, nama, jenis_kelamin || null, kelas_id, nama_ortu || null, nomor_wa_ortu || null);
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    if (String(e).includes("UNIQUE")) {
      return res.status(400).json({ error: "NIS sudah terdaftar." });
    }
    res.status(500).json({ error: "Gagal menambah siswa." });
  }
});

app.put("/api/siswa/:id", requireAuth, requireRole("admin", "super_admin"), (req, res) => {
  const siswaLama = db.prepare("SELECT * FROM siswa WHERE id = ?").get(req.params.id);
  if (!siswaLama) return res.status(404).json({ error: "Siswa tidak ditemukan." });

  const { nis, nama, jenis_kelamin, kelas_id, nama_ortu, nomor_wa_ortu } = req.body || {};
  if (!kelasDiizinkan(req, siswaLama.kelas_id, todayStr()) || !kelasDiizinkan(req, kelas_id, todayStr())) {
    return res.status(403).json({ error: "Kelas ini di luar tanggung jawab Anda." });
  }
  db.prepare(
    `UPDATE siswa SET nis = ?, nama = ?, jenis_kelamin = ?, kelas_id = ?, nama_ortu = ?, nomor_wa_ortu = ?
     WHERE id = ?`
  ).run(nis, nama, jenis_kelamin || null, kelas_id, nama_ortu || null, nomor_wa_ortu || null, req.params.id);
  res.json({ ok: true });
});

app.delete("/api/siswa/:id", requireAuth, requireRole("admin", "super_admin"), (req, res) => {
  const siswa = db.prepare("SELECT * FROM siswa WHERE id = ?").get(req.params.id);
  if (!siswa) return res.status(404).json({ error: "Siswa tidak ditemukan." });
  if (!kelasDiizinkan(req, siswa.kelas_id, todayStr())) {
    return res.status(403).json({ error: "Kelas ini di luar tanggung jawab Anda." });
  }
  db.prepare("UPDATE siswa SET status_aktif = 0 WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ---------- Absensi ----------
app.get("/api/absensi", requireAuth, (req, res) => {
  const { kelas_id, tanggal } = req.query;
  if (!kelas_id || !tanggal) {
    return res.status(400).json({ error: "kelas_id dan tanggal wajib diisi." });
  }
  if (req.session.user.role === "guru_piket" && tanggal !== todayStr()) {
    return res.status(403).json({ error: "Guru piket hanya bisa mencatat absensi untuk hari ini." });
  }
  if (!kelasDiizinkan(req, kelas_id, tanggal)) {
    return res.status(403).json({ error: "Kelas ini di luar tanggung jawab Anda." });
  }
  const rows = db
    .prepare(
      `SELECT s.id AS siswa_id, s.nis, s.nama, s.nama_ortu, s.nomor_wa_ortu,
              a.status, a.keterangan
       FROM siswa s
       LEFT JOIN absensi a ON a.siswa_id = s.id AND a.tanggal = ?
       WHERE s.kelas_id = ? AND s.status_aktif = 1
       ORDER BY s.nama`
    )
    .all(tanggal, kelas_id);
  res.json(rows);
});

app.post("/api/absensi", requireAuth, (req, res) => {
  const { tanggal, records } = req.body || {};
  if (!tanggal || !Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ error: "tanggal dan records wajib diisi." });
  }
  if (req.session.user.role === "guru_piket" && tanggal !== todayStr()) {
    return res.status(403).json({ error: "Guru piket hanya bisa mencatat absensi untuk hari ini." });
  }

  const siswaPertama = db.prepare("SELECT kelas_id FROM siswa WHERE id = ?").get(records[0].siswa_id);
  if (!siswaPertama || !kelasDiizinkan(req, siswaPertama.kelas_id, tanggal)) {
    return res.status(403).json({ error: "Kelas ini di luar tanggung jawab Anda." });
  }

  const upsert = db.prepare(`
    INSERT INTO absensi (siswa_id, tanggal, status, keterangan, dicatat_oleh)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(siswa_id, tanggal) DO UPDATE SET
      status = excluded.status,
      keterangan = excluded.keterangan,
      dicatat_oleh = excluded.dicatat_oleh
  `);
  const trx = db.transaction((items) => {
    for (const it of items) {
      upsert.run(it.siswa_id, tanggal, it.status, it.keterangan || null, req.session.user.id);
    }
  });
  trx(records);
  res.json({ ok: true, jumlah: records.length });
});

// ---------- Laporan ----------
app.get("/api/laporan/harian", requireAuth, (req, res) => {
  const { tanggal, kelas_id } = req.query;
  if (!tanggal) return res.status(400).json({ error: "tanggal wajib diisi." });

  if (req.session.user.role === "guru_piket" && tanggal !== todayStr()) {
    return res.status(403).json({ error: "Guru piket hanya bisa melihat laporan untuk hari ini." });
  }

  const allowed = getAllowedKampus(req.session.user, tanggal);
  if (allowed !== null && allowed.length === 0) return res.json({ rows: [], ringkasan: {} });
  if (kelas_id && !kelasDiizinkan(req, kelas_id, tanggal)) {
    return res.status(403).json({ error: "Kelas ini di luar tanggung jawab Anda." });
  }

  let sql = `
    SELECT s.nis, s.nama, s.nama_ortu, s.nomor_wa_ortu, k.nama_kelas, k.kampus_id, ka.nama_kampus, a.status, a.keterangan
    FROM siswa s
    JOIN kelas k ON k.id = s.kelas_id
    JOIN kampus ka ON ka.id = k.kampus_id
    LEFT JOIN absensi a ON a.siswa_id = s.id AND a.tanggal = ?
    WHERE s.status_aktif = 1`;
  const params = [tanggal];
  if (kelas_id) {
    sql += " AND s.kelas_id = ?";
    params.push(kelas_id);
  } else if (allowed) {
    sql += ` AND k.kampus_id IN (${allowed.map(() => "?").join(",")})`;
    params.push(...allowed);
  }
  sql += " ORDER BY ka.nama_kampus, k.nama_kelas, s.nama";
  const rows = db.prepare(sql).all(...params);

  const ringkasan = { Hadir: 0, Sakit: 0, Izin: 0, Alpa: 0, "Belum Dicatat": 0 };
  for (const r of rows) {
    const key = r.status || "Belum Dicatat";
    ringkasan[key] = (ringkasan[key] || 0) + 1;
  }
  res.json({ rows, ringkasan });
});

app.get("/api/laporan/bulanan", requireAuth, requireRole("admin", "super_admin"), (req, res) => {
  const { bulan, tahun, kelas_id, kampus_id } = req.query;
  if (!bulan || !tahun) return res.status(400).json({ error: "bulan dan tahun wajib diisi." });
  const bulanStr = String(bulan).padStart(2, "0");
  const prefix = `${tahun}-${bulanStr}`;

  const allowed = getAllowedKampus(req.session.user, todayStr());
  if (allowed !== null && allowed.length === 0) return res.json([]);
  if (kelas_id && !kelasDiizinkan(req, kelas_id, todayStr())) {
    return res.status(403).json({ error: "Kelas ini di luar tanggung jawab Anda." });
  }
  if (kampus_id && allowed !== null && !allowed.includes(Number(kampus_id))) {
    return res.status(403).json({ error: "Kampus ini di luar tanggung jawab Anda." });
  }

  let sql = `
    SELECT s.id AS siswa_id, s.nis, s.nama, k.nama_kelas, ka.nama_kampus,
           SUM(CASE WHEN a.status = 'Hadir' THEN 1 ELSE 0 END) AS hadir,
           SUM(CASE WHEN a.status = 'Sakit' THEN 1 ELSE 0 END) AS sakit,
           SUM(CASE WHEN a.status = 'Izin' THEN 1 ELSE 0 END) AS izin,
           SUM(CASE WHEN a.status = 'Alpa' THEN 1 ELSE 0 END) AS alpa,
           COUNT(a.id) AS total_dicatat
    FROM siswa s
    JOIN kelas k ON k.id = s.kelas_id
    JOIN kampus ka ON ka.id = k.kampus_id
    LEFT JOIN absensi a ON a.siswa_id = s.id AND a.tanggal LIKE ?
    WHERE s.status_aktif = 1`;
  const params = [`${prefix}%`];
  if (kelas_id) {
    sql += " AND s.kelas_id = ?";
    params.push(kelas_id);
  } else if (kampus_id) {
    sql += " AND k.kampus_id = ?";
    params.push(kampus_id);
  } else if (allowed) {
    sql += ` AND k.kampus_id IN (${allowed.map(() => "?").join(",")})`;
    params.push(...allowed);
  }
  sql += " GROUP BY s.id ORDER BY ka.nama_kampus, k.nama_kelas, s.nama";
  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

// ---------- Jadwal piket ----------
app.get("/api/piket", requireAuth, (req, res) => {
  const { tanggal } = req.query;
  let sql = `
    SELECT p.id, p.tanggal, p.user_id, u.nama AS nama_guru, u.username,
           p.kampus_id, ka.nama_kampus
    FROM piket_jadwal p
    JOIN users u ON u.id = p.user_id
    JOIN kampus ka ON ka.id = p.kampus_id`;
  const conditions = [];
  const params = [];

  if (req.session.user.role === "guru_piket") {
    conditions.push("p.user_id = ?");
    params.push(req.session.user.id);
  } else if (req.session.user.role === "admin") {
    const allowed = kampusAdminTetap(req.session.user.id);
    if (allowed.length === 0) return res.json([]);
    conditions.push(`p.kampus_id IN (${allowed.map(() => "?").join(",")})`);
    params.push(...allowed);
  }
  if (tanggal) {
    conditions.push("p.tanggal = ?");
    params.push(tanggal);
  }
  if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
  sql += " ORDER BY p.tanggal DESC, ka.nama_kampus";

  res.json(db.prepare(sql).all(...params));
});

app.post("/api/piket", requireAuth, requireRole("admin", "super_admin"), (req, res) => {
  const { user_id, kampus_id, tanggal } = req.body || {};
  if (!user_id || !kampus_id || !tanggal) {
    return res.status(400).json({ error: "Guru, kampus, dan tanggal wajib diisi." });
  }
  if (req.session.user.role === "admin") {
    const allowed = kampusAdminTetap(req.session.user.id);
    if (!allowed.includes(Number(kampus_id))) {
      return res.status(403).json({ error: "Anda hanya bisa menjadwalkan piket di kampus tanggung jawab Anda." });
    }
  }
  try {
    const info = db
      .prepare("INSERT INTO piket_jadwal (user_id, kampus_id, tanggal) VALUES (?, ?, ?)")
      .run(user_id, kampus_id, tanggal);
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    if (String(e).includes("UNIQUE")) {
      return res.status(400).json({ error: "Guru ini sudah dijadwalkan di kampus tersebut pada tanggal itu." });
    }
    res.status(500).json({ error: "Gagal menambah jadwal piket." });
  }
});

app.delete("/api/piket/:id", requireAuth, requireRole("admin", "super_admin"), (req, res) => {
  const jadwal = db.prepare("SELECT * FROM piket_jadwal WHERE id = ?").get(req.params.id);
  if (!jadwal) return res.status(404).json({ error: "Jadwal tidak ditemukan." });
  if (req.session.user.role === "admin") {
    const allowed = kampusAdminTetap(req.session.user.id);
    if (!allowed.includes(jadwal.kampus_id)) {
      return res.status(403).json({ error: "Anda tidak bertanggung jawab atas kampus ini." });
    }
  }
  db.prepare("DELETE FROM piket_jadwal WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ---------- Manajemen akun (khusus super_admin) ----------
app.get("/api/users", requireAuth, requireRole("super_admin"), (req, res) => {
  const rows = db
    .prepare("SELECT id, username, nama, role, created_at FROM users ORDER BY created_at")
    .all();
  const withKampus = rows.map((u) => {
    if (u.role === "admin") {
      const kampus = db
        .prepare(
          `SELECT ka.id, ka.nama_kampus FROM admin_kampus ak
           JOIN kampus ka ON ka.id = ak.kampus_id WHERE ak.user_id = ?`
        )
        .all(u.id);
      return { ...u, kampus };
    }
    return u;
  });
  res.json(withKampus);
});

// Daftar guru piket ringkas, untuk keperluan penjadwalan oleh admin/super_admin
app.get("/api/users/guru-piket", requireAuth, requireRole("admin", "super_admin"), (req, res) => {
  const rows = db
    .prepare("SELECT id, username, nama FROM users WHERE role = 'guru_piket' ORDER BY nama")
    .all();
  res.json(rows);
});

app.post("/api/users", requireAuth, requireRole("super_admin"), (req, res) => {
  const { username, password, nama, role, kampus_ids } = req.body || {};
  if (!username || !password || !nama || !role) {
    return res.status(400).json({ error: "Semua field wajib diisi." });
  }
  if (!["admin", "super_admin", "guru_piket"].includes(role)) {
    return res.status(400).json({ error: "Role tidak valid." });
  }
  if (role === "admin" && (!Array.isArray(kampus_ids) || kampus_ids.length === 0)) {
    return res.status(400).json({ error: "Akun Admin wajib ditugaskan minimal 1 kampus." });
  }
  try {
    const trx = db.transaction(() => {
      const info = db
        .prepare("INSERT INTO users (username, password_hash, nama, role) VALUES (?, ?, ?, ?)")
        .run(username, bcrypt.hashSync(password, 10), nama, role);
      if (role === "admin") {
        const insertAk = db.prepare("INSERT INTO admin_kampus (user_id, kampus_id) VALUES (?, ?)");
        for (const kid of kampus_ids) insertAk.run(info.lastInsertRowid, kid);
      }
      return info.lastInsertRowid;
    });
    const id = trx();
    res.json({ id });
  } catch (e) {
    if (String(e).includes("UNIQUE")) {
      return res.status(400).json({ error: "Username sudah digunakan." });
    }
    res.status(500).json({ error: "Gagal membuat akun." });
  }
});

// Mengubah penugasan kampus untuk akun Admin yang sudah ada
app.put("/api/users/:id/kampus", requireAuth, requireRole("super_admin"), (req, res) => {
  const { kampus_ids } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "Akun tidak ditemukan." });
  if (user.role !== "admin") {
    return res.status(400).json({ error: "Hanya akun Admin yang memiliki penugasan kampus tetap." });
  }
  if (!Array.isArray(kampus_ids) || kampus_ids.length === 0) {
    return res.status(400).json({ error: "Minimal 1 kampus wajib dipilih." });
  }
  const trx = db.transaction(() => {
    db.prepare("DELETE FROM admin_kampus WHERE user_id = ?").run(user.id);
    const insert = db.prepare("INSERT INTO admin_kampus (user_id, kampus_id) VALUES (?, ?)");
    for (const kid of kampus_ids) insert.run(user.id, kid);
  });
  trx();
  res.json({ ok: true });
});

app.delete("/api/users/:id", requireAuth, requireRole("super_admin"), (req, res) => {
  if (Number(req.params.id) === req.session.user.id) {
    return res.status(400).json({ error: "Tidak bisa menghapus akun sendiri." });
  }
  db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ---------- Statistik ringkas untuk dashboard ----------
app.get("/api/stats", requireAuth, (req, res) => {
  const today = todayStr();
  const role = req.session.user.role;
  const allowed = getAllowedKampus(req.session.user, today);

  if (role === "guru_piket") {
    const namaKampus = allowed.length
      ? db
          .prepare(`SELECT nama_kampus FROM kampus WHERE id IN (${allowed.map(() => "?").join(",")})`)
          .all(...allowed)
          .map((r) => r.nama_kampus)
      : [];
    let totalSiswaTugas = 0;
    let hadirHariIni = 0;
    if (allowed.length) {
      totalSiswaTugas = db
        .prepare(
          `SELECT COUNT(*) c FROM siswa s JOIN kelas k ON k.id = s.kelas_id
           WHERE s.status_aktif = 1 AND k.kampus_id IN (${allowed.map(() => "?").join(",")})`
        )
        .get(...allowed).c;
      hadirHariIni = db
        .prepare(
          `SELECT COUNT(*) c FROM absensi a JOIN siswa s ON s.id = a.siswa_id JOIN kelas k ON k.id = s.kelas_id
           WHERE a.tanggal = ? AND a.status = 'Hadir' AND k.kampus_id IN (${allowed.map(() => "?").join(",")})`
        )
        .get(today, ...allowed).c;
    }
    return res.json({
      role,
      today,
      kampusTugasHariIni: namaKampus,
      totalSiswaTugas,
      hadirHariIni,
      belumDicatatHariIni: totalSiswaTugas - hadirHariIni,
    });
  }

  // admin (di-scope ke kampusnya) & super_admin (allowed = null → semua)
  const filterKampusSql = allowed !== null ? ` AND k.kampus_id IN (${allowed.map(() => "?").join(",")})` : "";
  const filterParams = allowed !== null ? allowed : [];

  if (allowed !== null && allowed.length === 0) {
    return res.json({ role, today, totalSiswa: 0, totalKelas: 0, totalKampus: 0, hadirHariIni: 0, belumDicatatHariIni: 0, totalAdmin: null });
  }

  const totalSiswa = db
    .prepare(`SELECT COUNT(*) c FROM siswa s JOIN kelas k ON k.id = s.kelas_id WHERE s.status_aktif = 1${filterKampusSql}`)
    .get(...filterParams).c;
  const totalKelas = db
    .prepare(`SELECT COUNT(*) c FROM kelas k WHERE 1=1${filterKampusSql}`)
    .get(...filterParams).c;
  const totalKampus = allowed !== null ? allowed.length : db.prepare("SELECT COUNT(*) c FROM kampus").get().c;
  const hadirHariIni = db
    .prepare(
      `SELECT COUNT(*) c FROM absensi a JOIN siswa s ON s.id = a.siswa_id JOIN kelas k ON k.id = s.kelas_id
       WHERE a.tanggal = ? AND a.status = 'Hadir'${filterKampusSql}`
    )
    .get(today, ...filterParams).c;
  const totalDicatat = db
    .prepare(
      `SELECT COUNT(*) c FROM absensi a JOIN siswa s ON s.id = a.siswa_id JOIN kelas k ON k.id = s.kelas_id
       WHERE a.tanggal = ?${filterKampusSql}`
    )
    .get(today, ...filterParams).c;
  const belumDicatatHariIni = totalSiswa - totalDicatat;
  const totalAdmin = role === "super_admin" ? db.prepare("SELECT COUNT(*) c FROM users").get().c : null;

  res.json({ role, totalSiswa, totalKelas, totalKampus, hadirHariIni, belumDicatatHariIni, totalAdmin, today });
});

app.listen(PORT, () => {
  console.log(`Sistem Absensi Madrasah berjalan di http://localhost:${PORT}`);
});
