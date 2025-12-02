const USED_SYMBOLS_URL = './used-symbols.txt';
let cachedSymbols = null;

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

    try {
      const glyphs = await loadUsedSymbols();
      renderGlyphOverlay(glyphs);
    } catch (err) {
      console.error('Failed to load used symbols:', err);
      renderGlyphOverlay([], err.message || 'Failed to load symbol list.');
    }
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

function renderGlyphOverlay(glyphs, errorMessage) {
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

    panel.appendChild(closeBtn);
    panel.appendChild(list);
    overlay.appendChild(panel);
    host.appendChild(overlay);
  }

  const list = document.getElementById('debugOverlayContent');
  list.innerHTML = '';

  if (errorMessage) {
    const error = document.createElement('div');
    error.textContent = errorMessage;
    list.appendChild(error);
    return;
  }

  if (!glyphs.length) {
    const empty = document.createElement('div');
    empty.textContent = 'No glyphs listed in used-symbols.txt.';
    list.appendChild(empty);
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
    list.appendChild(row);
  });

  const rows = list.querySelectorAll('div');
  if (rows.length) {
    rows[rows.length - 1].style.borderBottom = 'none';
  }
}