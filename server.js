const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const DB = process.env.DATA_FILE || path.join(__dirname, 'data.json');
let db = { users: {}, guilds: {}, sessions: {} };
try { db = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch (e) {}
let timer = null;
const save = () => { clearTimeout(timer); timer = setTimeout(() => fs.writeFile(DB, JSON.stringify(db), () => {}), 500); };
const hash = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
const send = (r, c, o) => { r.writeHead(c, { 'Content-Type': 'application/json; charset=utf-8' }); r.end(JSON.stringify(o)); };
const readBody = req => new Promise(ok => {
  let b = '';
  req.on('data', d => { b += d; if (b.length > 2e5) req.destroy(); });
  req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch (e) { ok({}); } });
});
const who = req => { const k = db.sessions[(req.headers.authorization || '').slice(7)]; return k && db.users[k] ? k : null; };
const me = k => { const u = db.users[k]; return { name: u.name, char: u.char, avatar: u.avatar, wins: u.wins, gold: u.gold }; };
const login = k => { const t = crypto.randomBytes(24).toString('hex'); db.sessions[t] = k; save(); return [200, { token: t, me: me(k) }]; };
const gview = g => ({
  id: g.id, name: g.name,
  members: g.members.map(m => { const u = db.users[m]; return { name: u.name, owner: m === g.owner, emoji: u.char && u.char.emoji, label: u.char && u.char.label, wins: u.wins, gold: u.gold }; })
    .sort((a, b) => b.wins - a.wins),
  chat: g.chat
});
const lastMap = {};
async function aiMap(theme) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) return null;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 900, messages: [{ role: 'user',
      content: `Design a 15x15 dungeon map for the theme "${theme}". Reply with ONLY JSON: {"name":"short Thai name","grid":[15 strings, each 15 chars, '#' wall and '.' floor]}. All floor cells must be connected.` }] })
  });
  const j = await r.json();
  const m = JSON.parse(j.content[0].text.replace(/```json|```/g, '').trim());
  return { name: String(m.name).slice(0, 30), grid: m.grid };
}
const routes = {
  'POST /api/register': async (_, b) => {
    const u = String(b.u || ''), p = String(b.p || '');
    if (!/^[A-Za-z0-9_]{3,16}$/.test(u)) return [400, { err: 'ชื่อผู้ใช้ 3-16 ตัว (a-z, 0-9, _)' }];
    if (p.length < 6) return [400, { err: 'รหัสผ่านอย่างน้อย 6 ตัว' }];
    const k = u.toLowerCase(); if (db.users[k]) return [400, { err: 'ชื่อนี้ถูกใช้แล้ว' }];
    const salt = crypto.randomBytes(16).toString('hex');
    db.users[k] = { name: u, salt, pw: hash(p, salt), char: null, avatar: '', wins: 0, gold: 0, guild: null };
    return login(k);
  },
  'POST /api/login': async (_, b) => {
    const k = String(b.u || '').toLowerCase(), u = db.users[k];
    if (!u || !crypto.timingSafeEqual(Buffer.from(hash(String(b.p || ''), u.salt)), Buffer.from(u.pw))) return [400, { err: 'ชื่อหรือรหัสผ่านไม่ถูกต้อง' }];
    return login(k);
  },
  'GET /api/me': async k => [200, me(k)],
  'POST /api/save': async (k, b) => {
    const c = b.char || {}, av = String(b.avatar || '');
    if (!c.form || JSON.stringify(c.form).length > 1500) return [400, { err: 'ข้อมูลตัวละครไม่ถูกต้อง' }];
    if (av && !/^(data:image\/|https?:\/\/)/.test(av) || av.length > 60000) return [400, { err: 'รูปใหญ่เกินไปหรือไม่ถูกต้อง' }];
    db.users[k].char = { form: c.form, name: String(c.name || '').slice(0, 24), label: String(c.label || '').slice(0, 40), emoji: String(c.emoji || '').slice(0, 4) };
    db.users[k].avatar = av; save(); return [200, { ok: 1 }];
  },
  'POST /api/win': async (k, b) => {
    const u = db.users[k]; u.wins++; u.gold += Math.max(0, Math.min(500, parseInt(b.gold) || 0)); save(); return [200, { me: me(k) }];
  },
  'POST /api/map': async (k, b) => {
    if (Date.now() - (lastMap[k] || 0) < 10000) return [429, { err: 'รอสักครู่ก่อนสร้างแมพใหม่' }];
    lastMap[k] = Date.now();
    const m = await aiMap(String(b.theme || 'dungeon').slice(0, 60)).catch(() => null);
    return m ? [200, m] : [503, { err: 'เซิร์ฟเวอร์ยังไม่ได้ตั้ง ANTHROPIC_API_KEY หรือ AI ตอบผิดรูปแบบ' }];
  },
  'GET /api/guilds': async () => [200, { guilds: Object.values(db.guilds).map(g => ({ id: g.id, name: g.name, n: g.members.length })) }],
  'POST /api/guilds': async (k, b) => {
    const u = db.users[k], n = String(b.name || '').trim();
    if (u.guild) return [400, { err: 'คุณอยู่ในกิลด์แล้ว' }];
    if (n.length < 3 || n.length > 24) return [400, { err: 'ชื่อกิลด์ 3-24 ตัวอักษร' }];
    if (Object.values(db.guilds).some(g => g.name.toLowerCase() === n.toLowerCase())) return [400, { err: 'ชื่อกิลด์ซ้ำ' }];
    const id = crypto.randomBytes(4).toString('hex');
    db.guilds[id] = { id, name: n, owner: k, members: [k], chat: [] }; u.guild = id; save(); return [200, { ok: 1 }];
  },
  'POST /api/guilds/join': async (k, b) => {
    const u = db.users[k], g = db.guilds[b.id];
    if (u.guild) return [400, { err: 'คุณอยู่ในกิลด์แล้ว' }];
    if (!g) return [404, { err: 'ไม่พบกิลด์' }];
    if (g.members.length >= 20) return [400, { err: 'กิลด์เต็ม' }];
    g.members.push(k); u.guild = g.id; save(); return [200, { ok: 1 }];
  },
  'POST /api/guilds/leave': async k => {
    const u = db.users[k], g = db.guilds[u.guild]; if (!g) return [400, { err: 'ไม่ได้อยู่ในกิลด์' }];
    g.members = g.members.filter(m => m !== k); u.guild = null;
    if (!g.members.length) delete db.guilds[g.id]; else if (g.owner === k) g.owner = g.members[0];
    save(); return [200, { ok: 1 }];
  },
  'GET /api/guild': async k => { const g = db.guilds[db.users[k].guild]; return [200, { guild: g ? gview(g) : null }]; },
  'POST /api/guild/chat': async (k, b) => {
    const g = db.guilds[db.users[k].guild], t = String(b.text || '').trim().slice(0, 200);
    if (!g || !t) return [400, { err: 'ส่งไม่ได้' }];
    g.chat.push({ u: db.users[k].name, t, at: Date.now() }); g.chat = g.chat.slice(-50); save(); return [200, { ok: 1 }];
  }
};
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) {
    return fs.readFile(path.join(__dirname, 'index.html'), (e, d) => {
      res.writeHead(e ? 500 : 200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(e ? 'error' : d);
    });
  }
  const h = routes[req.method + ' ' + url.pathname];
  if (!h) return send(res, 404, { err: 'ไม่พบ' });
  const open = url.pathname === '/api/register' || url.pathname === '/api/login';
  const k = open ? null : who(req);
  if (!open && !k) return send(res, 401, { err: 'กรุณาล็อกอินก่อน' });
  const b = req.method === 'POST' ? await readBody(req) : {};
  try { const [c, o] = await h(k, b); send(res, c, o); } catch (e) { send(res, 500, { err: 'เซิร์ฟเวอร์ผิดพลาด' }); }
}).listen(PORT, '0.0.0.0', () => console.log('Running on ' + PORT));
