const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || '').trim();

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ==================== DB ====================
const db = new Database('chat.db');
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    banned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL,
    edited_at INTEGER,
    deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS dms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id INTEGER NOT NULL,
    to_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL,
    edited_at INTEGER,
    deleted INTEGER NOT NULL DEFAULT 0
  );
`);

// ---------- lightweight migrations ----------
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
    console.log(`migrated: added ${table}.${column}`);
  }
}
addColumnIfMissing('users', 'color',  "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('users', 'tag',    "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('users', 'tag_bg', "TEXT NOT NULL DEFAULT ''");

function ensureAdminUser() {
  if (!ADMIN_USERNAME) return;
  const u = db.prepare('SELECT id, role FROM users WHERE username = ?').get(ADMIN_USERNAME);
  if (u && u.role !== 'admin') {
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run('admin', u.id);
    console.log(`promoted ${ADMIN_USERNAME} to admin`);
  }
}
ensureAdminUser();

// ==================== SOCKET REGISTRY ====================
const sockets = new Map();
const userSockets = new Map();

function attach(ws, user) {
  const info = {
    userId: user.id,
    username: user.username,
    role: user.role,
    color: user.color || '',
    tag: user.tag || '',
    tag_bg: user.tag_bg || '',
  };
  sockets.set(ws, info);
  if (!userSockets.has(user.id)) userSockets.set(user.id, new Set());
  userSockets.get(user.id).add(ws);
}
function detach(ws) {
  const info = sockets.get(ws);
  sockets.delete(ws);
  if (info) {
    const set = userSockets.get(info.userId);
    if (set) { set.delete(ws); if (!set.size) userSockets.delete(info.userId); }
  }
}
function sendTo(userId, payload) {
  const set = userSockets.get(userId);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const ws of set) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}
function broadcast(payload, exceptWs) {
  const data = JSON.stringify(payload);
  for (const ws of sockets.keys()) {
    if (ws !== exceptWs && ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}
function onlineUsers() {
  const byId = new Map();
  for (const info of sockets.values()) {
    byId.set(info.userId, {
      id: info.userId,
      username: info.username,
      role: info.role,
      color: info.color,
      tag: info.tag,
      tag_bg: info.tag_bg,
    });
  }
  return [...byId.values()];
}
function broadcastUserList() {
  broadcast({ type: 'users', users: onlineUsers() });
}

// ==================== AUTH ====================
function makeToken() { return crypto.randomBytes(32).toString('hex'); }

function sessionUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  return db.prepare(`
    SELECT s.token, u.id, u.username, u.role, u.banned
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).get(token);
}

app.post('/api/register', async (req, res) => {
  const username = String(req.body.username || '').trim().slice(0, 24);
  const password = String(req.body.password || '');
  if (!/^[A-Za-z0-9_.-]{2,24}$/.test(username))
    return res.status(400).json({ error: 'Username must be 2-24 chars: letters, digits, _ . -' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 chars' });

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: 'Username taken' });

  const role = (ADMIN_USERNAME && username === ADMIN_USERNAME) ? 'admin' : 'user';
  const hash = await bcrypt.hash(password, 10);
  const now = Date.now();
  const info = db.prepare(
    'INSERT INTO users (username, password_hash, role, banned, created_at) VALUES (?, ?, ?, 0, ?)'
  ).run(username, hash, role, now);

  const token = makeToken();
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)')
    .run(token, info.lastInsertRowid, now);

  res.json({ token, user: { id: info.lastInsertRowid, username, role } });
});

app.post('/api/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (user.banned) return res.status(403).json({ error: 'You are banned' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  const token = makeToken();
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)')
    .run(token, user.id, Date.now());
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

app.post('/api/logout', (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const u = sessionUser(req);
  if (!u) return res.status(401).json({ error: 'Not signed in' });
  const full = db.prepare('SELECT color, tag, tag_bg FROM users WHERE id = ?').get(u.id);
  res.json({
    user: {
      id: u.id, username: u.username, role: u.role,
      color: full?.color || '', tag: full?.tag || '', tag_bg: full?.tag_bg || '',
    },
  });
});

// ==================== PROFILE ====================
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const PALETTE = ['#7aa2f7', '#9ece6a', '#e0af68', '#f7768e', '#bb9af7', '#7dcfff', '#ff9e64'];
const ALLOWED_TAGS = /^[\p{L}\p{N}\p{Emoji}_\- .]{0,16}$/u;
const RESERVED_TAGS = ['mod', 'admin', 'owner', 'staff'];

app.post('/api/profile', (req, res) => {
  const u = sessionUser(req);
  if (!u) return res.status(401).json({ error: 'Not signed in' });

  let color  = String(req.body.color  ?? '').trim().toLowerCase();
  let tag    = String(req.body.tag    ?? '').trim();
  let tag_bg = String(req.body.tag_bg ?? '').trim().toLowerCase();

  if (color === 'rainbow') {
    if (u.role !== 'admin') return res.status(403).json({ error: 'Rainbow is admin-only' });
  } else if (color) {
    if (!HEX_RE.test(color)) return res.status(400).json({ error: 'Bad color' });
    if (u.role !== 'admin' && !PALETTE.includes(color)) {
      return res.status(403).json({ error: 'That color is admin-only' });
    }
  }

  if (!ALLOWED_TAGS.test(tag)) return res.status(400).json({ error: 'Bad tag' });
  if (u.role !== 'admin' && RESERVED_TAGS.includes(tag.toLowerCase())) {
    return res.status(403).json({ error: 'That tag is reserved' });
  }
  if (tag_bg && !HEX_RE.test(tag_bg)) return res.status(400).json({ error: 'Bad tag background' });

  db.prepare('UPDATE users SET color = ?, tag = ?, tag_bg = ? WHERE id = ?')
    .run(color, tag, tag_bg, u.id);

  // update cached socket info
  for (const info of sockets.values()) {
    if (info.userId === u.id) {
      info.color = color;
      info.tag = tag;
      info.tag_bg = tag_bg;
    }
  }

  broadcast({
    type: 'profile-updated',
    user_id: u.id,
    username: u.username,
    color, tag, tag_bg,
  });
  broadcastUserList();

  res.json({ ok: true, profile: { color, tag, tag_bg } });
});

// ==================== ADMIN API ====================
function requireAdmin(req, res, next) {
  const u = sessionUser(req);
  if (!u) return res.status(401).json({ error: 'Not signed in' });
  if (u.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  req.admin = u;
  next();
}

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const rows = db.prepare(
    'SELECT id, username, role, banned, created_at, color, tag, tag_bg FROM users ORDER BY id'
  ).all();
  res.json({ users: rows });
});

app.post('/api/admin/ban', requireAdmin, (req, res) => {
  const id = Number(req.body.id);
  const banned = req.body.banned ? 1 : 0;
  if (id === req.admin.id) return res.status(400).json({ error: 'Cannot ban yourself' });
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'No such user' });

  db.prepare('UPDATE users SET banned = ? WHERE id = ?').run(banned, id);
  if (banned) {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    const set = userSockets.get(id);
    if (set) for (const ws of set) { try { ws.close(4003, 'banned'); } catch {} }
  }
  broadcast({ type: 'system', text: `${target.username} was ${banned ? 'banned' : 'unbanned'}`, ts: Date.now() });
  res.json({ ok: true });
});

app.post('/api/admin/promote', requireAdmin, (req, res) => {
  const id = Number(req.body.id);
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  if (id === req.admin.id) return res.status(400).json({ error: 'Cannot change your own role' });
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'No such user' });
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  for (const info of sockets.values()) {
    if (info.userId === id) info.role = role;
  }
  broadcast({ type: 'system', text: `${target.username} is now ${role}`, ts: Date.now() });
  broadcastUserList();
  res.json({ ok: true });
});

app.post('/api/admin/delete-message', requireAdmin, (req, res) => {
  const id = Number(req.body.id);
  const scope = req.body.scope === 'dm' ? 'dm' : 'public';
  const table = scope === 'dm' ? 'dms' : 'messages';
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ error: 'No such message' });

  db.prepare(`UPDATE ${table} SET deleted = 1 WHERE id = ?`).run(id);
  if (scope === 'dm') {
    sendTo(row.from_id, { type: 'dm-deleted', id });
    sendTo(row.to_id, { type: 'dm-deleted', id });
  } else {
    broadcast({ type: 'msg-deleted', id });
  }
  res.json({ ok: true });
});

// ==================== WEBSOCKET ====================
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token') || '';
  const user = db.prepare(`
    SELECT u.id, u.username, u.role, u.banned, u.color, u.tag, u.tag_bg
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).get(token);

  if (!user || user.banned) {
    ws.send(JSON.stringify({ type: 'auth-error', text: 'Not authenticated' }));
    return ws.close(4001, 'unauthorized');
  }

  attach(ws, user);

  const history = db.prepare(`
    SELECT id, user_id, username, text, ts, edited_at, deleted
    FROM messages ORDER BY id DESC LIMIT 100
  `).all().reverse();

  const dms = db.prepare(`
    SELECT id, from_id, to_id, text, ts, edited_at, deleted
    FROM dms WHERE from_id = ? OR to_id = ?
    ORDER BY id DESC LIMIT 200
  `).all(user.id, user.id).reverse();

  ws.send(JSON.stringify({
    type: 'hello',
    you: {
      id: user.id, username: user.username, role: user.role,
      color: user.color || '', tag: user.tag || '', tag_bg: user.tag_bg || '',
    },
    history, dms,
    users: onlineUsers(),
  }));

  broadcast({ type: 'system', text: `${user.username} joined`, ts: Date.now() }, ws);
  broadcastUserList();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const me = sockets.get(ws);
    if (!me) return;

    if (msg.type === 'chat' && typeof msg.text === 'string') {
      const text = msg.text.trim().slice(0, 2000);
      if (!text) return;
      const now = Date.now();
      const info = db.prepare(
        'INSERT INTO messages (user_id, username, text, ts) VALUES (?, ?, ?, ?)'
      ).run(me.userId, me.username, text, now);
      broadcast({
        type: 'msg', id: info.lastInsertRowid,
        user_id: me.userId, username: me.username,
        text, ts: now, edited_at: null, deleted: 0,
      });
      return;
    }

    if (msg.type === 'dm' && msg.to && typeof msg.text === 'string') {
      const text = msg.text.trim().slice(0, 2000);
      if (!text) return;
      const to = Number(msg.to);
      const target = db.prepare('SELECT id, username, banned FROM users WHERE id = ?').get(to);
      if (!target || target.banned)
        return ws.send(JSON.stringify({ type: 'error', text: 'Cannot DM that user' }));

      const now = Date.now();
      const info = db.prepare(
        'INSERT INTO dms (from_id, to_id, text, ts) VALUES (?, ?, ?, ?)'
      ).run(me.userId, to, text, now);
      const payload = {
        type: 'dm', id: info.lastInsertRowid,
        from_id: me.userId, to_id: to, text, ts: now,
        edited_at: null, deleted: 0,
      };
      sendTo(me.userId, payload);
      sendTo(to, payload);
      return;
    }

    if (msg.type === 'edit' && Number.isInteger(msg.id) && typeof msg.text === 'string') {
      const text = msg.text.trim().slice(0, 2000);
      if (!text) return;
      const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(msg.id);
      if (!row || row.deleted) return;
      if (row.user_id !== me.userId && me.role !== 'admin')
        return ws.send(JSON.stringify({ type: 'error', text: 'Not yours to edit' }));
      const now = Date.now();
      db.prepare('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?').run(text, now, msg.id);
      broadcast({ type: 'msg-edited', id: msg.id, text, edited_at: now });
      return;
    }

    if (msg.type === 'delete' && Number.isInteger(msg.id)) {
      const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(msg.id);
      if (!row || row.deleted) return;
      if (row.user_id !== me.userId && me.role !== 'admin')
        return ws.send(JSON.stringify({ type: 'error', text: 'Not yours to delete' }));
      db.prepare('UPDATE messages SET deleted = 1 WHERE id = ?').run(msg.id);
      broadcast({ type: 'msg-deleted', id: msg.id });
      return;
    }

    if (msg.type === 'dm-edit' && Number.isInteger(msg.id) && typeof msg.text === 'string') {
      const text = msg.text.trim().slice(0, 2000);
      if (!text) return;
      const row = db.prepare('SELECT * FROM dms WHERE id = ?').get(msg.id);
      if (!row || row.deleted || row.from_id !== me.userId) return;
      const now = Date.now();
      db.prepare('UPDATE dms SET text = ?, edited_at = ? WHERE id = ?').run(text, now, msg.id);
      const payload = { type: 'dm-edited', id: msg.id, text, edited_at: now };
      sendTo(row.from_id, payload);
      sendTo(row.to_id, payload);
      return;
    }

    if (msg.type === 'dm-delete' && Number.isInteger(msg.id)) {
      const row = db.prepare('SELECT * FROM dms WHERE id = ?').get(msg.id);
      if (!row || row.deleted) return;
      if (row.from_id !== me.userId && me.role !== 'admin') return;
      db.prepare('UPDATE dms SET deleted = 1 WHERE id = ?').run(msg.id);
      const payload = { type: 'dm-deleted', id: msg.id };
      sendTo(row.from_id, payload);
      sendTo(row.to_id, payload);
      return;
    }

    if (msg.type === 'typing') {
      broadcast({ type: 'typing', user_id: me.userId, username: me.username }, ws);
    }
  });

  ws.on('close', () => {
    const me = sockets.get(ws);
    detach(ws);
    if (me) {
      broadcast({ type: 'system', text: `${me.username} left`, ts: Date.now() });
      broadcastUserList();
    }
  });

  ws.on('error', () => {});
});

server.listen(PORT, () => console.log(`Chatroom on http://localhost:${PORT}`));
