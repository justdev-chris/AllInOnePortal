(function () {
  const C = window.Chat;
  const { refs } = C;

  const THEMES = ['dark', 'light', 'system', 'terminal'];
  const LS_THEME = 'theme';
  const LS_IMAGE = 'themeImage';

  function getStoredTheme() {
    const t = localStorage.getItem(LS_THEME);
    return THEMES.includes(t) ? t : 'dark';
  }

  function getStoredImage() {
    return localStorage.getItem(LS_IMAGE) || '';
  }

  function systemPrefersLight() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  }

  function resolveTheme(name) {
    if (name === 'system') return systemPrefersLight() ? 'light' : 'dark';
    return name;
  }

  C.applyTheme = function () {
    const name = getStoredTheme();
    const resolved = resolveTheme(name);
    document.body.classList.remove('theme-dark', 'theme-light', 'theme-terminal');
    document.body.classList.add('theme-' + resolved);
    document.body.dataset.theme = name;
    document.body.dataset.themeResolved = resolved;

    const img = getStoredImage();
    if (img) {
      document.body.classList.add('has-theme-image');
      document.body.style.setProperty('--theme-image', `url("${img.replace(/"/g, '\\"')}")`);
    } else {
      document.body.classList.remove('has-theme-image');
      document.body.style.removeProperty('--theme-image');
    }

    updateActiveButton();
  };

  C.setTheme = function (name) {
    if (!THEMES.includes(name)) return;
    localStorage.setItem(LS_THEME, name);
    C.applyTheme();
  };

  C.setThemeImage = function (url) {
    const v = String(url || '').trim();
    if (v) localStorage.setItem(LS_IMAGE, v);
    else localStorage.removeItem(LS_IMAGE);
    C.applyTheme();
  };

  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => {
    if (getStoredTheme() === 'system') C.applyTheme();
  });

  // ---------- profile modal UI ----------
  function buildPicker() {
    const modal = refs.profileModal;
    if (!modal) return;
    if (document.getElementById('themeSection')) return;

    const card = modal.querySelector('#profileCard');
    if (!card) return;

    const section = document.createElement('div');
    section.id = 'themeSection';
    section.innerHTML = `
      <label>Theme</label>
      <div id="themePicker">
        <button type="button" data-theme="dark">Dark</button>
        <button type="button" data-theme="light">Light</button>
        <button type="button" data-theme="system">System</button>
        <button type="button" data-theme="terminal">Terminal</button>
      </div>
      <label>Background image (optional)</label>
      <div id="themeImageRow">
        <input id="themeImageUrl" type="text" placeholder="https://… or /path.jpg" />
        <button id="themeImageClear" type="button">clear</button>
      </div>
    `;

    const actions = card.querySelector('#profileActions');
    if (actions) card.insertBefore(section, actions);
    else card.appendChild(section);

    document.querySelectorAll('#themePicker button').forEach(b => {
      b.onclick = () => C.setTheme(b.dataset.theme);
    });

    const urlInput = document.getElementById('themeImageUrl');
    urlInput.value = getStoredImage();
    urlInput.addEventListener('change', () => C.setThemeImage(urlInput.value));

    document.getElementById('themeImageClear').onclick = () => {
      urlInput.value = '';
      C.setThemeImage('');
    };
  }

  function updateActiveButton() {
    const current = getStoredTheme();
    document.querySelectorAll('#themePicker button').forEach(b => {
      b.classList.toggle('sel', b.dataset.theme === current);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      buildPicker();
      C.applyTheme();
    });
  } else {
    buildPicker();
    C.applyTheme();
  }

  C.getStoredTheme = getStoredTheme;
  C.getStoredImage = getStoredImage;
})();
