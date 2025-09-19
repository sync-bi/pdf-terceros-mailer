import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import XLSX from "xlsx";
import { PDFDocument } from "pdf-lib";
import nodemailer from "nodemailer";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage() });

/* ---------- SMTP ---------- */
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || "false") === "true",
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

/* ---------- DB terceros (con NIT) ---------- */
const DB_PATH = process.env.DB_PATH || (process.env.VERCEL ? "/tmp/db.sqlite" : "db.sqlite");
const db = new Database(DB_PATH);
db.exec(`
CREATE TABLE IF NOT EXISTS terceros (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nit TEXT UNIQUE,
  nombre TEXT NOT NULL,
  email TEXT NOT NULL
);
`);

const upsertByNit = db.prepare(`
  INSERT INTO terceros(nit,nombre,email)
  VALUES(@nit,@nombre,@email)
  ON CONFLICT(nit) DO UPDATE SET nombre=excluded.nombre, email=excluded.email
`);
const qAllTerceros  = db.prepare("SELECT id,nit,nombre,email FROM terceros ORDER BY nombre");
const qFindByNit    = db.prepare("SELECT id,nit,nombre,email FROM terceros WHERE nit=?");
const qFindByNombre = db.prepare("SELECT id,nit,nombre,email FROM terceros WHERE LOWER(nombre)=LOWER(?)");
const qAllNits      = db.prepare("SELECT nit FROM terceros WHERE nit IS NOT NULL");

const normDigits = s => String(s || "").replace(/\D/g, "");
const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s||""));
const getAllNitsSet = () => new Set(qAllNits.all().map(r => String(r.nit)));
let allNits = getAllNitsSet();

/* ---------- Seed desde ./data/terceros.xlsx ---------- */
function reimportFromExcel(){
  const excelPath = path.join("data","terceros.xlsx");
  if (!fs.existsSync(excelPath)) return { processed: 0, total: 0, skipped: 0, message: "excel no encontrado" };
  const wb = XLSX.readFile(excelPath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

  let processed = 0; let skipped = 0; const total = rows.length;
  db.transaction(() => {
    for (const r of rows) {
      const nit = normDigits(r.nit || r.NIT || r.Nit || r["NIT"] || r["Nit"]);
      const nombre = String(r.nombre || r.Nombre || r["Nombre Tercero"] || "").trim();
      const email  = String(r.email || r.Email || r.CORREO || r.Correo || "").trim();
      if (nit && nombre && isEmail(email)) { upsertByNit.run({ nit, nombre, email }); processed++; }
      else skipped++;
    }
  })();
  allNits = getAllNitsSet();
  return { processed, total, skipped };
}

// seed inicial
reimportFromExcel();

/* ---------- PDF helpers ---------- */
async function extractPerPageText(buffer){
  // carga diferida evita bugs en windows
  const { default: pdfParse } = await import("pdf-parse/lib/pdf-parse.js");
  const sep = "\n\f\n";
  const data = await pdfParse(buffer, {
    pagerender: pageData => pageData.getTextContent().then(tc =>
      tc.items.map(i=>i.str).join(" ") + sep
    )
  });
  return data.text.split("\f").map(t => t.trim()).filter(Boolean);
}

function extractNitFromText(text){
  const cands = (text.match(/[\d\.\-]{7,20}/g) || [])
    .map(normDigits).filter(n => n.length >= 7 && n.length <= 12);
  for (const n of cands) if (allNits.has(n)) return n;
  const m = text.match(/Nit\.?\s*[:\-]?\s*([\d\.\-]+)/i);
  if (m) return normDigits(m[1]);
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
app.use(express.json());
app.use(express.static("public"));

app.get("/api/terceros", (_req, res) => res.json(qAllTerceros.all()));

app.post("/api/terceros", (req,res)=>{
  const { nit, nombre, email } = req.body || {};
  if (!nombre || !isEmail(email)) return res.status(400).json({ error: "nombre y email válidos requeridos" });
  try {
    if (nit) {
      const n = normDigits(nit);
      upsertByNit.run({ nit: n, nombre, email });
      allNits = getAllNitsSet();
      const row = qFindByNit.get(n);
      return res.json({ ...row, upserted: true });
    }
    const ex = qFindByNombre.get(nombre);
    if (ex) {
      db.prepare("UPDATE terceros SET email=? WHERE id=?").run(email, ex.id);
      return res.json({ id: ex.id, nit: ex.nit, nombre, email, updated: true });
    } else {
      const info = db.prepare("INSERT INTO terceros(nit,nombre,email) VALUES(NULL,?,?)").run(nombre, email);
      return res.json({ id: info.lastInsertRowid, nombre, email, created: true });
    }
  } catch(err){ return res.status(500).json({ error: err.message }); }
});

// Eliminar tercero por id
app.delete("/api/terceros/:id", (req,res)=>{
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });
  try {
    const info = db.prepare("DELETE FROM terceros WHERE id=?").run(id);
    if (info.changes > 0) {
      allNits = getAllNitsSet();
      return res.json({ deleted: true });
    } else {
      return res.status(404).json({ error: "no encontrado" });
    }
  } catch(err){ return res.status(500).json({ error: err.message }); }
});

const uploadsCache = new Map();

app.post("/api/upload-pdf", upload.single("pdf"), async (req,res)=>{
  if (!req.file) return res.status(400).json({ error: "PDF requerido" });
  try {
    const bytes = req.file.buffer;
    const pagesText = await extractPerPageText(bytes);

    const rows = pagesText.map((text, i)=>{
      const nit = extractNitFromText(text);
      const byNit = nit ? qFindByNit.get(nit) : null;
      return {
        page: i+1,
        nit,
        textPreview: text.slice(0, 200),
        matched: byNit ? { id: byNit.id, nit: byNit.nit, nombre: byNit.nombre, email: byNit.email } : null
      };
    });

    const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    uploadsCache.set(uploadId, { bytes });

    res.json({ uploadId, totalPages: pagesText.length, rows });
  } catch(err){ res.status(500).json({ error: err.message }); }
});

// Body: { uploadId, selections:[{page,nombre,email}], subject, body, senderEmail }
app.post("/api/send", async (req,res)=>{
  const { uploadId, selections, subject, body, senderEmail } = req.body || {};
  if (!uploadId || !Array.isArray(selections)) return res.status(400).json({ error: "payload inválido" });
  if (!isEmail(senderEmail)) return res.status(400).json({ error: "senderEmail requerido y válido" });

  const item = uploadsCache.get(uploadId);
  if (!item) return res.status(400).json({ error: "uploadId inválido o expirado" });

  const results = [];
  for (const sel of selections){
    if (!isEmail(sel.email)) { results.push({ page: sel.page, status: "skipped", reason: "sin email válido" }); continue; }
    try {
      const pdfBytes = await buildSinglePagePdf(item.bytes, sel.page - 1);
      await transporter.sendMail({
        from: process.env.MAIL_FROM || process.env.SMTP_USER,
        replyTo: senderEmail,
        to: sel.email,
        subject: subject || "Documento",
        text: body || "Adjuntamos su documento.",
        attachments: [{ filename: `pagina-${sel.page}.pdf`, content: Buffer.from(pdfBytes) }]
      });
      results.push({ page: sel.page, status: "sent" });
    } catch(err){
      results.push({ page: sel.page, status: "error", error: err.message });
    }
  }
  res.json({ results });
});

// Reimportar Excel bajo demanda
app.post("/api/reimport-excel", (_req, res)=>{
  try {
    const info = reimportFromExcel();
    res.json({ ok: true, ...info });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectRun) {
  app.listen(PORT, ()=> console.log(`Listening on http://localhost:${PORT}`));
}

export default app;
