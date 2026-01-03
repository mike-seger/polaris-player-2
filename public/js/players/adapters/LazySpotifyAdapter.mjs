import { Emitter } from "../core/Emitter.mjs";

/**
 * Lazily constructs a SpotifyAdapter only when Spotify is actually used.
 * This keeps startup clean (no SDK name log / no SDK load) unless a spotify track is loaded.
 */
export class LazySpotifyAdapter {
  /**
   * @param {() => any} createAdapter
   */
  constructor(createAdapter) {
    this.name = 'Spotify';

    this._createAdapter = (typeof createAdapter === 'function') ? createAdapter : null;

    /** @type {any|null} */
    this._real = null;

    /** @type {HTMLElement|null} */
    this._container = null;

    this._em = new Emitter();

    // Some UI code expects an element so PlayerHost can toggle visibility.
    this._root = document.createElement('div');
    this._root.style.display = 'none';
  }

  supports(kind) { return kind === 'spotify'; }

  on(event, fn) { return this._em.on(event, fn); }

  getMediaPane() {
    if (this._real && typeof this._real.getMediaPane === 'function') {
      try { return this._real.getMediaPane(); } catch { /* ignore */ }
    }
    return { kind: 'none', element: this._root };
  }

  getCapabilities() {
    if (this._real && typeof this._real.getCapabilities === 'function') {
      try { return this._real.getCapabilities(); } catch { /* ignore */ }
    }
    // Reasonable defaults; actual caps will be emitted once the real adapter exists.
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

  getInfo() {
    if (this._real && typeof this._real.getInfo === 'function') {
      try { return this._real.getInfo(); } catch { /* ignore */ }
    }
    return {
      state: 'idle',
      muted: false,
      volume: 1,
      rate: 1,
      time: { positionMs: 0, durationMs: undefined, bufferedMs: undefined },
      activeTrackId: undefined,
    };
  }

  getThumbnailUrl(track) {
    if (this._real && typeof this._real.getThumbnailUrl === 'function') {
      try { return this._real.getThumbnailUrl(track); } catch { /* ignore */ }
    }
    return undefined;
  }

  _ensureReal() {
    if (this._real) return this._real;
    if (!this._createAdapter) throw new Error('LazySpotifyAdapter: missing factory');

    const real = this._createAdapter();
    if (!real) throw new Error('LazySpotifyAdapter: factory returned nothing');

    this._real = real;

    // If we already have a mount container, mount now.
    if (this._container && typeof this._real.mount === 'function') {
      try { this._real.mount(this._container); } catch { /* ignore */ }
    }

    // Bridge common events to our emitter so callers can subscribe before init.
    const bridge = (event) => {
      try {
        if (this._real && typeof this._real.on === 'function') {
          this._real.on(event, (payload) => {
            try { this._em.emit(event, payload); } catch { /* ignore */ }
          });
        }
      } catch {
        /* ignore */
      }
    };

    bridge('state');
    bridge('time');
    bridge('error');
    bridge('ended');
    bridge('capabilities');
    bridge('artwork');

    // Publish capabilities immediately.
    try { this._em.emit('capabilities', this.getCapabilities()); } catch { /* ignore */ }

    return this._real;
  }

  mount(container) {
    this._container = container instanceof HTMLElement ? container : null;

    // Ensure we have a stable pane element to toggle visibility.
    if (this._container && !this._container.contains(this._root)) {
      try { this._container.appendChild(this._root); } catch { /* ignore */ }
    }

    if (this._real && typeof this._real.mount === 'function') {
      try { this._real.mount(this._container); } catch { /* ignore */ }
    }

    try { this._em.emit('capabilities', this.getCapabilities()); } catch { /* ignore */ }
  }

  unmount() {
    if (this._real && typeof this._real.unmount === 'function') {
      try { this._real.unmount(); } catch { /* ignore */ }
    }
    this._container = null;
  }

  async activate() {
    const real = this._ensureReal();
    if (real && typeof real.activate === 'function') {
      await real.activate();
    }
  }

  async deactivate() {
    if (this._real && typeof this._real.deactivate === 'function') {
      await this._real.deactivate();
    }
  }

  async dispose() {
    if (this._real && typeof this._real.dispose === 'function') {
      await this._real.dispose();
    }
    this._real = null;
    try { this._em.clear(); } catch { /* ignore */ }
  }

  async load(track, opts = {}) {
    const real = this._ensureReal();
    return await real.load(track, opts);
  }

  async play() {
    const real = this._ensureReal();
    return await real.play();
  }

  async pause() {
    const real = this._ensureReal();
    return await real.pause();
  }

  async stop() {
    if (!this._real) return;
    return await this._real.stop();
  }

  async seekToMs(ms) {
    const real = this._ensureReal();
    return await real.seekToMs(ms);
  }

  async setVolume(v01) {
    const real = this._ensureReal();
    return await real.setVolume(v01);
  }

  async setMuted(m) {
    const real = this._ensureReal();
    return await real.setMuted(m);
  }

  async setRate(rate) {
    const real = this._ensureReal();
    return await real.setRate(rate);
  }

  // --- Spotify-specific helpers used by the UI ---
  async prefetchArtwork(trackId) {
    const real = this._ensureReal();
    if (real && typeof real.prefetchArtwork === 'function') {
      return await real.prefetchArtwork(trackId);
    }
    return undefined;
  }

  async prefetchArtworkMany(trackIds) {
    const real = this._ensureReal();
    if (real && typeof real.prefetchArtworkMany === 'function') {
      return await real.prefetchArtworkMany(trackIds);
    }
    return new Map();
  }

  async listDevices() {
    const real = this._ensureReal();
    if (real && typeof real.listDevices === 'function') {
      return await real.listDevices();
    }
    return [];
  }

  async transferPlayback(deviceId, opts) {
    const real = this._ensureReal();
    if (real && typeof real.transferPlayback === 'function') {
      return await real.transferPlayback(deviceId, opts);
    }
    throw new Error('Spotify adapter not available');
  }
}
