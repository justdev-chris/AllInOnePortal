(function () {
  const C = window.Chat;
  const { refs, state } = C;

  // ==================== NAME RENDERING ====================
  C.nameSpan = function (m) {
    const p = state.profiles.get(m.user_id) || {};
    const color = p.color || '';
    const rainbow = color === 'rainbow';
    const tag = p.tag
      ? `<span class="tag"${p.tag_bg ? ` style="background:${p.tag_bg}"` : ''}>${C.escapeHtml(p.tag)}</span>`
      : '';

    if (!rainbow) {
      const style = color ? ` style="color:${color}"` : '';
      return `<span class="name"${style}>${C.escapeHtml(m.username)}</span>${tag}`;
    }

    const chars = [...m.username];
    const total = chars.length || 1;
    const spans = chars.map((ch, i) => {
      const delay = (-i / total * 2).toFixed(3);
      const content = ch === ' ' ? '&nbsp;' : C.escapeHtml(ch);
      return `<span class="ch" style="animation-delay:${delay}s">${content}</span>`;
    }).join('');
    return `<span class="name rainbow">${spans}</span>${tag}`;
  };

  // ==================== LINK / GIF DETECT ====================
  const IMG_RE = /https?:\/\/[^\s<>"']+\.(?:gif|png|jpe?g|webp)(?:\?[^\s<>"']*)?/i;
  const URL_RE = /https?:\/\/[^\s<>"']+/i;

  function renderText(raw) {
    const escaped = C.escapeHtml(raw);
    const imgMatch = raw.match(IMG_RE);
    if (imgMatch) {
      const src = imgMatch[0];
      // strip image URL from text, show remainder + image
      const rest = raw.replace(src, '').trim();
      const restHtml = rest ? `<div>${C.escapeHtml(rest)}</div>` : '';
      return `${restHtml}<img src="${C.escapeHtml(src)}" alt="gif" loading="lazy" />`;
    }
    // linkify
    return escaped.replace(URL_RE, (u) => {
      const safe = C.escapeHtml(u);
      return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${safe}</a>`;
    });
  }

  // ==================== PUBLIC MESSAGES ====================
  C.addOrUpdateMsg = function (m) {
    state.messages.set(m.id, { ...m });
    C.renderMessage(state.messages.get(m.id));
  };

  C.renderMessage = function (m) {
    let el = document.getElementById('msg-' + m.id);
    if (!el) {
      el = document.createElement('div');
      el.id = 'msg-' + m.id;
      refs.logEl.appendChild(el);
    }
    const isMine = state.me && m.user_id === state.me.id;
    const canEdit = isMine && !m.deleted;
    const canDelete = !m.deleted && (isMine || state.me?.role === 'admin');

    el.className = 'msg' + (m.deleted ? ' deleted' : '');
    const text = m.deleted ? '(deleted)' : renderText(m.text);
    const edited = m.edited_at && !m.deleted ? '<span class="meta">(edited)</span>' : '';

    el.innerHTML = `
      <div class="body">
        ${C.nameSpan(m)}
        <span class="time">${new Date(m.ts).toLocaleTimeString()}</span>
        <div class="text">${text}${edited}</div>
        <div class="reactions"></div>
      </div>
      <div class="tools"></div>
      ${!m.deleted ? '<div class="react-picker"></div>' : ''}
    `;

    // tools
    const tools = el.querySelector('.tools');
    if (canEdit) {
      const b = document.createElement('button');
      b.textContent = 'edit';
      b.onclick = () => beginEditPublic(m);
      tools.appendChild(b);
    }
    if (canDelete) {
      const b = document.createElement('button');
      b.textContent = 'delete';
      b.onclick = () => {
        if (confirm('Delete this message?')) {
          state.ws.send(JSON.stringify({ type: 'delete', id: m.id }));
        }
      };
      tools.appendChild(b);
    }

    // reactions render
    renderReactions(el.querySelector('.reactions'), m);

    // react picker
    const picker = el.querySelector('.react-picker');
    if (picker) {
      C.REACTIONS.forEach(e => {
        const b = document.createElement('button');
        b.textContent = e;
        b.onclick = () => {
          state.ws.send(JSON.stringify({ type: 'react', id: m.id, emoji: e }));
        };
        picker.appendChild(b);
      });
    }
  };

  function renderReactions(container, m) {
    container.innerHTML = '';
    if (!m.reactions || !m.reactions.length) return;
    // group by emoji
    const groups = new Map();
    for (const r of m.reactions) {
      if (!groups.has(r.emoji)) groups.set(r.emoji, []);
      groups.get(r.emoji).push(r.user_id);
    }
    for (const [emoji, users] of groups) {
      const b = document.createElement('button');
      if (state.me && users.includes(state.me.id)) b.classList.add('mine');
      b.innerHTML = `${emoji}<span class="count">${users.length}</span>`;
      b.title = users.length + ' reaction' + (users.length === 1 ? '' : 's');
      b.onclick = () => {
        state.ws.send(JSON.stringify({ type: 'react', id: m.id, emoji }));
      };
      container.appendChild(b);
    }
  }

  function beginEditPublic(m) {
    state.editingId = m.id;
    state.editingDmId = null;
    refs.textInput.value = m.text;
    refs.textInput.focus();
    refs.composer.querySelector('button').textContent = 'Save';
  }
  function cancelEditPublic() {
    state.editingId = null;
    refs.textInput.value = '';
    refs.composer.querySelector('button').textContent = 'Send';
  }
  C.cancelEditPublic = cancelEditPublic;

  // ==================== DMs ====================
  C.addOrUpdateDm = function (m) {
    state.dms.set(m.id, { ...m });
    C.renderDm(state.dms.get(m.id));
  };

  C.renderDm = function (m) {
    const peer = m.from_id === state.me.id ? m.to_id : m.from_id;
    if (peer !== state.activeDM) return;
    let el = document.getElementById('dm-' + m.id);
    if (!el) {
      el = document.createElement('div');
      el.id = 'dm-' + m.id;
      refs.dmThread.appendChild(el);
    }
    el.className = 'dm' + (m.from_id === state.me.id ? ' out' : '') + (m.deleted ? ' deleted' : '');
    const text = m.deleted ? '(deleted)' : renderText(m.text);
    const edited = m.edited_at && !m.deleted ? '<span class="meta">(edited)</span>' : '';
    const canEdit = m.from_id === state.me.id && !m.deleted;
    const canDelete = !m.deleted && (m.from_id === state.me.id || state.me.role === 'admin');
    el.innerHTML = `${text}${edited}<div class="tools"></div>`;

    const tools = el.querySelector('.tools');
    if (canEdit) {
      const b = document.createElement('button');
      b.textContent = 'edit';
      b.onclick = () => {
        state.editingDmId = m.id;
        state.editingId = null;
        refs.dmInput.value = m.text;
        refs.dmInput.focus();
      };
      tools.appendChild(b);
    }
    if (canDelete) {
      const b = document.createElement('button');
      b.textContent = 'del';
      b.onclick = () => {
        if (confirm('Delete this DM?')) {
          state.ws.send(JSON.stringify({ type: 'dm-delete', id: m.id }));
        }
      };
      tools.appendChild(b);
    }
    refs.dmThread.scrollTop = refs.dmThread.scrollHeight;
  };

  C.openDM = function (userId, username) {
    state.activeDM = userId;
    state.unread.delete(userId);
    C.updateTitle();
    C.renderUsers([...state.profiles.values()]);
    C.renderThreads();

    // mark read on server
    C.apiFetch('/api/dm/read', { peer: userId }).catch(() => {});

    refs.app.classList.remove('nodm');
    refs.dmPanel.classList.remove('hidden');
    refs.dmWith.textContent = 'DM with ' + username;
    refs.dmThread.innerHTML = '';
    [...state.dms.values()]
      .filter(x => (x.from_id === state.me.id && x.to_id === userId) ||
                   (x.from_id === userId && x.to_id === state.me.id))
      .forEach(C.renderDm);
    refs.dmInput.focus();
  };

  refs.dmClose.onclick = () => {
    state.activeDM = null;
    refs.dmPanel.classList.add('hidden');
    refs.app.classList.add('nodm');
  };

  refs.dmComposer.onsubmit = (e) => {
    e.preventDefault();
    if (!state.activeDM || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    const text = refs.dmInput.value.trim();
    if (!text) return;
    if (state.editingDmId !== null) {
      state.ws.send(JSON.stringify({ type: 'dm-edit', id: state.editingDmId, text }));
      state.editingDmId = null;
      refs.dmInput.value = '';
    } else {
      state.ws.send(JSON.stringify({ type: 'dm', to: state.activeDM, text }));
      refs.dmInput.value = '';
    }
  };

  refs.dmInput.addEventListener('input', () => {
    if (!state.activeDM || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (now - state.lastDmTypingSent < 800) return;
    state.lastDmTypingSent = now;
    state.ws.send(JSON.stringify({ type: 'dm-typing', to: state.activeDM }));
  });

  // ==================== SIDEBAR ====================
  C.renderUsers = function (users) {
    users.forEach(u => state.profiles.set(u.id, u));
    refs.usersEl.innerHTML = '';
    users
      .slice()
      .sort((a, b) => a.username.localeCompare(b.username))
      .forEach(u => {
        const li = document.createElement('li');
        const meTag = u.id === state.me?.id ? ' <span style="color:#8b8f99;font-size:12px">(you)</span>' : '';
        const adminTag = u.role === 'admin' ? '<span class="admin">admin</span>' : '';
        const n = state.unread.get(u.id) || 0;
        const badge = n ? ` <span class="badge">${n}</span>` : '';
        const muted = u.muted_until && (u.muted_until === -1 || u.muted_until > Date.now());
        if (muted) li.classList.add('muted-name');
        li.innerHTML = `<span>${C.nameSpan({ user_id: u.id, username: u.username })}</span>${meTag}${badge}${adminTag}`;
        if (u.id !== state.me?.id) {
          li.title = 'Click to DM · Right-click for actions';
          li.onclick = () => C.openDM(u.id, u.username);
          li.oncontextmenu = (e) => {
            e.preventDefault();
            C.openUserMenu?.(u, e.pageX, e.pageY);
          };
        }
        refs.usersEl.appendChild(li);
      });
  };

  C.renderThreads = function () {
    refs.threadsEl.innerHTML = '';
    const ids = [...state.threads];
    if (!ids.length) {
      const li = document.createElement('li');
      li.style.color = '#565b66';
      li.style.fontSize = '12px';
      li.textContent = 'no DMs yet';
      refs.threadsEl.appendChild(li);
      return;
    }
    // sort by most recent message
    const lastTs = (id) => {
      let max = 0;
      for (const d of state.dms.values()) {
        const peer = d.from_id === state.me.id ? d.to_id : d.from_id;
        if (peer === id && d.ts > max) max = d.ts;
      }
      return max;
    };
    ids.sort((a, b) => lastTs(b) - lastTs(a));
    ids.forEach(id => {
      const u = state.profiles.get(id);
      const name = u?.username || ('user' + id);
      const li = document.createElement('li');
      const n = state.unread.get(id) || 0;
      const badge = n ? ` <span class="badge">${n}</span>` : '';
      li.innerHTML = `<span>${C.nameSpan({ user_id: id, username: name })}</span>${badge}`;
      li.onclick = () => C.openDM(id, name);
      refs.threadsEl.appendChild(li);
    });
  };

  C.addSystem = function (text) {
    const div = document.createElement('div');
    div.className = 'system';
    div.textContent = text;
    refs.logEl.appendChild(div);
  };

  // ==================== @MENTION AUTOCOMPLETE ====================
  const popup = refs.mentionPopup;
  let mentionState = { active: false, start: -1, matches: [], sel: 0 };

  function closeMention() {
    mentionState.active = false;
    popup.classList.add('hidden');
    popup.innerHTML = '';
  }

  function updateMention() {
    const input = refs.textInput;
    const value = input.value;
    const caret = input.selectionStart;
    // find the @ that starts this mention
    let i = caret - 1;
    while (i >= 0 && /[A-Za-z0-9_.-]/.test(value[i])) i--;
    if (i < 0 || value[i] !== '@') { closeMention(); return; }
    const query = value.slice(i + 1, caret).toLowerCase();

    const matches = [...state.profiles.values()]
      .filter(u => u.id !== state.me.id)
      .filter(u => u.username.toLowerCase().startsWith(query))
      .slice(0, 8);

    if (!matches.length) { closeMention(); return; }

    mentionState.active = true;
    mentionState.start = i;
    mentionState.matches = matches;
    mentionState.sel = 0;

    popup.innerHTML = '';
    matches.forEach((u, idx) => {
      const d = document.createElement('div');
      d.className = 'item' + (idx === 0 ? ' sel' : '');
      d.textContent = u.username;
      d.onmousedown = (e) => { e.preventDefault(); applyMention(idx); };
      popup.appendChild(d);
    });

    // position under the input
    const rect = input.getBoundingClientRect();
    popup.style.left = rect.left + 'px';
    popup.style.top = (rect.top - 8) + 'px';
    popup.style.transform = 'translateY(-100%)';
    popup.classList.remove('hidden');
  }

  function applyMention(idx) {
    const u = mentionState.matches[idx];
    if (!u) return;
    const input = refs.textInput;
    const v = input.value;
    const caret = input.selectionStart;
    const before = v.slice(0, mentionState.start);
    const after = v.slice(caret);
    const inserted = '@' + u.username + ' ';
    input.value = before + inserted + after;
    const newPos = before.length + inserted.length;
    input.setSelectionRange(newPos, newPos);
    closeMention();
    input.focus();
  }

  refs.textInput.addEventListener('input', () => {
    if (state.editingId !== null) { closeMention(); return; }
    updateMention();
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (now - state.lastTypingSent < 800) return;
    state.lastTypingSent = now;
    state.ws.send(JSON.stringify({ type: 'typing' }));
  });

  refs.textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.editingId !== null) {
      cancelEditPublic();
      return;
    }
    if (!mentionState.active) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      mentionState.sel = Math.min(mentionState.sel + 1, mentionState.matches.length - 1);
      [...popup.children].forEach((c, i) => c.classList.toggle('sel', i === mentionState.sel));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      mentionState.sel = Math.max(mentionState.sel - 1, 0);
      [...popup.children].forEach((c, i) => c.classList.toggle('sel', i === mentionState.sel));
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      applyMention(mentionState.sel);
    } else if (e.key === 'Escape') {
      closeMention();
    }
  });

  refs.textInput.addEventListener('blur', () => setTimeout(closeMention, 100));

  // ==================== COMPOSER ====================
  refs.composer.onsubmit = (e) => {
    e.preventDefault();
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    const text = refs.textInput.value.trim();
    if (!text) return;
    if (state.editingId !== null) {
      state.ws.send(JSON.stringify({ type: 'edit', id: state.editingId, text }));
      cancelEditPublic();
    } else {
      state.ws.send(JSON.stringify({ type: 'chat', text }));
      refs.textInput.value = '';
    }
  };

  // ==================== MENTION HIGHLIGHT ====================
  C.checkMention = function (m) {
    const mine = state.me?.username;
    if (!mine || m.user_id === state.me.id) return false;
    const re = new RegExp(`@${mine}\\b`, 'i');
    return re.test(m.text);
  };
})();
