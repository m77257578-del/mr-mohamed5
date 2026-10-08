// منصة الأستاذ محمد عبد المقصود — خادم Node.js وVercel Functions
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
// تحميل الإعدادات من ملف .env إن وُجد (سطر لكل إعداد: الاسم=القيمة)
try { for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(l); if (m && !l.trim().startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch (e) {}
const PORT = process.env.PORT || 3000;
const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UP = path.join(DIR, 'uploads'), DBF = path.join(DIR, 'db.json');
const ON_VERCEL = process.env.VERCEL === '1';
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const STORAGE_BUCKET = 'platform-files';
if (!ON_VERCEL) fs.mkdirSync(UP, { recursive: true });

const rnd = n => crypto.randomBytes(n).toString('hex');
const scrypt = (s, salt) => crypto.scryptSync(String(s), salt, 32).toString('hex');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const mk = (p, n = 6) => p + '-' + [...crypto.randomBytes(n)].map(b => ALPH[b % 32]).join('');
const E = (status, message) => Object.assign(new Error(message), { status });

const freshDb = () => ({ settings: { name: 'منصة الأستاذ محمد عبد المقصود', heroFile: '', heroMime: '', heroV: 0, salt: rnd(16), pepper: rnd(16), teacher: '' },
  students: [], parents: [], courses: [], content: [], notices: [], exams: [], results: [], appeals: [], messages: [], codes: [], notes: [], activity: [], orders: [] });
let db = freshDb(), cloudRevision = 0, cloudDirty = false;
if (!ON_VERCEL && fs.existsSync(DBF)) db = Object.assign(db, JSON.parse(fs.readFileSync(DBF, 'utf8')));
function initializeTeacher(state) {
  if (state.settings.teacher) return;
  const password = process.env.TEACHER_PASSWORD;
  if (!password || password.length < 12) throw new Error('اضبط TEACHER_PASSWORD في ملف .env بكلمة مرور لا تقل عن 12 حرفاً');
  state.settings.teacher = scrypt(password, state.settings.salt);
}
if (!ON_VERCEL) initializeTeacher(db);
let timer;
const flush = () => { clearTimeout(timer); timer = null; fs.writeFileSync(DBF + '.tmp', JSON.stringify(db)); fs.renameSync(DBF + '.tmp', DBF); };
const save = () => {
  if (ON_VERCEL) { cloudDirty = true; return; }
  clearTimeout(timer); timer = setTimeout(flush, 150);
};
if (!ON_VERCEL) save();

async function supabase(pathname, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw E(503, 'إعدادات Supabase غير مكتملة في Vercel');
  const response = await fetch(SUPABASE_URL + pathname, {
    ...options,
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
  });
  if (!response.ok) {
    const detail = await response.text();
    console.error('Supabase request failed:', response.status, detail);
    throw E(503, 'تعذر الاتصال بقاعدة بيانات المنصة في Supabase');
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function loadCloudDb() {
  const rows = await supabase('/rest/v1/platform_state?select=revision,data&id=eq.1');
  if (!rows.length) throw E(503, 'بيانات المنصة غير منقولة إلى Supabase؛ شغّل npm run migrate:supabase');
  const defaults = freshDb();
  const stored = rows[0].data || {};
  db = { ...defaults, ...stored, settings: { ...defaults.settings, ...(stored.settings || {}) } };
  cloudRevision = Number(rows[0].revision) || 0;
  cloudDirty = false;
  if (!db.settings.teacher) { initializeTeacher(db); cloudDirty = true; }
}

async function persistCloudDb() {
  if (!cloudDirty) return;
  const saved = await supabase('/rest/v1/rpc/save_platform_state', { method: 'POST', body: JSON.stringify({ p_expected_revision: cloudRevision, p_data: db }) });
  if (saved !== true) throw E(409, 'تغيرت بيانات المنصة بطلب آخر؛ أعد المحاولة');
  cloudRevision++;
  cloudDirty = false;
}

// ---------- جلسات وحماية من التخمين ----------
const sess = new Map(), bad = new Map();
const ipOf = r => String(r.headers['x-forwarded-for'] || r.socket.remoteAddress || '').split(',')[0].trim();
const locked = r => { const b = bad.get(ipOf(r)); return b && b.until > Date.now(); };
const fail = r => { const k = ipOf(r), b = bad.get(k) || { n: 0, until: 0 }; if (++b.n >= 8) { b.until = Date.now() + 600000; b.n = 0; } bad.set(k, b); };
const newSession = (role, id) => {
  const exp = Date.now() + 7 * 864e5;
  if (ON_VERCEL) {
    const payload = Buffer.from(JSON.stringify({ role, id, exp })).toString('base64url');
    const secret = process.env.SESSION_SECRET || SUPABASE_SERVICE_ROLE_KEY;
    const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    return payload + '.' + signature;
  }
  const t = rnd(24); sess.set(t, { role, id, exp }); return t;
};
function auth(req, role, u) {
  const t = (req.headers.authorization || '').slice(7) || u.searchParams.get('t');
  let s = sess.get(t);
  if (ON_VERCEL && t) {
    try {
      const [payload, signature] = t.split('.');
      const secret = process.env.SESSION_SECRET || SUPABASE_SERVICE_ROLE_KEY;
      const expected = crypto.createHmac('sha256', secret).update(payload).digest();
      const actual = Buffer.from(signature, 'base64url');
      if (actual.length === expected.length && crypto.timingSafeEqual(actual, expected)) s = JSON.parse(Buffer.from(payload, 'base64url').toString());
    } catch (e) { s = null; }
  }
  if (!s || s.exp < Date.now() || (role && s.role !== role)) throw E(401, 'سجّل الدخول من جديد');
  return s;
}
const subActive = s => !!s.subEnd && new Date(s.subEnd) > new Date();
const courseActive = (s, courseId) => (s.enrollments || []).some(e => e.courseId === courseId && new Date(e.expiresAt) > new Date());
const hasAccess = (s, item) => !!item.isFree || subActive(s) || (!!item.courseId && courseActive(s, item.courseId));
const gradeOk = (x, s) => x.grade === 'كل الصفوف' || x.grade === s.grade;
const publicCourseView = (course, student = null) => {
  const enrolled = !!student && (subActive(student) || courseActive(student, course.id));
  return {
    id: course.id, title: course.title, description: course.description, grade: course.grade, price: course.price, days: course.days,
    content: enrolled ? db.content.filter(item => item.courseId === course.id && !(item.blocked || []).includes(student.id)).map(item => ({
      id: item.id, type: item.type, title: item.title, fileName: item.fileName, mime: item.mime,
      fileId: item.fileId || '', url: item.fileId ? '/files/' + encodeURIComponent(item.fileId) : item.link
    })) : []
  };
};
const label = p => p >= 85 ? 'ممتاز' : p >= 75 ? 'جيد جداً' : p >= 65 ? 'جيد' : p >= 50 ? 'مقبول' : 'يحتاج متابعة';
const clean = (s, n = 500) => String(s ?? '').trim().slice(0, n);

function send(res, code, obj) { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(b); }
async function body(req, max = 2e6) { let n = 0; const b = []; for await (const c of req) { n += c.length; if (n > max) throw E(413, 'الطلب كبير'); b.push(c); } return b.length ? JSON.parse(Buffer.concat(b)) : {}; }

function serveFile(req, res, id, name, mime) {
  const fp = path.join(UP, path.basename(id));
  if (!fs.existsSync(fp)) throw E(404, 'الملف غير موجود');
  const size = fs.statSync(fp).size, inline = /^(video|image|audio)\//.test(mime) || mime === 'application/pdf';
  const h = { 'Content-Type': inline ? mime : 'application/octet-stream', 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': (inline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(name || 'file'), 'Cache-Control': 'private, max-age=3600' };
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    let a = m[1] ? +m[1] : size - +m[2], b = m[1] && m[2] ? +m[2] : size - 1;
    if (a > b || a >= size) { res.writeHead(416, { 'Content-Range': 'bytes */' + size }); return res.end(); }
    b = Math.min(b, size - 1);
    res.writeHead(206, { ...h, 'Content-Range': `bytes ${a}-${b}/${size}`, 'Content-Length': b - a + 1 });
    return fs.createReadStream(fp, { start: a, end: b }).pipe(res);
  }
  res.writeHead(200, { ...h, 'Content-Length': size });
  fs.createReadStream(fp).pipe(res);
}

function storageSignedUrl(result) {
  const raw = result.signedURL || result.signedUrl || result.url;
  if (!raw) throw E(503, 'تعذر إنشاء رابط الملف');
  const url = /^https?:\/\//i.test(raw) ? new URL(raw) : new URL(raw.startsWith('/storage/v1/') ? raw : '/storage/v1' + (raw.startsWith('/') ? raw : '/' + raw), SUPABASE_URL);
  if (result.token && !url.searchParams.has('token')) url.searchParams.set('token', result.token);
  return url.toString();
}

async function createUploadUrl(fileName, mime) {
  const fileId = rnd(12), safeMime = clean(mime, 100) || 'application/octet-stream';
  const result = await supabase('/storage/v1/object/upload/sign/' + STORAGE_BUCKET + '/' + fileId, { method: 'POST', body: JSON.stringify({ upsert: false }) });
  return { fileId, fileName: clean(fileName, 200) || 'file', mime: safeMime, signedUrl: storageSignedUrl(result) };
}

async function signedDownloadUrl(fileId, expiresIn = 60) {
  const result = await supabase('/storage/v1/object/sign/' + STORAGE_BUCKET + '/' + encodeURIComponent(path.basename(fileId)), { method: 'POST', body: JSON.stringify({ expiresIn }) });
  return storageSignedUrl(result);
}

async function redirectToStoredFile(res, fileId, expiresIn = 60) {
  const url = await signedDownloadUrl(fileId, expiresIn);
  res.writeHead(302, { Location: url, 'Cache-Control': 'private, no-store' });
  return res.end();
}

const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
async function askGemini(question) {
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: 'أنت مساعد ذكي في منصة الأستاذ محمد عبد المقصود التعليمية. ساعد الطلاب في مذاكرة اللغة العربية والإجابة عن أسئلتهم عن المنصة والمدرس بلغة عربية مبسطة ومختصرة. مطور المنصة هو الطالب محمود مدحت زكى، ولا تذكر أي معلومات أخرى عنه. لا تكشف أي إجابات امتحانات.' }] },
        contents: [{ role: 'user', parts: [{ text: question }] }]
      })
    });
    const j = await r.json();
    const text = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts.map(x => x.text || '').join('').trim();
    if (!r.ok || !text) throw new Error('gemini');
    return text.slice(0, 4000);
  } finally { clearTimeout(t); }
}
async function gradeEssayAI(e, answers) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 25000);
  try {
    const prompt = 'صحح إجابات طالب في امتحان مقالي بناءً على نموذج الإجابة أو ما يقاربه في المعنى. أعط كل سؤال درجة من 0 إلى 1 (يجوز 0.5 و0.25). أعد JSON فقط بالشكل {"scores":[...]} بعدد الأسئلة بالترتيب.' +
      '\nالأسئلة:\n' + e.questions.map((q, i) => (i + 1) + '. ' + q).join('\n') +
      '\nنموذج الإجابة:\n' + e.modelAnswer +
      '\nإجابات الطالب:\n' + answers.map((a, i) => (i + 1) + '. ' + a).join('\n');
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + (process.env.GEMINI_MODEL || 'gemini-2.5-flash') + ':generateContent', {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0 } })
    });
    const j = await r.json();
    const txt = j && j.candidates && j.candidates[0] && j.candidates[0].content.parts.map(x => x.text || '').join('');
    const sc = JSON.parse(txt).scores;
    if (!r.ok || !Array.isArray(sc) || sc.length !== answers.length) throw new Error('bad');
    return Math.round(sc.reduce((a, x) => a + Math.min(1, Math.max(0, Number(x) || 0)), 0) * 2) / 2;
  } finally { clearTimeout(t); }
}
const KMID = process.env.KASHIER_MID || '', KAPI = process.env.KASHIER_API_KEY || '', KSECRET = process.env.KASHIER_SECRET_KEY || '';
const KBASE = process.env.KASHIER_MODE === 'live' ? 'https://api.kashier.io' : 'https://test-api.kashier.io';
const onlinePay = () => !!(KMID && KAPI && KSECRET);
const strictEnc = v => encodeURIComponent(String(v)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
function enroll(s, course) {
  s.enrollments ||= [];
  const en = s.enrollments.find(x => x.courseId === course.id);
  const start = en && new Date(en.expiresAt) > new Date() ? new Date(en.expiresAt) : new Date();
  start.setDate(start.getDate() + (Number(course.days) || 30));
  if (en) en.expiresAt = start.toISOString(); else s.enrollments.push({ courseId: course.id, expiresAt: start.toISOString() });
}
const qKind = (e, i) => (e.kinds && e.kinds[i]) || (e.type === 'اختياري' ? 'mcq' : 'essay');
async function saveUpload(req, u) {
  if (ON_VERCEL) {
    const b = await body(req);
    return createUploadUrl(b.name, b.mime);
  }
  const id = rnd(12), fp = path.join(UP, id), ws = fs.createWriteStream(fp);
  let size = 0; req.on('data', c => size += c.length);
  try {
    await new Promise((ok, no) => { req.pipe(ws); ws.on('finish', ok); ws.on('error', no); req.on('aborted', () => { ws.destroy(); no(E(400, 'انقطع الرفع')); }); });
  } catch (e) { fs.rmSync(fp, { force: true }); throw e; }
  const mime = String(req.headers['content-type'] || 'application/octet-stream').replace(/[^\w.+\/-]/g, '').slice(0, 100) || 'application/octet-stream';
  return { fileId: id, fileName: clean(decodeURIComponent(u.searchParams.get('name') || 'file'), 200), mime, size };
}
async function rmFile(id) {
  if (!id) return;
  if (ON_VERCEL) return supabase('/storage/v1/object/' + STORAGE_BUCKET, { method: 'DELETE', body: JSON.stringify({ prefixes: [path.basename(id)] }) });
  fs.rmSync(path.join(UP, path.basename(id)), { force: true });
}


// ---------- عرض بيانات الطالب (بدون إجابات الامتحانات أو أي سر) ----------
function studentView(s) {
  const sub = subActive(s);
  const courses = db.courses.filter(c => (c.status === 'published' || courseActive(s, c.id)) && gradeOk(c, s)).map(c => {
    const enrollment = (s.enrollments || []).find(e => e.courseId === c.id && new Date(e.expiresAt) > new Date());
    return { ...publicCourseView(c, s), active: !!enrollment || sub, expiresAt: enrollment?.expiresAt || (sub ? s.subEnd : ''), imageUrl: c.imageFileId ? '/files/' + encodeURIComponent(c.imageFileId) : (c.imageUrl || '') };
  });
  return {
    profile: { name: s.name, grade: s.grade, code: s.code, subEnd: s.subEnd, sub, phone: s.phone },
    courses,
    notices: db.notices.filter(n => gradeOk(n, s)),
    content: db.content.filter(c => gradeOk(c, s) && hasAccess(s, c) && !(c.blocked || []).includes(s.id)).map(({ id, type, title, grade, link, fileId, fileName, mime, courseId, isFree }) => ({ id, type, title, grade, link, fileId, fileName, mime, courseId, isFree })),
    exams: db.exams.filter(e => gradeOk(e, s) && hasAccess(s, e)).map(e => ({ id: e.id, title: e.title, grade: e.grade, type: e.type, questions: e.questions, kinds: e.kinds || null, options: e.options || [], taken: db.results.some(r => r.examId === e.id && r.studentId === s.id) })),
    results: db.results.filter(r => r.studentId === s.id).map(r => ({ ...r, appeal: db.appeals.find(a => a.resultId === r.id) || null })),
    messages: db.messages.filter(m => m.studentId === s.id),
    notes: db.notes.filter(n => n.studentId === s.id).sort((a, b) => new Date(b.created) - new Date(a.created))
  };
}

async function route(req, res) {
  const u = new URL(req.url, 'http://x'), p = u.pathname, m = req.method;

  // ملفات الواجهة
  if (m === 'GET' && (p === '/' || p === '/index.html')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(path.join(__dirname, 'index.html'))); }
  if (m === 'GET' && p === '/manifest.webmanifest') { res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache' }); return res.end(fs.readFileSync(path.join(__dirname, 'manifest.webmanifest'))); }
  if (m === 'GET' && (p === '/sw.js' || p === '/app-icon-192.png' || p === '/app-icon-512.png')) { res.writeHead(200, { 'Content-Type': p === '/sw.js' ? 'application/javascript; charset=utf-8' : 'image/png', 'Cache-Control': 'no-cache' }); return res.end(fs.readFileSync(path.join(__dirname, p.slice(1)))); }
  if (m === 'GET' && p === '/hero') { if (!db.settings.heroFile) throw E(404, ''); return ON_VERCEL ? redirectToStoredFile(res, db.settings.heroFile) : serveFile(req, res, db.settings.heroFile, 'hero', db.settings.heroMime); }
  if (m === 'GET' && p === '/api/public') return send(res, 200, { name: db.settings.name, payments: db.settings.payments || [], onlinePay: onlinePay(), hero: db.settings.heroFile ? '/hero?v=' + db.settings.heroV : '', courses: db.courses.filter(c => c.status === 'published').map(publicCourseView) });

  if (m === 'GET' && p.startsWith('/public-files/')) {
    const session = auth(req, 'student', u), student = db.students.find(s => s.id === session.id);
    const fid = decodeURIComponent(p.slice('/public-files/'.length)), item = db.content.find(c => c.fileId === fid && c.courseId);
    if (!student || student.status === 'blocked' || !item || !gradeOk(item, student) || !hasAccess(student, item) || (item.blocked || []).includes(student.id)) throw E(403, 'سجّل الدخول وفعّل الكورس لعرض الملف');
    return ON_VERCEL ? redirectToStoredFile(res, fid, 86400) : serveFile(req, res, fid, item.fileName, item.mime);
  }

  // ملفات المحتوى (محمية)
  if (m === 'GET' && p.startsWith('/files/')) {
    const s = auth(req, null, u), fid = p.slice(7), c = db.content.find(x => x.fileId === fid);
    if (!c) throw E(404, 'الملف غير موجود');
    if (s.role === 'student') {
      const st = db.students.find(x => x.id === s.id);
      if (!st || st.status === 'blocked' || !hasAccess(st, c) || !gradeOk(c, st) || (c.blocked || []).includes(st.id)) throw E(403, 'غير مصرّح');
    } else if (s.role !== 'teacher') throw E(403, 'غير مصرّح');
    return ON_VERCEL ? redirectToStoredFile(res, fid) : serveFile(req, res, fid, c.fileName, c.mime);
  }

  // ----- تسجيل ودخول -----
  if (m === 'POST' && p === '/api/kashier/webhook') {
    const j = await body(req), d = j && j.data;
    if (!onlinePay() || !d || !Array.isArray(d.signatureKeys)) throw E(400, 'طلب غير صالح');
    const payload = [...d.signatureKeys].sort().map(k => k + '=' + strictEnc(d[k])).join('&');
    const sig = crypto.createHmac('sha256', KAPI).update(payload).digest('hex'), got = String(req.headers['x-kashier-signature'] || '').toLowerCase();
    if (sig.length !== got.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(got))) throw E(401, 'توقيع غير صالح');
    const o = (db.orders || []).find(x => x.id === String(d.merchantOrderId));
    if (!o) return send(res, 200, { ok: true });
    if (o.status === 'paid') throw E(409, 'تمت المعالجة');
    if (d.status !== 'SUCCESS') return send(res, 200, { ok: true });
    const st = db.students.find(x => x.id === o.studentId), course = db.courses.find(x => x.id === o.courseId);
    if (Number(d.amount) !== Number(o.amount) || String(d.currency) !== 'EGP' || !st || !course) { o.status = 'review'; o.txn = String(d.transactionId || ''); save(); return send(res, 200, { ok: true }); }
    enroll(st, course); o.status = 'paid'; o.paidAt = new Date().toISOString(); o.txn = String(d.transactionId || ''); save();
    return send(res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/api/register') {
    const b = await body(req), name = clean(b.name, 100), phone = clean(b.phone, 20), pphone = clean(b.parentPhone, 20);
    if (!name || !/^01\d{9}$/.test(phone) || !/^01\d{9}$/.test(pphone)) throw E(400, 'اكتب الاسم ورقمي هاتف صحيحين من 11 رقماً');
    const pw = clean(b.password, 100);
    if (pw.length < 4) throw E(400, 'اكتب كلمة سر من 4 أحرف على الأقل');
    if (db.students.some(q => q.phone === phone)) throw E(409, 'رقم الهاتف مسجل بالفعل، ادخل بكلمة السر');
    if (db.students.length > 20000) throw E(400, 'تعذر التسجيل حالياً');
    const s = { id: rnd(6), code: mk('ST'), name, phone, grade: clean(b.grade, 80), governorate: clean(b.governorate, 60), center: clean(b.center, 60), village: clean(b.village, 60), parentName: clean(b.parentName, 100), parentPhone: pphone, status: 'active', subEnd: '', created: new Date().toISOString() };
    s.pass = scrypt(pw, db.settings.salt + s.id);
    const pr = { id: rnd(6), code: mk('PR'), studentId: s.id, name: s.parentName, status: 'active' };
    db.students.push(s); db.parents.push(pr); save();
    return send(res, 200, { ok: true });
  }
  if (m === 'POST' && (p === '/api/student/login' || p === '/api/parent/login' || p === '/api/teacher/login')) {
    if (locked(req)) throw E(429, 'محاولات كثيرة، انتظر 10 دقائق');
    const b = await body(req), code = clean(b.code, 100).toUpperCase();
    if (p === '/api/teacher/login') {
      const ok = scrypt(clean(b.code, 200), db.settings.salt) === db.settings.teacher;
      if (!ok) {
        const sv = db.students.find(q => q.code === code && q.supervisor && q.status !== 'blocked');
        if (sv) return send(res, 200, { token: newSession('teacher', 'S:' + sv.id) });
        fail(req); throw E(401, 'الكود غير صحيح');
      }
      return send(res, 200, { token: newSession('teacher', 'T') });
    }
    const isS = p.includes('student'), phone = clean(b.phone, 20), pw = clean(b.password, 100);
    let x = null;
    if (phone && pw) {
      const st = db.students.find(q => q.phone === phone && q.pass && scrypt(pw, db.settings.salt + q.id) === q.pass);
      if (st) x = isS ? st : db.parents.find(q => q.studentId === st.id);
    } else if (code) {
      // حسابات قديمة بلا كلمة سر فقط
      if (isS) x = db.students.find(q => q.code === code && !q.pass);
      else { const pr = db.parents.find(q => q.code === code), st = pr && db.students.find(q => q.id === pr.studentId); if (pr && st && !st.pass) x = pr; }
    }
    if (!x) { fail(req); throw E(401, 'رقم الهاتف أو كلمة السر غير صحيحة'); }
    if (x.status === 'blocked') throw E(403, 'تم حجب هذا الحساب');
    return send(res, 200, { token: newSession(isS ? 'student' : 'parent', x.id) });
  }

  // ----- الطالب -----
  if (p.startsWith('/api/student/')) {
    const se = auth(req, 'student', u), s = db.students.find(x => x.id === se.id);
    if (!s || s.status === 'blocked') throw E(403, 'تم حجب هذا الحساب');
    if (m === 'GET' && p === '/api/student/me') return send(res, 200, studentView(s));
    const b = await body(req);
    if (p === '/api/student/redeem') {
      if (locked(req)) throw E(429, 'محاولات كثيرة، انتظر 10 دقائق');
      const h = sha(db.settings.pepper + clean(b.code, 40).toUpperCase().replace(/\s/g, '')), c = db.codes.find(x => x.hash === h);
      if (!c) { fail(req); throw E(400, 'الكود غير صحيح'); }
      if (c.status !== 'unused') throw E(400, 'هذا الكود مستخدم من قبل');
      c.status = 'used'; c.usedBy = s.id; c.usedAt = new Date().toISOString();
      if (c.courseId) {
        const course = db.courses.find(x => x.id === c.courseId && x.status === 'published');
        if (!course || !gradeOk(course, s)) { c.status = 'unused'; delete c.usedBy; delete c.usedAt; throw E(400, 'هذا الكود غير مخصص لصفك'); }
        s.enrollments ||= [];
        const enrollment = s.enrollments.find(x => x.courseId === c.courseId);
        const start = enrollment && new Date(enrollment.expiresAt) > new Date() ? new Date(enrollment.expiresAt) : new Date();
        start.setDate(start.getDate() + c.days);
        if (enrollment) enrollment.expiresAt = start.toISOString();
        else s.enrollments.push({ courseId: c.courseId, expiresAt: start.toISOString() });
        save(); return send(res, 200, { ok: true, course: course.title, expiresAt: start.toISOString() });
      }
      const d = subActive(s) ? new Date(s.subEnd) : new Date(); d.setDate(d.getDate() + c.days); s.subEnd = d.toISOString(); save();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/student/exam') {
      const e = db.exams.find(x => x.id === b.examId);
      if (!e || !hasAccess(s, e) || !gradeOk(e, s)) throw E(403, 'الامتحان غير متاح');
      if (db.results.some(r => r.examId === e.id && r.studentId === s.id)) throw E(400, 'سبق إرسال هذا الامتحان');
      const n = e.questions.length, ans = Array.isArray(b.answers) ? b.answers.slice(0, n).map(x => clean(x, 3000)) : [];
      if (ans.length !== n || ans.some(x => !x)) throw E(400, 'أجب عن جميع الأسئلة');
      const r = { id: rnd(6), examId: e.id, examTitle: e.title, studentId: s.id, studentName: s.name, answers: ans, total: n, score: null, label: '', status: 'pending', created: new Date().toISOString() };
      if (e.type === 'اختياري' && e.key && e.key.length === n) { r.score = ans.filter((a, i) => a === e.key[i]).length; r.label = label(r.score / n * 100); r.status = 'graded'; }
      if (e.type === 'مختلط' && Array.isArray(e.key)) {
        let pts = 0; const ei = [];
        ans.forEach((a, i) => { if (qKind(e, i) === 'mcq') { if (a === e.key[i]) pts++; } else ei.push(i); });
        if (GEMINI_KEY && ei.length && ei.every(i => (e.models || [])[i])) {
          try { const es = await gradeEssayAI({ questions: ei.map(i => e.questions[i]), modelAnswer: ei.map((i, k) => (k + 1) + '. ' + e.models[i]).join('\n') }, ei.map(i => ans[i])); r.score = pts + es; r.label = label(r.score / n * 100); r.status = 'graded'; r.aiGraded = true; } catch (x) { /* بانتظار تصحيح المعلم */ }
        }
      }
      if (e.type === 'مقالي' && GEMINI_KEY && e.modelAnswer) { try { r.score = await gradeEssayAI(e, ans); r.label = label(r.score / n * 100); r.status = 'graded'; r.aiGraded = true; } catch (x) { /* يبقى بانتظار تصحيح المعلم */ } }
      db.results.push(r); save(); return send(res, 200, { score: r.score, total: n });
    }
    if (p === '/api/student/appeal') {
      const r = db.results.find(x => x.id === b.resultId && x.studentId === s.id);
      if (!r || r.status !== 'graded' || db.appeals.some(a => a.resultId === r.id)) throw E(400, 'لا يمكن التظلم');
      if (!clean(b.reason)) throw E(400, 'اكتب سبب التظلم');
      db.appeals.push({ id: rnd(6), resultId: r.id, studentName: s.name, examTitle: r.examTitle, reason: clean(b.reason, 1000), status: 'pending', score: '' }); save(); return send(res, 200, { ok: true });
    }
    if (p === '/api/student/review') {
      const r = db.results.find(x => x.id === b.resultId && x.studentId === s.id);
      if (!r || r.status !== 'graded') throw E(400, 'النتيجة غير متاحة للمراجعة');
      const e = db.exams.find(x => x.id === r.examId);
      if (!e) throw E(404, 'الامتحان غير موجود');
      const items = e.questions.map((q, i) => {
        const isM = qKind(e, i) === 'mcq' && Array.isArray(e.key) && !!e.key[i];
        return { q, options: (e.options && e.options[i]) || [], mine: r.answers[i] || '', correct: isM ? e.key[i] : '', ok: isM ? r.answers[i] === e.key[i] : null, model: !isM ? ((e.models || [])[i] || '') : '' };
      });
      return send(res, 200, { items, model: e.type === 'مقالي' && !e.models ? (e.modelAnswer || '') : '' });
    }
    if (p === '/api/student/message') {
      if (!clean(b.text)) throw E(400, 'اكتب رسالتك');
      db.messages.push({ id: rnd(6), studentId: s.id, name: s.name, text: clean(b.text, 2000), reply: '', created: new Date().toISOString() }); save(); return send(res, 200, { ok: true });
    }
    if (p === '/api/student/activity') {
      const c = db.content.find(x => x.id === b.contentId);
      if (!c || !gradeOk(c, s)) throw E(404, 'المحتوى غير موجود');
      db.activity = db.activity || [];
      const now = new Date().toISOString(), old = db.activity.find(x => x.studentId === s.id && x.contentId === c.id);
      if (old) { old.last = now; old.count = (old.count || 1) + 1; } else db.activity.push({ studentId: s.id, contentId: c.id, kind: c.type, first: now, last: now, count: 1 });
      save(); return send(res, 200, { ok: true });
    }
    if (p === '/api/student/pay') {
      if (!onlinePay()) throw E(503, 'الدفع الإلكتروني غير مفعّل');
      const course = db.courses.find(x => x.id === b.courseId && x.status === 'published');
      if (!course || !gradeOk(course, s) || !(Number(course.price) > 0)) throw E(400, 'الكورس غير متاح للدفع');
      const o = { id: 'O' + rnd(8), studentId: s.id, courseId: course.id, amount: Number(course.price), status: 'pending', created: new Date().toISOString() };
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim(), origin = (/^localhost|^127\./.test(host) ? 'http://' : 'https://') + host;
      const r = await fetch(KBASE + '/v3/payment/sessions', {
        method: 'POST', headers: { Authorization: KSECRET, 'api-key': KAPI, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expireAt: new Date(Date.now() + 36e5).toISOString(), maxFailureAttempts: 3, paymentType: 'credit', amount: o.amount.toFixed(2), currency: 'EGP', order: o.id, merchantId: KMID, merchantRedirect: origin + '/?paid=' + o.id, serverWebhook: origin + '/api/kashier/webhook', display: 'ar', type: 'one-time', allowedMethods: 'card,wallet', customer: { email: 'student-' + s.id + '@example.com', reference: s.id } })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.sessionUrl) throw E(502, 'تعذر بدء الدفع، حاول لاحقاً');
      db.orders = db.orders || []; db.orders.push(o); save();
      return send(res, 200, { url: j.sessionUrl });
    }
    if (p === '/api/student/notes') {
      const text = clean(b.text, 5000);
      if (!text) throw E(400, 'اكتب ملاحظة الطالب');
      db.notes.push({ id: rnd(6), studentId: s.id, text, created: new Date().toISOString() }); save(); return send(res, 200, { ok: true });
    }
    if (p === '/api/student/assistant') {
      const question = clean(b.question, 2000);
      if (!question) throw E(400, 'اكتب سؤالاً');
      const q = question.toLowerCase();
      const isDev = /مطور|محمود مدحت/.test(question);
      if (GEMINI_KEY && !isDev) { try { return send(res, 200, { answer: await askGemini(question) }); } catch (e) { /* يرجع للرد المحلي */ } }
      let answer = 'أستطيع مساعدتك في المنصة التعليمية. اكتب عنوان الدرس أو السؤال الذي تريد مساعدته فيه.';
      if (isDev) {
        answer = 'المطور هو محمود مدحت زكى. لا تتوفر معلومات أخرى عنه.';
      } else if (q.includes('gemini') || q.includes('ai') || q.includes('ذكاء') || q.includes('مساعد')) {
        answer = 'المساعد الذكي داخل المنصة يدعم الأسئلة التعليمية، ويمكن ربطه لاحقاً بـ Gemini API عبر متغيرات البيئة، بينما في النسخة الحالية يجيب عن التعليمات المتعلقة بالمنصة فقط.';
      } else if (q.includes('امتحان') || q.includes('اختبار')) {
        answer = 'يمكنك الدخول إلى قسم الامتحانات من لوحة الطالب، ثم اختيار الاختياري أو المقالي، مع وجود نموذج إجابة في واجهة إنشاء الامتحان.';
      } else if (q.includes('مذكرة') || q.includes('ملاحظات') || q.includes('notes')) {
        answer = 'استخدم قسم ملاحظاتي داخل لوحة الطالب لحفظ ملحوظات كل درس للرجوع إليها لاحقاً.';
      } else if (q.includes('فيديو') || q.includes('مشاهدة')) {
        answer = 'يمكنك مشاهدة الفيديوهات المجانية أو المدفوعة من قسم المحتوى بعد تسجيل الدخول، مع ظهور العلامة المائية على الفيديو أثناء المشاهدة.';
      }
      return send(res, 200, { answer });
    }
  }

  // ----- ولي الأمر -----
  if (m === 'GET' && p === '/api/parent/me') {
    const se = auth(req, 'parent', u), pr = db.parents.find(x => x.id === se.id), s = pr && db.students.find(x => x.id === pr.studentId);
    if (!s || pr.status === 'blocked') throw E(403, 'تم حجب هذا الحساب');
    const rs = db.results.filter(r => r.studentId === s.id), gr = rs.filter(r => r.status === 'graded' && r.total);
    const avg = gr.length ? Math.round(gr.reduce((a, r) => a + r.score / r.total * 100, 0) / gr.length) : null;
    const act = (db.activity || []).filter(x => x.studentId === s.id), items = db.content.filter(c => gradeOk(c, s));
    const seen = new Set(act.map(x => x.contentId)), isVid = c => c.type === 'video';
    const lastAct = act.reduce((m, x) => (x.last > m ? x.last : m), '');
    return send(res, 200, { name: s.name, grade: s.grade, status: s.status === 'blocked' ? 'محجوب' : 'نشط', sub: subActive(s), subEnd: s.subEnd, results: rs,
      progress: { videosWatched: items.filter(c => isVid(c) && seen.has(c.id)).length, videosTotal: items.filter(isVid).length,
        filesOpened: items.filter(c => !isVid(c) && seen.has(c.id)).length, filesTotal: items.filter(c => !isVid(c)).length,
        examsDone: rs.length, examsTotal: db.exams.filter(e => gradeOk(e, s)).length, notes: db.notes.filter(n => n.studentId === s.id).length,
        average: avg, label: avg === null ? '' : label(avg), lastActive: lastAct } });
  }

  // ----- المعلم -----
  if (p.startsWith('/api/teacher/')) {
    const ta = auth(req, 'teacher', u), sup = String(ta.id).startsWith('S:');
    if (sup) {
      const sv = db.students.find(q => q.id === String(ta.id).slice(2));
      if (!sv || !sv.supervisor || sv.status === 'blocked') throw E(401, 'سجّل الدخول من جديد');
      if (['/api/teacher/settings', '/api/teacher/hero', '/api/teacher/codes', '/api/teacher/codes/delete'].includes(p)) throw E(403, 'هذه الصلاحية للمعلم فقط');
    }
    if (ON_VERCEL && m === 'POST' && p === '/api/teacher/upload') return send(res, 200, await saveUpload(req, u));
    if (!ON_VERCEL && m === 'PUT' && p === '/api/teacher/upload') return send(res, 200, await saveUpload(req, u));
    if (ON_VERCEL && m === 'POST' && p === '/api/teacher/hero') {
      const f = await body(req);
      if (!f.fileId || !String(f.mime || '').startsWith('image/')) throw E(400, 'اختر صورة');
      await rmFile(db.settings.heroFile);
      Object.assign(db.settings, { heroFile: path.basename(String(f.fileId)), heroMime: clean(f.mime, 100), heroV: Date.now() }); save();
      return send(res, 200, { ok: true });
    }
    if (m === 'PUT' && p === '/api/teacher/hero') {
      const f = await saveUpload(req, u); if (!f.mime.startsWith('image/')) { await rmFile(f.fileId); throw E(400, 'اختر صورة'); }
      await rmFile(db.settings.heroFile); Object.assign(db.settings, { heroFile: f.fileId, heroMime: f.mime, heroV: Date.now() }); save(); return send(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/api/teacher/all') return send(res, 200, { name: db.settings.name, payments: db.settings.payments || [], orders: (db.orders || []).slice(-100).reverse().map(o => ({ id: o.id, status: o.status, amount: o.amount, created: o.created, paidAt: o.paidAt || '', student: (db.students.find(x => x.id === o.studentId) || {}).name || '', course: (db.courses.find(x => x.id === o.courseId) || {}).title || '' })), students: db.students.map(({ pass, ...r }) => (sup ? { ...r, code: '—' } : r)), parents: sup ? db.parents.map(r => ({ ...r, code: '—' })) : db.parents, courses: db.courses, content: db.content, notices: db.notices, exams: db.exams, results: db.results, appeals: db.appeals, messages: db.messages,
      codes: sup ? [] : db.codes.map(({ hash, ...c }) => c) });
    const b = await body(req), find = (arr, id) => { const x = arr.find(q => q.id === id); if (!x) throw E(404, 'غير موجود'); return x; };
    switch (p) {
      case '/api/teacher/course': {
        const title = clean(b.title, 160), description = clean(b.description, 1500), grade = clean(b.grade, 80);
        const price = Number(b.price), days = Math.floor(Number(b.days));
        const isFree = !!b.isFree;
        if (!title || !grade || !Number.isFinite(price) || price < 0 || !Number.isInteger(days) || days < 1 || days > 3650) throw E(400, 'أدخل اسم الكورس والسعر ومدة صحيحة من يوم إلى 3650 يوماً');
        const course = { id: rnd(8), title, description, grade, price, days, status: 'published', isFree, imageFileId: b.imageFileId ? path.basename(String(b.imageFileId)) : '', imageUrl: clean(b.imageUrl, 1000), created: new Date().toISOString() };
        db.courses.push(course); save(); return send(res, 200, { ok: true, course });
      }
      case '/api/teacher/course/delete': {
        const course = find(db.courses, b.id);
        course.status = 'archived';
        db.codes.filter(x => x.courseId === course.id && x.status === 'unused').forEach(x => { x.status = 'cancelled'; });
        save(); break;
      }
      case '/api/teacher/settings':
        if (clean(b.name, 100)) db.settings.name = clean(b.name, 100);
        if (typeof b.payments === 'string') db.settings.payments = b.payments.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 10).map(l => { const [t, ...d] = l.split('|'); return { title: clean(t, 80), details: clean(d.join('|'), 200) }; }).filter(x => x.title);
        if (b.password) { if (String(b.password).length < 12) throw E(400, 'كلمة المرور لا تقل عن 12 حرفاً'); db.settings.teacher = scrypt(b.password, db.settings.salt); }
        break;
      case '/api/teacher/content': {
        const type = ['video', 'image', 'note', 'homework'].includes(b.type) ? b.type : 'note';
        if (!clean(b.title) || (!b.fileId && !/^https?:\/\//.test(b.link || ''))) throw E(400, 'أدخل عنواناً وملفاً أو رابطاً صحيحاً');
        const course = b.courseId ? db.courses.find(x => x.id === b.courseId && x.status === 'published') : null;
        if (b.courseId && !course) throw E(400, 'الكورس غير موجود أو غير منشور');
        db.content.push({ id: rnd(6), type, title: clean(b.title, 200), grade: course ? course.grade : clean(b.grade, 80), courseId: course?.id || '', link: b.fileId ? '' : clean(b.link, 1000), fileId: b.fileId ? path.basename(String(b.fileId)) : '', fileName: clean(b.fileName, 200), mime: clean(b.mime, 100), isFree: !!b.isFree, blocked: [], created: new Date().toISOString() }); break;
      }
      case '/api/teacher/content/delete': { const c = find(db.content, b.id); await rmFile(c.fileId); db.content = db.content.filter(x => x !== c); break; }
      case '/api/teacher/notice': if (!clean(b.text)) throw E(400, 'اكتب النص'); db.notices.push({ id: rnd(6), kind: b.kind === 'schedule' ? 'schedule' : 'announcement', text: clean(b.text, 2000), grade: clean(b.grade, 80), created: new Date().toISOString() }); break;
      case '/api/teacher/notice/delete': db.notices = db.notices.filter(x => x.id !== b.id); break;
      case '/api/teacher/exam': {
        if (Array.isArray(b.items)) {
          const items = b.items.slice(0, 50).filter(x => x && clean(x.q, 1000));
          if (!clean(b.title) || !items.length) throw E(400, 'اكتب عنواناً وأسئلة (حتى 50)');
          const L = ['أ', 'ب', 'ج', 'د'], kinds = [], questions = [], options = [], key = [], models = [];
          for (const x of items) {
            const mcq = x.kind === 'mcq';
            questions.push(clean(x.q, 1000)); kinds.push(mcq ? 'mcq' : 'essay');
            if (mcq) {
              const o = (Array.isArray(x.options) ? x.options : []).slice(0, 4).map(v => clean(v, 300));
              if (o.length !== 4 || o.some(v => !v) || !L.includes(x.answer)) throw E(400, 'اكتب الاختيارات الأربعة لكل سؤال اختياري واختر الإجابة الصحيحة');
              options.push(o); key.push(x.answer); models.push('');
            } else { options.push([]); key.push(''); models.push(clean(x.model, 3000)); }
          }
          const course2 = b.courseId ? db.courses.find(x => x.id === b.courseId && x.status === 'published') : null;
          if (b.courseId && !course2) throw E(400, 'الكورس غير موجود أو غير منشور');
          const type = kinds.every(k => k === 'mcq') ? 'اختياري' : kinds.every(k => k === 'essay') ? 'مقالي' : 'مختلط';
          db.exams.push({ id: rnd(6), title: clean(b.title, 200), grade: course2 ? course2.grade : clean(b.grade, 80), courseId: course2?.id || '', type, kinds, models, questions, options, key, modelAnswer: models.map((m, i) => kinds[i] === 'essay' ? (i + 1) + '. ' + m : '').filter(Boolean).join('\n'), created: new Date().toISOString() });
          break;
        }
        const questionRows = Array.isArray(b.questions) ? b.questions : String(b.questions || '').split('\n').map(x => x.trim()).filter(Boolean);
        const qs = questionRows.map((q, i) => typeof q === 'string' ? { text: q, options: [] } : q);
        if (!clean(b.title) || !qs.length || qs.length > 50) throw E(400, 'اكتب عنواناً وأسئلة (حتى 50)');
        const M = { 'أ': 'أ', 'ا': 'أ', 'ب': 'ب', 'ج': 'ج', 'د': 'د', A: 'أ', B: 'ب', C: 'ج', D: 'د' };
        let key = Array.isArray(b.key) ? b.key : String(b.key || '').toUpperCase().split(/[\s,،|]+/).filter(Boolean).map(t => M[t.replace(/^\d+[-.):]*/, '')]);
        if (key.length !== qs.length || key.some(x => !x)) key = null;
        const course = b.courseId ? db.courses.find(x => x.id === b.courseId && x.status === 'published') : null;
        if (b.courseId && !course) throw E(400, 'الكورس غير موجود أو غير منشور');
        db.exams.push({ id: rnd(6), title: clean(b.title, 200), grade: course ? course.grade : clean(b.grade, 80), courseId: course?.id || '', type: b.type === 'مقالي' ? 'مقالي' : 'اختياري', questions: qs.map(q => q.text || q.question || q).slice(0, 50), options: qs.map(q => Array.isArray(q.options) ? q.options : []), key, modelAnswer: clean(b.key, 5000), created: new Date().toISOString() }); break;
      }
      case '/api/teacher/exam/delete': db.exams = db.exams.filter(x => x.id !== b.id); break;
      case '/api/teacher/grade': { const r = find(db.results, b.id), v = Number(b.score); if (!(v >= 0 && v <= r.total)) throw E(400, 'درجة غير صحيحة'); Object.assign(r, { score: v, label: label(v / r.total * 100), status: 'graded' }); break; }
      case '/api/teacher/reply': { const x = find(db.messages, b.id); x.reply = clean(b.reply, 2000); break; }
      case '/api/teacher/appeal': { const a = find(db.appeals, b.id); a.status = 'reviewed'; a.score = clean(b.score, 10); break; }
      case '/api/teacher/student': {
        const s = find(db.students, b.id), pr = db.parents.find(x => x.studentId === s.id);
        if (sup && (b.action === 'supervisor' || b.action === 'delete')) throw E(403, 'هذه الصلاحية للمعلم فقط');
        if (b.action === 'setpass') {
          const pw2 = clean(b.password, 100);
          if (pw2.length < 4) throw E(400, 'كلمة السر 4 أحرف على الأقل');
          s.pass = scrypt(pw2, db.settings.salt + s.id);
        } else
        if (b.action === 'supervisor') { s.supervisor = !s.supervisor; }
        else if (b.action === 'block') { s.status = s.status === 'blocked' ? 'active' : 'blocked'; }
        else if (b.action === 'extend') { const d = subActive(s) ? new Date(s.subEnd) : new Date(); d.setDate(d.getDate() + (Number(b.days) || 30)); s.subEnd = d.toISOString(); }
        else if (b.action === 'delete') { db.students = db.students.filter(x => x !== s); db.parents = db.parents.filter(x => x !== pr); db.results = db.results.filter(x => x.studentId !== s.id); }
        break;
      }
      case '/api/teacher/parent': { const x = find(db.parents, b.id); x.status = x.status === 'blocked' ? 'active' : 'blocked'; break; }
      case '/api/teacher/codes': {
        const n = Math.min(Math.max(+b.count || 1, 1), 100), days = Math.min(Math.max(+b.days || 30, 1), 3650), out = [];
        const course = b.courseId ? db.courses.find(x => x.id === b.courseId && x.status === 'published') : null;
        if (b.courseId && !course) throw E(400, 'اختر كورساً منشوراً أو اشتراكاً عاماً');
        if (course && days !== course.days) throw E(400, 'مدة الكود يجب أن تطابق مدة الكورس المحددة');
        for (let i = 0; i < n; i++) { const c = [mk('', 4), mk('', 4), mk('', 4)].map(x => x.slice(1)).join('-'); out.push(c);
          db.codes.push({ id: rnd(6), hash: sha(db.settings.pepper + c), hint: c.slice(-4), days, courseId: course?.id || '', status: 'unused', created: new Date().toISOString() }); }
        save(); return send(res, 200, { codes: out, course: course ? { title: course.title, price: course.price, days: course.days } : null, days });
      }
      case '/api/teacher/codes/delete': db.codes = db.codes.filter(x => !(x.id === b.id && x.status === 'unused')); break;
      default: throw E(404, 'غير موجود');
    }
    save(); return send(res, 200, { ok: true });
  }
  throw E(404, 'غير موجود');
}

function capturedResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    headersSent: false,
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers = {}) { this.statusCode = status; Object.assign(this.headers, headers); this.headersSent = true; return this; },
    end(body) { this.body = body; this.ended = true; return this; }
  };
}

async function handleVercel(req, res) {
  const incoming = new URL(req.url, 'https://vercel.invalid');
  const originalPath = incoming.searchParams.get('__path');
  if (originalPath) {
    incoming.searchParams.delete('__path');
    req.url = originalPath + (incoming.searchParams.size ? '?' + incoming.searchParams.toString() : '');
  }
  const out = capturedResponse();
  out.setHeader('Access-Control-Allow-Origin', '*');
  out.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  out.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw E(503, 'أضف SUPABASE_URL وSUPABASE_SERVICE_ROLE_KEY إلى متغيرات Vercel');
    if (req.method === 'OPTIONS') out.writeHead(204).end();
    else {
      await loadCloudDb();
      await route(req, out);
    }
  } catch (e) {
    if (!e.status || e.status >= 500) console.error(e);
    send(out, e.status || 500, { error: e.status ? e.message : 'خطأ في الخادم' });
  }

  try { await persistCloudDb(); }
  catch (e) {
    console.error(e);
    out.statusCode = e.status || 503;
    out.headers['Content-Type'] = 'application/json; charset=utf-8';
    out.headers['Cache-Control'] = 'no-store';
    out.body = JSON.stringify({ error: e.message || 'تعذر حفظ بيانات المنصة' });
  }

  res.statusCode = out.statusCode;
  for (const [name, value] of Object.entries(out.headers)) res.setHeader(name, value);
  return res.end(out.body);
}

let vercelQueue = Promise.resolve();
function vercelHandler(req, res) {
  const task = vercelQueue.then(() => handleVercel(req, res));
  vercelQueue = task.catch(() => {});
  return task;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try { await route(req, res); }
  catch (e) { if (e.status !== 404 && !e.status) console.error(e); if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'خطأ في الخادم' }); else res.end(); }
});
module.exports = { vercelHandler };

if (require.main === module) {
  const shutdown = () => { flush(); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  server.listen(PORT, () => console.log('المنصة تعمل على :' + PORT));
}
