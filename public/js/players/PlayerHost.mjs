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

    this._em = new Emitter();
    this._unsubs = [];

    this._activeTrack = null;
  }

  /**
   * Mount UI container for adapters that render inside the browser (YT iframe, <video>).
   * Adapters that don't render can ignore this.
   * @param {HTMLElement} container
   */
  mount(container) {
    this._container = container instanceof HTMLElement ? container : null;
    if (!this._container) return;

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
  }

  _setAdapterVisible(adapter, visible) {
    if (!adapter) return;
    try {
      const pane = adapter.getMediaPane?.();
      const el = pane && pane.element;
      if (el && el.style) {
        el.style.display = visible ? '' : 'none';
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

    const next = this.adapters.find(a => a.supports(track.source.kind));
    if (!next) throw new Error(`No adapter supports source kind: ${track.source.kind}`);

    if (this.active !== next) {
      await this._switchTo(next);
    }

    this._activeTrack = track;
    await this.active.load(track, opts);
    this._em.emit("track", track);
  }

  async play() {
    if (!this.active) return;
    await this.active.play();
  }
  async pause() {
    if (!this.active) return;
    await this.active.pause();
  }
  async stop() {
    if (!this.active) return;
    await this.active.stop();
  }
  async seekToMs(ms) {
    if (!this.active) return;
    await this.active.seekToMs(ms);
  }
  async setVolume(v01) {
    if (!this.active) return;
    await this.active.setVolume(v01);
  }
  async setMuted(m) {
    if (!this.active) return;
    await this.active.setMuted(m);
  }
  async setRate(rate) {
    if (!this.active) return;
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

    // Ensure only the selected player is visible.
    for (const a of this.adapters) {
      this._setAdapterVisible(a, a === this.active);
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
