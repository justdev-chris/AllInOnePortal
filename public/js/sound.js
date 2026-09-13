(function () {
  const C = window.Chat;
  const { refs, state } = C;

  const audioPool = new Map();   // soundId -> HTMLAudioElement (for uploaded sounds)
  let currentAudio = null;
  let currentId = null;

  function stopCurrent() {
    if (currentAudio) {
      try { currentAudio.pause(); currentAudio.currentTime = 0; } catch {}
      currentAudio = null;
      currentId = null;
      updatePlayingHighlight();
    }
  }

  function playSound(sound) {
    if (!sound || !sound.url) return;

    if (currentId === sound.id) {
      stopCurrent();
      return;
    }

    stopCurrent();

    let audio = audioPool.get(sound.id);
    if (!audio) {
      audio = new Audio(sound.url);
      audio.preload = 'auto';
      audioPool.set(sound.id, audio);
    } else if (audio.src !== sound.url) {
      audio.src = sound.url;
    }

    currentAudio = audio;
    currentId = sound.id;
    updatePlayingHighlight();

    audio.onended = () => {
      if (currentAudio === audio) {
        currentAudio = null;
        currentId = null;
        updatePlayingHighlight();
      }
    };

    audio.play().catch(() => {
      C.showToast?.('Tap to allow audio playback');
      if (currentAudio === audio) {
        currentAudio = null;
        currentId = null;
        updatePlayingHighlight();
      }
    });
  }

  function updatePlayingHighlight() {
    document.querySelectorAll('#soundPanel button[data-sound-id]').forEach(b => {
      b.classList.toggle('playing', Number(b.dataset.soundId) === currentId);
    });
  }

  // called by core.js when {type:'sound'} arrives
  C.playIncomingSound = function (payload) {
    if (!payload || !payload.id || !payload.url) return;
    playSound({ id: payload.id, url: payload.url, name: payload.name });
  };

  C.stopAllSounds = stopCurrent;

  // ---------- panel ----------
  async function loadSounds() {
    const r = await C.apiFetch('/api/sounds', undefined, 'GET');
    if (!r.ok) return [];
    return r.data.sounds || [];
  }

  async function renderPanel() {
    const panel = document.getElementById('soundPanel');
    if (!panel) return;

    const isAdmin = state.me?.role === 'admin';

    const sounds = await loadSounds();
    panel.innerHTML = '';

    if (!sounds.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:#8b8f99;font-size:12px;padding:6px';
      empty.textContent = isAdmin ? 'No sounds yet — upload one below.' : 'No sounds yet.';
      panel.appendChild(empty);
    } else {
      const grid = document.createElement('div');
      grid.className = 'soundGrid';
      sounds.forEach(s => {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.soundId = s.id;
        b.textContent = s.name;
        b.onclick = () => {
          if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({ type: 'sound', id: s.id }));
          }
        };
        grid.appendChild(b);
      });
      panel.appendChild(grid);
    }

    if (isAdmin) {
      const uploader = document.createElement('div');
      uploader.className = 'soundUploader';
      uploader.innerHTML = `
        <input id="soundName" type="text" placeholder="name" maxlength="24" />
        <input id="soundFile" type="file" accept="audio/*" />
        <button id="soundUploadBtn" type="button">upload</button>
      `;
      panel.appendChild(uploader);

      const nameEl = uploader.querySelector('#soundName');
      const fileEl = uploader.querySelector('#soundFile');
      const btn = uploader.querySelector('#soundUploadBtn');

      btn.onclick = async () => {
        const name = nameEl.value.trim();
        const file = fileEl.files?.[0];
        if (!name || !file) {
          C.showToast('Need a name and a file');
          return;
        }
        if (file.size > 2 * 1024 * 1024) {
          C.showToast('Max 2 MB');
          return;
        }

        const fd = new FormData();
        fd.append('name', name);
        fd.append('file', file);

        btn.disabled = true;
        try {
          const res = await fetch('/api/admin/sounds/upload', {
            method: 'POST',
            headers: { authorization: 'Bearer ' + state.token },
            body: fd,
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            C.showToast(data.error || 'Upload failed');
            return;
          }
          nameEl.value = '';
          fileEl.value = '';
          await renderPanel();
          C.showToast('Uploaded');
        } catch {
          C.showToast('Upload failed');
        } finally {
          btn.disabled = false;
        }
      };
    }

    updatePlayingHighlight();
  }

  C.refreshSoundPanel = renderPanel;

  document.addEventListener('DOMContentLoaded', () => {
    const toggle = document.getElementById('soundToggle');
    const panel = document.getElementById('soundPanel');
    if (!toggle || !panel) return;
    toggle.onclick = () => {
      const hidden = panel.classList.toggle('hidden');
      toggle.classList.toggle('active', !hidden);
      if (!hidden) renderPanel();
    };
    if (state.me) renderPanel();
  });

  // re-render when we learn who we are (after hello)
  const origHandle = C.handleMessage;
  C.handleMessage = function (e) {
    origHandle(e);
    if (C.state.me && !C.state._soundReady) {
      C.state._soundReady = true;
      renderPanel();
    }
  };
})();
