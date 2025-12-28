import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

// Prefix all console logs with an ISO timestamp for easier tracing.
const _consoleLog = console.log.bind(console);
const _consoleInfo = console.info.bind(console);
const _consoleWarn = console.warn.bind(console);
const _consoleError = console.error.bind(console);

function _logWithIso(prefixFn, args) {
  const ts = new Date().toISOString();
  if (args.length === 0) return prefixFn(`[${ts}]`);
  return prefixFn(`[${ts}]`, ...args);
}

console.log = (...args) => _logWithIso(_consoleLog, args);
console.info = (...args) => _logWithIso(_consoleInfo, args);
console.warn = (...args) => _logWithIso(_consoleWarn, args);
console.error = (...args) => _logWithIso(_consoleError, args);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

function parsePort(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || Number.isNaN(n)) return null;
  // Allow 0 (ephemeral) and the valid TCP/UDP port range.
  if (n < 0 || n > 65535) return null;
  return n;
}

function parsePortFromArgs(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--port' || a === '-p') {
      return parsePort(argv[i + 1]);
    }
    if (a && a.startsWith('--port=')) {
      return parsePort(a.slice('--port='.length));
    }
  }
  return null;
}

const DEFAULT_PORT = 3000;
const argvPort = parsePortFromArgs(process.argv.slice(2));
if (process.argv.includes('--port') || process.argv.includes('-p') || process.argv.some((a) => a.startsWith('--port='))) {
  if (argvPort === null) {
    console.error('Invalid --port value. Use an integer 0-65535 (0 chooses an ephemeral port).');
    process.exit(1);
  }
}

const envPort = parsePort(process.env.PORT);
const PORT = argvPort ?? envPort ?? DEFAULT_PORT;
const YT_API_KEY = process.env.YT_API_KEY;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const SCRAPE_USER_AGENT =
  process.env.YT_SCRAPE_USER_AGENT ||
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
const SCRAPE_MAX_PAGES = Number.parseInt(process.env.YT_SCRAPE_MAX_PAGES || '80', 10);

if (!YT_API_KEY) {
  console.error('Missing YT_API_KEY in .env');
  process.exit(1);
}

const CACHE_DIR = path.join(__dirname, 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'playlists.json');

// --- NEW: overrides file + in-memory map ---
const DATA_DIR = path.join(__dirname, 'data');
const OVERRIDES_FILE = path.join(DATA_DIR, 'overrides-by-id.json');
let titleOverrides = {};   // { [videoId]: { title: "...", ... } }

// Load overrides once at startup
function loadOverrides() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      titleOverrides = {};
      return;
    }
    if (!fs.existsSync(OVERRIDES_FILE)) {
      titleOverrides = {};
      return;
    }
    const raw = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8'));
    // Expecting { "overrides": { "<videoId>": { "title": "...", ... }, ... } }
    titleOverrides = raw.overrides || {};
    console.log(`Loaded ${Object.keys(titleOverrides).length} title overrides`);
  } catch (e) {
    console.warn('Failed to load overrides-by-id.json:', e.message);
    titleOverrides = {};
  }
}

let playlistCache = {};

function loadCache() {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    if (fs.existsSync(CACHE_FILE)) {
      playlistCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    } else playlistCache = {};
  } catch {
    playlistCache = {};
  }
}

function saveCache() {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(playlistCache, null, 2));
  } catch {}
}

app.get('/api/status', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

function getPlaylistId(input) {
  try {
    const url = new URL(input);
    return url.searchParams.get('list') || input;
  } catch {
    return input;
  }
}

function getCachedPlaylist(id) {
  const e = playlistCache[id];
  if (!e) return null;
  if (Date.now() - new Date(e.fetchedAt).getTime() > CACHE_TTL_MS) return null;
  return e;
}

// --- NEW: helper to attach userTitle from overrides ---
function applyTitleOverrides(items) {
  if (!items || !Array.isArray(items)) return items;
  return items.map((item) => {
    const ov = titleOverrides[item.videoId];
    if (ov && typeof ov.title === 'string' && ov.title.length > 0) {
      // keep original title, add a userTitle
      return { ...item, userTitle: ov.title };
    }
    return item;
  });
}

async function fetchPlaylistFromYouTube(id) {
  try {
    const titlePromise = fetchPlaylistTitle(id).catch(() => '');
    const results = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({
        part: 'snippet,contentDetails',
        playlistId: id,
        maxResults: '50',
        key: YT_API_KEY
      });
      if (pageToken) params.set('pageToken', pageToken);
      const resp = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?${params}`);
      if (!resp.ok) {
        const text = await resp.text();
        const error = new Error(text || `playlistItems request failed with status ${resp.status}`);
        error.status = resp.status;
        throw error;
      }
      const data = await resp.json();
      for (const item of data.items || []) {
        const vid = item.contentDetails?.videoId;
        const sn = item.snippet || {};
        if (!vid || sn.title === 'Private video' || sn.title === 'Deleted video') continue;
        results.push({
          videoId: vid,
          title: sn.title,
          position: sn.position,
          thumbnail: sn.thumbnails?.medium?.url || sn.thumbnails?.default?.url || null,
          channelTitle: sn.channelTitle
        });
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    const playlistTitle = await titlePromise;
    return { title: playlistTitle, items: results, source: 'api' };
  } catch (error) {
    if (isQuotaError(error)) {
      console.warn(`Quota exceeded fetching playlist ${id}, attempting fallback scrape.`);
      return await fetchPlaylistViaScrape(id);
    }
    throw error;
  }
}

async function fetchPlaylistTitle(id) {
  const params = new URLSearchParams({
    part: 'snippet',
    id,
    maxResults: '1',
    key: YT_API_KEY
  });

  const resp = await fetch(`https://www.googleapis.com/youtube/v3/playlists?${params}`);
  if (!resp.ok) {
    throw new Error(`Failed to fetch playlist metadata: ${resp.status}`);
  }
  const data = await resp.json();
  const title = data.items?.[0]?.snippet?.title;
  return title || '';
}

function isQuotaError(error) {
  if (!error) return false;
  const status = error.status || error.code || error.response?.status;
  const message = (typeof error.message === 'string' ? error.message : String(error)) || '';
  if (status === 403 && /quota/i.test(message)) return true;
  if (/quotaExceeded/i.test(message)) return true;
  if (/quota/i.test(message) && status === 403) return true;
  return false;
}

function extractJsonAfterMarker(html, marker) {
  const idx = html.indexOf(marker);
  if (idx === -1) {
    return null;
  }
  const start = html.indexOf('{', idx + marker.length);
  if (start === -1) {
    return null;
  }
  let depth = 0;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return html.slice(start, i + 1);
      }
    }
  }
  return null;
}

function extractContinuationToken(obj) {
  if (!obj) return null;
  if (typeof obj === 'string') return null;
  if (obj.continuationCommand?.token) return obj.continuationCommand.token;
  if (obj.nextContinuationData?.continuation) return obj.nextContinuationData.continuation;
  if (obj.reloadContinuationData?.continuation) return obj.reloadContinuationData.continuation;
  if (obj.continuationEndpoint?.continuationCommand?.token) {
    return obj.continuationEndpoint.continuationCommand.token;
  }
  return null;
}

function collectPlaylistData(node, renderers, continuationSet) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const child of node) {
      collectPlaylistData(child, renderers, continuationSet);
    }
    return;
  }
  if (typeof node !== 'object') return;

  if (node.playlistVideoRenderer) {
    renderers.push(node.playlistVideoRenderer);
  }

  const token = extractContinuationToken(node);
  if (token) {
    continuationSet.add(token);
  }

  for (const value of Object.values(node)) {
    collectPlaylistData(value, renderers, continuationSet);
  }
}

function extractYtConfig(html) {
  const config = {};
  const regex = /ytcfg\.set\((\{.*?\})\);/gs;
  let match;
  while ((match = regex.exec(html))) {
    try {
      const parsed = JSON.parse(match[1]);
      Object.assign(config, parsed);
      if (config.INNERTUBE_API_KEY && config.INNERTUBE_CONTEXT) {
        break;
      }
    } catch (error) {
      continue;
    }
  }
  return config;
}

async function fetchContinuationPage(apiKey, context, token) {
  const body = {
    context,
    continuation: token
  };

  const resp = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${apiKey}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': SCRAPE_USER_AGENT,
      'accept-language': 'en-US,en;q=0.9'
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(text || `Continuation request failed with status ${resp.status}`);
  }

  return resp.json();
}

async function fetchPlaylistViaScrape(id) {
  const url = `https://www.youtube.com/playlist?list=${id}&hl=en`;
  const resp = await fetch(url, {
    headers: {
      'user-agent': SCRAPE_USER_AGENT,
      'accept-language': 'en-US,en;q=0.9'
    }
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(text || `Fallback playlist fetch failed with status ${resp.status}`);
  }

  const html = await resp.text();
  const ytConfig = extractYtConfig(html);
  const jsonText =
    extractJsonAfterMarker(html, 'ytInitialData =') ||
    extractJsonAfterMarker(html, 'var ytInitialData =');

  if (!jsonText) {
    throw new Error('Fallback parser: ytInitialData not found');
  }

  let data;
  try {
    data = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`Fallback parser: failed to parse ytInitialData (${error.message})`);
  }

  const title =
    data?.metadata?.playlistMetadataRenderer?.title ||
    data?.header?.playlistHeaderRenderer?.title?.simpleText ||
    '';

  const renderers = [];
  const continuationSet = new Set();
  collectPlaylistData(data?.contents, renderers, continuationSet);

  const apiKey = ytConfig.INNERTUBE_API_KEY;
  let context = ytConfig.INNERTUBE_CONTEXT;
  if (typeof context === 'string') {
    try {
      context = JSON.parse(context);
    } catch (error) {
      console.warn('Failed to parse INNERTUBE_CONTEXT string from ytcfg:', error.message);
      context = null;
    }
  }

  if (apiKey && context && continuationSet.size > 0) {
    const queue = Array.from(continuationSet);
    const queueSet = new Set(queue);
    const processed = new Set();
    let pagesFetched = 0;

    while (queue.length > 0 && pagesFetched < SCRAPE_MAX_PAGES) {
      const token = queue.shift();
      queueSet.delete(token);
      if (!token || processed.has(token)) {
        continue;
      }
      processed.add(token);
      pagesFetched += 1;

      try {
        const continuationData = await fetchContinuationPage(apiKey, context, token);
        collectPlaylistData(continuationData, renderers, continuationSet);
        for (const candidate of continuationSet) {
          if (!processed.has(candidate) && !queueSet.has(candidate)) {
            queue.push(candidate);
            queueSet.add(candidate);
          }
        }
      } catch (error) {
        console.warn(`Failed to fetch continuation for playlist ${id}: ${error.message}`);
        break;
      }
    }
  } else if (continuationSet.size > 0) {
    console.warn(
      `Unable to follow playlist continuations for ${id}: missing INNERTUBE_API_KEY/CONTEXT.`
    );
  }

  const items = [];
  const seenVideoIds = new Set();
  for (const renderer of renderers) {
    const vidRaw = renderer.videoId;
    const vid = typeof vidRaw === 'string' ? vidRaw.trim() : '';
    if (!vid || renderer.isPlayable === false || seenVideoIds.has(vid)) continue;
    seenVideoIds.add(vid);

    const titleText = renderer.title?.runs?.[0]?.text || renderer.title?.simpleText || '';
    const positionText =
      renderer.index?.simpleText || renderer.index?.runs?.[0]?.text || String(items.length + 1);
    const position = Number.parseInt(positionText, 10);
    const thumbnail = renderer.thumbnail?.thumbnails?.[0]?.url || null;
    const channelTitle = renderer.shortBylineText?.runs?.[0]?.text || null;

    items.push({
      videoId: vid,
      title: titleText,
      position: Number.isFinite(position) ? Math.max(0, position - 1) : items.length,
      thumbnail,
      channelTitle
    });
  }

  if (!items.length) {
    throw new Error('Fallback parser: no videos found in playlist');
  }

  return {
    title,
    items,
    source: 'scrape',
    fallback: true
  };
}

app.get('/api/playlist', async (req, res) => {
  const raw = req.query.playlistId;
  const force = req.query.forceRefresh === '1';
  if (!raw) return res.status(400).json({ error: 'playlistId required' });

  const id = getPlaylistId(raw);

  try {
    if (!force) {
      const c = getCachedPlaylist(id);
      if (c) {
        // ensure any new overrides are visible even on cached entries
        const withOverrides = {
          ...c,
          items: applyTitleOverrides(c.items)
        };
        return res.json({ playlistId: id, fromCache: true, ...withOverrides });
      }
    }

    const playlistData = await fetchPlaylistFromYouTube(id);
    const items = applyTitleOverrides(playlistData.items);

    const entry = {
      playlistId: id,
      fetchedAt: new Date().toISOString(),
      title: playlistData.title,
      items,
      source: playlistData.source || 'api',
      fallback: Boolean(playlistData.fallback)
    };
    playlistCache[id] = entry;
    saveCache();
    res.json({ playlistId: id, fromCache: false, ...entry });
  } catch (e) {
    console.error(`Failed to fetch playlist ${id}:`, e);
    const stale = playlistCache[id];
    if (stale) {
      const withOverrides = {
        ...stale,
        items: applyTitleOverrides(stale.items)
      };
      return res.json({ playlistId: id, fromCache: true, stale: true, ...withOverrides });
    }
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/cache-info', (req, res) => {
  res.json(playlistCache);
});

// Register static file handling after API routes so dynamic endpoints take precedence.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: 0,
  setHeaders: (res, filePath) => {
    // iOS Safari can be particularly aggressive about caching when navigating
    // back/forward or resuming a tab. These headers bias hard toward revalidation.
    if (/\.(html|mjs|js|css|json)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// load overrides first so cache entries get userTitle baked in on initial fetch
loadOverrides();
loadCache();

const server = app.listen(PORT, () => {
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : PORT;
  console.log(`Server at http://localhost:${actualPort}`);
});
