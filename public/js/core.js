// ==================== GLOBAL NAMESPACE ====================
window.Chat = window.Chat || {};
const C = window.Chat;

// ==================== STATE ====================
C.state = {
  token: localStorage.getItem('token') || null,
  me: null,
  ws: null,
  reconnectDelay: 1000,
  authMode: 'login',
  messages: new Map(),   // public msg id -> entry
  dms: new Map(),        // dm id -> entry
  profiles: new Map(),   // userId -> { id, username, role, color, tag, tag_bg }
  activeDM: null,
  editingId: null,
  editingDmId: null,
  editingProfile: { color: '', tag: '', tag_bg: '' },
  typingTimers: new Map(),
  lastTypingSent: 0,
};

C.PALETTE = ['', '#7aa2f7', '#9ece6a', '#e0af68', '#f7768e', '#bb9af7', '#7dcfff', '#ff9e64'];

// ==================== DOM REFS ====================
C.refs = {
  overlay:      document.getElementById('overlay'),
  authCard:     document.getElementById('authCard'),
  authTitle:    document.getElementById('authTitle'),
  authUser:     document.getElementById('authUser'),
  authPass:     document.getElementById('authPass'),
  authError:    document.getElementById('authError'),
  authSubmit:   document.getElementById('authSubmit'),
  authMode:     document.getElementById('authMode'),

  app:          document.getElementById('app'),
  whoEl:        document.getElementById('who'),
  statusEl:     document.getElementById('status'),
  logoutBtn:    document.getElementById('logout'),
  logEl:        document.getElementById('log'),
  composer:     document.getElementById('composer'),
  textInput:    document.getElementById('textInput'),
  usersEl:      document.getElementById('users'),
  typingEl:     document.getElementById('typing'),

  dmPanel:      document.getElementById('dmPanel'),
  dmThread:     document.getElementById('dmThread'),
  dmWith:       document.getElementById('dmWith'),
  dmClose:      document.getElementById('dmClose'),
  dmComposer:   document.getElementById('dmComposer'),
  dmInput:      document.getElementById('dmInput'),

  profileModal: document.getElementById('profileModal'),
  paletteEl:    document.getElementById('palette'),
  profileTag:   document.getElementById('profileTag'),
  profileTagBg: document.getElementById('profileTagBg'),
  previewEl:    document.getElementById('preview'),
  profileError: document.getElementById('profileError'),
};

// ==================== HELPERS ====================
C.escapeHtml = function (s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
};

C.scroll = function () {
  C.refs.logEl.scrollTop = C.refs.logEl.scrollHeight;
};

C.apiFetch = async function (route, body, method = 'POST') {
  const opts = {
    method,
    headers: { 'content-type': 'application/json' },
  };
  if (C.state.token) opts.headers.authorization = 'Bearer ' + C.state.token;
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(route, opts);
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
};

// ==================== AUTH ====================
function setAuthMode(mode) {
  C.state.authMode = mode;
  const { authTitle, authSubmit, authMode, authError } = C.refs;
  if (mode === 'login') {
    authTitle.textContent = 'Sign in';
    authSubmit.textContent = 'Sign in';
    authMode.innerHTML = 'No account? <a id="toggleMode" href="#">Register</a>';
  } else {
    authTitle.textContent = 'Create account';
    authSubmit.textContent = 'Register';
    authMode.innerHTML = 'Have an account? <a id="toggleMode" href="#">Sign in</a>';
  }
  document.getElementById('toggleMode').onclick = (e) => {
    e.preventDefault();
    setAuthMode(C.state.authMode === 'login' ? 'register' : 'login');
    authError.textContent = '';
  };
}
setAuthMode('login');

C.refs.authCard.onsubmit = async (e) => {
  e.preventDefault();
  const { authUser, authPass, authError } = C.refs;
  authError.textContent = '';
  const username = authUser.value.trim();
  const password = authPass.value;
  if (!username || !password) { authError.textContent = 'Fill both fields.'; return; }

  const route = C.state.authMode === 'login' ? '/api/login' : '/api/register';
  try {
    const r = await fetch(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await r.json();
    if (!r.ok) { authError.textContent = data.error || 'Failed'; return; }
    C.state.token = data.token;
    localStorage.setItem('token', data.token);
    C.startChat();
  } catch {
    authError.textContent = 'Network error';
  }
};

C.refs.logoutBtn.onclick = async () => {
  try { await fetch('/api/logout', { method: 'POST', headers: { authorization: 'Bearer ' + C.state.token } }); } catch {}
  localStorage.removeItem('token');
  C.state.token = null;
  try { C.state.ws && C.state.ws.close(); } catch {}
  location.reload();
};

// ==================== BOOT ====================
if (C.state.token) {
  fetch('/api/me', { headers: { authorization: 'Bearer ' + C.state.token } })
    .then(r => r.ok ? r.json() : Promise.reject())
    .then(() => C.startChat())
    .catch(() => { localStorage.removeItem('token'); C.state.token = null; });
}

C.startChat = function () {
  C.refs.overlay.classList.add('hidden');
  C.refs.app.classList.remove('hidden');
  C.connect();
};

// ==================== WEBSOCKET ====================
C.connect = function () {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(C.state.token)}`);
  C.state.ws = ws;

  ws.onopen = () => {
    C.state.reconnectDelay = 1000;
    C.refs.statusEl.textContent = 'online';
  };

  ws.onclose = (ev) => {
    if (ev.code === 4001 || ev.code === 4003) {
      localStorage.removeItem('token');
      C.state.token = null;
      C.refs.overlay.classList.remove('hidden');
      C.refs.app.classList.add('hidden');
      return;
    }
    C.refs.statusEl.textContent = 'reconnecting…';
    setTimeout(C.connect, C.state.reconnectDelay);
    C.state.reconnectDelay = Math.min(C.state.reconnectDelay * 2, 30000);
  };

  ws.onerror = () => {};
  ws.onmessage = C.handleMessage;
};

C.handleMessage = function (e) {
  let m;
  try { m = JSON.parse(e.data); } catch { return; }

  if (m.type === 'auth-error') {
    localStorage.removeItem('token');
    C.state.token = null;
    C.refs.overlay.classList.remove('hidden');
    C.refs.app.classList.add('hidden');
    return;
  }

  if (m.type === 'hello') {
    C.state.me = m.you;
    C.state.profiles.clear();
    m.users.forEach(u => C.state.profiles.set(u.id, u));
    C.state.profiles.set(m.you.id, m.you);

    const { whoEl, adminLink } = C.refs;
    whoEl.innerHTML = `signed in as <b>${C.escapeHtml(m.you.username)}</b>`;
    whoEl.classList.toggle('admin', m.you.role === 'admin');
    if (m.you.role === 'admin') {
      whoEl.innerHTML += ` <span style="color:#e0af68;font-size:12px">· admin</span>`;
    }
    document.getElementById('adminLink').classList.toggle('hidden', m.you.role !== 'admin');

    C.refs.logEl.innerHTML = '';
    C.state.messages.clear();
    C.state.dms.clear();
    m.history.forEach(C.addOrUpdateMsg);
    m.dms.forEach(C.addOrUpdateDm);
    C.renderUsers(m.users);
    C.scroll();
    C.refs.textInput.focus();
    return;
  }

  if (m.type === 'msg') { C.addOrUpdateMsg(m); C.scroll(); return; }
  if (m.type === 'msg-edited') {
    const x = C.state.messages.get(m.id);
    if (x) { x.text = m.text; x.edited_at = m.edited_at; C.renderMessage(x); }
    return;
  }
  if (m.type === 'msg-deleted') {
    const x = C.state.messages.get(m.id);
    if (x) { x.deleted = 1; C.renderMessage(x); }
    return;
  }

  if (m.type === 'dm') { C.addOrUpdateDm(m); return; }
  if (m.type === 'dm-edited') {
    const x = C.state.dms.get(m.id);
    if (x) { x.text = m.text; x.edited_at = m.edited_at; C.renderDm(x); }
    return;
  }
  if (m.type === 'dm-deleted') {
    const x = C.state.dms.get(m.id);
    if (x) { x.deleted = 1; C.renderDm(x); }
    return;
  }

  if (m.type === 'profile-updated') {
    const p = C.state.profiles.get(m.user_id) || {};
    C.state.profiles.set(m.user_id, { ...p, ...m });
    C.state.messages.forEach(msg => {
      if (msg.user_id === m.user_id) C.renderMessage(msg);
    });
    return;
  }

  if (m.type === 'users') { C.renderUsers(m.users); return; }
  if (m.type === 'system') { C.addSystem(m.text); C.scroll(); return; }
  if (m.type === 'error') { alert(m.text); return; }

  if (m.type === 'typing') {
    if (m.user_id === C.state.me?.id) return;
    C.refs.typingEl.textContent = `${m.username} is typing…`;
    clearTimeout(C.state.typingTimers.get(m.user_id));
    C.state.typingTimers.set(m.user_id, setTimeout(() => { C.refs.typingEl.textContent = ''; }, 1500));
  }
};

// global export for debug
window.Chat = C;
