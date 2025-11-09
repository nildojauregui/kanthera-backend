// server.js — Kanthera backend solid V1

import express from "express";
import cors from "cors";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import PDFDocument from "pdfkit";
import { nanoid } from "nanoid";
import OpenAI from "openai";

/* ---------- Paths & helpers ---------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, "data");
const UPLOADS_DIR = path.join(__dirname, "uploads");
const GENERATED_DIR = path.join(__dirname, "generated");
const SITES_FILE = path.join(DATA_DIR, "sites.json");
const WORKERS_FILE = path.join(DATA_DIR, "workers.json");

// ensure dirs
for (const d of [DATA_DIR, UPLOADS_DIR, GENERATED_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ensure json files
async function ensureJson(file) {
  try {
    await fsp.access(file, fs.constants.F_OK);
  } catch {
    await fsp.writeFile(file, "[]", "utf8");
  }
}
await ensureJson(SITES_FILE);
await ensureJson(WORKERS_FILE);

async function readJson(file) {
  const t = await fsp.readFile(file, "utf8");
  try { return JSON.parse(t || "[]"); } catch { return []; }
}
async function writeJson(file, data) {
  await fsp.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

/* ---------- App & CORS ---------- */
const app = express();
app.use(express.json({ limit: "10mb" }));

const ALLOW_ORIGIN = process.env.CORS_ORIGIN || "*";
app.use(cors({
  origin: ALLOW_ORIGIN === "*" ? true : ALLOW_ORIGIN,
  credentials: false,
}));

/* ---------- Static ---------- */
app.use("/uploads", express.static(UPLOADS_DIR));
app.use("/generated", express.static(GENERATED_DIR));

/* ---------- Health ---------- */
app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "kanthera" });
});

/* ---------- SITES ---------- */
app.get("/api/sites", async (req, res) => {
  const sites = await readJson(SITES_FILE);
  res.json(sites);
});

app.post("/api/sites", async (req, res) => {
  try {
    const { name, address, client } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, error: "name required" });
    const sites = await readJson(SITES_FILE);
    const id = "CNT-" + nanoid(4).toUpperCase();
    const site = { id, name, address: address || "", client: client || "", workers: [] };
    sites.push(site);
    await writeJson(SITES_FILE, sites);
    res.json(site);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ---------- WORKERS ---------- */
app.get("/api/workers", async (req, res) => {
  const workers = await readJson(WORKERS_FILE);
  res.json(workers);
});

app.post("/api/workers", async (req, res) => {
  try {
    const { name, cf, role } = req.body || {};
    if (!name || !cf) return res.status(400).json({ ok: false, error: "name & cf required" });
    const workers = await readJson(WORKERS_FILE);
    const id = "DIP-" + nanoid(4).toUpperCase();
    const worker = { id, name, cf, role: role || "Operaio", docs: {} };
    workers.push(worker);
    await writeJson(WORKERS_FILE, workers);
    res.json(worker);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// patch (es. salvataggio scadenze dopo OCR)
app.patch("/api/workers/:id", async (req, res) => {
  try {
    const workers = await readJson(WORKERS_FILE);
    const idx = workers.findIndex(w => w.id === req.params.id);
    if (idx === -1) return res.status(404).json({ ok: false, error: "not found" });
    workers[idx] = { ...workers[idx], ...req.body };
    await writeJson(WORKERS_FILE, workers);
    res.json({ ok: true, worker: workers[idx] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ---------- Upload & OCR+AI ---------- */
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS_DIR),
  filename: (_, file, cb) => {
    const safe = file.originalname.replace(/\s+/g, "_");
    cb(null, `${Date.now()}_${safe}`);
  }
});
const upload = multer({ storage });

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

app.post("/api/workers/:id/docs", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "file missing" });

    // OCR STUB (qui puoi collegare Google Vision se vuoi)
    let ocrText = `OCR from: ${req.file.originalname}`;

    // AI extraction (best-effort)
    let extracted = {};
    let confidence = 0.7;

    if (openai) {
      const prompt = `
Estrai i seguenti campi dal testo OCR. Rispondi SOLO in JSON.
{
  "doc_type": "visita_medica | formazione_generale | formazione_specifica | antincendio | ps | dpi_consegna | tesserino | altro",
  "holder_name": "string",
  "cf": "string|null",
  "issue_date": "YYYY-MM-DD|null",
  "expiry_date": "YYYY-MM-DD|null",
  "confidence_overall": 0.0-1.0
}
TESTO:
"""${ocrText}"""
      `.trim();

      try {
        const out = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0,
          messages: [{ role: "user", content: prompt }]
        });
        const txt = out.choices?.[0]?.message?.content || "{}";
        extracted = JSON.parse(txt);
        confidence = extracted.confidence_overall ?? 0.7;
      } catch (e) {
        // fallback senza bloccare
        extracted = {};
      }
    }

    res.json({
      ok: true,
      file: `/uploads/${req.file.filename}`,
      url: `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`,
      ocr: ocrText,
      extracted,
      confidence
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ---------- POS (PDF) ---------- */
app.post("/api/pos", async (req, res) => {
  try {
    const { site, workers } = req.body || {};
    if (!site?.name) return res.status(400).json({ ok: false, error: "site required" });

    const filename = `POS_${site.id || "SITE"}_${new Date().toISOString().replace(/[:.]/g, "-")}.pdf`;
    const outPath = path.join(GENERATED_DIR, filename);

    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);

    doc.fontSize(18).text("Piano Operativo di Sicurezza (POS)", { align: "center" }).moveDown();
    doc.fontSize(12).text(`Cantiere: ${site.name}`);
    if (site.address) doc.text(`Indirizzo: ${site.address}`);
    if (site.client) doc.text(`Committente: ${site.client}`);
    doc.moveDown();

    doc.text("Lavoratori:");
    (workers || []).forEach((w, i) => {
      doc.text(`  - ${w.name} (${w.role || "Operaio"})`);
      if (i > 30) doc.addPage(); // protezione layout semplice
    });

    doc.end();
    await new Promise(resolve => stream.on("finish", resolve));

    res.json({
      ok: true,
      file: `/generated/${filename}`,
      url: `${req.protocol}://${req.get("host")}/generated/${filename}`
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ---------- Boot ---------- */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("kanthera backend on", PORT);
});
