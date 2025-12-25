const KEY_YT_EMBED_150 = 'polaris.errorLists.ytEmbed150.v1';

function safeJsonParse(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function loadYtEmbed150Map() {
  try {
    const raw = localStorage.getItem(KEY_YT_EMBED_150);
    const parsed = safeJsonParse(raw, null);
    if (!parsed || typeof parsed !== 'object') return {};

    // v1 format: { [videoId]: userTitle }
    if (!('items' in parsed)) {
      const map = {};
      for (const [k, v] of Object.entries(parsed)) {
        const id = String(k || '').trim();
        if (!id) continue;
        const title = (typeof v === 'string') ? v : '';
        map[id] = title;
      }
      return map;
    }

    // Future-proofed format: { version: 1, items: { [videoId]: userTitle } }
    const items = parsed.items;
    if (!items || typeof items !== 'object') return {};
    const map = {};
    for (const [k, v] of Object.entries(items)) {
      const id = String(k || '').trim();
      if (!id) continue;
      const title = (typeof v === 'string') ? v : '';
      map[id] = title;
    }
    return map;
  } catch {
    return {};
  }
}

function saveYtEmbed150Map(map) {
  try {
    localStorage.setItem(KEY_YT_EMBED_150, JSON.stringify({ version: 1, items: map }));
  } catch {
    /* ignore */
  }
}

export function getYtEmbedError150Map() {
  return loadYtEmbed150Map();
}

export function addYtEmbedError150({ videoId, userTitle }) {
  const id = String(videoId || '').trim();
  if (!id) return;
  const title = String(userTitle || '');

  const map = loadYtEmbed150Map();
  if (!(id in map)) {
    map[id] = title;
    saveYtEmbed150Map(map);
    return;
  }

  // If we previously stored an empty title, upgrade it.
  if (!map[id] && title) {
    map[id] = title;
    saveYtEmbed150Map(map);
  }
}

export function removeYtEmbedError150(videoId) {
  const id = String(videoId || '').trim();
  if (!id) return false;
  const map = loadYtEmbed150Map();
  if (!(id in map)) return false;
  delete map[id];
  saveYtEmbed150Map(map);
  return true;
}

export function hasYtEmbedError150(videoId) {
  const id = String(videoId || '').trim();
  if (!id) return false;
  const map = loadYtEmbed150Map();
  return id in map;
}

export function getYtEmbedError150Count() {
  try {
    return Object.keys(loadYtEmbed150Map()).length;
  } catch {
    return 0;
  }
}

export function getYtEmbedError150List() {
  const map = loadYtEmbed150Map();
  const rows = Object.keys(map).map((videoId) => ({ videoId, userTitle: map[videoId] || '' }));
  rows.sort((a, b) => {
    const at = String(a.userTitle || '').toLocaleLowerCase();
    const bt = String(b.userTitle || '').toLocaleLowerCase();
    if (at < bt) return -1;
    if (at > bt) return 1;
    const av = String(a.videoId || '');
    const bv = String(b.videoId || '');
    if (av < bv) return -1;
    if (av > bv) return 1;
    return 0;
  });
  return rows;
}

function toTsvCell(value) {
  return String(value || '')
    .replace(/\r?\n/g, ' ')
    .replace(/\t/g, ' ')
    .trimEnd();
}

export function buildYtEmbedError150Tsv() {
  const rows = getYtEmbedError150List();
  const lines = ['videoId\tuserTitle'];
  for (const r of rows) {
    lines.push(`${toTsvCell(r.videoId)}\t${toTsvCell(r.userTitle)}`);
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
}

export function downloadTextAsFile({ filename, text, mime = 'text/plain' }) {
  const blob = new Blob([String(text || '')], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'download.txt';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => {
      try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    }, 1000);
  }
}
