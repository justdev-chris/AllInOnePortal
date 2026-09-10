const { WebSocketServer, WebSocket } = require('ws');

function attachSocketServer(httpServer, db) {
  const wss = new WebSocketServer({ server: httpServer });

  // ==================== SOCKET REGISTRY ====================
  const sockets = new Map();      // ws -> { userId, username, role, color, tag, tag_bg }
  const userSockets = new Map();  // userId -> Set<ws>

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
      if (set) {
        set.delete(ws);
        if (!set.size) userSockets.delete(info.userId);
      }
    }
  }

  function sendTo(userId, payload) {
    const set = userSockets.get(userId);
    if (!set) return;
    const data = JSON.stringify(payload);
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
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

  // ==================== CONNECTION ====================
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
        id: user.id,
        username: user.username,
        role: user.role,
        color: user.color || '',
        tag: user.tag || '',
        tag_bg: user.tag_bg || '',
      },
      history,
      dms,
      users: onlineUsers(),
    }));

    broadcast({ type: 'system', text: `${user.username} joined`, ts: Date.now() }, ws);
    broadcastUserList();

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      const me = sockets.get(ws);
      if (!me) return;

      // ---- public chat ----
      if (msg.type === 'chat' && typeof msg.text === 'string') {
        const text = msg.text.trim().slice(0, 2000);
        if (!text) return;
        const now = Date.now();
        const info = db.prepare(
          'INSERT INTO messages (user_id, username, text, ts) VALUES (?, ?, ?, ?)'
        ).run(me.userId, me.username, text, now);
        broadcast({
          type: 'msg',
          id: info.lastInsertRowid,
          user_id: me.userId,
          username: me.username,
          text, ts: now,
          edited_at: null,
          deleted: 0,
        });
        return;
      }

      // ---- DM send ----
      if (msg.type === 'dm' && msg.to && typeof msg.text === 'string') {
        const text = msg.text.trim().slice(0, 2000);
        if (!text) return;
        const to = Number(msg.to);
        const target = db.prepare('SELECT id, username, banned FROM users WHERE id = ?').get(to);
        if (!target || target.banned) {
          return ws.send(JSON.stringify({ type: 'error', text: 'Cannot DM that user' }));
        }
        const now = Date.now();
        const info = db.prepare(
          'INSERT INTO dms (from_id, to_id, text, ts) VALUES (?, ?, ?, ?)'
        ).run(me.userId, to, text, now);
        const payload = {
          type: 'dm',
          id: info.lastInsertRowid,
          from_id: me.userId,
          to_id: to,
          text, ts: now,
          edited_at: null,
          deleted: 0,
        };
        sendTo(me.userId, payload);
        sendTo(to, payload);
        return;
      }

      // ---- edit public ----
      if (msg.type === 'edit' && Number.isInteger(msg.id) && typeof msg.text === 'string') {
        const text = msg.text.trim().slice(0, 2000);
        if (!text) return;
        const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(msg.id);
        if (!row || row.deleted) return;
        if (row.user_id !== me.userId && me.role !== 'admin') {
          return ws.send(JSON.stringify({ type: 'error', text: 'Not yours to edit' }));
        }
        const now = Date.now();
        db.prepare('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?').run(text, now, msg.id);
        broadcast({ type: 'msg-edited', id: msg.id, text, edited_at: now });
        return;
      }

      // ---- delete public ----
      if (msg.type === 'delete' && Number.isInteger(msg.id)) {
        const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(msg.id);
        if (!row || row.deleted) return;
        if (row.user_id !== me.userId && me.role !== 'admin') {
          return ws.send(JSON.stringify({ type: 'error', text: 'Not yours to delete' }));
        }
        db.prepare('UPDATE messages SET deleted = 1 WHERE id = ?').run(msg.id);
        broadcast({ type: 'msg-deleted', id: msg.id });
        return;
      }

      // ---- edit DM ----
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

      // ---- delete DM ----
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

      // ---- typing ----
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

  return {
    wss,
    broadcast,
    sendTo,
    onlineUsers,
    broadcastUserList,
    userSockets,
    sockets,
  };
}

module.exports = { attachSocketServer };
