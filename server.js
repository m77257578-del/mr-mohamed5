// منصة الأستاذ محمد عبد المقصود — خادم حقيقي بدون أي مكتبات خارجية (Node 18+)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
// تحميل الإعدادات من ملف .env إن وُجد (سطر لكل إعداد: الاسم=القيمة)
try { for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(l); if (m && !l.trim().startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch (e) {}
const PORT = process.env.PORT || 3000;
const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UP = path.join(DIR, 'uploads'), DBF = path.join(DIR, 'db.json');
fs.mkdirSync(UP, { recursive: true });

const rnd = n => crypto.randomBytes(n).toString('hex');
const scrypt = (s, salt) => crypto.scryptSync(String(s), salt, 32).toString('hex');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const mk = (p, n = 6) => p + '-' + [...crypto.randomBytes(n)].map(b => ALPH[b % 32]).join('');
const E = (status, message) => Object.assign(new Error(message), { status });

let db = { settings: { name: 'منصة الأستاذ محمد عبد المقصود', heroFile: '', heroMime: '', heroV: 0, salt: rnd(16), pepper: rnd(16), teacher: '' },
  students: [], parents: [], content: [], notices: [], exams: [], results: [], appeals: [], messages: [], codes: [] };
if (fs.existsSync(DBF)) db = Object.assign(db, JSON.parse(fs.readFileSync(DBF, 'utf8')));
if (!db.settings.teacher) {
  const password = process.env.TEACHER_PASSWORD;
  if (!password || password.length < 12) throw new Error('اضبط TEACHER_PASSWORD في ملف .env بكلمة مرور لا تقل عن 12 حرفاً');
  db.settings.teacher = scrypt(password, db.settings.salt);
}
let timer;
const flush = () => { clearTimeout(timer); timer = null; fs.writeFileSync(DBF + '.tmp', JSON.stringify(db)); fs.renameSync(DBF + '.tmp', DBF); };
const save = () => { clearTimeout(timer); timer = setTimeout(flush, 150); };
save();

// ---------- جلسات وحماية من التخمين ----------
const sess = new Map(), bad = new Map();
const ipOf = r => String(r.headers['x-forwarded-for'] || r.socket.remoteAddress || '').split(',')[0].trim();
const locked = r => { const b = bad.get(ipOf(r)); return b && b.until > Date.now(); };
const fail = r => { const k = ipOf(r), b = bad.get(k) || { n: 0, until: 0 }; if (++b.n >= 8) { b.until = Date.now() + 600000; b.n = 0; } bad.set(k, b); };
const newSession = (role, id) => { const t = rnd(24); sess.set(t, { role, id, exp: Date.now() + 7 * 864e5 }); return t; };
function auth(req, role, u) {
  const t = (req.headers.authorization || '').slice(7) || u.searchParams.get('t');
  const s = sess.get(t);
  if (!s || s.exp < Date.now() || (role && s.role !== role)) throw E(401, 'سجّل الدخول من جديد');
  return s;
}
const subActive = s => !!s.subEnd && new Date(s.subEnd) > new Date();
const gradeOk = (x, s) => x.grade === 'كل الصفوف' || x.grade === s.grade;
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

async function saveUpload(req, u) {
  const id = rnd(12), fp = path.join(UP, id), ws = fs.createWriteStream(fp);
  let size = 0; req.on('data', c => size += c.length);
  try {
    await new Promise((ok, no) => { req.pipe(ws); ws.on('finish', ok); ws.on('error', no); req.on('aborted', () => { ws.destroy(); no(E(400, 'انقطع الرفع')); }); });
  } catch (e) { fs.rmSync(fp, { force: true }); throw e; }
  const mime = String(req.headers['content-type'] || 'application/octet-stream').replace(/[^\w.+\/-]/g, '').slice(0, 100) || 'application/octet-stream';
  return { fileId: id, fileName: clean(decodeURIComponent(u.searchParams.get('name') || 'file'), 200), mime, size };
}
const rmFile = id => id && fs.rmSync(path.join(UP, path.basename(id)), { force: true });


// ---------- عرض بيانات الطالب (بدون إجابات الامتحانات أو أي سر) ----------
function studentView(s) {
  const sub = subActive(s);
  return {
    profile: { name: s.name, grade: s.grade, code: s.code, subEnd: s.subEnd, sub },
    notices: db.notices.filter(n => gradeOk(n, s)),
    content: sub ? db.content.filter(c => gradeOk(c, s) && !(c.blocked || []).includes(s.id)).map(({ id, type, title, grade, link, fileId, fileName, mime }) => ({ id, type, title, grade, link, fileId, fileName, mime })) : [],
    exams: sub ? db.exams.filter(e => gradeOk(e, s)).map(e => ({ id: e.id, title: e.title, grade: e.grade, type: e.type, questions: e.questions, taken: db.results.some(r => r.examId === e.id && r.studentId === s.id) })) : [],
    results: db.results.filter(r => r.studentId === s.id).map(r => ({ ...r, appeal: db.appeals.find(a => a.resultId === r.id) || null })),
    messages: db.messages.filter(m => m.studentId === s.id)
  };
}

async function route(req, res) {
  const u = new URL(req.url, 'http://x'), p = u.pathname, m = req.method;

  // ملفات الواجهة
  if (m === 'GET' && (p === '/' || p === '/index.html')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(path.join(__dirname, 'index.html'))); }
  if (m === 'GET' && p === '/manifest.webmanifest') { res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache' }); return res.end(fs.readFileSync(path.join(__dirname, 'manifest.webmanifest'))); }
  if (m === 'GET' && (p === '/sw.js' || p === '/app-icon.svg')) { res.writeHead(200, { 'Content-Type': p === '/sw.js' ? 'application/javascript; charset=utf-8' : 'image/svg+xml', 'Cache-Control': 'no-cache' }); return res.end(fs.readFileSync(path.join(__dirname, p.slice(1)))); }
  if (m === 'GET' && p === '/hero') { if (!db.settings.heroFile) throw E(404, ''); return serveFile(req, res, db.settings.heroFile, 'hero', db.settings.heroMime); }
  if (m === 'GET' && p === '/api/public') return send(res, 200, { name: db.settings.name, hero: db.settings.heroFile ? '/hero?v=' + db.settings.heroV : '' });

  // ملفات المحتوى (محمية)
  if (m === 'GET' && p.startsWith('/files/')) {
    const s = auth(req, null, u), fid = p.slice(7), c = db.content.find(x => x.fileId === fid);
    if (!c) throw E(404, 'الملف غير موجود');
    if (s.role === 'student') {
      const st = db.students.find(x => x.id === s.id);
      if (!st || st.status === 'blocked' || !subActive(st) || !gradeOk(c, st) || (c.blocked || []).includes(st.id)) throw E(403, 'غير مصرّح');
    } else if (s.role !== 'teacher') throw E(403, 'غير مصرّح');
    return serveFile(req, res, fid, c.fileName, c.mime);
  }

  // ----- تسجيل ودخول -----
  if (m === 'POST' && p === '/api/register') {
    const b = await body(req), name = clean(b.name, 100), phone = clean(b.phone, 20), pphone = clean(b.parentPhone, 20);
    if (!name || !/^01\d{9}$/.test(phone) || !/^01\d{9}$/.test(pphone)) throw E(400, 'اكتب الاسم ورقمي هاتف صحيحين من 11 رقماً');
    if (db.students.length > 20000) throw E(400, 'تعذر التسجيل حالياً');
    const s = { id: rnd(6), code: mk('ST'), name, phone, grade: clean(b.grade, 80), governorate: clean(b.governorate, 60), center: clean(b.center, 60), village: clean(b.village, 60), parentName: clean(b.parentName, 100), parentPhone: pphone, status: 'active', subEnd: '', created: new Date().toISOString() };
    const pr = { id: rnd(6), code: mk('PR'), studentId: s.id, name: s.parentName, status: 'active' };
    db.students.push(s); db.parents.push(pr); save();
    return send(res, 200, { studentCode: s.code, parentCode: pr.code });
  }
  if (m === 'POST' && (p === '/api/student/login' || p === '/api/parent/login' || p === '/api/teacher/login')) {
    if (locked(req)) throw E(429, 'محاولات كثيرة، انتظر 10 دقائق');
    const b = await body(req), code = clean(b.code, 100).toUpperCase();
    if (p === '/api/teacher/login') {
      const ok = scrypt(clean(b.code, 200), db.settings.salt) === db.settings.teacher;
      if (!ok) { fail(req); throw E(401, 'الكود غير صحيح'); }
      return send(res, 200, { token: newSession('teacher', 'T') });
    }
    const isS = p.includes('student'), list = isS ? db.students : db.parents, x = list.find(q => q.code === code);
    if (!x) { fail(req); throw E(401, isS ? 'كود الطالب غير صحيح' : 'كود ولي الأمر غير صحيح'); }
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
      const d = subActive(s) ? new Date(s.subEnd) : new Date(); d.setDate(d.getDate() + c.days); s.subEnd = d.toISOString(); save();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/student/exam') {
      const e = db.exams.find(x => x.id === b.examId);
      if (!e || !subActive(s) || !gradeOk(e, s)) throw E(403, 'الامتحان غير متاح');
      if (db.results.some(r => r.examId === e.id && r.studentId === s.id)) throw E(400, 'سبق إرسال هذا الامتحان');
      const n = e.questions.length, ans = Array.isArray(b.answers) ? b.answers.slice(0, n).map(x => clean(x, 3000)) : [];
      if (ans.length !== n || ans.some(x => !x)) throw E(400, 'أجب عن جميع الأسئلة');
      const r = { id: rnd(6), examId: e.id, examTitle: e.title, studentId: s.id, studentName: s.name, answers: ans, total: n, score: null, label: '', status: 'pending', created: new Date().toISOString() };
      if (e.type === 'اختياري' && e.key && e.key.length === n) { r.score = ans.filter((a, i) => a === e.key[i]).length; r.label = label(r.score / n * 100); r.status = 'graded'; }
      db.results.push(r); save(); return send(res, 200, { score: r.score, total: n });
    }
    if (p === '/api/student/appeal') {
      const r = db.results.find(x => x.id === b.resultId && x.studentId === s.id);
      if (!r || r.status !== 'graded' || db.appeals.some(a => a.resultId === r.id)) throw E(400, 'لا يمكن التظلم');
      if (!clean(b.reason)) throw E(400, 'اكتب سبب التظلم');
      db.appeals.push({ id: rnd(6), resultId: r.id, studentName: s.name, examTitle: r.examTitle, reason: clean(b.reason, 1000), status: 'pending', score: '' }); save(); return send(res, 200, { ok: true });
    }
    if (p === '/api/student/message') {
      if (!clean(b.text)) throw E(400, 'اكتب رسالتك');
      db.messages.push({ id: rnd(6), studentId: s.id, name: s.name, text: clean(b.text, 2000), reply: '', created: new Date().toISOString() }); save(); return send(res, 200, { ok: true });
    }
  }

  // ----- ولي الأمر -----
  if (m === 'GET' && p === '/api/parent/me') {
    const se = auth(req, 'parent', u), pr = db.parents.find(x => x.id === se.id), s = pr && db.students.find(x => x.id === pr.studentId);
    if (!s || pr.status === 'blocked') throw E(403, 'تم حجب هذا الحساب');
    return send(res, 200, { name: s.name, grade: s.grade, status: s.status === 'blocked' ? 'محجوب' : 'نشط', sub: subActive(s), subEnd: s.subEnd, results: db.results.filter(r => r.studentId === s.id) });
  }

  // ----- المعلم -----
  if (p.startsWith('/api/teacher/')) {
    auth(req, 'teacher', u);
    if (m === 'PUT' && p === '/api/teacher/upload') return send(res, 200, await saveUpload(req, u));
    if (m === 'PUT' && p === '/api/teacher/hero') {
      const f = await saveUpload(req, u); if (!f.mime.startsWith('image/')) { rmFile(f.fileId); throw E(400, 'اختر صورة'); }
      rmFile(db.settings.heroFile); Object.assign(db.settings, { heroFile: f.fileId, heroMime: f.mime, heroV: Date.now() }); save(); return send(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/api/teacher/all') return send(res, 200, { name: db.settings.name, students: db.students, parents: db.parents, content: db.content, notices: db.notices, exams: db.exams, results: db.results, appeals: db.appeals, messages: db.messages,
      codes: db.codes.map(({ hash, ...c }) => c) });
    const b = await body(req), find = (arr, id) => { const x = arr.find(q => q.id === id); if (!x) throw E(404, 'غير موجود'); return x; };
    switch (p) {
      case '/api/teacher/settings':
        if (clean(b.name, 100)) db.settings.name = clean(b.name, 100);
        if (b.password) { if (String(b.password).length < 12) throw E(400, 'كلمة المرور لا تقل عن 12 حرفاً'); db.settings.teacher = scrypt(b.password, db.settings.salt); }
        break;
      case '/api/teacher/content': {
        const type = ['video', 'image', 'note', 'homework'].includes(b.type) ? b.type : 'note';
        if (!clean(b.title) || (!b.fileId && !/^https?:\/\//.test(b.link || ''))) throw E(400, 'أدخل عنواناً وملفاً أو رابطاً صحيحاً');
        db.content.push({ id: rnd(6), type, title: clean(b.title, 200), grade: clean(b.grade, 80), link: b.fileId ? '' : clean(b.link, 1000), fileId: b.fileId ? path.basename(String(b.fileId)) : '', fileName: clean(b.fileName, 200), mime: clean(b.mime, 100), blocked: [], created: new Date().toISOString() }); break;
      }
      case '/api/teacher/content/delete': { const c = find(db.content, b.id); rmFile(c.fileId); db.content = db.content.filter(x => x !== c); break; }
      case '/api/teacher/notice': if (!clean(b.text)) throw E(400, 'اكتب النص'); db.notices.push({ id: rnd(6), kind: b.kind === 'schedule' ? 'schedule' : 'announcement', text: clean(b.text, 2000), grade: clean(b.grade, 80), created: new Date().toISOString() }); break;
      case '/api/teacher/notice/delete': db.notices = db.notices.filter(x => x.id !== b.id); break;
      case '/api/teacher/exam': {
        const qs = String(b.questions || '').split('\n').map(x => x.trim()).filter(Boolean);
        if (!clean(b.title) || !qs.length || qs.length > 50) throw E(400, 'اكتب عنواناً وأسئلة (حتى 50)');
        const M = { 'أ': 'أ', 'ا': 'أ', 'ب': 'ب', 'ج': 'ج', 'د': 'د', A: 'أ', B: 'ب', C: 'ج', D: 'د' };
        let key = String(b.key || '').toUpperCase().split(/[\s,،|]+/).filter(Boolean).map(t => M[t.replace(/^\d+[-.):]*/, '')]);
        if (key.length !== qs.length || key.some(x => !x)) key = null;
        db.exams.push({ id: rnd(6), title: clean(b.title, 200), grade: clean(b.grade, 80), type: b.type === 'مقالي' ? 'مقالي' : 'اختياري', questions: qs, key, modelAnswer: clean(b.key, 5000), created: new Date().toISOString() }); break;
      }
      case '/api/teacher/exam/delete': db.exams = db.exams.filter(x => x.id !== b.id); break;
      case '/api/teacher/grade': { const r = find(db.results, b.id), v = Number(b.score); if (!(v >= 0 && v <= r.total)) throw E(400, 'درجة غير صحيحة'); Object.assign(r, { score: v, label: label(v / r.total * 100), status: 'graded' }); break; }
      case '/api/teacher/reply': { const x = find(db.messages, b.id); x.reply = clean(b.reply, 2000); break; }
      case '/api/teacher/appeal': { const a = find(db.appeals, b.id); a.status = 'reviewed'; a.score = clean(b.score, 10); break; }
      case '/api/teacher/student': {
        const s = find(db.students, b.id), pr = db.parents.find(x => x.studentId === s.id);
        if (b.action === 'block') { s.status = s.status === 'blocked' ? 'active' : 'blocked'; }
        else if (b.action === 'extend') { const d = subActive(s) ? new Date(s.subEnd) : new Date(); d.setDate(d.getDate() + (Number(b.days) || 30)); s.subEnd = d.toISOString(); }
        else if (b.action === 'delete') { db.students = db.students.filter(x => x !== s); db.parents = db.parents.filter(x => x !== pr); db.results = db.results.filter(x => x.studentId !== s.id); }
        break;
      }
      case '/api/teacher/parent': { const x = find(db.parents, b.id); x.status = x.status === 'blocked' ? 'active' : 'blocked'; break; }
      case '/api/teacher/codes': {
        const n = Math.min(Math.max(+b.count || 1, 1), 100), days = Math.min(Math.max(+b.days || 30, 1), 3650), out = [];
        for (let i = 0; i < n; i++) { const c = [mk('', 4), mk('', 4), mk('', 4)].map(x => x.slice(1)).join('-'); out.push(c);
          db.codes.push({ id: rnd(6), hash: sha(db.settings.pepper + c), hint: c.slice(-4), days, status: 'unused', created: new Date().toISOString() }); }
        save(); return send(res, 200, { codes: out });
      }
      case '/api/teacher/codes/delete': db.codes = db.codes.filter(x => !(x.id === b.id && x.status === 'unused')); break;
      default: throw E(404, 'غير موجود');
    }
    save(); return send(res, 200, { ok: true });
  }
  throw E(404, 'غير موجود');
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try { await route(req, res); }
  catch (e) { if (e.status !== 404 && !e.status) console.error(e); if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'خطأ في الخادم' }); else res.end(); }
});
const shutdown = () => { flush(); process.exit(0); };
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
server.listen(PORT, () => console.log('المنصة تعمل على http://localhost:' + PORT));
