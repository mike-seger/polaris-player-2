(function () {
  'use strict';

  const STATES = Object.freeze({
    UNSTARTED: -1,
    ENDED: 0,
    PLAYING: 1,
    PAUSED: 2,
    BUFFERING: 3,
    CUED: 5
  });

  class YTController {
    static STATES = STATES;

    constructor(options = {}) {
      const {
        elementId = 'player',
        autoplay = false,
        controls = 0,
        origin = null,
      } = options;

      this.STATES = STATES;
      this.elementId = elementId;
      this.autoplay = autoplay;
      this.controls = controls;
      this.origin = origin;

      this._player = null;
      this._ready = false;
      this._initStarted = false;
      this._warnTimer = null;

      this._readyHandlers = [];
      this._stateHandlers = [];

      this._pendingLoad = null;
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

    init() {
      if (this._initStarted || this._player) return;
      this._initStarted = true;

      const tryInit = () => {
        if (this._player) return;
        if (!window.YT || typeof window.YT.Player !== 'function') return;
        this._createPlayer();
      };

      // Ensure callback is installed before the iframe_api script runs.
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (typeof prev === 'function') {
          try { prev(); } catch { /* ignore */ }
        }
        tryInit();
      };

      // If the API already loaded, init immediately.
      if (window.YT && typeof window.YT.Player === 'function') {
        if (typeof queueMicrotask === 'function') {
          queueMicrotask(tryInit);
        } else {
          setTimeout(tryInit, 0);
        }
      }

      // Diagnostics: warn if the IFrame API never appears.
      this._warnTimer = setTimeout(() => {
        if (this._player) return;
        if (!window.YT || typeof window.YT.Player !== 'function') {
          console.warn(
            'YouTube IFrame API did not load. Possible causes: network blocks, CSP, ad-blockers, or mixed-content. Check DevTools Network/Console for https://www.youtube.com/iframe_api.'
          );
        }
      }, 10000);
    }

    destroy() {
      if (this._warnTimer) {
        clearTimeout(this._warnTimer);
        this._warnTimer = null;
      }
      this._pendingLoad = null;
      this._readyHandlers = [];
      this._stateHandlers = [];
      this._ready = false;
      if (this._player && typeof this._player.destroy === 'function') {
        try { this._player.destroy(); } catch { /* ignore */ }
      }
      this._player = null;
      this._initStarted = false;
    }

    isReady() {
      return this._ready;
    }

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
      try {
        return this._player.getDuration() || 0;
      } catch {
        return 0;
      }
    }

    getCurrentTime() {
      if (!this._player || typeof this._player.getCurrentTime !== 'function') return 0;
      try {
        return this._player.getCurrentTime() || 0;
      } catch {
        return 0;
      }
    }

    getVideoId() {
      if (!this._player || typeof this._player.getVideoData !== 'function') return '';
      try {
        return this._player.getVideoData()?.video_id || '';
      } catch {
        return '';
      }
    }

    play() {
      if (!this._player || typeof this._player.playVideo !== 'function') return;
      try { this._player.playVideo(); } catch { /* ignore */ }
    }

    pause() {
      if (!this._player || typeof this._player.pauseVideo !== 'function') return;
      try { this._player.pauseVideo(); } catch { /* ignore */ }
    }

    seekTo(seconds, allowSeekAhead = true) {
      if (!this._player || typeof this._player.seekTo !== 'function') return;
      try { this._player.seekTo(seconds, allowSeekAhead); } catch { /* ignore */ }
    }

    load(videoId, options = {}) {
      const { startSeconds = 0, autoplay = true } = options || {};
      if (!videoId) return;

      if (!this._ready || !this._player) {
        this._pendingLoad = { videoId, startSeconds, autoplay };
        return;
      }

      if (autoplay && typeof this._player.loadVideoById === 'function') {
        try { this._player.loadVideoById(videoId, startSeconds); } catch { /* ignore */ }
        return;
      }

      if (typeof this._player.cueVideoById === 'function') {
        try { this._player.cueVideoById(videoId, startSeconds); } catch { /* ignore */ }
      }
    }

    _createPlayer() {
      if (this._player) return;

      const playerOrigin = this.origin || ((window.location && window.location.origin)
        ? window.location.origin
        : `${window.location.protocol}//${window.location.host}`);

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
        videoId: '',
        playerVars: {
          autoplay: this.autoplay ? 1 : 0,
          controls: this.controls,
          origin: playerOrigin
        },
        events: {
          onReady,
          onStateChange
        }
      });
    }
  }

  window.YTController = YTController;
})();
