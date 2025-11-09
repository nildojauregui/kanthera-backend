import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import cors from 'cors';
import bodyParser from 'body-parser';
import multer from 'multer';
import dotenv from 'dotenv';

dotenv.config();
const __dirname = path.resolve();
const app = express();

const PORT = process.env.PORT || 3001;
const ORIGIN = process.env.CORS_ORIGIN || '*';
app.use(cors({ origin: ORIGIN }));
app.use(bodyParser.json());

// Folders
const GENERATED_DIR = path.join(__dirname, 'backend', 'backend_generated');
const UPLOADS_DIR = path.join(__dirname, 'backend', 'uploads');
if (!fs.existsSync(GENERATED_DIR)) fs.mkdirSync(GENERATED_DIR, {recursive:true});
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, {recursive:true});
app.use('/generated', express.static(GENERATED_DIR));
app.use('/uploads', express.static(UPLOADS_DIR));

// Data
const DATA_PATH = path.join(__dirname, 'data', 'seed.json');
const readDB = () => JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
const writeDB = (db) => fs.writeFileSync(DATA_PATH, JSON.stringify(db, null, 2));

// Routes
app.get('/api/health', (_,res)=>res.json({ok:true, service:'kanthera-backend'}));
app.get('/api/sites', (_,res)=>res.json(readDB().sites));
app.get('/api/workers', (_,res)=>res.json(readDB().workers));
app.get('/api/companies', (_,res)=>res.json(readDB().companies));

app.post('/api/sites', (req,res)=>{
  const db = readDB();
  const s = req.body;
  if(!s.id) s.id = 'CNT-' + String(db.sites.length+1).padStart(4,'0');
  db.sites.push(s);
  writeDB(db);
  res.json({ok:true, site:s});
});

app.post('/api/pos', (req,res)=>{
  const payload = req.body || {};
  const ts = new Date().toISOString().replace(/[:]/g,'-').slice(0,19);
  const outPath = path.join(GENERATED_DIR, `POS_${(payload.site?.id||'CNT-XXXX')}_${ts}.pdf`);

  const doc = new PDFDocument({ margin:40 });
  doc.pipe(fs.createWriteStream(outPath));

  // Header
  doc.rect(40,40,530,30).fill('#0B1220').stroke();
  doc.fill('#FFFFFF').fontSize(14).text('Kanthera — Tu costruisci. Noi semplifichiamo.', 50, 48);
  doc.fill('#000000').moveDown(2);

  doc.fontSize(20).text('POS – Piano Operativo di Sicurezza', { align:'left' });
  doc.moveDown();
  doc.fontSize(12).text('Site: ' + (payload.site?.name || '—'));
  doc.text('Address: ' + (payload.site?.address || '—'));
  doc.text('Client: ' + (payload.site?.client || '—') + ' — ' + (payload.site?.client_cf_piva || '—'));
  doc.text('CSE: ' + (payload.site?.cse?.name || '—') + ' — ' + (payload.site?.cse?.email || '—'));
  doc.text('Period: ' + (payload.site?.dates?.start || '—') + ' → ' + (payload.site?.dates?.end || '—'));
  doc.moveDown();

  doc.fontSize(14).text('Workers');
  (payload.workers||[]).forEach(w=>{
    doc.fontSize(12).text(`- ${w.name} (${w.role}) • Course: ${w.docs?.corso||'N/A'} • Checkup: ${w.docs?.visita||'N/A'}`);
  });
  doc.moveDown();

  doc.fontSize(14).text('Risks & Measures');
  doc.fontSize(12).text('Activities: ' + (payload.vars?.activities || '—'));
  doc.text('Risks: ' + (payload.vars?.risks || '—'));
  doc.text('Measures: ' + (payload.vars?.measures || '—'));
  doc.end();

  res.json({ ok:true, file: '/generated/' + path.basename(outPath) });
});

// OCR upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ts = new Date().toISOString().replace(/[:]/g,'-').slice(0,19);
    const safe = (file.originalname || 'upload').replace(/[^a-zA-Z0-9._-]/g,'_');
    cb(null, ts + '_' + safe);
  }
});
const upload = multer({ storage });

let visionClient = null;
try {
  const vision = await import('@google-cloud/vision');
  visionClient = new vision.ImageAnnotatorClient();
} catch (e) {
  console.warn('Google Vision not configured. OCR will return a stub unless configured.');
}

app.post('/api/upload', upload.single('file'), async (req,res)=>{
  try {
    const fpath = req.file.path;
    let ocrText = '';
    if (visionClient) {
      const [result] = await visionClient.textDetection(fpath);
      ocrText = (result.fullTextAnnotation && result.fullTextAnnotation.text) || '';
    } else {
      ocrText = '(OCR stub) Configure Google Vision to extract text. File saved at ' + fpath;
    }
    res.json({ ok:true, file: '/uploads/' + path.basename(fpath), ocr: ocrText });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok:false, error: String(err) });
  }
});

app.listen(PORT, ()=>console.log('Kanthera backend running on http://localhost:'+PORT));
