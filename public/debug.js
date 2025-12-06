const USED_SYMBOLS_URL = './used-symbols.txt';
let cachedSymbols = null;
let cachedUserSettings = null;
const AVAILABLE_VIEWS = [
  { id: 'icons', label: 'Icon Encodings' },
  { id: 'settings', label: 'User Settings' }
];

document.addEventListener('DOMContentLoaded', () => {
  const debugBtn = document.getElementById('debugBtn');
  if (!debugBtn) return;

  debugBtn.addEventListener('click', async () => {
    if (document.fonts && document.fonts.ready) {
      try {
        await document.fonts.ready;
      } catch (err) {
        console.warn('Font readiness check failed:', err);
      }
    }

      await openDebugOverlay();
  });
});

async function loadUsedSymbols() {
  if (cachedSymbols) return cachedSymbols;

  const resp = await fetch(USED_SYMBOLS_URL, { cache: 'no-store' });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} while fetching ${USED_SYMBOLS_URL}`);
  }

  const text = await resp.text();
  const parsed = parseUsedSymbols(text);
  cachedSymbols = parsed;
  return parsed;
}

async function loadUserSettings() {
  if (cachedUserSettings) return cachedUserSettings;
  const STORAGE_KEY = 'ytAudioPlayer.settings';
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    cachedUserSettings = raw ? JSON.parse(raw) : {};
  } catch (error) {
    console.warn('Failed to read user settings from localStorage:', error);
    cachedUserSettings = { error: error.message };
  }
  return cachedUserSettings;
}

function parseUsedSymbols(raw) {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const match = line.match(/^U\+([0-9a-fA-F]+)\s+(.*)$/);
      if (!match) return null;
      const hex = match[1].toUpperCase();
      const name = (match[2] || '').trim();
      const codePoint = parseInt(hex, 16);
      if (!Number.isFinite(codePoint)) return null;
      return {
        hex,
        name,
        char: String.fromCodePoint(codePoint)
      };
    })
    .filter(Boolean);
}

async function openDebugOverlay() {
  try {
    const [glyphs, userSettings] = await Promise.all([loadUsedSymbols(), loadUserSettings()]);
      renderDebugOverlay({ view: 'icons', glyphs, userSettings });
  } catch (error) {
    console.error('Failed to open debug overlay:', error);
    renderDebugOverlay({
      view: 'icons',
      glyphs: [],
      userSettings: {},
      errorMessage: error.message || 'Failed to load debug data.'
    });
  }
}

function renderDebugOverlay({ view, glyphs, userSettings, errorMessage }) {
  let overlay = document.getElementById('debugOverlay');
  if (!overlay) {
    const host = document.getElementById('sidebar') || document.body;
    overlay = document.createElement('div');
    overlay.id = 'debugOverlay';
    overlay.style.position = host === document.body ? 'fixed' : 'absolute';
    overlay.style.inset = '0';
    overlay.style.background = 'rgba(0, 0, 0, 0.65)';
    overlay.style.display = 'flex';
    overlay.style.flexDirection = 'column';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.zIndex = '9999';
    overlay.style.padding = host === document.body ? '0' : '0.5rem';

    const panel = document.createElement('div');
    panel.classList.add('debug-overlay-panel');
    panel.style.background = '#161921';
    panel.style.color = '#f5f7fa';
    panel.style.padding = '1rem';
    panel.style.borderRadius = '8px';
    panel.style.display = 'flex';
    panel.style.flexDirection = 'column';
    panel.style.gap = '0.75rem';
    if (host === document.body) {
      panel.style.width = 'min(420px, 90vw)';
      panel.style.maxWidth = 'min(420px, 90vw)';
      panel.style.maxHeight = '80vh';
    } else {
      panel.style.width = 'calc(100% - 1.75rem)';
      panel.style.maxWidth = 'calc(100% - 1.75rem)';
      panel.style.maxHeight = 'calc(100% - 1.75rem)';
    }
    panel.style.overflow = 'hidden';
    panel.style.boxSizing = 'border-box';
    panel.style.boxShadow = '0 6px 18px rgba(0,0,0,0.35)';
    panel.style.border = '1px solid #2b2f3a';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = 'Close';
    closeBtn.style.alignSelf = 'flex-end';
    closeBtn.style.marginBottom = '0.25rem';
    closeBtn.style.background = '#28344d';
    closeBtn.style.color = '#f5f7fa';
    closeBtn.style.border = '1px solid #394150';
    closeBtn.style.borderRadius = '4px';
    closeBtn.style.padding = '0.35rem 0.85rem';
    closeBtn.style.cursor = 'pointer';
    closeBtn.style.fontSize = '0.85rem';
    closeBtn.style.fontWeight = '600';
    closeBtn.addEventListener('click', () => overlay.remove());

    const selector = document.createElement('select');
    selector.id = 'debugOverlaySelect';
    selector.style.background = '#202633';
    selector.style.color = '#f5f7fa';
    selector.style.border = '1px solid #394150';
    selector.style.borderRadius = '4px';
    selector.style.padding = '0.3rem 0.6rem';
    selector.style.fontSize = '0.85rem';
    selector.style.flex = '1';

    AVAILABLE_VIEWS.forEach(({ id, label }) => {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = label;
      selector.appendChild(option);
    });

    selector.addEventListener('change', async (event) => {
      const selected = event.target.value;
      await refreshDebugOverlay(selected);
    });

    const headerRow = document.createElement('div');
    headerRow.style.display = 'flex';
    headerRow.style.alignItems = 'center';
    headerRow.style.justifyContent = 'space-between';
    headerRow.style.gap = '0.75rem';
    headerRow.appendChild(selector);
    headerRow.appendChild(closeBtn);

    const list = document.createElement('div');
    list.id = 'debugOverlayContent';
    list.style.display = 'flex';
    list.style.flexDirection = 'column';
    list.style.gap = '0.75rem';
    list.style.color = '#f5f7fa';
    list.style.flex = '1';
    list.style.overflowY = 'auto';
    list.style.paddingRight = '0.25rem';
    list.classList.add('debug-overlay-scroll');

    panel.appendChild(headerRow);
    panel.appendChild(list);
    overlay.appendChild(panel);
    host.appendChild(overlay);
  }

  const selector = document.getElementById('debugOverlaySelect');
  if (selector) {
    selector.value = view;
  }

  fillDebugOverlay(view, { glyphs, userSettings, errorMessage });
}

async function refreshDebugOverlay(viewId) {
  let glyphs = cachedSymbols;
  let userSettings = cachedUserSettings;
  let errorMessage;

  try {
    if (!glyphs && viewId === 'icons') {
      glyphs = await loadUsedSymbols();
    }
    if (!userSettings && viewId === 'settings') {
      userSettings = await loadUserSettings();
    }
  } catch (error) {
    console.error('Failed to refresh debug overlay view:', error);
    errorMessage = error.message || 'Failed to load data for this view.';
  }

  fillDebugOverlay(viewId, { glyphs: glyphs || [], userSettings: userSettings || {}, errorMessage });
}

function fillDebugOverlay(view, { glyphs, userSettings, errorMessage }) {
  const list = document.getElementById('debugOverlayContent');
  if (!list) return;

  list.innerHTML = '';

  if (errorMessage) {
    const error = document.createElement('div');
    error.textContent = errorMessage;
    list.appendChild(error);
    return;
  }

  if (view === 'settings') {
    renderUserSettings(list, userSettings);
  } else {
    renderIconEncodings(list, glyphs);
  }
}

function renderUserSettings(container, settings) {
  const title = document.createElement('div');
  title.textContent = 'User Settings (localStorage)';
  title.style.fontWeight = '600';
  container.appendChild(title);

  if (!settings || (typeof settings === 'object' && Object.keys(settings).length === 0)) {
    const empty = document.createElement('div');
    empty.textContent = 'No stored settings found.';
    container.appendChild(empty);
    return;
  }

  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(settings, null, 2);
  pre.style.margin = '0';
  pre.style.padding = '0.5rem';
  pre.style.background = '#11141c';
  pre.style.border = '1px solid #2b2f3a';
  pre.style.borderRadius = '4px';
  pre.style.fontSize = '0.8rem';
  pre.style.lineHeight = '1.4';
  pre.style.color = '#f5f7fa';
  pre.style.whiteSpace = 'pre-wrap';
  pre.style.wordBreak = 'break-word';

  container.appendChild(pre);
}

function renderIconEncodings(container, glyphs) {
  if (!glyphs || !glyphs.length) {
    const empty = document.createElement('div');
    empty.textContent = 'No glyphs listed in used-symbols.txt.';
    container.appendChild(empty);
    return;
  }

  glyphs.forEach(({ hex, char, name }) => {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '0.75rem';
    row.style.padding = '0.5rem 0.25rem';
    row.style.borderBottom = '1px solid #2b2f3a';

    const iconPreview = document.createElement('span');
    iconPreview.setAttribute('aria-hidden', 'true');
    iconPreview.style.fontFamily = "'Material Icons Round-Regular'";
    iconPreview.style.fontSize = '32px';
    iconPreview.style.lineHeight = '1';
    iconPreview.style.minWidth = '32px';
    iconPreview.style.color = '#f5f7fa';
    iconPreview.textContent = char;

    const codeLine = document.createElement('code');
    codeLine.textContent = name ? `U+${hex} ${name}` : `U+${hex}`;
    codeLine.style.fontFamily = 'SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
    codeLine.style.fontSize = '0.85rem';
    codeLine.style.color = '#a8b3c7';

    row.appendChild(iconPreview);
    row.appendChild(codeLine);
    container.appendChild(row);
  });

  const rows = container.querySelectorAll('div');
  if (rows.length) {
    rows[rows.length - 1].style.borderBottom = 'none';
  }
}