// ---------- Helper pemanggilan API ----------
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...options,
  });
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const data = isJson ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401) {
      window.location.href = "/index.html";
      return null;
    }
    throw new Error((data && data.error) || "Terjadi kesalahan.");
  }
  return data;
}

function fmtTanggal(iso) {
  if (!iso) return "-";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
}

function badgeStatus(status) {
  if (!status) return `<span class="badge badge-kosong">Belum dicatat</span>`;
  const map = { Hadir: "hadir", Sakit: "sakit", Izin: "izin", Alpa: "alpa", Terlambat: "terlambat" };
  return `<span class="badge badge-${map[status]}">${status}</span>`;
}

// ---------- WhatsApp ----------
// Menormalkan nomor HP Indonesia ke format internasional untuk wa.me
function normalisasiNomorWa(nomor) {
  if (!nomor) return null;
  let n = String(nomor).replace(/[^0-9]/g, "");
  if (n.startsWith("0")) n = "62" + n.slice(1);
  else if (!n.startsWith("62")) n = "62" + n;
  return n;
}

function buatLinkWa(nomor, pesan) {
  const n = normalisasiNomorWa(nomor);
  if (!n) return null;
  return `https://wa.me/${n}?text=${encodeURIComponent(pesan)}`;
}

// Template bawaan (dipakai jika kampus belum mengatur URL Google Apps Script,
// atau saat GAS gagal diakses)
function templateBawaan(status) {
  if (status === "Hadir") {
    return `Yth. {{nama_ortu}},\n\nAssalamu'alaikum warahmatullahi wabarakatuh.\nMohon izin menginformasikan, ananda *{{nama}}* ({{nama_kelas}}) tercatat *hadir* di madrasah pada {{tanggal}}.\n\nTerima kasih.\n— Admin Madrasah`;
  }
  return `Yth. {{nama_ortu}},\n\nAssalamu'alaikum warahmatullahi wabarakatuh.\nKami sampaikan bahwa ananda *{{nama}}* ({{nama_kelas}}) tercatat *{{status}}* di madrasah pada {{tanggal}}.{{keterangan_baris}}\n\nTerima kasih.\n— Admin Madrasah`;
}

// Mengisi placeholder {{...}} pada template dengan data absensi
function renderTemplateWa(tpl, data) {
  const nilai = {
    nama_ortu: data.nama_ortu || "Bapak/Ibu Wali",
    nama: data.nama || "",
    status: data.status || "",
    tanggal: fmtTanggal(data.tanggal),
    nama_kelas: data.nama_kelas || "",
    keterangan: data.keterangan || "",
    keterangan_baris: data.keterangan ? `\nKeterangan: ${data.keterangan}` : "",
  };
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, key) => (key in nilai ? nilai[key] : ""));
}

// Cache template mentah per kampus (null berarti belum diatur / gagal diambil,
// fallback bawaan dihitung terpisah sesuai status saat dipakai)
const _cacheTemplateWa = {};
async function ambilTemplateWaKampus(kampusId) {
  if (!kampusId) return null;
  if (!(kampusId in _cacheTemplateWa)) {
    try {
      const r = await api(`/api/template-pesan?kampus_id=${kampusId}`);
      _cacheTemplateWa[kampusId] = r.template || null;
    } catch (e) {
      _cacheTemplateWa[kampusId] = null;
    }
  }
  return _cacheTemplateWa[kampusId];
}

async function buatPesanWa(kampusId, data) {
  const custom = await ambilTemplateWaKampus(kampusId);
  const tpl = custom || templateBawaan(data.status);
  return renderTemplateWa(tpl, data);
}

// ---------- Sidebar & guard halaman ----------
const NAV_ITEMS = [
  { href: "/app/dashboard.html", label: "Ringkasan", roles: ["admin", "super_admin", "guru_piket"] },
  { href: "/app/absensi.html", label: "Input Absensi", roles: ["admin", "super_admin", "guru_piket"] },
  { href: "/app/laporan.html", label: "Laporan", roles: ["admin", "super_admin"] },
  { href: "/app/siswa.html", label: "Data Siswa", roles: ["admin", "super_admin"] },
  { href: "/app/kelas.html", label: "Data Kelas", roles: ["admin", "super_admin"] },
  { href: "/app/kampus.html", label: "Data Kampus", roles: ["admin", "super_admin"] },
  { href: "/app/piket.html", label: "Jadwal Piket", roles: ["admin", "super_admin", "guru_piket"] },
  { href: "/app/akun.html", label: "Akun Pengguna", roles: ["super_admin"] },
];

async function initShell(activeHref) {
  let me;
  try {
    const r = await api("/api/auth/me");
    me = r.user;
  } catch (e) {
    window.location.href = "/index.html";
    return null;
  }

  const items = NAV_ITEMS.filter((i) => i.roles.includes(me.role));
  const navHtml = items
    .map(
      (i) =>
        `<a href="${i.href}" class="${i.href === activeHref ? "active" : ""}">${i.label}</a>`
    )
    .join("");

  const roleLabel =
    me.role === "super_admin" ? "Super Admin" : me.role === "guru_piket" ? "Guru Piket" : "Admin";

  document.getElementById("sidebar").innerHTML = `
    <div class="brand-block">
      <div class="brand">Al-Hikmah</div>
      <div class="sub">Sistem Absensi Madrasah</div>
    </div>
    <nav class="nav">${navHtml}</nav>
    <div class="user-block">
      <div class="name">${me.nama}</div>
      <div class="role">${roleLabel}</div>
      <button class="logout-btn" id="btn-logout">Keluar</button>
    </div>
  `;

  document.getElementById("btn-logout").addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    window.location.href = "/index.html";
  });

  return me;
}
