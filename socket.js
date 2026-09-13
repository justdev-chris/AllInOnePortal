const { WebSocketServer, WebSocket } = require('ws');
const { findImageUrl } = require('./imageprobe');
const path = require('path');

function attachSocketServer(httpServer, db) {
  const wss = new WebSocketServer({ server: httpServer });

  // ==================== REGISTRY ====================
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
      muted_until: user.muted_until || 0,
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
        id: info.userId, username: info.username, role: info.role,
        color: info.color, tag: info.tag, tag_bg: info.tag_bg,
        muted_until: info.muted_until,
      });
    }
    return [...byId.values()];
  }
  function broadcastUserList() {
    broadcast({ type: 'users', users: onlineUsers() });
  }

  // ==================== HELPERS ====================
  function isMuted(info) {
    if (!info.muted_until) return false;
    if (info.muted_until === -1) return true;
    return Date.now() < info.muted_until;
  }

  function getSetting(key, fallback) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  }

  function getSlowmodeSeconds() {
    return Number(getSetting('slowmode_seconds', '0')) || 0;
  }

  function getAnnouncement() {
    const raw = getSetting('announcement', '');
    if (!raw) return null;
    try {
      const a = JSON.parse(raw);
      if (!a || !a.text) return null;
      if (a.expires_at && Date.now() > a.expires_at) return null;
      return a;
    } catch {
      return null;
    }
  }

  const lastMessageAt = new Map();
  const lastSoundAt = new Map();

  // ==================== SOUND REGISTRY ====================
  function getSoundById(id) {
    return db.prepare('SELECT id, name, filename FROM sounds WHERE id = ?').get(id);
  }

  function soundUrl(filename) {
    return '/uploads/sounds/' + filename;
  }

  // ==================== CONNECTION ====================
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://x');
    const token = url.searchParams.get('token') || '';

    const user = db.prepare(`
      SELECT u.id, u.username, u.role, u.banned, u.color, u.tag, u.tag_bg, u.muted_until
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?
    `).get(token);

    if (!user || user.banned) {
      ws.send(JSON.stringify({ type: 'auth-error', text: 'Not authenticated' }));
      return ws.close(4001, 'unauthorized');
    }

    attach(ws, user);

    const history = db.prepare(`
      SELECT id, user_id, username, text, ts, edited_at, deleted, image_url
      FROM messages ORDER BY id DESC LIMIT 100
    `).all().reverse();

    const messageIds = history.map(m => m.id);
    const reactions = messageIds.length
      ? db.prepare(`
          SELECT message_id, user_id, emoji
          FROM reactions
          WHERE message_id IN (${messageIds.map(() => '?').join(',')})
        `).all(...messageIds)
      : [];
    const reactMap = new Map();
    for (const r of reactions) {
      if (!reactMap.has(r.message_id)) reactMap.set(r.message_id, []);
      reactMap.get(r.message_id).push({ user_id: r.user_id, emoji: r.emoji });
    }
    for (const m of history) m.reactions = reactMap.get(m.id) || [];

    const dms = db.prepare(`
      SELECT id, from_id, to_id, text, ts, edited_at, deleted, read_at, image_url
      FROM dms WHERE from_id = ? OR to_id = ?
      ORDER BY id DESC LIMIT 200
    `).all(user.id, user.id).reverse();

    const unreadRows = db.prepare(`
      SELECT from_id AS peer, COUNT(*) AS n
      FROM dms
      WHERE to_id = ? AND read_at IS NULL AND deleted = 0
      GROUP BY from_id
    `).all(user.id);
    const unread = {};
    for (const r of unreadRows) unread[r.peer] = r.n;

    ws.send(JSON.stringify({
      type: 'hello',
      you: {
        id: user.id, username: user.username, role: user.role,
        color: user.color || '', tag: user.tag || '', tag_bg: user.tag_bg || '',
        muted_until: user.muted_until || 0,
      },
      history, dms, unread,
      slowmode: getSlowmodeSeconds(),
      announcement: getAnnouncement(),
      users: onlineUsers(),
    }));

    broadcast({ type: 'system', text: `${user.username} joined`, ts: Date.now() }, ws);
    broadcastUserList();

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      const me = sockets.get(ws);
      if (!me) return;

      // ---- public chat ----
      if (msg.type === 'chat' && typeof msg.text === 'string') {
        if (isMuted(me) && me.role !== 'admin') {
          return ws.send(JSON.stringify({ type: 'error', text: 'You are muted.' }));
        }
        const slow = getSlowmodeSeconds();
        if (slow > 0 && me.role !== 'admin') {
          const last = lastMessageAt.get(me.userId) || 0;
          const wait = (last + slow * 1000) - Date.now();
          if (wait > 0) {
            return ws.send(JSON.stringify({
              type: 'error',
              text: `Slow mode: wait ${Math.ceil(wait / 1000)}s`,
            }));
          }
        }

        const text = msg.text.trim().slice(0, 2000);
        if (!text) return;
        const now = Date.now();
        lastMessageAt.set(me.userId, now);

        const info = db.prepare(
          'INSERT INTO messages (user_id, username, text, ts) VALUES (?, ?, ?, ?)'
        ).run(me.userId, me.username, text, now);
        const id = info.lastInsertRowid;

        broadcast({
          type: 'msg',
          id,
          user_id: me.userId,
          username: me.username,
          text, ts: now,
          edited_at: null, deleted: 0,
          reactions: [],
          image_url: null,
        });

        findImageUrl(text).then((image_url) => {
          if (!image_url) return;
          db.prepare('UPDATE messages SET image_url = ? WHERE id = ?').run(image_url, id);
          broadcast({ type: 'msg-image', id, image_url });
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
          'INSERT INTO dms (from_id, to_id, text, ts, read_at) VALUES (?, ?, ?, ?, ?)'
        ).run(me.userId, to, text, now, null);
        const id = info.lastInsertRowid;

        const payload = {
          type: 'dm', id,
          from_id: me.userId, to_id: to,
          text, ts: now, edited_at: null, deleted: 0,
          image_url: null,
        };
        sendTo(me.userId, payload);
        sendTo(to, payload);

        findImageUrl(text).then((image_url) => {
          if (!image_url) return;
          db.prepare('UPDATE dms SET image_url = ? WHERE id = ?').run(image_url, id);
          const follow = { type: 'dm-image', id, image_url };
          sendTo(me.userId, follow);
          sendTo(to, follow);
        });
        return;
      }

      // ---- edit public ----
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

        findImageUrl(text).then((image_url) => {
          db.prepare('UPDATE messages SET image_url = ? WHERE id = ?').run(image_url, msg.id);
          broadcast({ type: 'msg-image', id: msg.id, image_url });
        });
        return;
      }

      // ---- delete public ----
      if (msg.type === 'delete' && Number.isInteger(msg.id)) {
        const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(msg.id);
        if (!row || row.deleted) return;
        if (row.user_id !== me.userId && me.role !== 'admin')
          return ws.send(JSON.stringify({ type: 'error', text: 'Not yours to delete' }));
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

        findImageUrl(text).then((image_url) => {
          db.prepare('UPDATE dms SET image_url = ? WHERE id = ?').run(image_url, msg.id);
          const follow = { type: 'dm-image', id: msg.id, image_url };
          sendTo(row.from_id, follow);
          sendTo(row.to_id, follow);
        });
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

      // ---- reactions ----
      if (msg.type === 'react' && Number.isInteger(msg.id) && typeof msg.emoji === 'string') {
        const emoji = msg.emoji.slice(0, 8);
        const row = db.prepare('SELECT id FROM messages WHERE id = ?').get(msg.id);
        if (!row) return;

        const existing = db.prepare(
          'SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'
        ).get(msg.id, me.userId, emoji);

        if (existing) {
          db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
            .run(msg.id, me.userId, emoji);
        } else {
          db.prepare('INSERT INTO reactions (message_id, user_id, emoji, ts) VALUES (?, ?, ?, ?)')
            .run(msg.id, me.userId, emoji, Date.now());
        }

        const reactions = db.prepare(
          'SELECT user_id, emoji FROM reactions WHERE message_id = ?'
        ).all(msg.id);

        broadcast({ type: 'reactions', id: msg.id, reactions });
        return;
      }

      // ---- sound board ----
      if (msg.type === 'sound' && Number.isInteger(msg.id)) {
        if (me.role !== 'admin') {
          return ws.send(JSON.stringify({ type: 'error', text: 'Admins only' }));
        }
        const now = Date.now();
        const last = lastSoundAt.get(me.userId) || 0;
        if (now - last < 3000) {
          return ws.send(JSON.stringify({ type: 'error', text: 'Slow down' }));
        }
        const s = getSoundById(msg.id);
        if (!s) {
          return ws.send(JSON.stringify({ type: 'error', text: 'No such sound' }));
        }
        lastSoundAt.set(me.userId, now);
        broadcast({
          type: 'sound',
          id: s.id,
          name: s.name,
          url: soundUrl(s.filename),
        });
        return;
      }

      // ---- typing ----
      if (msg.type === 'typing') {
        broadcast({ type: 'typing', user_id: me.userId, username: me.username }, ws);
        return;
      }
      if (msg.type === 'dm-typing' && msg.to) {
        sendTo(Number(msg.to), {
          type: 'dm-typing',
          from: me.userId,
          username: me.username,
        });
        return;
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

  function broadcastAll(payload) {
    broadcast(payload);
  }

  return {
    wss,
    broadcast,
    broadcastAll,
    sendTo,
    onlineUsers,
    broadcastUserList,
    userSockets,
    sockets,
  };
}

module.exports = { attachSocketServer };
