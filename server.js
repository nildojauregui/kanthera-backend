// server.js — Kanthera Backend V1.6 (ESM, CORS fix + seed demo)

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

/* -------------------- Paths & FS helpers -------------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const DATA_DIR      = path.join(__dirname, "data");
const UPLOADS_DIR   = path.join(__dirname, "uploads");
const GENERATED_DIR = path.join(__dirname, "generated");

const SITES_FILE   = path.join(DATA_DIR, "sites.json");
const WORKERS_FILE = path.join(DATA_DIR, "workers.json");
const USERS_FILE   = path.join(DATA_DIR, "users.json");
const COMPANY_FILE = path.join(DATA_DIR, "company.json");

for (const d of [DATA_DIR, UPLOADS_DIR, GENERATED_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

async function ensureJson(file, fallback = "[]") {
  try { await fsp.access(file, fs.constants.F_OK); }
  catch { await fsp.writeFile(file, fallback, "utf8"); }
}
await ensureJson(SITES_FILE,   "[]");
await ensureJson(WORKERS_FILE, "[]");
await ensureJson(USERS_FILE,   "[]");
await ensureJson(COMPANY_FILE, "{}");

async function readJson(file) {
  try {
    const t = await fsp.readFile(file, "utf8");
    if (!t) return file === COMPANY_FILE ? {} : [];
    return JSON.parse(t);
  } catch {
    return file === COMPANY_FILE ? {} : [];
  }
}
async function writeJson(file, data) {
  const pretty = JSON.stringify(data, null, 2);
  await fsp.writeFile(file, pretty, "utf8");
}

/* -------------------- Permissions model -------------------- */
const PERM = {
  VIEW_PSC:                 ['owner','coordinator','contractor','subcontractor','supervisor','admin'],
  EDIT_PSC:                 ['coordinator','admin'],
  UPLOAD_POS:               ['contractor','subcontractor','supervisor','admin'],
  APPROVE_DOCS:             ['owner','coordinator','supervisor','admin'],
  VIEW_MINUTES:             ['owner','coordinator','contractor','subcontractor','supervisor','admin'],
  MANAGE_SITE_USERS:        ['owner','coordinator','admin'],
  VIEW_DVR:                 ['owner','coordinator','contractor','subcontractor','supervisor','admin'],
  UPLOAD_SAL:               ['owner','contractor','supervisor','admin'],
  VIEW_SCHEDULE:            ['owner','coordinator','contractor','subcontractor','supervisor','admin'],
  UPLOAD_INSPECTION_PHOTOS: ['coordinator','contractor','subcontractor','supervisor','admin'],
  VIEW_TRAINING:            ['owner','coordinator','contractor','subcontractor','supervisor','admin'],
  DOWNLOAD_REPORTS:         ['owner','coordinator','contractor','supervisor','admin']
};
const COMPANY_CAN_INVITE = ['company_admin','company_manager'];

/* -------------------- App & CORS (Opzione 1) -------------------- */
const app = express();
app.use(express.json({ limit: "10mb" }));

// Imposta il dominio del frontend (senza slash finale)
const ALLOW_ORIGIN = (process.env.CORS_ORIGIN || "https://kanthera-backend.netlify.app").replace(/\/$/, "");

// Config CORS robusta + preflight
const corsCfg = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // es. curl/health
    if (ALLOW_ORIGIN === "*" || origin === ALLOW_ORIGIN) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`), false);
  },
  methods: ["GET","POST","PATCH","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","x-user-id","x-company-role"],
  credentials: false,
};
app.options("*", cors(corsCfg));
app.use(cors(corsCfg));

// Logging minimale utile per debug Render
app.use((req,res,next)=>{
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} origin=${req.headers.origin||'-'}`);
  next();
});

app.use("/uploads",   express.static(UPLOADS_DIR));
app.use("/generated", express.static(GENERATED_DIR));

// Auth light (demo)
app.use(async (req, res, next) => {
  const id = req.header("x-user-id") || "USR-0001";
  const company_role = req.header("x-company-role") || "company_admin";
  req.user = { id, company_role };

  req.can = async (action, siteId) => {
    if (!siteId) return true;
    const sites = await readJson(SITES_FILE);
    const site  = sites.find(s => s.id === siteId);
    if (!site) return false;
    const entry = (site.roles || []).find(r => r.user_id === req.user.id);
    const role  = entry?.role;
    if (!role) return false;
    return PERM[action]?.includes(role) || role === 'admin';
  };
  next();
});

/* -------------------- Health -------------------- */
app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "kanthera" });
});

/* -------------------- Company & Users -------------------- */
app.get("/api/company", async (req, res) => {
  const c = await readJson(COMPANY_FILE);
  res.json(c);
});

app.get("/api/users", async (req, res) => {
  const u = await readJson(USERS_FILE);
  res.json(u);
});

app.post("/api/invite", async (req, res) => {
  if (!COMPANY_CAN_INVITE.includes(req.user.company_role)) {
    return res.status(403).json({ ok: false, error: "Forbidden" });
  }
  const { email, name, company_role = "company_viewer" } = req.body || {};
  if (!email || !name) return res.status(400).json({ ok: false, error: "name & email required" });
  const users = await readJson(USERS_FILE);
  const exists = users.find(u => u.email === email);
  if (exists) return res.json({ ok: true, user: exists });
  const user = { id: "USR-" + nanoid(4).toUpperCase(), email, name, company_role };
  users.push(user);
  await writeJson(USERS_FILE, users);
  res.json({ ok: true, user });
});

/* -------------------- Sites -------------------- */
function validateSitePayload(p){
  const errors = [];
  if(!p.name) errors.push("Inserisci il nome del cantiere");
  if(!p.address) errors.push("Inserisci l’indirizzo");
  if(!p.dates?.start) errors.push("Inserisci data inizio");
  if(!p.roles || !p.roles.length) errors.push("Assegna almeno un ruolo");
  return errors;
}

app.get("/api/sites", async (req, res) => {
  const sites = await readJson(SITES_FILE);
  res.json(sites);
});

app.get("/api/sites/:id", async (req, res) => {
  const sites = await readJson(SITES_FILE);
  const s = sites.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ ok: false, error: "not found" });
  res.json(s);
});

app.post("/api/sites", async (req, res) => {
  try {
    const payload = req.body || {};
    if(!payload.roles || !payload.roles.length){
      payload.roles = [{ user_id: req.user.id, role: "owner" }];
    }
    const errors = validateSitePayload(payload);
    if (errors.length) return res.status(400).json({ ok: false, errors });

    if (payload.dates?.start && payload.dates?.end) {
      const d1 = new Date(payload.dates.start);
      const d2 = new Date(payload.dates.end);
      const diff = Math.ceil((d2 - d1) / 86400000);
      payload.meta = payload.meta || {};
      payload.meta.duration_days = diff > 0 ? diff : null;
      if (diff > 200) {
        payload.meta.warnings = Array.from(new Set([...(payload.meta.warnings||[]), "PSC obbligatorio"]));
      }
    }

    const sites = await readJson(SITES_FILE);
    const id = "CNT-" + nanoid(4).toUpperCase();
    const site = {
      id,
      name: payload.name,
      address: payload.address || "",
      client: payload.client || "",
      client_phone: payload.client_phone || null,
      dates: payload.dates || { start: null, end: null },
      cse: payload.cse || { name: null, email: null },
      workers: payload.workers || [],
      roles: payload.roles || [],
      meta: payload.meta || {}
    };
    sites.push(site);
    await writeJson(SITES_FILE, sites);
    res.json(site);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

/* ---- Gestione utenti di cantiere ---- */
app.get("/api/sites/:id/users", async (req,res)=>{
  const sites = await readJson(SITES_FILE);
  const s = sites.find(x=>x.id===req.params.id);
  if(!s) return res.status(404).json({ok:false,error:"not found"});
  res.json(s.roles || []);
});
app.post("/api/sites/:id/users", async (req,res)=>{
  if(!(await req.can('MANAGE_SITE_USERS', req.params.id)))
    return res.status(403).json({ok:false,error:'Forbidden'});
  const { user_id, role } = req.body||{};
  const sites = await readJson(SITES_FILE);
  const s = sites.find(x=>x.id===req.params.id);
  if(!s) return res.status(404).json({ok:false,error:'not found'});
  s.roles = s.roles || [];
  const i = s.roles.findIndex(r=>r.user_id===user_id);
  if(i>-1) s.roles[i].role = role; else s.roles.push({user_id, role});
  await writeJson(SITES_FILE, sites);
  res.json({ok:true, roles:s.roles});
});
app.delete("/api/sites/:id/users/:user_id", async (req,res)=>{
  if(!(await req.can('MANAGE_SITE_USERS', req.params.id)))
    return res.status(403).json({ok:false,error:'Forbidden'});
  const sites = await readJson(SITES_FILE);
  const s = sites.find(x=>x.id===req.params.id);
  if(!s) return res.status(404).json({ok:false,error:'not found'});
  s.roles = (s.roles||[]).filter(r=>r.user_id!==req.params.user_id);
  await writeJson(SITES_FILE, sites);
  res.json({ok:true, roles:s.roles});
});

/* ---- Assegnazione lavoratori al cantiere ---- */
// Ritorna l'elenco completo dei worker (oggetti) assegnati al cantiere
app.get("/api/sites/:id/workers", async (req, res) => {
  const sites   = await readJson(SITES_FILE);
  const workers = await readJson(WORKERS_FILE);
  const s = sites.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ ok:false, error:"site not found" });
  const list = (s.workers || []).map(id => workers.find(w => w.id === id)).filter(Boolean);
  res.json(list);
});

// Aggiunge un worker al cantiere (se non già presente)
app.post("/api/sites/:id/workers", async (req, res) => {
  const { worker_id } = req.body || {};
  if (!worker_id) return res.status(400).json({ ok:false, error:"worker_id required" });

  const sites   = await readJson(SITES_FILE);
  const workers = await readJson(WORKERS_FILE);

  const s = sites.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ ok:false, error:"site not found" });

  const existsWorker = workers.some(w => w.id === worker_id);
  if (!existsWorker) return res.status(404).json({ ok:false, error:"worker not found" });

  s.workers = s.workers || [];
  if (!s.workers.includes(worker_id)) s.workers.push(worker_id);

  await writeJson(SITES_FILE, sites);
  res.json({ ok:true, workers: s.workers });
});

// Rimuove un worker dal cantiere
app.delete("/api/sites/:id/workers/:worker_id", async (req, res) => {
  const sites = await readJson(SITES_FILE);
  const s = sites.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ ok:false, error:"site not found" });
  s.workers = (s.workers || []).filter(id => id !== req.params.worker_id);
  await writeJson(SITES_FILE, sites);
  res.json({ ok:true, workers: s.workers });
});


/* -------------------- Workers -------------------- */
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
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.patch("/api/workers/:id", async (req, res) => {
  try {
    const workers = await readJson(WORKERS_FILE);
    const idx = workers.findIndex(w => w.id === req.params.id);
    if (idx === -1) return res.status(404).json({ ok: false, error: "not found" });
    const merged = { ...workers[idx], ...req.body };
    if (req.body?.docs) {
      merged.docs = { ...(workers[idx].docs||{}), ...(req.body.docs||{}) };
    }
    workers[idx] = merged;
    await writeJson(WORKERS_FILE, workers);
    res.json({ ok: true, worker: workers[idx] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.delete("/api/workers/:id", async (req,res)=>{
  const workers = await readJson(WORKERS_FILE);
  const left = workers.filter(w=>w.id!==req.params.id);
  await writeJson(WORKERS_FILE, left);
  res.json({ok:true});
});

/* -------------------- Upload & OCR+AI -------------------- */
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS_DIR),
  filename:    (_, file, cb) => {
    const safe = file.originalname.replace(/\s+/g, "_");
    cb(null, `${Date.now()}_${safe}`);
  }
});
const upload = multer({ storage });

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

app.post("/api/workers/:id/docs", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "file missing" });

    const ocrText = `OCR from: ${req.file.originalname}`;

    let extracted = {};
    let confidence = 0.7;

    if (openai) {
      const prompt = `
Estrai i seguenti campi dal testo OCR. Rispondi SOLO in JSON:
{
  "doc_type": "visita_medica | formazione_generale | formazione_specifica | alto_rischio | antincendio | primo_soccorso | dpi | tesserino | preposto | rls | altro",
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
      } catch {
        extracted = {};
      }
    }

    res.json({
      ok: true,
      file: `/uploads/${req.file.filename}`,
      url:  `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`,
      ocr:  ocrText,
      extracted,
      confidence
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

/* -------------------- POS (PDF) -------------------- */
app.post("/api/pos", async (req, res) => {
  try {
    const { site, workers } = req.body || {};
    if (!site?.name) return res.status(400).json({ ok: false, error: "site required" });

    const company  = await readJson(COMPANY_FILE);
    const filename = `POS_${site.id || "SITE"}_${new Date().toISOString().replace(/[:.]/g, "-")}.pdf`;
    const outPath  = path.join(GENERATED_DIR, filename);

    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);

    doc.fontSize(18).text("Piano Operativo di Sicurezza (POS)", { align: "center" }).moveDown();

    // 1) Impresa
    doc.fontSize(12).text("1) Identificazione impresa", { underline: true });
    doc.text(`Impresa: ${company.name || '—'} – P.IVA ${company.vat || '—'}`);
    doc.text(`Sede: ${company.address || '—'}`);
    doc.text(`Legale Rappresentante: ${company.legal_rep || '—'}`);
    doc.moveDown();

    // 2) Cantiere
    doc.text("2) Descrizione cantiere", { underline: true });
    doc.text(`Indirizzo: ${site.address || '—'}`);
    doc.text(`Committente: ${site.client || '—'}`);
    const start = site.dates?.start || '';
    const end   = site.dates?.end   || '';
    const dur   = site.meta?.duration_days || '—';
    doc.text(`Durata: ${start} → ${end} (${dur} gg)`);
    doc.moveDown();

    // 3) Organizzazione sicurezza
    doc.text("3) Organizzazione sicurezza", { underline: true });
    doc.text(`CSE: ${site.cse?.name || '—'} – ${site.cse?.email || '—'}`);
    doc.text(`RSPP: ${company.rspp?.name || '—'} – ${company.rspp?.email || '—'}`);
    const preposto = (workers||[]).find(w => w.docs?.preposto);
    const rls      = (workers||[]).find(w => w.docs?.rls);
    doc.text(`Preposto: ${preposto?.name || '—'}`);
    doc.text(`RLS: ${rls?.name || '—'}`);
    doc.moveDown();

    // 4) Elenco lavoratori
    doc.text("4) Elenco lavoratori", { underline: true });
    (workers || []).forEach((w, i) => {
      const idoneita = w.docs?.visita_medica ? 'Idoneo' : '—';
      const gen = w.docs?.corso_generale ? 'OK' : '—';
      const spec= w.docs?.corso_specifica_fs ? 'OK' : '—';
      const dpi = w.docs?.dpi_consegna ? 'OK' : '—';
      doc.text(`- ${w.name} (${w.role || 'Operaio'}) — Idoneità: ${idoneita}, Gen: ${gen}, Spec: ${spec}, DPI: ${dpi}`);
      if (i && i % 30 === 0) doc.addPage();
    });
    doc.moveDown();

    // Placeholder
    doc.text("5) Macchinari e attrezzature — da completare", { underline: true }).moveDown();
    doc.text("6) Procedure operative — da completare", { underline: true }).moveDown();
    doc.text("7) Valutazione rischi specifici — da completare", { underline: true }).moveDown();
    doc.text("8) Misure di prevenzione e protezione — da completare", { underline: true }).moveDown();
    doc.text("9) Piano di emergenza — da completare", { underline: true }).moveDown();
    doc.text("10) Cronoprogramma POS — da completare", { underline: true });

    doc.end();
    await new Promise(resolve => stream.on("finish", resolve));

    res.json({
      ok: true,
      file: `/generated/${filename}`,
      url:  `${req.protocol}://${req.get("host")}/generated/${filename}`
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

/* -------------------- SEED (demo, opzionale) -------------------- */
// Esegui UNA VOLTA per popolare company/sites/workers con dati demo.
// Puoi rimuovere questa route dopo la demo.
app.all("/api/seed", async (req, res) => {
  try {
    const company = {
      name: "Pavi Servizi S.A.S.",
      vat: "IT02634910182",
      address: "Via Gravellone 11, San Martino Siccomario (PV)",
      legal_rep: "Nildo Jauregui",
      rspp: { name: "Ing. Marco RSPP", email: "marco.rsp@paviservizi.it" }
    };
    await writeJson(COMPANY_FILE, company);

    const workers = [
      {
        id: "DIP-0001",
        name: "Mario Rossi",
        cf: "RSSMRA80A01H501U",
        role: "Operaio",
        docs: {
          visita_medica: "2026-05-20",
          corso_generale: "2029-09-01",
          corso_specifica_fs: "2029-09-01",
          dpi_consegna: true,
          tesserino: true,
          preposto: true,
          antincendio: "2027-02-01",
          ps: "2027-02-01"
        }
      },
      {
        id: "DIP-0002",
        name: "Giuseppe Verdi",
        cf: "VRDGPP85B12H501S",
        role: "Operaio",
        docs: {
          visita_medica: "2026-01-15",
          corso_generale: "2028-05-10",
          corso_specifica_fs: "2028-05-10",
          dpi_consegna: true,
          tesserino: true,
          antincendio: "2027-08-01"
        }
      }
    ];
    await writeJson(WORKERS_FILE, workers);

    const sites = [
      {
        id: "CNT-0001",
        name: "Cantiere Sede Cliente Verdi – Piano 3",
        address: "Via Roma 12, Bologna",
        client: "Cliente Verdi Srl",
        dates: { start: "2025-11-01", end: "2026-03-31" },
        cse: { name: "Laura Bianchi", email: "laura.bianchi@uffici.co" },
        workers: ["DIP-0001","DIP-0002"],
        roles: [{ user_id: "USR-0001", role: "owner" }],
        meta: { duration_days: 150 }
      },
      {
        id: "CNT-0002",
        name: "Ristrutturazione Uffici – Lotto B",
        address: "Via Milano 45, Modena",
        client: "Uffici & Co.",
        dates: { start: "2025-10-15", end: "2026-02-28" },
        cse: { name: "Laura Bianchi", email: "laura.bianchi@uffici.co" },
        workers: ["DIP-0001"],
        roles: [{ user_id: "USR-0001", role: "owner" }],
        meta: { duration_days: 136 }
      }
    ];
    await writeJson(SITES_FILE, sites);

    res.json({ ok: true, company, workersCount: workers.length, sitesCount: sites.length });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

/* -------------------- Capability check -------------------- */
app.get("/api/can", async (req,res)=>{
  const action = req.query.action;
  const siteId  = req.query.site;
  const allowed = await req.can(action, siteId);
  res.json({ ok: true, can: allowed });
});

/* -------------------- Boot -------------------- */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("kanthera backend on", PORT);
});
