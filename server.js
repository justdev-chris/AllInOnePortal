const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { attachSocketServer } = require('./socket');

const app = express();
const server = http.createServer(app);
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
  CREATE TABLE IF NOT EXISTS reactions (
    message_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    emoji TEXT NOT NULL,
    ts INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id INTEGER NOT NULL,
    actor_username TEXT NOT NULL,
    action TEXT NOT NULL,
    target_id INTEGER,
    target_username TEXT,
    reason TEXT,
    ts INTEGER NOT NULL
  );
`);

function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
    console.log(`migrated: added ${table}.${column}`);
  }
}
addColumnIfMissing('users', 'color',        "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('users', 'tag',          "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('users', 'tag_bg',       "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('users', 'muted_until',  "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing('dms',   'read_at',      "INTEGER");

// settings helpers
function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

// defaults
if (getSetting('slowmode_seconds', null) === null) setSetting('slowmode_seconds', '0');

function audit(actor, action, target, reason) {
  db.prepare(`
    INSERT INTO audit_log (actor_id, actor_username, action, target_id, target_username, reason, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    actor.id,
    actor.username,
    action,
    target?.id ?? null,
    target?.username ?? null,
    reason || null,
    Date.now()
  );
}

function ensureAdminUser() {
  if (!ADMIN_USERNAME) return;
  const u = db.prepare('SELECT id, role FROM users WHERE username = ?').get(ADMIN_USERNAME);
  if (u && u.role !== 'admin') {
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run('admin', u.id);
    console.log(`promoted ${ADMIN_USERNAME} to admin`);
  }
}
ensureAdminUser();

// ==================== SOCKET SERVER ====================
const socketApi = attachSocketServer(server, db);
const { broadcast, sendTo, onlineUsers, broadcastUserList, userSockets, sockets } = socketApi;

// make helpers available to socket.js if it needs them
socketApi.getSetting = getSetting;

// ==================== AUTH ====================
function makeToken() { return crypto.randomBytes(32).toString('hex'); }

function sessionUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  return db.prepare(`
    SELECT s.token, u.id, u.username, u.role, u.banned, u.muted_until
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
  const full = db.prepare('SELECT color, tag, tag_bg, muted_until FROM users WHERE id = ?').get(u.id);
  res.json({
    user: {
      id: u.id, username: u.username, role: u.role,
      color: full?.color || '', tag: full?.tag || '', tag_bg: full?.tag_bg || '',
      muted_until: full?.muted_until || 0,
    },
  });
});

// ==================== DM READ ====================
app.post('/api/dm/read', (req, res) => {
  const u = sessionUser(req);
  if (!u) return res.status(401).json({ error: 'Not signed in' });
  const peer = Number(req.body.peer);
  if (!peer) return res.status(400).json({ error: 'peer required' });
  db.prepare(`
    UPDATE dms SET read_at = ?
    WHERE to_id = ? AND from_id = ? AND read_at IS NULL
  `).run(Date.now(), u.id, peer);
  sendTo(peer, { type: 'dm-read-by', by: u.id });
  res.json({ ok: true });
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

  for (const info of sockets.values()) {
    if (info.userId === u.id) {
      info.color = color;
      info.tag = tag;
      info.tag_bg = tag_bg;
    }
  }

  broadcast({ type: 'profile-updated', user_id: u.id, username: u.username, color, tag, tag_bg });
  broadcastUserList();
  res.json({ ok: true, profile: { color, tag, tag_bg } });
});

// ==================== ADMIN ====================
function requireAdmin(req, res, next) {
  const u = sessionUser(req);
  if (!u) return res.status(401).json({ error: 'Not signed in' });
  if (u.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  req.admin = u;
  next();
}

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const rows = db.prepare(
    'SELECT id, username, role, banned, created_at, color, tag, tag_bg, muted_until FROM users ORDER BY id'
  ).all();
  res.json({ users: rows, slowmode: Number(getSetting('slowmode_seconds', '0')) });
});

app.post('/api/admin/ban', requireAdmin, (req, res) => {
  const id = Number(req.body.id);
  const banned = req.body.banned ? 1 : 0;
  const reason = String(req.body.reason || '').trim().slice(0, 200);
  if (id === req.admin.id) return res.status(400).json({ error: 'Cannot ban yourself' });
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'No such user' });

  db.prepare('UPDATE users SET banned = ? WHERE id = ?').run(banned, id);
  if (banned) {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    const set = userSockets.get(id);
    if (set) for (const ws of set) { try { ws.close(4003, 'banned'); } catch {} }
  }
  audit(req.admin, banned ? 'ban' : 'unban', target, reason);
  broadcast({ type: 'system', text: `${target.username} was ${banned ? 'banned' : 'unbanned'}`, ts: Date.now() });
  res.json({ ok: true });
});

app.post('/api/admin/promote', requireAdmin, (req, res) => {
  const id = Number(req.body.id);
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  const reason = String(req.body.reason || '').trim().slice(0, 200);
  if (id === req.admin.id) return res.status(400).json({ error: 'Cannot change your own role' });
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'No such user' });
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  for (const info of sockets.values()) {
    if (info.userId === id) info.role = role;
  }
  audit(req.admin, role === 'admin' ? 'promote' : 'demote', target, reason);
  broadcast({ type: 'system', text: `${target.username} is now ${role}`, ts: Date.now() });
  broadcastUserList();
  res.json({ ok: true });
});

app.post('/api/admin/mute', requireAdmin, (req, res) => {
  const id = Number(req.body.id);
  const duration = Number(req.body.duration || 0);   // seconds; 0 = permanent, -1 = unmute
  const reason = String(req.body.reason || '').trim().slice(0, 200);
  if (id === req.admin.id) return res.status(400).json({ error: 'Cannot mute yourself' });
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'No such user' });

  let until = 0;
  let action = 'unmute';
  if (duration > 0) {
    until = Date.now() + duration * 1000;
    action = 'mute';
  } else if (duration === 0) {
    until = -1;   // sentinel: permanent mute
    action = 'mute';
  } else {
    until = 0;    // unmute
    action = 'unmute';
  }

  db.prepare('UPDATE users SET muted_until = ? WHERE id = ?').run(until, id);
  for (const info of sockets.values()) {
    if (info.userId === id) info.muted_until = until;
  }
  audit(req.admin, action, target, reason);
  sendTo(id, { type: 'mute-state', muted_until: until });
  broadcast({ type: 'system', text: `${target.username} was ${action === 'mute' ? 'muted' : 'unmuted'}`, ts: Date.now() });
  res.json({ ok: true, muted_until: until });
});

app.post('/api/admin/delete-message', requireAdmin, (req, res) => {
  const id = Number(req.body.id);
  const scope = req.body.scope === 'dm' ? 'dm' : 'public';
  const reason = String(req.body.reason || '').trim().slice(0, 200);
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
  audit(req.admin, 'delete-message', null, reason || `msg #${id}`);
  res.json({ ok: true });
});

app.post('/api/admin/slowmode', requireAdmin, (req, res) => {
  const seconds = Math.max(0, Math.min(3600, Number(req.body.seconds) || 0));
  setSetting('slowmode_seconds', seconds);
  audit(req.admin, 'slowmode', null, `${seconds}s`);
  broadcast({ type: 'slowmode', seconds });
  res.json({ ok: true, seconds });
});

app.get('/api/admin/audit', requireAdmin, (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const action = req.query.action ? String(req.query.action) : null;
  const actor  = req.query.actor  ? String(req.query.actor)  : null;
  const target = req.query.target ? String(req.query.target) : null;

  let sql = 'SELECT * FROM audit_log WHERE 1=1';
  const params = [];
  if (action) { sql += ' AND action = ?'; params.push(action); }
  if (actor)  { sql += ' AND actor_username = ?'; params.push(actor); }
  if (target) { sql += ' AND target_username = ?'; params.push(target); }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params);
  res.json({ entries: rows });
});

// ==================== LISTEN ====================
server.listen(PORT, () => console.log(`Chatroom on http://localhost:${PORT}`));
