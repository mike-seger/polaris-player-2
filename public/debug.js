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
    const sidebar = document.getElementById('sidebar');
    overlay = document.createElement('div');
    overlay.id = 'debugOverlay';
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.background = 'rgba(10, 12, 18, 0.72)';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'flex-start';
    overlay.style.justifyContent = 'flex-start';
    overlay.style.zIndex = '1000';
    overlay.style.pointerEvents = 'auto';

    const panel = document.createElement('div');
    panel.classList.add('debug-overlay-panel');
    panel.style.background = '#161921';
    panel.style.color = '#f5f7fa';
    panel.style.padding = '1rem';
    panel.style.borderRadius = '8px';
    panel.style.display = 'flex';
    panel.style.flexDirection = 'column';
    panel.style.gap = '0.75rem';
    panel.style.flex = '1';
    panel.style.maxHeight = 'none';
    panel.style.overflow = 'hidden';
    panel.style.boxSizing = 'border-box';
    panel.style.boxShadow = '0 6px 18px rgba(0,0,0,0.35)';
    panel.style.border = '1px solid #2b2f3a';

    function applyPanelPlacement() {
      if (!panel || !overlay) return;
      const sidebarRect = sidebar instanceof HTMLElement ? sidebar.getBoundingClientRect() : null;
      const trackList = document.getElementById('trackListContainer');
      const trackRect = trackList instanceof HTMLElement ? trackList.getBoundingClientRect() : null;

      if (sidebarRect || trackRect) {
        const topOffset = Math.max(sidebarRect ? sidebarRect.top : (trackRect ? trackRect.top : 0), 0);
        const leftOffset = trackRect ? trackRect.left : (sidebarRect ? sidebarRect.left : 0);
        const targetWidth = trackRect ? trackRect.width : (sidebarRect ? sidebarRect.width : undefined);

        overlay.style.alignItems = 'flex-start';
        overlay.style.justifyContent = 'flex-start';
        overlay.style.padding = '0';
        overlay.style.paddingTop = `${topOffset}px`;
        overlay.style.paddingLeft = `${leftOffset}px`;
        overlay.style.paddingRight = '0';
        overlay.style.paddingBottom = '0';
        panel.style.position = 'relative';
        panel.style.top = '0';
        panel.style.left = '0';
        if (typeof targetWidth === 'number') {
          panel.style.width = `${targetWidth}px`;
          panel.style.maxWidth = `${targetWidth}px`;
          panel.style.minWidth = `${targetWidth}px`;
        } else {
          panel.style.width = 'auto';
          panel.style.maxWidth = '100%';
          panel.style.minWidth = '0';
        }
      } else {
        overlay.style.padding = '1rem';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        panel.style.position = 'relative';
        panel.style.top = 'auto';
        panel.style.left = 'auto';
        panel.style.width = 'min(420px, 90vw)';
        panel.style.maxWidth = 'min(420px, 90vw)';
        panel.style.minWidth = '0';
      }
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || document.body.clientHeight;
      const topOffset = parseFloat(overlay.style.paddingTop || '0');
      const bottomOffset = parseFloat(overlay.style.paddingBottom || '0');
      const availableHeight = Math.max(viewportHeight - topOffset - bottomOffset, 0);
      panel.style.maxHeight = `${availableHeight}px`;
      panel.style.overflow = 'hidden';
    }

    const removeOverlay = () => {
      if (typeof overlay._placementCleanup === 'function') {
        overlay._placementCleanup();
      }
      overlay.remove();
    };

    const closeBtn = window.OverlayShared && typeof window.OverlayShared.createOverlayCloseButton === 'function'
      ? window.OverlayShared.createOverlayCloseButton({ onClick: removeOverlay })
      : (function fallbackCloseButton() {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.setAttribute('aria-label', 'Close overlay');
          btn.style.background = '#28344d';
          btn.style.color = '#f5f7fa';
          btn.style.border = '1px solid #394150';
          btn.style.borderRadius = '4px';
          btn.style.padding = '0.35rem';
          btn.style.cursor = 'pointer';
          btn.style.fontSize = '0';
          btn.style.display = 'inline-flex';
          btn.style.alignItems = 'center';
          btn.style.justifyContent = 'center';
          const icon = document.createElement('span');
          icon.className = 'icon close';
          icon.setAttribute('aria-hidden', 'true');
          btn.appendChild(icon);
          btn.addEventListener('click', removeOverlay);
          return btn;
        })();

    const selector = document.createElement('select');
    selector.id = 'debugOverlaySelect';
    selector.style.background = '#202633';
    selector.style.color = '#f5f7fa';
    selector.style.border = '1px solid #394150';
    selector.style.borderRadius = '4px';
    selector.style.padding = '0.3rem 0.6rem';
    selector.style.fontSize = '0.85rem';
    selector.style.paddingRight = '1.8rem';
    selector.style.webkitAppearance = 'none';
    selector.style.mozAppearance = 'none';
    selector.style.appearance = 'none';

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
    const selectWrapper = document.createElement('div');
    selectWrapper.className = 'debug-select-wrapper';
    selectWrapper.appendChild(selector);
    headerRow.appendChild(selectWrapper);
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
    list.style.maxHeight = '100%';

    panel.appendChild(headerRow);
    panel.appendChild(list);
    overlay.appendChild(panel);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        removeOverlay();
      }
    });
    document.body.appendChild(overlay);
    applyPanelPlacement();

    const updatePlacement = () => {
      if (!overlay.isConnected) return;
      applyPanelPlacement();
    };

    window.addEventListener('resize', updatePlacement, { passive: true });
    window.addEventListener('scroll', updatePlacement, { passive: true });
    overlay._placementCleanup = () => {
      window.removeEventListener('resize', updatePlacement);
      window.removeEventListener('scroll', updatePlacement);
    };

    overlay._applyPanelPlacement = applyPanelPlacement;
  }

  const selector = document.getElementById('debugOverlaySelect');
  if (selector) {
    selector.value = view;
  }

  if (overlay && typeof overlay._applyPanelPlacement === 'function') {
    overlay._applyPanelPlacement();
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