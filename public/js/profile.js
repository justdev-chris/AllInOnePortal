(function () {
  const C = window.Chat;
  const { refs, state } = C;

  document.getElementById('profileBtn').onclick = openProfile;
  document.getElementById('profileCancel').onclick = () => refs.profileModal.classList.add('hidden');
  document.getElementById('profileSave').onclick = saveProfile;

  refs.profileTag.addEventListener('input', () => {
    state.editingProfile.tag = refs.profileTag.value;
    updatePreview();
  });
  refs.profileTagBg.addEventListener('input', () => {
    state.editingProfile.tag_bg = refs.profileTagBg.value.trim();
    updatePreview();
  });

  function openProfile() {
    if (!state.me) return;
    state.editingProfile = {
      color: state.me.color || '',
      tag: state.me.tag || '',
      tag_bg: state.me.tag_bg || '',
    };
    refs.profileTag.value = state.editingProfile.tag;
    refs.profileTagBg.value = state.editingProfile.tag_bg;
    refs.profileError.textContent = '';
    renderPalette();
    updatePreview();
    refs.profileModal.classList.remove('hidden');
  }

  function renderPalette() {
    refs.paletteEl.innerHTML = '';
    const isAdmin = state.me?.role === 'admin';

    C.PALETTE.forEach(c => {
      const b = document.createElement('button');
      b.type = 'button';
      b.style.background = c || '#2a2e37';
      b.title = c || 'default';
      if (state.editingProfile.color === c) b.classList.add('sel');
      b.onclick = () => {
        state.editingProfile.color = c;
        renderPalette();
        updatePreview();
      };
      refs.paletteEl.appendChild(b);
    });

    if (isAdmin) {
      const rb = document.createElement('button');
      rb.type = 'button';
      rb.className = 'rainbow-btn';
      rb.title = 'rainbow';
      if (state.editingProfile.color === 'rainbow') rb.classList.add('sel');
      rb.onclick = () => {
        state.editingProfile.color = 'rainbow';
        renderPalette();
        updatePreview();
      };
      refs.paletteEl.appendChild(rb);

      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;gap:6px;margin-top:8px;width:100%';
      wrap.innerHTML = `
        <input id="customHex" type="text" maxlength="7" placeholder="#ff00aa"
          style="flex:1;background:#0f1115;border:1px solid #2a2e37;color:inherit;padding:6px 8px;border-radius:6px;font:inherit;font-size:13px" />
        <button id="customHexBtn" type="button"
          style="background:#2a2e37;color:#e6e6e6;border:0;padding:6px 10px;border-radius:6px;cursor:pointer;font:inherit;font-size:13px">use</button>
      `;
      refs.paletteEl.appendChild(wrap);
      wrap.querySelector('#customHexBtn').onclick = () => {
        const v = wrap.querySelector('#customHex').value.trim().toLowerCase();
        if (!/^#[0-9a-f]{6}$/.test(v)) {
          refs.profileError.textContent = 'Hex must look like #rrggbb';
          return;
        }
        state.editingProfile.color = v;
        refs.profileError.textContent = '';
        renderPalette();
        updatePreview();
      };
    }
  }

  function updatePreview() {
    const name = state.me?.username || 'you';
    const color = state.editingProfile.color;
    const rainbow = color === 'rainbow';
    const tag = state.editingProfile.tag
      ? `<span class="tag"${state.editingProfile.tag_bg ? ` style="background:${state.editingProfile.tag_bg}"` : ''}>${C.escapeHtml(state.editingProfile.tag)}</span>`
      : '';

    if (rainbow) {
      const chars = [...name];
      const total = chars.length || 1;
      const spans = chars.map((ch, i) => {
        const delay = (-i / total * 2).toFixed(3);
        const content = ch === ' ' ? '&nbsp;' : C.escapeHtml(ch);
        return `<span class="ch" style="animation-delay:${delay}s">${content}</span>`;
      }).join('');
      refs.previewEl.innerHTML = `<span class="name rainbow">${spans}</span>${tag}`;
    } else {
      const style = color ? ` style="color:${color}"` : '';
      refs.previewEl.innerHTML = `<span class="name"${style}>${C.escapeHtml(name)}</span>${tag}`;
    }
  }

  async function saveProfile() {
    refs.profileError.textContent = '';
    try {
      const { ok, data } = await C.apiFetch('/api/profile', state.editingProfile);
      if (!ok) { refs.profileError.textContent = data.error || 'Failed'; return; }

      state.me.color = data.profile.color;
      state.me.tag = data.profile.tag;
      state.me.tag_bg = data.profile.tag_bg;
      state.profiles.set(state.me.id, { ...state.profiles.get(state.me.id), ...state.me });
      refs.profileModal.classList.add('hidden');

      // update header
      refs.whoEl.innerHTML = `signed in as <b>${C.nameSpan({ user_id: state.me.id, username: state.me.username })}</b>`;
      refs.whoEl.classList.toggle('admin', state.me.role === 'admin');
      if (state.me.role === 'admin') {
        refs.whoEl.innerHTML += ` <span style="color:#e0af68;font-size:12px">· admin</span>`;
      }
    } catch {
      refs.profileError.textContent = 'Network error';
    }
  }
})();
