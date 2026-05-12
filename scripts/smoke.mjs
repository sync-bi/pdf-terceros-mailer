#!/usr/bin/env node
// Smoke test read-only contra la app desplegada.
// Uso:
//   node scripts/smoke.mjs [pdf-path] [base-url]
// Defaults:
//   pdf-path = ./data/sample.pdf  (o el primer PDF de ./data si existe)
//   base-url = https://pdf-terceros-mailer.vercel.app
//
// NO envia correos. NO crea terceros. Solo GET /api/terceros, GET /api/smtp-verify,
// y POST /api/upload-pdf (que solo lee la DB).

import fs from "node:fs";
import path from "node:path";

const baseUrl = (process.argv[3] || process.env.SMOKE_BASE_URL || "https://pdf-terceros-mailer.vercel.app").replace(/\/$/, "");
const pdfArg = process.argv[2];

function findPdf() {
  if (pdfArg && fs.existsSync(pdfArg)) return pdfArg;
  const dataDir = "data";
  if (fs.existsSync(dataDir)) {
    const candidates = fs.readdirSync(dataDir).filter(f => f.toLowerCase().endsWith(".pdf"));
    if (candidates.length) return path.join(dataDir, candidates[0]);
  }
  return null;
}

const pdfPath = findPdf();

function fmt(ms) { return `${ms}ms`; }
function line(){ console.log("-".repeat(72)); }

async function getJson(url) {
  const t0 = Date.now();
  const r = await fetch(url);
  const ms = Date.now() - t0;
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, ms, body };
}

async function uploadPdf(url, filePath) {
  const buf = fs.readFileSync(filePath);
  const blob = new Blob([buf], { type: "application/pdf" });
  const fd = new FormData();
  fd.append("pdf", blob, path.basename(filePath));
  const t0 = Date.now();
  const r = await fetch(url, { method: "POST", body: fd });
  const ms = Date.now() - t0;
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, ms, body };
}

let failures = 0;
function check(label, ok, detail = "") {
  const mark = ok ? "✓" : "✗";
  console.log(`  ${mark} ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}

console.log(`SMOKE TEST → ${baseUrl}`);
line();

console.log("1) GET /api/terceros");
const t1 = await getJson(`${baseUrl}/api/terceros`);
check("status 200", t1.status === 200, fmt(t1.ms));
check("respuesta es array", Array.isArray(t1.body), `${Array.isArray(t1.body) ? t1.body.length + " terceros" : typeof t1.body}`);
const totalTerceros = Array.isArray(t1.body) ? t1.body.length : 0;
const conNit = Array.isArray(t1.body) ? t1.body.filter(t => t.nit).length : 0;
const sinNit = totalTerceros - conNit;
check("hay terceros sembrados", totalTerceros > 0, `${conNit} con NIT, ${sinNit} sin NIT`);
line();

console.log("2) GET /api/smtp-verify");
const t2 = await getJson(`${baseUrl}/api/smtp-verify`);
check("status 200", t2.status === 200, fmt(t2.ms));
check("SMTP responde ok", t2.body && t2.body.ok === true, JSON.stringify(t2.body).slice(0, 100));
line();

if (!pdfPath) {
  console.log("3) POST /api/upload-pdf — OMITIDO (no se encontro PDF de prueba)");
  console.log(`   Pasa un PDF como primer argumento: node scripts/smoke.mjs <ruta.pdf>`);
  line();
} else {
  console.log(`3) POST /api/upload-pdf  (${pdfPath})`);
  const t3 = await uploadPdf(`${baseUrl}/api/upload-pdf`, pdfPath);
  check("status 200", t3.status === 200, fmt(t3.ms));
  check("respuesta tiene rows", t3.body && Array.isArray(t3.body.rows), `${t3.body?.totalPages ?? 0} paginas`);
  if (Array.isArray(t3.body?.rows)) {
    const rows = t3.body.rows;
    const matched = rows.filter(r => r.matched && r.matched.email).length;
    const unmatchedConNit = rows.filter(r => !r.matched && r.nit).length;
    const unmatchedSinNit = rows.filter(r => !r.matched && !r.nit).length;
    console.log("");
    console.log(`   Resultado del PDF (${rows.length} paginas):`);
    console.log(`     • ${matched} cruzaron con tercero (correo precargado)`);
    console.log(`     • ${unmatchedConNit} sin cruce pero con NIT extraido (se pueden recuperar: el cliente escribe el correo y la proxima vez matchea por NIT)`);
    console.log(`     • ${unmatchedSinNit} sin cruce y sin NIT (necesitarian match por nombre — el correo se guarda pero la proxima vez tampoco matchea)`);
    if (unmatchedConNit + unmatchedSinNit > 0) {
      console.log("");
      console.log(`   Muestra de paginas sin cruce (primeras 5):`);
      rows.filter(r => !r.matched).slice(0, 5).forEach(r => {
        console.log(`     pag ${r.page}  NIT="${r.nit || "(no detectado)"}"  preview="${r.textPreview.replace(/\s+/g," ").slice(0, 90)}..."`);
      });
    }
  } else {
    console.log("   respuesta:", JSON.stringify(t3.body).slice(0, 300));
  }
  line();
}

console.log(failures === 0 ? "RESULTADO: OK" : `RESULTADO: ${failures} fallo(s)`);
process.exit(failures === 0 ? 0 : 1);
