import { Emitter } from "./core/Emitter.mjs";

/**
 * PlayerHost routes tracks to the appropriate adapter.
 * The UI should talk only to PlayerHost, not directly to YouTube/VLC/video elements.
 */
export class PlayerHost {
  /**
   * @param {import("./core/types.mjs").IPlayerAdapter[]} adapters
   */
  constructor(adapters) {
    this.adapters = Array.isArray(adapters) ? adapters : [];
    this.active = null;

    /** @type {HTMLElement|null} */
    this._container = null;

    /** @type {import("./core/types.mjs").IPlayerAdapter|null} */
    this._visualizerAdapter = null;

    this._em = new Emitter();
    this._unsubs = [];

    this._activeTrack = null;
  }

  _debugEnabled() {
    try {
      return typeof window !== 'undefined' && !!window.__POLARIS_DEBUG_PLAYER_COMMANDS__;
    } catch {
      return false;
    }
  }

  _debugLog(method, detail = undefined) {
    if (!this._debugEnabled()) return;
    try {
      const adapterName = this.active && this.active.name ? this.active.name : 'none';
      console.debug(`[PlayerHost] ${method} (active=${adapterName})`, detail);
    } catch {
      /* ignore */
    }
  }

  /**
   * Mount UI container for adapters that render inside the browser (YT iframe, <video>).
   * Adapters that don't render can ignore this.
   * @param {HTMLElement} container
   */
  mount(container) {
    this._container = container instanceof HTMLElement ? container : null;
    if (!this._container) return;

    // Cache visualizer adapter for overlay management
    this._visualizerAdapter = this.adapters.find(a => a && a.name === 'visualizer');

    // Mount all adapters once so we can toggle visibility via display:none.
    for (const a of this.adapters) {
      if (typeof a.mount === 'function') {
        try { a.mount(this._container); } catch { /* ignore */ }
      }
    }

    // Hide everything initially; _switchTo will show the active adapter.
    for (const a of this.adapters) {
      this._setAdapterVisible(a, false);
    }

    if (this.active) {
      this._setAdapterVisible(this.active, true);
    }

    // If a track is already active, sync overlay visibility
    if (this._activeTrack) {
      this._updateVisualizerOverlay(this._activeTrack);
    }
  }

  _setAdapterVisible(adapter, visible) {
    if (!adapter) return;
    try {
      const pane = adapter.getMediaPane?.();
      const el = pane && pane.element;
      if (el && el.style) {
        el.style.display = visible ? '' : 'none';

        // Ensure media panes fill the container when shown (fixes half-size YT after toggle)
        if (visible) {
          el.style.width = '100%';
          el.style.height = '100%';
        }
      }
    } catch {
      /* ignore */
    }
  }

  /** @returns {import("./core/types.mjs").MediaPane} */
  getMediaPane() {
    if (!this.active) return { kind: "none" };
    try { return this.active.getMediaPane(); } catch { return { kind: "none" }; }
  }

  /** @returns {import("./core/types.mjs").PlaybackInfo} */
  getInfo() {
    if (!this.active) {
      return {
        state: "idle",
        muted: false,
        volume: 1,
        rate: 1,
        time: { positionMs: 0, durationMs: undefined, bufferedMs: undefined },
        activeTrackId: undefined,
      };
    }
    return this.active.getInfo();
  }

  /** @returns {import("./core/types.mjs").Capability} */
  getCapabilities() {
    if (!this.active) {
      return {
        canPlay: false, canPause: false, canStop: false, canSeek: false,
        canSetRate: false, canSetVolume: false, canMute: false,
        hasAccurateTime: false, hasAudioPipeline: false, hasVideo: false
      };
    }
    return this.active.getCapabilities();
  }

  /**
   * Returns a thumbnail/artwork URL for a track if the relevant adapter can provide one.
   * @param {import("./core/types.mjs").Track} track
   * @returns {string|undefined}
   */
  getThumbnailUrl(track) {
    if (!track || !track.source || !track.source.kind) return undefined;
    const a = this.adapters.find((ad) => ad && typeof ad.supports === 'function' && ad.supports(track.source.kind));
    const fn = a && a.getThumbnailUrl;
    if (typeof fn === 'function') {
      try { return fn.call(a, track); } catch { return undefined; }
    }
    return track.artworkUrl;
  }

  /**
   * Routes track to adapter by `track.source.kind`.
   * @param {import("./core/types.mjs").Track} track
   * @param {import("./core/types.mjs").AdapterLoadOptions=} opts
   */
  async load(track, opts = {}) {
    if (!track || !track.source || !track.source.kind) {
      throw new Error("Invalid track");
    }

    this._debugLog('load', {
      kind: track?.source?.kind,
      id: track?.id,
      startMs: track?.startMs,
      endMs: track?.endMs,
      opts,
    });

    const next = this.adapters.find(a => a.supports(track.source.kind));
    if (!next) throw new Error(`No adapter supports source kind: ${track.source.kind}`);

    if (this.active !== next) {
      await this._switchTo(next);
    }

    this._activeTrack = track;
    await this.active.load(track, opts);
    this._em.emit("track", track);

    // Ensure correct overlay visibility after load
    this._updateVisualizerOverlay(track);
  }

  /**
   * Reload the current track (used when switching adapters, e.g., toggling visualizer)
   */
  async reloadCurrentTrack() {
    if (!this._activeTrack) return;
    
    // Save current state BEFORE any changes
    const info = this.active?.getInfo?.();
    const wasPlaying = info?.state === 'playing';
    const currentPositionMs = info?.time?.positionMs || 0;
    const oldAdapter = this.active?.name;
    
    console.log('[PlayerHost] Reloading track:', {
      track: this._activeTrack.id,
      oldAdapter,
      wasPlaying,
      currentPositionMs,
      trackStartMs: this._activeTrack.startMs,
      trackEndMs: this._activeTrack.endMs
    });
    
    // Load track; keep autoplay aligned with prior state and start from saved position
    await this.load(this._activeTrack, { autoplay: wasPlaying, startMs: currentPositionMs });
    
    console.log('[PlayerHost] Loaded on new adapter:', this.active?.name);
    
    // Seek to saved position (wait a moment so YouTube is ready to accept seeks)
    if (currentPositionMs > 0) {
      console.log('[PlayerHost] Seeking to:', currentPositionMs);
      await new Promise(resolve => setTimeout(resolve, 150));
      await this.seekToMs(currentPositionMs);
    }
    
    // Resume playback if it was playing
    if (wasPlaying) {
      // Small delay to ensure seek completes
      await new Promise(resolve => setTimeout(resolve, 50));
      console.log('[PlayerHost] Resuming playback');
      await this.play();
    }
  }

  /**
   * Show/hide visualizer overlay for YouTube tracks when visualizer is enabled.
   * Hides the YouTube iframe when overlay is shown.
   * @private
   */
  _updateVisualizerOverlay(track) {
    if (!this._visualizerAdapter) return;

    const isYouTube = track?.source?.kind === 'youtube';
    const visualizerEnabled = typeof this._visualizerAdapter.isEnabled === 'function'
      ? this._visualizerAdapter.isEnabled()
      : !!this._visualizerAdapter._enabled;

    // Only manage overlay for YouTube tracks; do not hide visualizer when it is the active adapter (HTML/local playback).
    if (!isYouTube) {
      if (this.active === this._visualizerAdapter) {
        this._setAdapterVisible(this._visualizerAdapter, true);
      }
      return;
    }

    const showVisualizer = isYouTube && visualizerEnabled;

    // Toggle visualizer pane
    this._setAdapterVisible(this._visualizerAdapter, showVisualizer);

    // If the active adapter is YouTube, hide it when showing visualizer
    if (this.active && this.active.name === 'youtube') {
      this._setAdapterVisible(this.active, !showVisualizer);
    }

    // When showing overlay for YouTube, request viz data load; stop when hiding
    if (showVisualizer) {
      if (typeof this._visualizerAdapter.loadVisualization === 'function') {
        try { this._visualizerAdapter.loadVisualization(track); } catch { /* ignore */ }
      }
    } else {
      if (typeof this._visualizerAdapter.stopVisualization === 'function') {
        try { this._visualizerAdapter.stopVisualization(); } catch { /* ignore */ }
      }
    }
  }

  async play() {
    if (!this.active) return;
    this._debugLog('play');
    await this.active.play();
  }
  async pause() {
    if (!this.active) return;
    this._debugLog('pause');
    await this.active.pause();
  }
  async stop() {
    if (!this.active) return;
    this._debugLog('stop');
    await this.active.stop();
  }
  async seekToMs(ms) {
    if (!this.active) return;
    this._debugLog('seekToMs', { ms });
    await this.active.seekToMs(ms);
  }
  async setVolume(v01) {
    if (!this.active) return;
    this._debugLog('setVolume', { v01 });
    await this.active.setVolume(v01);
  }
  async setMuted(m) {
    if (!this.active) return;
    this._debugLog('setMuted', { m });
    await this.active.setMuted(m);
  }
  async setRate(rate) {
    if (!this.active) return;
    this._debugLog('setRate', { rate });
    await this.active.setRate(rate);
  }

  /** @param {string} event @param {Function} fn */
  on(event, fn) { return this._em.on(event, fn); }

  async dispose() {
    await this._switchTo(null);
    for (const a of this.adapters) {
      try { await a.dispose(); } catch { /* ignore */ }
    }
    this._em.clear();
  }

  async _switchTo(next) {
    // teardown old subscriptions
    for (const u of this._unsubs.splice(0)) { try { u(); } catch { /* ignore */ } }

    // stop old adapter (best effort)
    if (this.active) {
      this._debugLog('switch:stop-old', { from: this.active?.name, to: next?.name });
      try { await this.active.stop(); } catch { /* ignore */ }
      try {
        if (typeof this.active.deactivate === 'function') {
          await this.active.deactivate();
        }
      } catch {
        /* ignore */
      }
      // Make sure inactive players are not visible.
      this._setAdapterVisible(this.active, false);
    }

    this.active = next;

    if (!this.active) return;

    this._debugLog('switch:active', { active: this.active?.name });

    // Ensure only the selected player is visible.
    for (const a of this.adapters) {
      this._setAdapterVisible(a, a === this.active);
    }

    // Sync overlay visibility when switching adapters
    if (this._activeTrack) {
      this._updateVisualizerOverlay(this._activeTrack);
    }

    try {
      if (typeof this.active.activate === 'function') {
        await this.active.activate();
      }
    } catch {
      /* ignore */
    }

    // bridge adapter events to host events (UI can subscribe once)
    this._unsubs.push(this.active.on("state", (s) => this._em.emit("state", s)));
    this._unsubs.push(this.active.on("time", (t) => this._em.emit("time", t)));
    this._unsubs.push(this.active.on("error", (e) => this._em.emit("error", e)));
    this._unsubs.push(this.active.on("ended", () => this._em.emit("ended")));
    this._unsubs.push(this.active.on("capabilities", (c) => this._em.emit("capabilities", c)));
  }

  _require() {
    if (!this.active) throw new Error("No active adapter");
    return this.active;
  }
}
