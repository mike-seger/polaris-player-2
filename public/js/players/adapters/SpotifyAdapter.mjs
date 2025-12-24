import { Emitter } from '../core/Emitter.mjs';

function clamp01(n) {
  const x = Number(n);
  if (!isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

async function spotifyApi(accessToken, path, { method = 'GET', query = null, json = null } = {}) {
  const url = new URL(`https://api.spotify.com/v1/${path.replace(/^\//, '')}`);
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }

  const resp = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    },
    body: json ? JSON.stringify(json) : undefined,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Spotify API ${method} ${path} failed (${resp.status}): ${text}`);
  }

  if (resp.status === 204) return null;
  return resp.json().catch(() => null);
}

export class SpotifyAdapter {
  constructor({ auth, name = 'Polaris Spotify Player' } = {}) {
    this.name = 'Spotify';
    this._auth = auth;
    this._sdkName = name;

    this._em = new Emitter();

    this._container = null;
    this._root = document.createElement('div');
    this._root.style.display = 'none';
    this._root.style.width = '100%';
    this._root.style.height = '100%';
    this._root.style.alignItems = 'center';
    this._root.style.justifyContent = 'center';
    this._root.style.color = 'var(--color-text)';
    this._root.style.fontSize = '0.9rem';
    this._root.style.padding = '1rem';
    this._root.style.boxSizing = 'border-box';
    this._root.textContent = 'Spotify playback ready.';

    this._player = null;
    this._deviceId = '';

    this._state = {
      state: 'idle',
      muted: false,
      volume: 1,
      rate: 1,
      time: { positionMs: 0, durationMs: undefined, bufferedMs: undefined },
      activeTrackId: undefined,
    };

    this._lastNonMutedVolume = 1;
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

  on(event, fn) { return this._em.on(event, fn); }

  getInfo() { return this._state; }

  async _ensureReady() {
    if (!this._auth) throw new Error('SpotifyAuth not configured.');

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
    });

    player.addListener('ready', ({ device_id }) => {
      this._deviceId = device_id || '';
      this._setState('ready');
      this._root.textContent = 'Spotify connected.';
      this._em.emit('capabilities', this.getCapabilities());
    });

    player.addListener('not_ready', () => {
      this._deviceId = '';
      this._setState('error');
      this._root.textContent = 'Spotify disconnected.';
    });

    player.addListener('player_state_changed', (s) => {
      if (!s) return;
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

      // End detection: when paused near the end.
      if (paused && durationMs > 0 && durationMs - positionMs < 800) {
        this._em.emit('ended');
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
  }

  _setState(state) {
    this._state.state = state;
    this._em.emit('state', state);
  }

  _setError(code, message) {
    this._state.state = 'error';
    this._em.emit('state', 'error');
    this._em.emit('error', { code, message });
    this._root.textContent = `Spotify error: ${message}`;
  }

  async load(track, opts = {}) {
    await this._ensureReady();

    const trackId = track && track.source && track.source.kind === 'spotify' ? String(track.source.trackId || '').trim() : '';
    if (!trackId || trackId === 'unmatched') {
      this._setError('NO_SPOTIFY_ID', 'Track has no spotifyId (or it is unmatched).');
      return;
    }

    const autoplay = !!opts.autoplay;
    const startMs = typeof opts.startMs === 'number' ? Math.max(0, Math.floor(opts.startMs)) : 0;

    this._state.activeTrackId = track.id;
    this._setState('loading');

    const accessToken = await this._auth.getAccessToken();

    // Make this device active.
    await spotifyApi(accessToken, '/me/player', {
      method: 'PUT',
      json: { device_ids: [this._deviceId], play: false },
    });

    await spotifyApi(accessToken, '/me/player/play', {
      method: 'PUT',
      query: { device_id: this._deviceId },
      json: {
        uris: [`spotify:track:${trackId}`],
        position_ms: startMs,
      },
    });

    // If caller didn't request autoplay, pause immediately.
    if (!autoplay) {
      try { await this.pause(); } catch { /* ignore */ }
    } else {
      this._setState('playing');
    }

    this._em.emit('capabilities', this.getCapabilities());
  }

  async play() {
    await this._ensureReady();
    if (!this._player) return;
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
    await this.pause();
    try { await this.seekToMs(0); } catch { /* ignore */ }
    this._setState('ready');
  }

  async seekToMs(ms) {
    await this._ensureReady();
    if (!this._player) return;
    const x = Math.max(0, Math.floor(Number(ms) || 0));
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
