import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const YT_API_KEY = process.env.YT_API_KEY;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

if (!YT_API_KEY) {
  console.error('Missing YT_API_KEY in .env');
  process.exit(1);
}

app.use(express.static(path.join(__dirname, 'public')));

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
    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json();
    for (const item of (data.items || [])) {
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
  return { title: playlistTitle, items: results };
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
      items
    };
    playlistCache[id] = entry;
    saveCache();
    res.json({ playlistId: id, fromCache: false, ...entry });
  } catch (e) {
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

// load overrides first so cache entries get userTitle baked in on initial fetch
loadOverrides();
loadCache();

app.listen(PORT, () => console.log(`Server at http://localhost:${PORT}`));
