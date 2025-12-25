import { Emitter } from '../core/Emitter.mjs';

function clamp01(n) {
  const x = Number(n);
  if (!isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isSpotifyTrackId(id) {
  // Spotify track IDs are typically 22-char base62 strings.
  return typeof id === 'string' && /^[0-9A-Za-z]{22}$/.test(id);
}

function loadSpotifySdkOnce() {
  if (window.Spotify && window.Spotify.Player) return Promise.resolve();
  if (loadSpotifySdkOnce._p) return loadSpotifySdkOnce._p;

  loadSpotifySdkOnce._p = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-spotify-sdk="1"]');
    if (existing) {
      // Wait for global callback.
      window.onSpotifyWebPlaybackSDKReady = () => resolve();
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://sdk.scdn.co/spotify-player.js';
    script.async = true;
    script.defer = true;
    script.dataset.spotifySdk = '1';
    script.onerror = () => reject(new Error('Failed to load Spotify Web Playback SDK'));

    window.onSpotifyWebPlaybackSDKReady = () => resolve();
    document.head.appendChild(script);
  });

  return loadSpotifySdkOnce._p;
}

const SPOTIFY_ARTWORK_CACHE_KEY = 'polaris.spotify.artwork.v1';
const SPOTIFY_ARTWORK_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

// Browser fetch cannot always read `Retry-After` due to CORS `Access-Control-Expose-Headers`.
// Use a conservative client-side backoff (capped) to avoid hammering when rate-limited.
const SPOTIFY_ARTWORK_BACKOFF_BASE_MS = 5000;
const SPOTIFY_ARTWORK_BACKOFF_MAX_MS = 120000;

function readArtworkCache() {
  try {
    const raw = localStorage.getItem(SPOTIFY_ARTWORK_CACHE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return {};
    return obj;
  } catch {
    return {};
  }
}

function writeArtworkCache(cache) {
  try {
    localStorage.setItem(SPOTIFY_ARTWORK_CACHE_KEY, JSON.stringify(cache || {}));
  } catch {
    // ignore
  }
}

function getCachedArtworkUrl(trackId) {
  const id = String(trackId || '').trim();
  if (!id) return undefined;
  const cache = readArtworkCache();
  const entry = cache && cache[id];
  if (!entry || typeof entry !== 'object') return undefined;
  const url = typeof entry.url === 'string' ? entry.url : '';
  const ts = Number(entry.ts) || 0;
  if (!url) return undefined;
  if (ts && Date.now() - ts > SPOTIFY_ARTWORK_CACHE_TTL_MS) return undefined;
  return url;
}

function setCachedArtworkUrl(trackId, url) {
  const id = String(trackId || '').trim();
  const u = String(url || '').trim();
  if (!id || !u) return;
  const cache = readArtworkCache();
  cache[id] = { url: u, ts: Date.now() };
  writeArtworkCache(cache);
}

async function spotifyApi(accessToken, path, { method = 'GET', query = null, json = null } = {}) {
  const url = new URL(`https://api.spotify.com/v1/${path.replace(/^\//, '')}`);
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }

  // Minimal retry on rate limiting.
  // NOTE: Some headers may not be readable due to CORS, so we also apply a conservative exponential backoff.
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const resp = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(json ? { 'Content-Type': 'application/json' } : {}),
      },
      body: json ? JSON.stringify(json) : undefined,
    });

    if (resp.status === 429 && attempt < maxAttempts) {
      const ra = Number(resp.headers.get('Retry-After'));
      const baseMs = isFinite(ra) && ra > 0
        ? Math.floor(ra * 1000)
        : Math.min(30000, 1000 * (2 ** (attempt - 1)));
      const jitter = Math.floor(Math.random() * Math.min(750, Math.max(100, baseMs * 0.2)));
      await delay(baseMs + jitter);
      continue;
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      const err = new Error(`Spotify API ${method} ${path} failed (${resp.status}): ${text}`);
      err.status = resp.status;
      if (resp.status === 429) {
        const ra = Number(resp.headers.get('Retry-After'));
        if (isFinite(ra) && ra > 0) {
          err.retryAfterMs = Math.floor(ra * 1000);
        }
      }
      throw err;
    }

    if (resp.status === 204) return null;
    return resp.json().catch(() => null);
  }

  // Should be unreachable.
  throw new Error(`Spotify API ${method} ${path} failed (unknown).`);
}

export class SpotifyAdapter {
  constructor({ auth, name = 'Polaris Spotify Player' } = {}) {
    this.name = 'Spotify';
    this._auth = auth;
    this._sdkName = name;

    this._em = new Emitter();

    this._container = null;
    this._root = document.createElement('div');
    this._root.className = 'spotify-art-pane';
    this._root.style.display = 'none';
    this._root.style.width = '100%';
    this._root.style.height = '100%';
    this._root.style.flex = '1 1 auto';
    this._root.style.alignSelf = 'stretch';
    this._root.style.boxSizing = 'border-box';

    this._placeholderArtworkUrl = './img/spotify-icon.png';

    this._artImg = document.createElement('img');
    this._artImg.alt = '';
    this._artImg.loading = 'eager';
    this._artImg.decoding = 'async';
    this._artImg.style.display = 'none';
    this._artImg.style.width = '100%';
    this._artImg.style.height = '100%';
    this._artImg.style.objectFit = 'contain';
    this._root.appendChild(this._artImg);

    this._statusEl = document.createElement('div');
    this._statusEl.className = 'spotify-art-status';
    this._statusEl.textContent = 'Spotify connected.';
    this._root.appendChild(this._statusEl);

    this._player = null;
    this._deviceId = '';

    this._ensureReadyPromise = null;

    this._pendingPlay = null; // { trackId, startMs }
    this._startingPlayPromise = null;
    this._playbackRecoverTimer = null;
    this._playbackRecoverBackoffMs = 0;

    this._pollTimer = null;
    this._isPolling = false;
    this._activeSpotifyTrackId = '';
    this._activeTrackSkipArtworkCache = false;
    this._endedFired = false;
    this._suppressEndedUntilMs = 0;

    this._lastPollPositionMs = 0;
    this._lastPollDurationMs = 0;
    this._lastPollWasPlaying = false;
    this._inactivePollCount = 0;

    this._artworkCooldownUntilMs = 0;
    this._artworkBackoffMs = 0;

    this._state = {
      state: 'idle',
      muted: false,
      volume: 1,
      rate: 1,
      time: { positionMs: 0, durationMs: undefined, bufferedMs: undefined },
      activeTrackId: undefined,
    };

    this._lastNonMutedVolume = 1;

    this._artworkPrefetchInFlight = new Map();
    /** @type {Map<string, string>} */
    this._lastArtworkEmitById = new Map();

    /** @type {Set<string>} */
    this._skipArtworkCacheIds = new Set();
  }

  async _startPlayback(trackId, startMs = 0) {
    const tid = String(trackId || '').trim();
    if (!tid) return;
    if (!this._deviceId) return;

    if (this._startingPlayPromise) {
      return this._startingPlayPromise.catch(() => {});
    }

    this._startingPlayPromise = (async () => {
      const accessToken = await this._auth.getAccessToken();
      // Ensure this device is active before play.
      await spotifyApi(accessToken, '/me/player', {
        method: 'PUT',
        json: { device_ids: [this._deviceId], play: false },
      });

      await spotifyApi(accessToken, '/me/player/play', {
        method: 'PUT',
        query: { device_id: this._deviceId },
        json: {
          uris: [`spotify:track:${tid}`],
          position_ms: Math.max(0, Math.floor(Number(startMs) || 0)),
        },
      });
    })();

    try {
      await this._startingPlayPromise;
    } finally {
      this._startingPlayPromise = null;
    }
  }

  _schedulePlaybackRecovery(reason = '') {
    if (this._playbackRecoverTimer) return;
    const prev = Math.max(0, Number(this._playbackRecoverBackoffMs) || 0);
    const next = Math.min(120000, prev ? prev * 2 : 5000);
    const jitter = Math.floor(Math.random() * Math.min(1000, Math.max(200, next * 0.2)));
    const waitMs = next + jitter;
    this._playbackRecoverBackoffMs = next;

    this._playbackRecoverTimer = setTimeout(() => {
      this._playbackRecoverTimer = null;
      void this._recoverPlayback(reason);
    }, waitMs);
  }

  async _recoverPlayback(_reason = '') {
    // Best-effort: recreate the SDK player. This helps recover from certain SDK playback failures.
    const wasPlaying = this._state.state === 'playing' || this._state.state === 'buffering';
    const tid = String(this._activeSpotifyTrackId || '').trim();
    const pending = this._pendingPlay;

    this._stopPolling();
    try { await this._player?.disconnect?.(); } catch { /* ignore */ }
    this._player = null;
    this._deviceId = '';
    this._ensureReadyPromise = null;

    try {
      await this._ensureReady();
    } catch {
      return;
    }

    // Resume requested playback.
    if (pending && pending.trackId) {
      try {
        await this._startPlayback(pending.trackId, pending.startMs);
        this._pendingPlay = null;
        this._setState('playing');
      } catch {
        // keep pending
      }
      return;
    }

    if (wasPlaying && tid) {
      try {
        await this._startPlayback(tid, this._lastPollPositionMs || 0);
        this._setState('playing');
      } catch {
        // ignore
      }
    }
  }

  _emitArtworkIfNew(trackId, url) {
    const id = String(trackId || '').trim();
    const u = String(url || '').trim();
    if (!id || !u) return;

    const prev = this._lastArtworkEmitById.get(id);
    if (prev === u) return;
    this._lastArtworkEmitById.set(id, u);

    this._em.emit('artwork', { trackId: id, url: u });
  }

  _sdkTrackMatchesId(sdkTrack, id) {
    const want = String(id || '').trim();
    if (!want) return false;
    const t = sdkTrack || null;
    const tid = t && t.id ? String(t.id).trim() : '';
    if (tid && tid === want) return true;
    const uri = t && t.uri ? String(t.uri).trim() : '';
    if (uri && uri.endsWith(`:${want}`)) return true;
    const lf = t && t.linked_from ? t.linked_from : null;
    const lfid = lf && lf.id ? String(lf.id).trim() : '';
    if (lfid && lfid === want) return true;
    const lfuri = lf && lf.uri ? String(lf.uri).trim() : '';
    if (lfuri && lfuri.endsWith(`:${want}`)) return true;
    return false;
  }

  _maybeCacheArtworkFromSdkTrack(sdkTrack, alsoKeyAs = '') {
    const t = sdkTrack || null;
    const trackId = t && t.id ? String(t.id).trim() : '';
    const images = t && t.album && Array.isArray(t.album.images) ? t.album.images : [];
    const url = images.length && images[0] && typeof images[0].url === 'string' ? String(images[0].url).trim() : '';
    if (!url) return;

    if (trackId) {
      if (this._skipArtworkCacheIds && this._skipArtworkCacheIds.has(trackId)) return;
      try {
        const prev = getCachedArtworkUrl(trackId);
        if (prev !== url) {
          setCachedArtworkUrl(trackId, url);
          this._emitArtworkIfNew(trackId, url);
        }
      } catch {
        /* ignore */
      }
    }

    const extraKey = String(alsoKeyAs || '').trim();
    // Only associate SDK artwork to the requested id if the SDK track appears to match.
    // During track changes the SDK can briefly report the previous/current track; blindly
    // keying that artwork under the requested id causes rapid src flips (visible flicker).
    if (extraKey && extraKey !== trackId && this._sdkTrackMatchesId(t, extraKey)) {
      if (this._skipArtworkCacheIds && this._skipArtworkCacheIds.has(extraKey)) return;
      try {
        const prev = getCachedArtworkUrl(extraKey);
        if (prev !== url) {
          setCachedArtworkUrl(extraKey, url);
          this._emitArtworkIfNew(extraKey, url);
        }
      } catch {
        /* ignore */
      }
    }
  }

  async _awaitArtworkCooldown() {
    const waitMs = Math.max(0, (Number(this._artworkCooldownUntilMs) || 0) - Date.now());
    if (waitMs > 0) await delay(waitMs);
  }

  _noteArtworkRateLimit(retryAfterMs) {
    const extraRaw = Math.max(0, Number(retryAfterMs) || 0);
    const extra = Math.min(extraRaw, SPOTIFY_ARTWORK_BACKOFF_MAX_MS);
    if (!extra) return;
    const until = Date.now() + extra;
    this._artworkCooldownUntilMs = Math.max(this._artworkCooldownUntilMs || 0, until);
  }

  _resetArtworkBackoff() {
    this._artworkBackoffMs = 0;
  }

  _noteArtworkRateLimited(err) {
    // Prefer Retry-After if we could read it.
    const ra = err && typeof err.retryAfterMs === 'number' ? err.retryAfterMs : 0;
    if (ra > 0) {
      this._noteArtworkRateLimit(ra);
      // Also reset exponential to avoid runaway when server gives explicit guidance.
      this._resetArtworkBackoff();
      return;
    }

    // Otherwise, exponential backoff with jitter, capped.
    const prev = Math.max(0, Number(this._artworkBackoffMs) || 0);
    const next = Math.min(
      SPOTIFY_ARTWORK_BACKOFF_MAX_MS,
      prev ? prev * 2 : SPOTIFY_ARTWORK_BACKOFF_BASE_MS,
    );
    const jitter = Math.floor(Math.random() * Math.min(1000, Math.max(100, next * 0.2)));
    const withJitter = Math.min(SPOTIFY_ARTWORK_BACKOFF_MAX_MS, next + jitter);

    this._artworkBackoffMs = withJitter;
    this._noteArtworkRateLimit(withJitter);
  }

  setArtworkUrl(url) {
    const u = String(url || '').trim();
    if (u) {
      if (this._artImg && this._artImg.getAttribute('src') !== u) {
        this._artImg.setAttribute('src', u);
      }
      if (this._artImg) this._artImg.style.display = '';
      if (this._statusEl) this._statusEl.style.display = 'none';
      return;
    }

    // In Spotify mode we always show a stable placeholder when artwork is not available.
    const ph = String(this._placeholderArtworkUrl || '').trim();
    if (this._artImg) {
      if (ph && this._artImg.getAttribute('src') !== ph) {
        this._artImg.setAttribute('src', ph);
      }
      this._artImg.style.display = '';
    }
    if (this._statusEl) this._statusEl.style.display = 'none';
  }

  supports(kind) { return kind === 'spotify'; }

  mount(container) {
    this._container = container;
    if (container && !container.contains(this._root)) container.appendChild(this._root);
    this._root.style.display = '';
    this._em.emit('capabilities', this.getCapabilities());
  }

  unmount() {
    this._root.style.display = 'none';
    if (this._container && this._container.contains(this._root)) {
      try { this._container.removeChild(this._root); } catch { /* ignore */ }
    }
    this._container = null;
  }

  getCapabilities() {
    return {
      canPlay: true,
      canPause: true,
      canStop: true,
      canSeek: true,
      canSetRate: false,
      canSetVolume: true,
      canMute: true,
      hasAccurateTime: true,
      hasAudioPipeline: false,
      hasVideo: false,
    };
  }

  getMediaPane() {
    // Provide an element so PlayerHost can toggle visibility via display:none.
    return { kind: 'none', element: this._root };
  }

  /**
   * Return cached album art URL for a Spotify track if available.
   * NOTE: Must be synchronous because the UI calls PlayerHost.getThumbnailUrl() synchronously.
   */
  getThumbnailUrl(track) {
    const explicit = track && typeof track.artworkUrl === 'string' ? String(track.artworkUrl || '').trim() : '';
    if (explicit) return explicit;

    const trackId = track && track.source && track.source.kind === 'spotify'
      ? String(track.source.trackId || '').trim()
      : '';
    if (!trackId || trackId === 'unmatched') return undefined;
    return getCachedArtworkUrl(trackId);
  }

  /**
   * Fetch and cache album art URL for a Spotify track.
   * @param {string} trackId
   * @returns {Promise<string|undefined>}
   */
  async prefetchArtwork(trackId) {
    const id = String(trackId || '').trim();
    if (!id || id === 'unmatched' || id === 'unknown' || !isSpotifyTrackId(id)) return undefined;
    const cached = getCachedArtworkUrl(id);
    if (cached) return cached;

    if (this._artworkPrefetchInFlight.has(id)) {
      return this._artworkPrefetchInFlight.get(id);
    }

    const p = (async () => {
      // Ensure we have a token; this does not prompt login itself.
      const accessToken = await this._auth.getAccessToken();
      await this._awaitArtworkCooldown();
      let data;
      try {
        data = await spotifyApi(accessToken, `/tracks/${encodeURIComponent(id)}`);
        this._resetArtworkBackoff();
      } catch (e) {
        if (e && e.status === 429) {
          this._noteArtworkRateLimited(e);
        }
        throw e;
      }
      const images = data && data.album && Array.isArray(data.album.images) ? data.album.images : [];
      const url = images.length && images[0] && typeof images[0].url === 'string' ? images[0].url : '';
      if (url) {
        setCachedArtworkUrl(id, url);
        return url;
      }
      return undefined;
    })();

    this._artworkPrefetchInFlight.set(id, p);
    try {
      return await p;
    } finally {
      this._artworkPrefetchInFlight.delete(id);
    }
  }

  /**
   * Fetch and cache album art for many Spotify track IDs using a batched API call.
   * @param {string[]} trackIds
   * @returns {Promise<Map<string, string>>} map of trackId -> artworkUrl (only for ids with artwork)
   */
  async prefetchArtworkMany(trackIds) {
    const input = Array.isArray(trackIds) ? trackIds : [];
    const uniqueIds = [];
    const seen = new Set();
    for (const raw of input) {
      const id = String(raw || '').trim();
      if (!id || id === 'unmatched' || id === 'unknown' || !isSpotifyTrackId(id)) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      uniqueIds.push(id);
    }

    /** @type {Map<string, string>} */
    const out = new Map();

    // Fast path: all cached.
    const toFetch = [];
    const waits = [];

    for (const id of uniqueIds) {
      const cached = getCachedArtworkUrl(id);
      if (cached) {
        out.set(id, cached);
        continue;
      }

      const inFlight = this._artworkPrefetchInFlight.get(id);
      if (inFlight) {
        waits.push(Promise.resolve(inFlight)
          .then((url) => {
            if (url) out.set(id, url);
          })
          .catch(() => {}));
        continue;
      }

      toFetch.push(id);
    }

    const chunkSize = 50;
    // Serialize chunk fetches to avoid blasting /tracks and getting rate-limited.
    let chain = Promise.resolve();
    for (let i = 0; i < toFetch.length; i += chunkSize) {
      const chunk = toFetch.slice(i, i + chunkSize);

      const chunkPromise = (chain = chain
        .then(async () => {
        const accessToken = await this._auth.getAccessToken();
        await this._awaitArtworkCooldown();
        let data;
        try {
          data = await spotifyApi(accessToken, '/tracks', {
            query: { ids: chunk.join(',') },
          });
          this._resetArtworkBackoff();
        } catch (e) {
          if (e && e.status === 429) {
            this._noteArtworkRateLimited(e);
          }
          throw e;
        }
        const tracks = data && Array.isArray(data.tracks) ? data.tracks : [];
        /** @type {Map<string, string>} */
        const map = new Map();
        for (const t of tracks) {
          const tid = t && t.id ? String(t.id).trim() : '';
          if (!tid) continue;
          const images = t && t.album && Array.isArray(t.album.images) ? t.album.images : [];
          const url = images.length && images[0] && typeof images[0].url === 'string' ? images[0].url : '';
          if (!url) continue;
          setCachedArtworkUrl(tid, url);
          map.set(tid, url);
        }
        return map;
        })
        .catch(() => new Map()));

      for (const id of chunk) {
        const perIdPromise = chunkPromise.then((m) => m.get(id));
        this._artworkPrefetchInFlight.set(id, perIdPromise);

        waits.push(perIdPromise
          .then((url) => {
            if (url) out.set(id, url);
          })
          .catch(() => {})
          .finally(() => {
            // Only remove if it's still the same promise.
            if (this._artworkPrefetchInFlight.get(id) === perIdPromise) {
              this._artworkPrefetchInFlight.delete(id);
            }
          }));
      }
    }

    if (waits.length) {
      await Promise.all(waits);
    }

    return out;
  }

  on(event, fn) { return this._em.on(event, fn); }

  getInfo() { return this._state; }

  flushArtworkCache() {
    try { localStorage.removeItem(SPOTIFY_ARTWORK_CACHE_KEY); } catch { /* ignore */ }
    try { this._lastArtworkEmitById && this._lastArtworkEmitById.clear(); } catch { /* ignore */ }
  }

  async _ensureReady() {
    if (!this._auth) throw new Error('SpotifyAuth not configured.');

    // Serialize SDK initialization: concurrent calls can create multiple Players, which can
    // drastically increase DRM license requests and lead to 429s / playback failures.
    if (this._ensureReadyPromise) {
      await this._ensureReadyPromise;
      if (this._player && this._deviceId) return;
    }

    this._ensureReadyPromise = (async () => {

      // Make sure we can refresh/obtain a token.
      await this._auth.getAccessToken();

      if (this._player && this._deviceId) return;

      await loadSpotifySdkOnce();

      const player = new window.Spotify.Player({
        name: this._sdkName,
        getOAuthToken: async (cb) => {
          try {
            const token = await this._auth.getAccessToken();
            cb(token);
          } catch {
            cb('');
          }
        },
        volume: clamp01(this._state.volume),
      });

      player.addListener('initialization_error', ({ message }) => {
        this._setError('INIT_ERROR', message);
      });
      player.addListener('authentication_error', ({ message }) => {
        this._setError('AUTH_ERROR', message);
      });
      player.addListener('account_error', ({ message }) => {
        // Most commonly: user is not Premium.
        this._setError('ACCOUNT_ERROR', message);
      });
      player.addListener('playback_error', ({ message }) => {
        this._setError('PLAYBACK_ERROR', message);
        this._schedulePlaybackRecovery(message || 'playback_error');
      });

      player.addListener('ready', ({ device_id }) => {
        this._deviceId = device_id || '';
        this._setState('ready');
        if (this._statusEl) this._statusEl.textContent = 'Spotify connected.';
        this._em.emit('capabilities', this.getCapabilities());

        // Start polling to provide smooth progress/time updates.
        this._startPolling();
      });

      player.addListener('not_ready', () => {
        this._deviceId = '';
        this._setState('error');
        if (this._statusEl) this._statusEl.textContent = 'Spotify disconnected.';
        this.setArtworkUrl('');

        this._stopPolling();
        this._schedulePlaybackRecovery('not_ready');
      });

      player.addListener('player_state_changed', (s) => {
        if (!s) return;

        // The Web Playback SDK provides album images in state; use it to populate our artwork cache
        // without hitting the Web API. This naturally fills as you play/skip.
        try {
          const tw = s && s.track_window ? s.track_window : null;
          const current = tw && tw.current_track ? tw.current_track : null;
          if (!this._activeTrackSkipArtworkCache) {
            this._maybeCacheArtworkFromSdkTrack(current, this._activeSpotifyTrackId);
          }

          // Intentionally do NOT cache artwork for previous/next tracks.
          // The SDK track_window can include adjacent queue tracks, and caching them eagerly
          // creates "unexpected" new cache entries even when the playlist already provides artwork.

          const activeKey = String(this._activeSpotifyTrackId || '').trim();
          if (activeKey && this._sdkTrackMatchesId(current, activeKey)) {
            // Prefer the SDK-provided image directly to avoid cache timing issues.
            if (!this._activeTrackSkipArtworkCache && !(this._skipArtworkCacheIds && this._skipArtworkCacheIds.has(activeKey))) {
              const images = current && current.album && Array.isArray(current.album.images) ? current.album.images : [];
              const url = images.length && images[0] && typeof images[0].url === 'string' ? String(images[0].url).trim() : '';
              if (url) this.setArtworkUrl(url);
            }
          }
        } catch {
          // ignore
        }

        const positionMs = Number(s.position) || 0;
        const durationMs = Number(s.duration) || 0;
        const paused = !!s.paused;
        this._state.time = {
          positionMs,
          durationMs: durationMs > 0 ? durationMs : undefined,
          bufferedMs: undefined,
        };
        this._state.state = paused ? 'paused' : 'playing';
        this._em.emit('time', this._state.time);
        this._em.emit('state', this._state.state);

        // Lightweight end detection fallback.
        if (!this._endedFired && Date.now() >= this._suppressEndedUntilMs) {
          if (paused && durationMs > 0 && durationMs - positionMs < 800) {
            this._endedFired = true;
            this._em.emit('ended');
          }
        }
      });

      this._player = player;
      this._setState('loading');

      const ok = await player.connect();
      if (!ok) {
        throw new Error('Spotify player connect() failed.');
      }

      // Wait briefly for device id.
      for (let i = 0; i < 50; i += 1) {
        if (this._deviceId) break;
        await delay(50);
      }

      if (!this._deviceId) {
        throw new Error('Spotify player did not become ready (missing device id).');
      }
    })();

    try {
      await this._ensureReadyPromise;
    } finally {
      // keep the promise around if we're still not ready; it will be replaced on recovery.
    }
  }

  _startPolling() {
    if (this._pollTimer) return;
    if (!this._player) return;
    this._isPolling = true;
    this._pollTimer = setInterval(() => {
      void this._pollOnce();
    }, 500);
  }

  _stopPolling() {
    this._isPolling = false;
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async _pollOnce() {
    if (!this._isPolling || !this._player) return;

    let st = null;
    try {
      st = await this._player.getCurrentState();
    } catch {
      return;
    }

    if (!st) {
      // Not active on this device.
      this._inactivePollCount += 1;

      // Avoid treating transient inactivity as an end-of-track.
      // Only consider it "ended" if we were already near the end.
      if (!this._endedFired && Date.now() >= this._suppressEndedUntilMs) {
        const prevDur = this._lastPollDurationMs;
        const prevPos = this._lastPollPositionMs;
        const nearEnd = prevDur > 0 && prevPos > prevDur - 1200;
        if (nearEnd && this._inactivePollCount >= 3) {
          this._endedFired = true;
          this._em.emit('ended');
          return;
        }
      }

      if (this._state.state !== 'ready' && this._state.state !== 'idle') {
        this._setState('ready');
      }
      return;
    }

    this._inactivePollCount = 0;

    const positionMs = Number(st.position) || 0;
    const durationMs = Number(st.duration) || 0;
    const paused = !!st.paused;

    const prevPos = this._lastPollPositionMs;
    const prevDur = this._lastPollDurationMs;
    const prevWasPlaying = this._lastPollWasPlaying;

    this._state.time = {
      positionMs,
      durationMs: durationMs > 0 ? durationMs : undefined,
      bufferedMs: undefined,
    };
    this._state.state = paused ? 'paused' : 'playing';
    this._em.emit('time', this._state.time);
    this._em.emit('state', this._state.state);

    this._lastPollPositionMs = positionMs;
    this._lastPollDurationMs = durationMs;
    this._lastPollWasPlaying = !paused;

    // End detection:
    // Use only time-based heuristics. Do NOT use track-id mismatch here: Spotify may "relink"
    // and report a different canonical track id while still playing the intended audio.
    if (!this._endedFired && Date.now() >= this._suppressEndedUntilMs) {
      // If we were very near the end and suddenly jumped back near 0, treat as ended.
      if (prevDur > 0 && prevPos > prevDur - 1500 && positionMs < 1000 && (prevWasPlaying || paused)) {
        this._endedFired = true;
        this._em.emit('ended');
        return;
      }

      if (paused && durationMs > 0 && durationMs - positionMs < 800) {
        this._endedFired = true;
        this._em.emit('ended');
      }
    }
  }

  _setState(state) {
    this._state.state = state;
    this._em.emit('state', state);
  }

  _setError(code, message) {
    this._state.state = 'error';
    this._em.emit('state', 'error');
    this._em.emit('error', { code, message });
    if (this._statusEl) this._statusEl.textContent = `Spotify error: ${message}`;
    this.setArtworkUrl('');
  }

  async load(track, opts = {}) {
    await this._ensureReady();

    const trackId = track && track.source && track.source.kind === 'spotify' ? String(track.source.trackId || '').trim() : '';
    if (!trackId || trackId === 'unmatched') {
      this._setError('NO_SPOTIFY_ID', 'Track has no spotifyId (or it is unmatched).');
      return;
    }

    const fallbackArtworkUrl = track && typeof track.artworkUrl === 'string'
      ? String(track.artworkUrl || '').trim()
      : '';

    // If the playlist already provides artwork for this track, do NOT read/write the cache for it.
    try {
      if (fallbackArtworkUrl) this._skipArtworkCacheIds.add(trackId);
      else this._skipArtworkCacheIds.delete(trackId);
    } catch {
      // ignore
    }

    this._activeTrackSkipArtworkCache = !!fallbackArtworkUrl;

    // UI artwork:
    // - If playlist provides art, show it immediately.
    // - Else show cached art if available.
    // - Else keep previous art during the loading transition to avoid flashing the placeholder.
    if (fallbackArtworkUrl) {
      this.setArtworkUrl(fallbackArtworkUrl);
    } else {
      try {
        const cachedUrl = getCachedArtworkUrl(trackId);
        if (cachedUrl) this.setArtworkUrl(cachedUrl);
        else {
          const cur = this._artImg ? String(this._artImg.getAttribute('src') || '').trim() : '';
          const ph = String(this._placeholderArtworkUrl || '').trim();
          if (!cur || (ph && cur === ph)) {
            this.setArtworkUrl('');
          }
        }
      } catch {
        const cur = this._artImg ? String(this._artImg.getAttribute('src') || '').trim() : '';
        const ph = String(this._placeholderArtworkUrl || '').trim();
        if (!cur || (ph && cur === ph)) {
          this.setArtworkUrl('');
        }
      }
    }

    const activeAtCall = trackId;
    void activeAtCall;

    const autoplay = !!opts.autoplay;
    const startMs = typeof opts.startMs === 'number' ? Math.max(0, Math.floor(opts.startMs)) : 0;

    this._state.activeTrackId = track.id;
    this._activeSpotifyTrackId = trackId;
    this._endedFired = false;
    // Track changes can produce brief "inactive" or mismatched state from the SDK.
    // Suppress end detection a bit longer to prevent accidental auto-advance.
    this._suppressEndedUntilMs = Date.now() + 7000;
    this._inactivePollCount = 0;
    this._setState('loading');

    // Store pending play details for non-autoplay loads.
    this._pendingPlay = autoplay ? null : { trackId, startMs };

    const accessToken = await this._auth.getAccessToken();

    const retryOnceOn404 = async (fn) => {
      try {
        return await fn();
      } catch (e) {
        if (e && e.status === 404) {
          await delay(400);
          return fn().catch(() => undefined);
        }
        throw e;
      }
    };

    // Make this device active.
    await retryOnceOn404(() => spotifyApi(accessToken, '/me/player', {
      method: 'PUT',
      json: { device_ids: [this._deviceId], play: false },
    }));

    if (autoplay) {
      await retryOnceOn404(() => this._startPlayback(trackId, startMs));
      this._pendingPlay = null;
      this._playbackRecoverBackoffMs = 0;
      this._setState('playing');
    } else {
      // Do NOT start-and-pause playback: that triggers DRM license requests and can lead to 429s.
      this._setState('ready');
    }

    this._em.emit('capabilities', this.getCapabilities());
  }

  async play() {
    await this._ensureReady();
    if (!this._player) return;

    const pending = this._pendingPlay;
    if (pending && pending.trackId) {
      try {
        await this._startPlayback(pending.trackId, pending.startMs);
        this._pendingPlay = null;
        this._playbackRecoverBackoffMs = 0;
        this._setState('playing');
        return;
      } catch {
        // fall through to resume
      }
    }

    await this._player.resume();
    this._setState('playing');
  }

  async pause() {
    await this._ensureReady();
    if (!this._player) return;
    await this._player.pause();
    this._setState('paused');
  }

  async stop() {
    // Spotify doesn't have a true stop; pause and rewind.
    this._pendingPlay = null;
    await this.pause();
    try { await this.seekToMs(0); } catch { /* ignore */ }
    this._setState('ready');
    this.setArtworkUrl('');
  }

  async seekToMs(ms) {
    await this._ensureReady();
    if (!this._player) return;
    const x = Math.max(0, Math.floor(Number(ms) || 0));

    // If we're not actively playing yet (non-autoplay load), update the pending start point.
    if (this._pendingPlay && this._pendingPlay.trackId) {
      this._pendingPlay = { ...this._pendingPlay, startMs: x };
    }

    await this._player.seek(x);
    this._state.time = { ...this._state.time, positionMs: x };
    this._em.emit('time', this._state.time);
  }

  async setVolume(v01) {
    await this._ensureReady();
    if (!this._player) return;
    const v = clamp01(v01);
    await this._player.setVolume(v);
    this._state.volume = v;
    if (v > 0) this._lastNonMutedVolume = v;
    this._state.muted = v === 0;
    this._em.emit('capabilities', this.getCapabilities());
  }

  async setMuted(m) {
    const wants = !!m;
    if (wants) {
      await this.setVolume(0);
      this._state.muted = true;
      return;
    }
    const restore = this._lastNonMutedVolume > 0 ? this._lastNonMutedVolume : 1;
    await this.setVolume(restore);
    this._state.muted = false;
  }

  async setRate(_rate) {
    // Not supported.
  }

  async dispose() {
    this._stopPolling();
    try {
      if (this._player) {
        await this._player.disconnect();
      }
    } catch {
      // ignore
    }
    this._player = null;
    this._deviceId = '';
    this._container = null;
  }
}
