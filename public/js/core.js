// ==================== NAMESPACE ====================
window.Chat = window.Chat || {};
const C = window.Chat;

// ==================== STATE ====================
C.state = {
  token: localStorage.getItem('token') || null,
  me: null,
  ws: null,
  reconnectDelay: 1000,
  authMode: 'login',
  messages: new Map(),
  dms: new Map(),
  profiles: new Map(),
  unread: new Map(),          // userId -> count
  threads: new Set(),         // userIds who have DM history with me
  activeDM: null,
  editingId: null,
  editingDmId: null,
  editingProfile: { color: '', tag: '', tag_bg: '' },
  typingTimers: new Map(),
  dmTypingTimers: new Map(),
  lastTypingSent: 0,
  lastDmTypingSent: 0,
  slowmode: 0,                // seconds
  lastSlowNotified: 0,
  baseTitle: 'Chatroom',
};

C.PALETTE = ['', '#7aa2f7', '#9ece6a', '#e0af68', '#f7768e', '#bb9af7', '#7dcfff', '#ff9e64'];
C.REACTIONS = ['👍', '❤️', '😂', '🎉', '🔥', '👀', '😢', '🤔'];

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
  adminLink:    document.getElementById('adminLink'),
  logEl:        document.getElementById('log'),
  composer:     document.getElementById('composer'),
  textInput:    document.getElementById('textInput'),
  sendBtn:      document.getElementById('sendBtn'),
  usersEl:      document.getElementById('users'),
  threadsEl:    document.getElementById('threads'),
  typingEl:     document.getElementById('typing'),

  slowBadge:    document.getElementById('slowBadge'),
  slowSeconds:  document.getElementById('slowSeconds'),
  muteBanner:   document.getElementById('muteBanner'),
  muteUntil:    document.getElementById('muteUntil'),

  dmPanel:      document.getElementById('dmPanel'),
  dmThread:     document.getElementById('dmThread'),
  dmWith:       document.getElementById('dmWith'),
  dmTyping:     document.getElementById('dmTyping'),
  dmClose:      document.getElementById('dmClose'),
  dmComposer:   document.getElementById('dmComposer'),
  dmInput:      document.getElementById('dmInput'),

  profileModal: document.getElementById('profileModal'),
  paletteEl:    document.getElementById('palette'),
  profileTag:   document.getElementById('profileTag'),
  profileTagBg: document.getElementById('profileTagBg'),
  previewEl:    document.getElementById('preview'),
  profileError: document.getElementById('profileError'),

  mentionPopup: document.getElementById('mentionPopup'),
  userMenu:     document.getElementById('userMenu'),
  toastsEl:     document.getElementById('toasts'),
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
  const opts = { method, headers: { 'content-type': 'application/json' } };
  if (C.state.token) opts.headers.authorization = 'Bearer ' + C.state.token;
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(route, opts);
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
};

C.showToast = function (text, onClick) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  t.onclick = () => { onClick?.(); t.remove(); };
  C.refs.toastsEl.appendChild(t);
  setTimeout(() => t.remove(), 6000);
};

C.updateTitle = function () {
  const n = [...C.state.unread.values()].reduce((a, b) => a + b, 0);
  document.title = n > 0 ? `(${n}) ${C.state.baseTitle}` : C.state.baseTitle;
};

C.isMuted = function () {
  const mu = C.state.me?.muted_until || 0;
  if (mu === 0) return false;
  if (mu === -1) return true;
  return Date.now() < mu;
};

C.updateMuteUi = function () {
  const muted = C.isMuted();
  C.refs.muteBanner.classList.toggle('hidden', !muted);
  if (muted) {
    const mu = C.state.me.muted_until;
    C.refs.muteUntil.textContent = mu === -1
      ? '(permanent)'
      : `(until ${new Date(mu).toLocaleTimeString()})`;
  }
  // composer disabled if muted (unless admin)
  const isAdmin = C.state.me?.role === 'admin';
  const disable = muted && !isAdmin;
  C.refs.textInput.disabled = disable;
  C.refs.sendBtn.disabled = disable;
  C.refs.textInput.placeholder = disable ? 'You are muted' : 'Type a message…';
};

C.updateSlowUi = function () {
  const s = C.state.slowmode;
  if (!s) {
    C.refs.slowBadge.classList.add('hidden');
    return;
  }
  C.refs.slowBadge.classList.remove('hidden');
  C.refs.slowSeconds.textContent = s + 's';
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

// ==================== MESSAGE DISPATCH ====================
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
    C.state.slowmode = m.slowmode || 0;
    C.state.profiles.clear();
    m.users.forEach(u => C.state.profiles.set(u.id, u));
    C.state.profiles.set(m.you.id, m.you);

    C.state.unread.clear();
    Object.entries(m.unread || {}).forEach(([peer, n]) => C.state.unread.set(Number(peer), n));
    C.updateTitle();

    // sidebar threads (anyone with DM history)
    C.state.threads.clear();
    m.dms.forEach(d => {
      const peer = d.from_id === m.you.id ? d.to_id : d.from_id;
      C.state.threads.add(peer);
    });

    const { whoEl, adminLink } = C.refs;
    whoEl.innerHTML = `signed in as <b>${C.nameSpan({ user_id: m.you.id, username: m.you.username })}</b>`;
    whoEl.classList.toggle('admin', m.you.role === 'admin');
    if (m.you.role === 'admin') {
      whoEl.innerHTML += ` <span style="color:#e0af68;font-size:12px">· admin</span>`;
    }
    adminLink.classList.toggle('hidden', m.you.role !== 'admin');

    C.updateMuteUi();
    C.updateSlowUi();

    C.refs.logEl.innerHTML = '';
    C.state.messages.clear();
    C.state.dms.clear();
    m.history.forEach(C.addOrUpdateMsg);
    m.dms.forEach(C.addOrUpdateDm);
    C.renderUsers(m.users);
    C.renderThreads();
    C.scroll();
    C.refs.textInput.focus();
    return;
  }

  if (m.type === 'msg') {
    C.addOrUpdateMsg(m);
    C.scroll();
    if (C.checkMention?.(m)) {
      const el = document.getElementById('msg-' + m.id);
      if (el) {
        el.classList.add('mention');
        setTimeout(() => el.classList.remove('mention'), 4000);
      }
      C.showToast(`${m.username} mentioned you`, () => {
        document.getElementById('msg-' + m.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
    return;
  }
  if (m.type === 'msg-deleted') {
    const x = C.state.messages.get(m.id);
    if (x) { x.deleted = 1; C.renderMessage(x); }
    return;
  }

  if (m.type === 'dm') { C.onIncomingDm(m); return; }
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
  if (m.type === 'dm-read-by') {
    // nothing to render yet, hook for "seen" ticks later
    return;
  }
  if (m.type === 'dm-typing') {
    if (m.from !== C.state.activeDM) return;
    C.refs.dmTyping.textContent = `${m.username} typing…`;
    clearTimeout(C.state.dmTypingTimers.get(m.from));
    C.state.dmTypingTimers.set(m.from, setTimeout(() => {
      C.refs.dmTyping.textContent = '';
    }, 1800));
    return;
  }

  if (m.type === 'reactions') {
    const x = C.state.messages.get(m.id);
    if (x) { x.reactions = m.reactions; C.renderMessage(x); }
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

  if (m.type === 'mute-state') {
    if (C.state.me) C.state.me.muted_until = m.muted_until;
    C.updateMuteUi();
    return;
  }
  if (m.type === 'slowmode') {
    C.state.slowmode = m.seconds;
    C.updateSlowUi();
    return;
  }

  if (m.type === 'users') { C.renderUsers(m.users); return; }
  if (m.type === 'system') { C.addSystem(m.text); C.scroll(); return; }
  if (m.type === 'error') {
    C.showToast(m.text);
    return;
  }

  if (m.type === 'typing') {
    if (m.user_id === C.state.me?.id) return;
    C.refs.typingEl.textContent = `${m.username} is typing…`;
    clearTimeout(C.state.typingTimers.get(m.user_id));
    C.state.typingTimers.set(m.user_id, setTimeout(() => {
      C.refs.typingEl.textContent = '';
    }, 1500));
  }
};

// ==================== INCOMING DM ====================
C.onIncomingDm = function (m) {
  const me = C.state.me;
  const peer = m.from_id === me.id ? m.to_id : m.from_id;
  C.state.threads.add(peer);
  C.addOrUpdateDm(m);
  C.renderThreads();

  if (m.from_id !== me.id && peer !== C.state.activeDM) {
    C.state.unread.set(peer, (C.state.unread.get(peer) || 0) + 1);
    C.updateTitle();
    C.renderUsers([...C.state.profiles.values()]);
    C.renderThreads();
    const from = C.state.profiles.get(peer);
    C.showToast(`${from?.username || 'someone'}: ${m.text.slice(0, 60)}`,
      () => C.openDM(peer, from?.username || 'user'));
  }
};

// debug handle
window.Chat = C;
