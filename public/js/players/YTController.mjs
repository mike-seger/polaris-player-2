const STATES = Object.freeze({
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5
});

let iframeApiPromise = null;

function loadYouTubeIframeApi() {
  if (window.YT && typeof window.YT.Player === 'function') {
    return Promise.resolve();
  }
  if (iframeApiPromise) return iframeApiPromise;

  iframeApiPromise = new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    let settled = false;

    const settleOk = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const settleErr = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    window.onYouTubeIframeAPIReady = () => {
      if (typeof prev === 'function') {
        try { prev(); } catch { /* ignore */ }
      }
      settleOk();
    };

    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => {
      settleErr(new Error('Failed to load https://www.youtube.com/iframe_api'));
    };
    document.head.appendChild(script);

    // Diagnostics timeout.
    setTimeout(() => {
      if (settled) return;
      if (window.YT && typeof window.YT.Player === 'function') {
        settleOk();
        return;
      }
      console.warn(
        'YouTube IFrame API did not load in time. Possible causes: network blocks, CSP, ad-blockers, or mixed-content.'
      );
    }, 10000);
  });

  return iframeApiPromise;
}

/**
 * YTController remains YouTube-specific.
 * Generic behavior is implemented in YouTubeAdapter.mjs (which wraps this controller).
 */
export class YTController {
  static STATES = STATES;

  constructor(options = {}) {
    const {
      elementId = null,    // if null, you can call mount(container) later
      autoplay = false,
      controls = 0,
      origin = null,
    } = options;

    this.STATES = STATES;
    this.elementId = elementId;
    this.autoplay = autoplay;
    this.controls = controls;
    this.origin = origin;

    this._warnedOriginMismatch = false;

    this._player = null;
    this._ready = false;
    this._initStarted = false;
    this._apiReady = false;

    this._readyHandlers = [];
    this._stateHandlers = [];
    this._errorHandlers = [];

    this._pendingLoad = null;

    this._lastLoadRequest = null;

    // mount support
    this._mountContainer = null;
    this._mountDiv = null;
  }

  getDebugInfo() {
    const pageOrigin = (window.location && window.location.origin)
      ? window.location.origin
      : `${window.location.protocol}//${window.location.host}`;

    const configuredOrigin = (typeof this.origin === 'string') ? this.origin.trim() : '';
    const runtimeOrigin = this._getRuntimeOrigin();

    /** @type {string|undefined} */
    let iframeSrc;
    /** @type {string|undefined} */
    let iframeOriginParam;
    /** @type {string|undefined} */
    let iframeSrcOrigin;

    try {
      const hostEl = document.getElementById(this.elementId);
      const iframe = hostEl ? hostEl.querySelector('iframe') : null;
      if (iframe && typeof iframe.getAttribute === 'function') {
        iframeSrc = iframe.getAttribute('src') || undefined;
        if (iframeSrc) {
          try {
            const u = new URL(iframeSrc);
            iframeSrcOrigin = u.origin;
            const p = u.searchParams.get('origin');
            iframeOriginParam = p ? decodeURIComponent(p) : undefined;
          } catch {
            // ignore parsing errors
          }
        }
      }
    } catch {
      // ignore DOM access errors
    }

    return {
      pageOrigin,
      configuredOrigin: configuredOrigin || undefined,
      runtimeOrigin,
      elementId: this.elementId || undefined,
      iframeSrc,
      iframeSrcOrigin,
      iframeOriginParam,
      lastLoadRequest: this._lastLoadRequest || undefined,
    };
  }

  _getRuntimeOrigin() {
    const runtimeOrigin = (window.location && window.location.origin)
      ? window.location.origin
      : `${window.location.protocol}//${window.location.host}`;

    const configured = (typeof this.origin === 'string') ? this.origin.trim() : '';
    if (configured && configured !== runtimeOrigin && !this._warnedOriginMismatch) {
      this._warnedOriginMismatch = true;
      console.warn('YTController: configured origin differs from page origin; using page origin', {
        configured,
        runtimeOrigin
      });
    }

    return runtimeOrigin;
  }

  mount(container) {
    if (!container || !(container instanceof HTMLElement)) return;
    this._mountContainer = container;
    if (!this.elementId) {
      this._mountDiv = document.createElement("div");
      this._mountDiv.className = "yt-iframe-host";
      this._mountDiv.id = `yt-${Math.random().toString(16).slice(2)}`;
      container.appendChild(this._mountDiv);
      this.elementId = this._mountDiv.id;
    }
  }

  unmount() {
    if (this._mountDiv && this._mountDiv.parentElement) {
      try { this._mountDiv.parentElement.removeChild(this._mountDiv); } catch { /* ignore */ }
    }
    this._mountDiv = null;
    this._mountContainer = null;
    // keep elementId; caller may re-mount with same id if desired
  }

  onReady(fn) {
    if (typeof fn !== 'function') return;
    if (this._ready) {
      try { fn(); } catch { /* ignore */ }
      return;
    }
    this._readyHandlers.push(fn);
  }

  onStateChange(fn) {
    if (typeof fn !== 'function') return;
    this._stateHandlers.push(fn);
  }

  onError(fn) {
    if (typeof fn !== 'function') return;
    this._errorHandlers.push(fn);
  }

  init() {
    if (this._initStarted || this._player) return;
    if (!this.elementId) {
      throw new Error("YTController.init(): elementId is null. Call mount(container) first or pass elementId.");
    }
    this._initStarted = true;
    void this._initAsync();
  }

  async _initAsync() {
    try {
      await loadYouTubeIframeApi();
    } catch (err) {
      console.error(err);
      this._errorHandlers.forEach((fn) => { try { fn(err); } catch { /* ignore */ } });
      return;
    }
    this._apiReady = !!(window.YT && typeof window.YT.Player === 'function');
    if (!this._apiReady) return;

    // Do not create a player until we have a real videoId to load.
    const queued = this._pendingLoad;
    if (queued && queued.videoId && !this._player) {
      this._createPlayer(queued.videoId);
    }
  }

  destroy() {
    this._pendingLoad = null;
    this._lastLoadRequest = null;
    this._readyHandlers = [];
    this._stateHandlers = [];
    this._errorHandlers = [];
    this._ready = false;
    this._apiReady = false;
    if (this._player && typeof this._player.destroy === 'function') {
      try { this._player.destroy(); } catch { /* ignore */ }
    }
    this._player = null;
    this._initStarted = false;
  }

  isReady() { return this._ready; }

  getState() {
    if (!this._player || typeof this._player.getPlayerState !== 'function') return STATES.UNSTARTED;
    try {
      const s = this._player.getPlayerState();
      return typeof s === 'number' ? s : STATES.UNSTARTED;
    } catch {
      return STATES.UNSTARTED;
    }
  }

  getDuration() {
    if (!this._player || typeof this._player.getDuration !== 'function') return 0;
    try { return this._player.getDuration() || 0; } catch { return 0; }
  }

  getCurrentTime() {
    if (!this._player || typeof this._player.getCurrentTime !== 'function') return 0;
    try { return this._player.getCurrentTime() || 0; } catch { return 0; }
  }

  getVideoId() {
    if (!this._player || typeof this._player.getVideoData !== 'function') return '';
    try { return this._player.getVideoData()?.video_id || ''; } catch { return ''; }
  }

  play() {
    if (!this._player || typeof this._player.playVideo !== 'function') return;
    try { this._player.playVideo(); } catch { /* ignore */ }
  }

  pause() {
    if (!this._player || typeof this._player.pauseVideo !== 'function') return;
    try { this._player.pauseVideo(); } catch { /* ignore */ }
  }

  stop() {
    if (!this._player || typeof this._player.stopVideo !== 'function') return;
    try { this._player.stopVideo(); } catch { /* ignore */ }
  }

  seekTo(seconds, allowSeekAhead = true) {
    if (!this._player || typeof this._player.seekTo !== 'function') return;
    try { this._player.seekTo(seconds, allowSeekAhead); } catch { /* ignore */ }
  }

  setVolume(percent0to100) {
    if (!this._player || typeof this._player.setVolume !== 'function') return;
    try { this._player.setVolume(percent0to100); } catch { /* ignore */ }
  }

  getVolume() {
    if (!this._player || typeof this._player.getVolume !== 'function') return 100;
    try {
      const v = this._player.getVolume();
      return typeof v === "number" ? v : 100;
    } catch {
      return 100;
    }
  }

  setMuted(muted) {
    if (!this._player) return;
    try {
      if (muted && typeof this._player.mute === "function") this._player.mute();
      if (!muted && typeof this._player.unMute === "function") this._player.unMute();
    } catch { /* ignore */ }
  }

  isMuted() {
    if (!this._player || typeof this._player.isMuted !== 'function') return false;
    try { return !!this._player.isMuted(); } catch { return false; }
  }

  setRate(rate) {
    if (!this._player || typeof this._player.setPlaybackRate !== 'function') return;
    try { this._player.setPlaybackRate(rate); } catch { /* ignore */ }
  }

  getRate() {
    if (!this._player || typeof this._player.getPlaybackRate !== 'function') return 1;
    try {
      const r = this._player.getPlaybackRate();
      return typeof r === "number" ? r : 1;
    } catch {
      return 1;
    }
  }

  load(videoId, options = {}) {
    const { startSeconds = 0, autoplay = true } = options || {};
    const cleanedVideoId = (videoId || '').trim();
    if (!cleanedVideoId) return;

    const runtimeOrigin = this._getRuntimeOrigin();

    this._lastLoadRequest = {
      videoId: cleanedVideoId,
      startSeconds: Number.isFinite(startSeconds) ? startSeconds : 0,
      autoplay: !!autoplay,
      origin: runtimeOrigin || undefined,
      elementId: this.elementId || undefined,
    };

    if (!this._ready || !this._player) {
      this._pendingLoad = {
        videoId: cleanedVideoId,
        startSeconds: Number.isFinite(startSeconds) ? startSeconds : 0,
        autoplay: !!autoplay,
      };

      // If the API is already ready but we haven't created a player yet, create it now.
      if (this._apiReady && !this._player) {
        this._createPlayer(cleanedVideoId);
      }
      return;
    }

    if (autoplay && typeof this._player.loadVideoById === 'function') {
      try {
        // Prefer object-form to avoid signature quirks.
        this._player.loadVideoById({ videoId: cleanedVideoId, startSeconds: Number(startSeconds) || 0 });
      } catch { /* ignore */ }
      return;
    }

    if (typeof this._player.cueVideoById === 'function') {
      try {
        this._player.cueVideoById({ videoId: cleanedVideoId, startSeconds: Number(startSeconds) || 0 });
      } catch { /* ignore */ }
    }
  }

  _createPlayer(initialVideoId) {
    if (this._player) return;
    if (!initialVideoId) return;

    const playerOrigin = this._getRuntimeOrigin();

    const onReady = () => {
      this._ready = true;
      const queued = this._pendingLoad;
      this._pendingLoad = null;
      if (queued) {
        this.load(queued.videoId, { startSeconds: queued.startSeconds, autoplay: queued.autoplay });
      }
      const handlers = this._readyHandlers.slice();
      this._readyHandlers.length = 0;
      handlers.forEach((fn) => {
        try { fn(); } catch { /* ignore */ }
      });
    };

    const onStateChange = (event) => {
      const state = (event && typeof event.data === 'number') ? event.data : STATES.UNSTARTED;
      this._stateHandlers.forEach((fn) => {
        try { fn(state); } catch { /* ignore */ }
      });
    };

    this._player = new window.YT.Player(this.elementId, {
      height: '200',
      width: '320',
      videoId: initialVideoId,
      playerVars: {
        autoplay: this.autoplay ? 1 : 0,
        controls: this.controls,
        origin: playerOrigin
      },
      events: {
        onReady,
        onStateChange,
        onError: (e) => {
          const err = e && typeof e === 'object' && e !== null && 'data' in e
            ? {
              code: 'YT_IFRAME_ERROR',
              ytCode: /** @type {any} */(e).data,
              message: `YouTube iframe error ${/** @type {any} */(e).data}`,
              detail: e,
              request: this._lastLoadRequest || this._pendingLoad || undefined
            }
            : e;
          this._errorHandlers.forEach((fn) => { try { fn(err); } catch { /* ignore */ } });
        }
      }
    });
  }
}

export { STATES };
