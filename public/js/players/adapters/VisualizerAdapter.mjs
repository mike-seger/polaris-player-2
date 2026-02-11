import { Emitter } from "../core/Emitter.mjs";

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Adapter that plays TrackSource.kind === "file" using the Interactive Particles Visualizer in an iframe.
 * The visualizer runs as an isolated app, communicating via postMessage.
 * @implements {import("../core/types.mjs").IPlayerAdapter}
 */
export class VisualizerAdapter {
  constructor(options = {}) {
    this.name = "visualizer";
    this._em = new Emitter();

    this._track = null;
    this._state = "idle";
    this._volume = 1;
    this._muted = false;
    this._rate = 1;

    this._positionMs = 0;
    this._durationMs = undefined;

    this._container = null;
    this._iframe = null;  // Kept for compatibility, will be same as _canvasIframe
    this._canvasIframe = null;
    this._guiIframe = null;
    this._iframeReady = false;
    this._messageHandler = null;

    // Queue commands sent before iframe is ready
    this._pendingCommands = [];

    // Visualizer module metadata
    this._modules = [];
    this._activeModule = null;
    this._pendingModuleResolvers = [];
    this._pendingModuleSetResolvers = [];

    // Resume state
    this._resumeKey = 'polaris.visualizer.resume.v1';
    this._resumeState = null;

    // Path to the visualizer (dual-iframe: loads with ?mode=canvas and ?mode=gui)
    // Default: ../visualizer/index.html (relative to public/)
    this._visualizerPath = options.visualizerPath || "../visualizer/index.html";
    
    // Only enable if explicitly requested via options
    this._enabled = options.enabled === true;

    // When true, this adapter will own playback for local/file tracks.
    // Default true to preserve existing behavior (visualizer drives local playback); set
    // primaryForLocal: false when constructing to force HTML video to remain primary.
    this._primaryForLocal = options.primaryForLocal !== false;
  }

  /** @param {HTMLElement} container */
  mount(container) {
    if (this._canvasIframe) return; // Already mounted
    this._container = container instanceof HTMLElement ? container : null;
    if (!this._container) return;

    // Create a wrapper div to hold both iframes
    // This allows PlayerHost to control visibility of both iframes together
    this._wrapperDiv = document.createElement("div");
    this._wrapperDiv.id = "visualizer-dual-iframe-wrapper";
    this._wrapperDiv.style.position = "absolute";
    this._wrapperDiv.style.inset = "0";
    this._wrapperDiv.style.width = "100%";
    this._wrapperDiv.style.height = "100%";
    this._wrapperDiv.style.pointerEvents = "none"; // Wrapper doesn't intercept events
    this._wrapperDiv.style.background = "transparent";
    this._wrapperDiv.style.display = this._enabled ? "block" : "none";

    // Create canvas iframe (visualization only, z-index: 1, pointer-events: none)
    this._canvasIframe = document.createElement("iframe");
    this._canvasIframe.id = "visualizer-canvas-iframe";
    this._canvasIframe.style.position = "absolute";
    this._canvasIframe.style.inset = "0";
    this._canvasIframe.style.width = "100%";
    this._canvasIframe.style.height = "100%";
    this._canvasIframe.style.border = "none";
    this._canvasIframe.style.background = "#000";
    this._canvasIframe.style.zIndex = "1";
    this._canvasIframe.style.pointerEvents = "none";  // Don't block player controls
    this._canvasIframe.allow = "autoplay";
    
    // Create GUI iframe (controls only, z-index: 1001, transparent background)
    // Initially positioned top-right where controls usually appear, but allows resizing via messages
    this._guiIframe = document.createElement("iframe");
    this._guiIframe.id = "visualizer-gui-iframe";
    this._guiIframe.style.position = "absolute";
    this._guiIframe.style.top = "0";
    this._guiIframe.style.right = "0";
    // interactive sizing needs !important to override global #player iframe styles
    this._guiIframe.style.setProperty("width", "400px", "important");
    this._guiIframe.style.setProperty("height", "600px", "important");
    this._guiIframe.style.setProperty("max-height", "100%", "important");
    this._guiIframe.style.setProperty("max-width", "100%", "important");
    this._guiIframe.style.border = "none";
    this._guiIframe.style.background = "transparent";
    this._guiIframe.style.zIndex = "1001";  // Above player controls (z: 1-1000)
    this._guiIframe.style.pointerEvents = "auto";  // GUI controls are interactive
    this._guiIframe.allow = "autoplay";
    
    // Set up message handler
    this._messageHandler = (event) => this._handleMessage(event);
    window.addEventListener("message", this._messageHandler);

    // Load both iframes using the specific entry points (canvas.html and gui.html)
    // Assumes these files exist in the same directory as the configured visualizer path
    const pathParts = this._visualizerPath.split('?')[0].split('/');
    pathParts.pop(); // Remove filename (e.g., index.html)
    const baseUrl = pathParts.join('/') + '/';
    
    this._canvasIframe.src = `${baseUrl}canvas.html`;
    this._guiIframe.src = `${baseUrl}gui.html`;
    
    // Append both iframes to wrapper
    this._wrapperDiv.appendChild(this._canvasIframe);
    this._wrapperDiv.appendChild(this._guiIframe);
    
    // Append wrapper to container
    this._container.appendChild(this._wrapperDiv);
    
    // Keep reference to iframe for compatibility (getMediaPane returns wrapper)
    this._iframe = this._wrapperDiv;
  }

  unmount() {
    if (this._messageHandler) {
      window.removeEventListener("message", this._messageHandler);
      this._messageHandler = null;
    }
    // Remove wrapper div (which contains both iframes)
    if (this._wrapperDiv && this._wrapperDiv.parentNode) {
      this._wrapperDiv.parentNode.removeChild(this._wrapperDiv);
    }
    this._iframe = null;
    this._wrapperDiv = null;
    this._canvasIframe = null;
    this._guiIframe = null;
    this._iframeReady = false;
    this._pendingCommands = [];
  }

  /**
   * Handle messages from the visualizer iframe
   */
  _handleMessage(event) {
    // Security: verify origin if needed
    // if (event.origin !== expectedOrigin) return;

    const msg = event.data;
    if (!msg || typeof msg !== "object") return;
    
    // Handle GUI resize requests from visualizer
    if (msg.type === "GUI_RESIZE") {
      if (this._guiIframe) {
        // Only update if value is present and valid number
        if (msg.width && typeof msg.width === 'number') {
          this._guiIframe.style.setProperty("width", msg.width + 'px', "important");
        }
        if (msg.height && typeof msg.height === 'number') {
          this._guiIframe.style.setProperty("height", msg.height + 'px', "important");
        }
      }
      return; 
    }

    switch (msg.type) {
      case "VISUALIZER_READY":
        this._iframeReady = true;
        this._flushPendingCommands();
        this._requestModuleList();
        console.log('[VisualizerAdapter] VISUALIZER_READY');
        break;

      case "TIME_UPDATE":
        if (typeof msg.currentTime === "number") {
          this._positionMs = Math.floor(msg.currentTime * 1000);
        }
        if (typeof msg.duration === "number") {
          this._durationMs = Math.floor(msg.duration * 1000);
        }
        this._em.emit("time", this.getInfo().time);
        this._persistResumeState();
        break;

      case "PLAYING":
        this._setState("playing");
        this._persistResumeState(true);
        break;

      case "PAUSED":
        this._setState("paused");
        this._persistResumeState(false);
        break;

      case "ENDED":
        this._setState("ended");
        this._em.emit("ended");
        this._persistResumeState(false, { resetPosition: true });
        break;

      case "READY":
        this._setState("ready");
        break;

      case "LOADING":
        this._setState("loading");
        break;

      case "BUFFERING":
        this._setState("buffering");
        break;

      case "ERROR":
        this._setState("error");
        this._em.emit("error", { message: msg.error || "Visualizer error" });
        break;

      case "VISUALIZER_MODULES": {
        console.log('[VisualizerAdapter] VISUALIZER_MODULES', msg);
        const modules = Array.isArray(msg.modules) ? msg.modules.map(String) : [];
        const active = typeof msg.active === 'string' ? msg.active : (modules[0] || null);
        this._modules = modules;
        this._activeModule = active;
        this._em.emit('modules', { modules, active });
        this._resolvePendingModuleRequests({ modules, active });
        break;
      }

      case "VISUALIZER_MODULE_SET": {
        console.log('[VisualizerAdapter] VISUALIZER_MODULE_SET', msg);
        const modules = Array.isArray(msg.modules) ? msg.modules.map(String) : this._modules;
        const active = typeof msg.active === 'string' ? msg.active : this._activeModule;
        this._modules = modules;
        this._activeModule = active;
        this._em.emit('modules', { modules, active });
        this._resolvePendingModuleSetRequests(msg.ok !== false, { modules, active });
        break;
      }
    }
  }

  /**
   * Send a command to both visualizer iframes
   */
  _postCommand(command) {
    if (!this._canvasIframe || !this._guiIframe) return;

    if (!this._iframeReady) {
      // Queue command until iframes are ready
      this._pendingCommands.push(command);
      return;
    }

    try {
      // Send to both canvas and GUI iframes
      if (this._canvasIframe.contentWindow) {
        this._canvasIframe.contentWindow.postMessage(command, "*");
      }
      if (this._guiIframe.contentWindow) {
        this._guiIframe.contentWindow.postMessage(command, "*");
      }
    } catch (err) {
      console.error("[VisualizerAdapter] Failed to post message:", err);
    }
  }

  /**
   * Push externally captured audio data into both visualizer iframes (overlay mode).
   * @param {{frequencyData?: Uint8Array, timeData?: Uint8Array, rms?: number}} payload
   */
  pushAudioData(payload = {}) {
    if (!this._canvasIframe && !this._guiIframe) return;
    try {
      const frequencyData = payload.frequencyData ? Array.from(payload.frequencyData) : undefined;
      const timeData = payload.timeData ? Array.from(payload.timeData) : undefined;
      const bufferLength = payload.frequencyData?.length || payload.timeData?.length || 0;

      const message = {
        type: 'AUDIO_DATA',
        frequencyData,
        timeData,
        bufferLength,
        timeLength: timeData ? timeData.length : undefined,
        rms: payload.rms
      };
      
      // Send to both iframes
      if (this._canvasIframe?.contentWindow) {
        this._canvasIframe.contentWindow.postMessage(message, '*');
      }
      if (this._guiIframe?.contentWindow) {
        this._guiIframe.contentWindow.postMessage(message, '*');
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * Flush any commands that were queued before iframe was ready
   */
  _flushPendingCommands() {
    while (this._pendingCommands.length > 0) {
      const cmd = this._pendingCommands.shift();
      this._postCommand(cmd);
    }
  }

  _requestModuleList() {
    this._postCommand({ type: 'LIST_VISUALIZER_MODULES' });
  }

  _resolvePendingModuleRequests(payload) {
    const resolvers = this._pendingModuleResolvers.splice(0);
    for (const resolve of resolvers) {
      try { resolve(payload); } catch { /* ignore */ }
    }
  }

  _resolvePendingModuleSetRequests(ok, payload) {
    const resolvers = this._pendingModuleSetResolvers.splice(0);
    for (const resolve of resolvers) {
      try { resolve({ ok, ...(payload || {}) }); } catch { /* ignore */ }
    }
  }

  /** @param {import("../core/types.mjs").MediaPane} */
  getMediaPane() {
    if (!this._iframe) return { kind: "none" };
    return {
      kind: "element",
      element: this._iframe
    };
  }

  /**
   * Determines if this adapter should handle the given source kind.
   * Only returns true for "file" kind when visualizer is enabled.
   * @param {string} kind
   * @returns {boolean}
   */
  supports(kind) {
    return this._enabled && this._primaryForLocal && kind === "file";
  }

  /** @param {import("../core/types.mjs").Track} track */
  async canPlay(track) {
    // Only handle tracks if visualizer is explicitly enabled
    if (!this._enabled) return false;
    
    // Only handle local file tracks with audio/video
    if (!track || !track.source) return false;
    const src = track.source;
    if (src.kind !== "file") return false;
    
    // Support audio and video files
    const url = src.url || "";
    return /\.(mp3|mp4|m4a|wav|ogg|webm|flac)$/i.test(url);
  }

  /**
   * Enable or disable the visualizer adapter
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    this._enabled = enabled === true;
    
    // Update wrapper div visibility (controls both iframes together)
    if (this._wrapperDiv) {
      this._wrapperDiv.style.display = this._enabled ? "block" : "none";
    }
    
    // Toggle video element visibility (opposite of visualizer)
    const videoEl = this._container?.querySelector('video');
    if (videoEl) {
      videoEl.style.display = this._enabled ? "none" : "block";
    }
  }

  /**
   * Check if visualizer is enabled
   * @returns {boolean}
   */
  isEnabled() {
    return this._enabled;
  }

  /** @param {import("../core/types.mjs").Track} track @param {import("../core/types.mjs").AdapterLoadOptions=} opts */
  async load(track, opts = {}) {
    this._track = track;
    this._setState("loading");
    this._positionMs = 0;
    this._durationMs = track?.durationMs;

    const autoplay = opts && opts.autoplay === true;

    this._resumeState = this._loadResumeState(track);

    // Only handle local/file playback when we are the active adapter
    if (track && track.source && track.source.kind === "file") {
      const url = track.source.url;
      const vizUrl = track.visualizer;
      this._postCommand({ type: "LOAD_TRACK", url, vizUrl, trackId: track.id, autoplay });

      // Apply resume if available
      const r = this._resumeState;
      if (r && typeof r.positionMs === 'number' && r.positionMs > 500) {
        const seekSeconds = r.positionMs / 1000;
        this._postCommand({ type: "SEEK", time: seekSeconds });
        if (r.playing || autoplay) {
          this._postCommand({ type: "PLAY" });
        }
      } else if (autoplay) {
        this._postCommand({ type: "PLAY" });
      }
      return;
    }

    // If invoked for non-file tracks, keep idle state (used only for overlay support)
    this._setState("idle");
  }

  /**
   * Load visualization data for a YouTube track (overlay mode). No audio is loaded here.
   * @param {import("../core/types.mjs").Track} track
   */
  loadVisualization(track) {
    if (!this._enabled) return;
    if (!track || (track.source?.kind !== 'youtube' && track.source?.kind !== 'file')) return;
    const vizUrl = track.visualizer;
    if (!vizUrl) return;

    this._postCommand({
      type: 'LOAD_TRACK',
      vizUrl,
      trackId: track.id
    });
  }

  /** Stop any visualization when overlay is hidden */
  stopVisualization() {
    if (!this._enabled) return;
    this._postCommand({ type: 'STOP' });
  }

  async play() {
    this._postCommand({ type: "PLAY" });
  }

  async pause() {
    this._postCommand({ type: "PAUSE" });
  }

  async stop() {
    this._postCommand({ type: "STOP" });
    this._setState("idle");
  }

  async seekToMs(ms) {
    const seconds = Math.max(0, ms / 1000);
    this._postCommand({ type: "SEEK", time: seconds });
  }

  async setVolume(v01) {
    this._volume = clamp01(v01);
    this._postCommand({ type: "SET_VOLUME", volume: this._volume });
  }

  async setMuted(m) {
    this._muted = !!m;
    this._postCommand({ type: "SET_MUTED", muted: this._muted });
  }

  async setRate(r) {
    this._rate = Number(r) || 1;
    this._postCommand({ type: "SET_RATE", rate: this._rate });
  }

  async listModules() {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve({ modules: [...this._modules], active: this._activeModule });
      }, 1500);

      this._pendingModuleResolvers.push((payload) => {
        clearTimeout(timeout);
        resolve(payload || { modules: [...this._modules], active: this._activeModule });
      });

      this._requestModuleList();
    });
  }

  async setModule(name) {
    const target = typeof name === 'string' ? name : '';
    if (!target) return false;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 1500);

      this._pendingModuleSetResolvers.push((payload) => {
        clearTimeout(timeout);
        resolve(payload?.ok !== false);
      });

      this._postCommand({ type: 'SET_VISUALIZER_MODULE', module: target });
    });
  }

  getModules() {
    return { modules: [...this._modules], active: this._activeModule };
  }

  /** @returns {import("../core/types.mjs").PlaybackInfo} */
  getInfo() {
    return {
      state: this._state,
      muted: this._muted,
      volume: this._volume,
      rate: this._rate,
      time: {
        positionMs: this._positionMs,
        durationMs: this._durationMs ?? this._track?.durationMs,
        bufferedMs: undefined
      },
      activeTrackId: this._track?.id
    };
  }

  /** @returns {import("../core/types.mjs").PlayerCapabilities} */
  getCapabilities() {
    return {
      canPlay: true,
      canPause: true,
      canStop: true,
      canSeek: true,
      canSetRate: true,
      canSetVolume: true,
      canMute: true,
      hasAccurateTime: true,
      hasAudioPipeline: false, // iframe is isolated
      hasVideo: true // has visualization
    };
  }

  /** @returns {import("../core/types.mjs").PlayerCapabilities} */
  getCaps() {
    return this.getCapabilities();
  }

  on(evt, fn) {
    this._em.on(evt, fn);
    return () => this._em.off(evt, fn);
  }

  off(evt, fn) {
    this._em.off(evt, fn);
  }

  async dispose() {
    this.unmount();
    this._em.clear();
    this._track = null;
    this._pendingCommands = [];
  }

  _setState(s) {
    if (this._state === s) return;
    this._state = s;
    this._em.emit("state", s);
  }

  _persistResumeState(playingOverride = null, options = {}) {
    try {
      const store = (typeof sessionStorage !== 'undefined') ? sessionStorage : null;
      if (!store) return;

      const track = this._track;
      const url = track?.source?.url || '';
      const trackId = track?.id || '';
      if (!url && !trackId) return;

      const payload = {
        trackId,
        url,
        positionMs: options.resetPosition ? 0 : this._positionMs || 0,
        playing: playingOverride !== null ? !!playingOverride : (this._state === 'playing'),
        updatedAt: Date.now()
      };
      store.setItem(this._resumeKey, JSON.stringify(payload));
    } catch {
      // ignore
    }
  }

  _loadResumeState(track) {
    try {
      const store = (typeof sessionStorage !== 'undefined') ? sessionStorage : null;
      if (!store) return null;
      const raw = store.getItem(this._resumeKey);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return null;
      const url = track?.source?.url || '';
      const trackId = track?.id || '';
      const matchId = data.trackId && trackId && data.trackId === trackId;
      const matchUrl = data.url && url && data.url === url;
      if (!matchId && !matchUrl) return null;
      return data;
    } catch {
      return null;
    }
  }
}
