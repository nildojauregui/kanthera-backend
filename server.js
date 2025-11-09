// server.js — Kanthera MVP (POS + OCR fix)

// ---- imports & setup (ESM safe) ----
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import PDFDocument from "pdfkit";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

// ---- middlewares ----
app.use(cors({
  origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN,
  credentials: false,
}));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ---- data seed ----
const DATA_PATH = path.join(__dirname, "data", "seed.json");
function readSeed() {
  const raw = fs.readFileSync(DATA_PATH, "utf8");
  return JSON.parse(raw);
}

// ---- ensure folders & static serving ----
const UPLOADS_DIR = path.join(__dirname, "uploads");
const GENERATED_DIR = path.join(__dirname, "generated");
[UPLOADS_DIR, GENERATED_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.use("/uploads", express.static(UPLOADS_DIR));
app.use("/generated", express.static(GENERATED_DIR));

// ---- helpers ----
function baseUrl(req) {
  // Se non impostato in env, usa host della richiesta
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers.host;
  return process.env.BASE_URL || `${proto}://${host}`;
}

// ---- health & data ----
app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "kanthera-backend" });
});

app.get("/api/sites", (req, res) => {
  const { sites } = readSeed();
  res.json(sites || []);
});

app.get("/api/workers", (req, res) => {
  const { workers } = readSeed();
  res.json(workers || []);
});

// ---- POS: generate PDF ----
app.post("/api/pos", async (req, res) => {
  try {
    const { site, workers = [], vars = {} } = req.body || {};
    if (!site || !site.id) {
      return res.status(400).json({ ok: false, error: "Missing site payload" });
    }

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `POS_${site.id}_${ts}.pdf`;
    const filePath = path.join(GENERATED_DIR, fileName);

    // PDF basic
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    doc.fontSize(18).text("Piano Operativo di Sicurezza (POS)", { align: "center" });
    doc.moveDown();

    doc.fontSize(12).text(`Cantiere: ${site.name}`);
    doc.text(`Indirizzo: ${site.address}`);
    doc.text(`Committente: ${site.client} (${site.client_cf_piva || "N/A"})`);
    doc.text(`CSE: ${site?.cse?.name || "-"}  (${site?.cse?.email || "-"})`);
    doc.text(`Periodo: ${site?.dates?.start || "-"} → ${site?.dates?.end || "-"}`);

    doc.moveDown();
    doc.fontSize(14).text("Lavoratori:", { underline: true });
    workers.forEach((w) => {
      doc.fontSize(12).text(`- ${w.name} (${w.role}) • Corso: ${w?.docs?.corso || "N/A"} • Visita: ${w?.docs?.visita || "N/A"}`);
    });

    doc.moveDown();
    doc.fontSize(14).text("Attività / Rischi / Misure:", { underline: true });
    doc.fontSize(12).text(`Attività: ${vars.activities || "—"}`);
    doc.text(`Rischi: ${vars.risks || "—"}`);
    doc.text(`Misure: ${vars.measures || "—"}`);

    doc.end();

    // quando finisce lo stream, rispondi con link
    stream.on("finish", () => {
      const rel = `/generated/${fileName}`;
      const url = `${baseUrl(req)}${rel}`;
      res.json({ ok: true, file: rel, url });
    });

    stream.on("error", (e) => {
      console.error("PDF stream error:", e);
      res.status(500).json({ ok: false, error: "PDF generation failed" });
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "POS error" });
  }
});

// ---- OCR upload (stub) ----
// file <= 15MB, estensioni: pdf/jpg/jpeg/png
const upload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, UPLOADS_DIR),
    filename: (_, file, cb) => {
      const ts = Date.now();
      const clean = file.originalname.replace(/[^\w.\-]/g, "_");
      cb(null, `${ts}_${clean}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /pdf|jpg|jpeg|png/i.test(file.mimetype) || /\.(pdf|jpg|jpeg|png)$/i.test(file.originalname);
    cb(ok ? null : new Error("Unsupported file type"));
  },
});

app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "File missing" });

    const rel = `/uploads/${req.file.filename}`;
    const url = `${baseUrl(req)}${rel}`;

    // OCR STUB — evita errori se Vision non configurato
    const ocrText = `(OCR stub) File caricato correttamente: ${req.file.originalname}\nPercorso: ${rel}\nNota: abilita Google Vision per OCR reale.`;

    res.json({ ok: true, file: rel, url, ocr: ocrText });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message || "Upload error" });
  }
});

// ---- start ----
app.listen(PORT, () => {
  console.log(`Kanthera backend running on port ${PORT}`);
});
