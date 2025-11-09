// KANTHERA V1.2 — Backend with OCR + GPT-4o-mini AI extraction
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import PDFDocument from "pdfkit";
import { nanoid } from "nanoid";
import OpenAI from "openai";

// ---- CONFIG ----
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
let visionClient = null;
try {
  const vision = await import("@google-cloud/vision");
  visionClient = new vision.ImageAnnotatorClient();
} catch (e) { /* fallback ok */ }

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 10000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

app.use(cors({ origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN }));
app.use(express.json({ limit: "10mb" }));

// ---- PATHS ----
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");
const UPLOADS_DIR = path.join(__dirname, "uploads");
const GENERATED_DIR = path.join(__dirname, "generated");
[DATA_DIR, UPLOADS_DIR, GENERATED_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});
app.use("/uploads", express.static(UPLOADS_DIR));
app.use("/generated", express.static(GENERATED_DIR));

function readDB() { return JSON.parse(fs.readFileSync(DB_PATH, "utf8")); }
function writeDB(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }
const baseUrl = req => `${req.headers["x-forwarded-proto"]||"https"}://${req.headers.host}`;

// ---- BASIC ROUTES ----
app.get("/api/health", (_, res) => res.json({ ok:true, service:"kanthera" }));
app.get("/api/workers", (_, res)=>res.json(readDB().workers));
app.get("/api/sites",   (_, res)=>res.json(readDB().sites));
app.get("/api/config",  (_, res)=>res.json(readDB().config));

// ---- CREATE WORKER ----
app.post("/api/workers",(req,res)=>{
  const db = readDB();
  const {name, cf, role, company_id} = req.body || {};
  if(!name||!cf) return res.status(400).json({ok:false,error:"name/cf required"});
  const id = "DIP-" + nanoid(6).toUpperCase();
  db.workers.push({ id, company_id:company_id||"IMP-0001", name, cf, role:role||"Operaio", docs:{} });
  writeDB(db); res.json({ok:true,id});
});

// ---- CREATE SITE ----
app.post("/api/sites",(req,res)=>{
  const db = readDB();
  const {name,address,client,client_cf_piva,cse,dates,workers} = req.body||{};
  if(!name) return res.status(400).json({ok:false,error:"name required"});
  const id = "CNT-" + nanoid(6).toUpperCase();
  db.sites.push({ id,name,address:address||"",client:client||"",client_cf_piva:client_cf_piva||"",
    cse:cse||{name:"",email:""},dates:dates||{start:"",end:""},workers:Array.isArray(workers)?workers:[] });
  writeDB(db); res.json({ok:true,id});
});

// ---- SETTINGS ----
app.post("/api/config",(req,res)=>{
  const db = readDB();
  db.config = {...db.config, ...(req.body||{})};
  writeDB(db); res.json({ok:true});
});

// ---- PATCH WORKER ----
app.patch("/api/workers/:id",(req,res)=>{
  const db = readDB();
  const w = db.workers.find(x=>x.id===req.params.id);
  if(!w) return res.status(404).json({ok:false,error:"not found"});
  Object.assign(w, req.body||{});
  writeDB(db); res.json({ok:true});
});

// ---- POS PDF ----
app.post("/api/pos",(req,res)=>{
  const {site, workers=[], vars={}} = req.body||{};
  if(!site||!site.id) return res.status(400).json({ok:false,error:"missing site"});
  const ts = new Date().toISOString().replace(/[:.]/g,"-");
  const file = `POS_${site.id}_${ts}.pdf`;
  const fp = path.join(GENERATED_DIR, file);
  const doc = new PDFDocument({ size:"A4", margin:50 });
  doc.pipe(fs.createWriteStream(fp));
  doc.fontSize(18).text("Piano Operativo di Sicurezza (POS)",{align:"center"}).moveDown();
  doc.fontSize(12).text(`Cantiere: ${site.name}`).text(`Committente: ${site.client||"-"}`)
     .text(`Periodo: ${site?.dates?.start||"-"} → ${site?.dates?.end||"-"}`).moveDown()
     .fontSize(14).text("Lavoratori",{underline:true});
  workers.forEach(w=>doc.fontSize(12).text(`- ${w.name} (${w.role}) • Corso: ${w?.docs?.corso||"N/D"} • Visita: ${w?.docs?.visita||"N/D"}`));
  doc.end();
  res.json({ok:true,file:`/generated/${file}`,url:`${baseUrl(req)}/generated/${file}`});
});

// ---- OCR + AI Extraction ----
const upload = multer({
  storage: multer.diskStorage({
    destination: (_,__,cb)=>cb(null,UPLOADS_DIR),
    filename:(_,f,cb)=>cb(null,`${Date.now()}_${f.originalname.replace(/[^\w.\-]/g,"_")}`)
  }),
  limits:{fileSize:15*1024*1024}
});

app.post("/api/workers/:id/docs", upload.single("file"), async (req,res)=>{
  try {
    if(!req.file) return res.status(400).json({ok:false,error:"file missing"});

    // 1. OCR
    let ocrText = `(OCR stub) ${req.file.originalname}`;
    if (visionClient) {
      try {
        const isPdf = /\.pdf$/i.test(req.file.originalname);
        const [result] = isPdf
          ? await visionClient.documentTextDetection(req.file.path)
          : await visionClient.textDetection(req.file.path);
        ocrText = result?.fullTextAnnotation?.text ||
                  result?.textAnnotations?.[0]?.description || ocrText;
      } catch(e){ /* fallback */ }
    }

    // 2. LLM Extraction (GPT-4o-mini)
    const prompt = `
    Estrarrai dati da un documento di cantiere.
    RISPONDI SOLO IN JSON (nessun testo extra).

    Campi richiesti:
    {
      "doc_type": "visita_medica | formazione_generale | formazione_specifica | antincendio | ps | dpi_consegna | tesserino | altro",
      "holder_name": "string",
      "cf": "string|null",
      "issue_date": "YYYY-MM-DD|null",
      "expiry_date": "YYYY-MM-DD|null",
      "confidence_overall": 0.0-1.0
    }

    OCR:
    """${ocrText.slice(0,5000)}"""`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [{ role: "user", content: prompt }]
    });

    let extraction = {};
    try { extraction = JSON.parse(completion.choices[0].message.content); }
    catch { extraction = {}; }

    // 3. Fallback regex
    const rx = /(\b\d{2}\/\d{2}\/\d{4}\b)|(\b\d{4}-\d{2}-\d{2}\b)/g;
    const dates = [...(ocrText.match(rx)||[])];
    if(!extraction.issue_date) extraction.issue_date = dates[0]||null;
    if(!extraction.expiry_date) extraction.expiry_date = dates[1]||null;

    res.json({
      ok:true,
      file:`/uploads/${req.file.filename}`,
      url:`${baseUrl(req)}/uploads/${req.file.filename}`,
      ocr: ocrText.slice(0,2000),
      extracted: extraction,
      confidence: extraction.confidence_overall || 0.7
    });
  } catch(e){
    console.error(e);
    res.status(500).json({ok:false,error:e.message});
  }
});

app.listen(PORT,()=>console.log("kanthera backend on",PORT));
