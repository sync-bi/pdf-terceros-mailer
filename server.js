import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import pg from "pg";
import XLSX from "xlsx";
import { PDFDocument } from "pdf-lib";
import nodemailer from "nodemailer";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage() });
app.set('etag', false);

/* ---------- SMTP ---------- */
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || "false") === "true",
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

/* ---------- DB Postgres ---------- */
const connectionString =
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL ||
  process.env.POSTGRES_PRISMA_URL ||
  process.env.POSTGRES_URL_NON_POOLING;

if (!connectionString) {
  console.warn("[db] No POSTGRES_URL/DATABASE_URL set. DB operations will fail until configured.");
}

const pool = new pg.Pool({
  connectionString,
  ssl: connectionString && /sslmode=require|neon\.tech|vercel/.test(connectionString)
    ? { rejectUnauthorized: false }
    : undefined,
  max: 5
});

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS terceros (
  id SERIAL PRIMARY KEY,
  nit TEXT UNIQUE,
  nombre TEXT NOT NULL,
  email TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS terceros_nombre_lower_idx ON terceros (LOWER(nombre));
`;

const normDigits = s => String(s || "").replace(/\D/g, "");
const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s||""));

async function upsertByNit({ nit, nombre, email }) {
  const sql = `
    INSERT INTO terceros(nit, nombre, email)
    VALUES ($1, $2, $3)
    ON CONFLICT (nit) DO UPDATE SET nombre = EXCLUDED.nombre, email = EXCLUDED.email
    RETURNING id, nit, nombre, email
  `;
  const r = await pool.query(sql, [nit, nombre, email]);
  return r.rows[0];
}

async function upsertByNombreNoNit({ nombre, email }) {
  const existing = await pool.query(
    "SELECT id, nit, nombre, email FROM terceros WHERE LOWER(nombre) = LOWER($1) AND nit IS NULL LIMIT 1",
    [nombre]
  );
  if (existing.rows[0]) {
    const r = await pool.query(
      "UPDATE terceros SET email = $1 WHERE id = $2 RETURNING id, nit, nombre, email",
      [email, existing.rows[0].id]
    );
    return { ...r.rows[0], updated: true };
  }
  const r = await pool.query(
    "INSERT INTO terceros(nit, nombre, email) VALUES (NULL, $1, $2) RETURNING id, nit, nombre, email",
    [nombre, email]
  );
  return { ...r.rows[0], created: true };
}

async function getAllTerceros() {
  const r = await pool.query("SELECT id, nit, nombre, email FROM terceros ORDER BY nombre");
  return r.rows;
}

async function getAllNitsSet() {
  const r = await pool.query("SELECT nit FROM terceros WHERE nit IS NOT NULL");
  return new Set(r.rows.map(row => String(row.nit)));
}

async function findByNit(nit) {
  const r = await pool.query("SELECT id, nit, nombre, email FROM terceros WHERE nit = $1", [nit]);
  return r.rows[0] || null;
}

async function countTerceros() {
  const r = await pool.query("SELECT COUNT(*)::int AS c FROM terceros");
  return r.rows[0].c;
}

async function deleteTercero(id) {
  const r = await pool.query("DELETE FROM terceros WHERE id = $1", [id]);
  return r.rowCount;
}

/* ---------- Seed desde ./data/terceros.xlsx ---------- */
async function reimportFromExcel(){
  const excelPath = path.join("data","terceros.xlsx");
  if (!fs.existsSync(excelPath)) return { processed: 0, total: 0, skipped: 0, message: "excel no encontrado" };
  const wb = XLSX.readFile(excelPath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

  let processed = 0; let skipped = 0; const total = rows.length;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const r of rows) {
      const nit = normDigits(r.nit || r.NIT || r.Nit || r["NIT"] || r["Nit"]);
      const nombre = String(r.nombre || r.Nombre || r["Nombre Tercero"] || "").trim();
      const email  = String(r.email || r.Email || r.CORREO || r.Correo || "").trim();
      if (nit && nombre && isEmail(email)) {
        await client.query(
          `INSERT INTO terceros(nit, nombre, email) VALUES ($1, $2, $3)
           ON CONFLICT (nit) DO UPDATE SET nombre = EXCLUDED.nombre, email = EXCLUDED.email`,
          [nit, nombre, email]
        );
        processed++;
      } else {
        skipped++;
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return { processed, total, skipped };
}

/* ---------- Inicialización diferida ---------- */
const dbReady = (async () => {
  if (!connectionString) return;
  await pool.query(SCHEMA_SQL);
  const c = await countTerceros();
  if (c === 0) {
    try {
      const info = await reimportFromExcel();
      console.log("[db] seed inicial desde Excel:", info);
    } catch (err) {
      console.error("[db] error en seed inicial:", err.message);
    }
  }
})();

/* ---------- PDF helpers ---------- */
async function extractPerPageText(buffer){
  const { default: pdfParse } = await import("pdf-parse/lib/pdf-parse.js");
  const sep = "\n\f\n";
  const data = await pdfParse(buffer, {
    pagerender: pageData => pageData.getTextContent().then(tc =>
      tc.items.map(i=>i.str).join(" ") + sep
    )
  });
  return data.text.split("\f").map(t => t.trim()).filter(Boolean);
}

function extractNitFromText(text, nitsSet){
  const cands = (text.match(/[\d\.\-]{7,20}/g) || [])
    .map(normDigits).filter(n => n.length >= 7 && n.length <= 12);
  // 1) Match exacto
  for (const n of cands) if (nitsSet.has(n)) return n;
  // 2) Sin el ultimo digito: muchos PDFs traen el NIT con DV pegado (ej: "890321151-0" -> "8903211510")
  //    pero el NIT en la base esta sin DV ("890321151"). Probar la variante.
  for (const n of cands) {
    if (n.length >= 8) {
      const sinDV = n.slice(0, -1);
      if (nitsSet.has(sinDV)) return sinDV;
    }
  }
  // 3) Fallback por regex explicito "Nit: ..."
  const m = text.match(/Nit\.?\s*[:\-]?\s*([\d\.\-]+)/i);
  if (m) {
    const raw = normDigits(m[1]);
    if (nitsSet.has(raw)) return raw;
    if (raw.length >= 8 && nitsSet.has(raw.slice(0, -1))) return raw.slice(0, -1);
    return raw;
  }
  return "";
}

async function buildSinglePagePdf(originalBytes, pageIndex){
  const src = await PDFDocument.load(originalBytes);
  const out = await PDFDocument.create();
  const [copied] = await out.copyPages(src, [pageIndex]);
  out.addPage(copied);
  return await out.save();
}

/* ---------- App ---------- */
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ limit: '25mb', extended: true }));
app.use(express.static("public"));

// Middleware: asegura DB inicializada antes de responder
app.use(async (_req, _res, next) => {
  try { await dbReady; next(); } catch (e) { next(e); }
});

app.get("/api/terceros", async (_req, res) => {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
    "Surrogate-Control": "no-store"
  });
  try {
    res.json(await getAllTerceros());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const uploadsCache = new Map();

app.post("/api/cleanup-uploads", (_req, res) => {
  let clearedFiles = 0;
  try {
    const dir = "/tmp/uploads";
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        try { fs.unlinkSync(path.join(dir, name)); clearedFiles++; } catch {}
      }
    }
  } catch {}
  try { uploadsCache.clear(); } catch {}
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
    "Surrogate-Control": "no-store"
  });
  res.json({ ok: true, clearedFiles, cacheCleared: true });
});

app.post("/api/terceros", async (req, res) => {
  const { nit, nombre, email } = req.body || {};
  if (!nombre || !isEmail(email)) return res.status(400).json({ error: "nombre y email válidos requeridos" });
  try {
    if (nit) {
      const n = normDigits(nit);
      const row = await upsertByNit({ nit: n, nombre, email });
      return res.json({ ...row, upserted: true });
    }
    const r = await upsertByNombreNoNit({ nombre, email });
    return res.json(r);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.delete("/api/terceros/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });
  try {
    const changed = await deleteTercero(id);
    if (changed > 0) return res.json({ deleted: true });
    return res.status(404).json({ error: "no encontrado" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/upload-pdf", upload.single("pdf"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "PDF requerido" });
  try {
    const bytes = req.file.buffer;
    const pagesText = await extractPerPageText(bytes);

    const nitsSet = await getAllNitsSet();

    const rows = [];
    for (let i = 0; i < pagesText.length; i++) {
      const text = pagesText[i];
      const nit = extractNitFromText(text, nitsSet);
      const byNit = nit ? await findByNit(nit) : null;
      rows.push({
        page: i + 1,
        nit,
        textPreview: text.slice(0, 200),
        matched: byNit ? { id: byNit.id, nit: byNit.nit, nombre: byNit.nombre, email: byNit.email } : null
      });
    }

    const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    uploadsCache.set(uploadId, { bytes });
    try {
      const tmpDir = "/tmp/uploads";
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, `${uploadId}.pdf`), bytes);
    } catch {}

    res.json({ uploadId, totalPages: pagesText.length, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Body: { uploadId, selections:[{page,nit,nombre,email}], subject, body, senderEmail }
app.post("/api/send", async (req, res) => {
  const { uploadId, selections, subject, body, senderEmail, pdfData } = req.body || {};
  if (!Array.isArray(selections)) return res.status(400).json({ error: "payload inválido" });
  if (!isEmail(senderEmail)) return res.status(400).json({ error: "senderEmail requerido y válido" });

  let originalBytes = null;
  if (uploadId) {
    const item = uploadsCache.get(uploadId);
    if (item && item.bytes) originalBytes = item.bytes;
  }
  if (!originalBytes) {
    try {
      const filePath = path.join("/tmp/uploads", `${uploadId}.pdf`);
      if (fs.existsSync(filePath)) {
        originalBytes = fs.readFileSync(filePath);
      }
    } catch {}
  }
  if (!originalBytes && pdfData) {
    try { originalBytes = Buffer.from(String(pdfData), 'base64'); } catch {}
  }
  if (!originalBytes) return res.status(400).json({ error: "uploadId inválido o expirado" });

  const results = [];
  for (const sel of selections) {
    if (!isEmail(sel.email)) { results.push({ page: sel.page, status: "skipped", reason: "sin email válido" }); continue; }

    // Persistir tercero antes de enviar para que la próxima vez ya venga precargado
    const nombre = String(sel.nombre || "").trim();
    const email = String(sel.email).trim();
    const nit = normDigits(sel.nit);
    if (nombre) {
      try {
        if (nit) {
          await upsertByNit({ nit, nombre, email });
        } else {
          await upsertByNombreNoNit({ nombre, email });
        }
      } catch (err) {
        console.error("Persist tercero error", { page: sel.page, message: err.message });
      }
    }

    try {
      const pdfBytes = await buildSinglePagePdf(originalBytes, sel.page - 1);
      await transporter.sendMail({
        from: process.env.MAIL_FROM || process.env.SMTP_USER,
        replyTo: senderEmail,
        to: email,
        subject: subject || "Documento",
        text: body || "Adjuntamos su documento.",
        attachments: [{ filename: `pagina-${sel.page}.pdf`, content: Buffer.from(pdfBytes) }]
      });
      results.push({ page: sel.page, status: "sent" });
    } catch (err) {
      console.error("SMTP send error", { page: sel.page, to: email, message: err.message, code: err.code });
      results.push({ page: sel.page, status: "error", error: err.message });
    }
  }
  res.json({ results });
});

app.get("/api/smtp-verify", async (_req, res) => {
  try {
    await transporter.verify();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: err.code });
  }
});

app.post("/api/reimport-excel", async (_req, res) => {
  try {
    const info = await reimportFromExcel();
    res.json({ ok: true, ...info });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectRun) {
  app.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
}

export default app;
