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
    overlay = document.createElement('div');
    overlay.id = 'debugOverlay';
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.background = 'rgba(0, 0, 0, 0.7)';
    overlay.style.display = 'flex';
    overlay.style.flexDirection = 'column';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.zIndex = '9999';

    const panel = document.createElement('div');
    panel.style.background = '#fff';
    panel.style.padding = '1rem';
    panel.style.borderRadius = '8px';
    panel.style.width = 'min(420px, 90vw)';
    panel.style.maxHeight = '80vh';
    panel.style.overflow = 'auto';
    panel.style.boxShadow = '0 6px 18px rgba(0,0,0,0.25)';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = 'Close';
    closeBtn.style.alignSelf = 'flex-end';
    closeBtn.style.marginBottom = '0.5rem';
    closeBtn.addEventListener('click', () => overlay.remove());

    const list = document.createElement('div');
    list.id = 'debugOverlayContent';
    list.style.display = 'flex';
    list.style.flexDirection = 'column';
    list.style.gap = '0.75rem';

    panel.appendChild(closeBtn);
    panel.appendChild(list);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
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

    const iconPreview = document.createElement('span');
    iconPreview.setAttribute('aria-hidden', 'true');
    iconPreview.style.fontFamily = "'Material Icons Round-Regular'";
    iconPreview.style.fontSize = '32px';
    iconPreview.style.lineHeight = '1';
    iconPreview.style.minWidth = '32px';
    iconPreview.textContent = char;

      const codeLine = document.createElement('code');
      codeLine.textContent = name ? `U+${hex} ${name}` : `U+${hex}`;

    row.appendChild(iconPreview);
    row.appendChild(codeLine);
    list.appendChild(row);
  });
}