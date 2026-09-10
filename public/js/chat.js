(function () {
  const C = window.Chat;
  const { refs, state } = C;

  // ---------- name rendering ----------
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

  // ---------- public messages ----------
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
    const text = m.deleted ? '(deleted)' : C.escapeHtml(m.text);
    const edited = m.edited_at && !m.deleted ? '<span class="meta">(edited)</span>' : '';

    el.innerHTML = `
      <div class="body">
        ${C.nameSpan(m)}
        <span class="time">${new Date(m.ts).toLocaleTimeString()}</span>
        <div class="text">${text}${edited}</div>
      </div>
      <div class="tools"></div>
    `;

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
  };

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

  // ---------- DMs ----------
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
    const text = m.deleted ? '(deleted)' : C.escapeHtml(m.text);
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

  // ---------- users ----------
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
        li.innerHTML = `<span>${C.nameSpan({ user_id: u.id, username: u.username })}</span>${meTag}${adminTag}`;
        if (u.id !== state.me?.id) {
          li.title = 'Click to DM';
          li.onclick = () => C.openDM(u.id, u.username);
        }
        refs.usersEl.appendChild(li);
      });
  };

  C.addSystem = function (text) {
    const div = document.createElement('div');
    div.className = 'system';
    div.textContent = text;
    refs.logEl.appendChild(div);
  };

  // ---------- composer ----------
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

  refs.textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.editingId !== null) cancelEditPublic();
  });

  refs.textInput.addEventListener('input', () => {
    if (state.editingId !== null) return;
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (now - state.lastTypingSent < 800) return;
    state.lastTypingSent = now;
    state.ws.send(JSON.stringify({ type: 'typing' }));
  });
})();
