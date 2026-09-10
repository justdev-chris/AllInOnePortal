const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

const clients = new Map();   // ws -> { id, name }
const history = [];          // last N entries
const HISTORY_LIMIT = 100;

let nextId = 1;

app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
function broadcast(payload, except) {
  const data = JSON.stringify(payload);
  for (const ws of clients.keys()) {
    if (ws !== except && ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function pushHistory(entry) {
  history.push(entry);
  if (history.length > HISTORY_LIMIT) history.shift();
}

function systemMessage(text, except) {
  const entry = { type: 'system', text, ts: Date.now() };
  pushHistory(entry);
  broadcast(entry, except);
}

function userList() {
  return [...clients.values()]
    .filter(c => c.name)
    .map(c => ({ id: c.id, name: c.name }));
}

function isNameTaken(name) {
  for (const c of clients.values()) {
    if (c.name && c.name.toLowerCase() === name.toLowerCase()) return true;
  }
  return false;
}

// ---------- websocket ----------
wss.on('connection', (ws) => {
  clients.set(ws, { id: null, name: null });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const me = clients.get(ws);
    if (!me) return;

    // ---- join ----
    if (msg.type === 'join') {
      if (me.name) return;
      const name = String(msg.name || '')
        .trim()
        .slice(0, 24)
        .replace(/\s+/g, '_');
      if (!name) {
        ws.send(JSON.stringify({ type: 'error', text: 'Please enter a name.' }));
        return;
      }
      if (isNameTaken(name)) {
        ws.send(JSON.stringify({ type: 'error', text: 'That name is taken.' }));
        return;
      }

      me.id = nextId++;
      me.name = name;

      ws.send(JSON.stringify({
        type: 'welcome',
        you: { id: me.id, name: me.name },
        history,
        users: userList(),
      }));

      systemMessage(`${name} joined`, ws);
      broadcast({ type: 'users', users: userList() });
      return;
    }

    // everything below requires a joined client
    if (!me.name) return;

    // ---- chat ----
    if (msg.type === 'chat' && typeof msg.text === 'string') {
      const text = msg.text.trim().slice(0, 2000);
      if (!text) return;
      const entry = { type: 'chat', id: me.id, name: me.name, text, ts: Date.now() };
      pushHistory(entry);
      broadcast(entry);
      return;
    }

    // ---- typing ----
    if (msg.type === 'typing') {
      broadcast({ type: 'typing', id: me.id, name: me.name }, ws);
    }
  });

  ws.on('close', () => {
    const me = clients.get(ws);
    clients.delete(ws);
    if (me && me.name) {
      systemMessage(`${me.name} left`);
      broadcast({ type: 'users', users: userList() });
    }
  });

  ws.on('error', () => {
    // swallow; close handler cleans up
  });
});

server.listen(PORT, () => {
  console.log(`Chatroom running at http://localhost:${PORT}`);
});