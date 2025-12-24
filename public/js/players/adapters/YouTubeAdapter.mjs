import { Emitter } from "../core/Emitter.mjs";
import { makePlaceholderSvgDataUrl } from "../core/placeholder.mjs";
import { YTController, STATES as YT_STATES } from "../YTController.mjs";

const DEFAULT_CAPS = Object.freeze({
  canPlay: true,
  canPause: true,
  canStop: true,
  canSeek: true,
  canSetRate: true,
  canSetVolume: true,
  canMute: true,
  hasAccurateTime: true,      // mostly
  hasAudioPipeline: false,    // iframe is isolated; WebAudio analyser isn't possible
  hasVideo: true
});

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function ytStateToGeneric(s) {
  switch (s) {
    case YT_STATES.PLAYING: return "playing";
    case YT_STATES.PAUSED: return "paused";
    case YT_STATES.BUFFERING: return "buffering";
    case YT_STATES.ENDED: return "ended";
    case YT_STATES.CUED: return "ready";
    case YT_STATES.UNSTARTED:
    default: return "idle";
  }
}

/**
 * Adapter that plays TrackSource.kind === "youtube"
 * @implements {import("../core/types.mjs").IPlayerAdapter}
 */
export class YouTubeAdapter {
  constructor(options = {}) {
    this.name = "youtube";
    this._em = new Emitter();

    /** @type {import("../core/types.mjs").Track|null} */
    this._track = null;

    this._state = "idle";
    this._volume = 1;
    this._muted = false;
    this._rate = 1;

    this._timeTimer = null;

    this._yt = new YTController(options);
    this._yt.onReady(() => {
      this._emitCaps();
      this._setState("ready");
    });
    this._yt.onStateChange((s) => {
      const gs = ytStateToGeneric(s);
      this._setState(gs);
      if (gs === "ended") this._em.emit("ended");
    });
    this._yt.onError((e) => {
      this._setState("error");
      const code = (e && typeof e === 'object' && e !== null && 'code' in e) ? e.code : 'YT_ERROR';
      const ytCode = (e && typeof e === 'object' && e !== null && 'ytCode' in e) ? e.ytCode : undefined;
      const message = (e && typeof e === 'object' && e !== null && typeof e.message === 'string')
        ? e.message
        : 'YouTube player error';

      console.warn('YouTubeAdapter: onError', { code, ytCode, message, detail: e });
      this._em.emit("error", { code, ytCode, message, detail: e });
    });

    this._placeholder = makePlaceholderSvgDataUrl({
      title: "YouTube",
      subtitle: "Loading video…",
      theme: "dark"
    });
  }

  supports(kind) { return kind === "youtube"; }

  mount(container) {
    this._yt.mount(container);
    this._yt.init();
  }

  unmount() { this._yt.unmount?.(); }

  getCapabilities() { return { ...DEFAULT_CAPS }; }

  getMediaPane() {
    // YouTube renders inside the browser; we don't need a placeholder.
    // UI should simply show the container where the iframe is mounted.
    return { kind: "iframe", element: document.getElementById(this._yt.elementId) || undefined };
  }

  on(event, fn) { return this._em.on(event, fn); }

  async load(track, opts = {}) {
    this._track = track;
    this._setState("loading");

    const startMs = Number.isFinite(opts.startMs) ? opts.startMs : (track.startMs || 0);
    const startSeconds = Math.max(0, Math.floor(startMs / 1000));
    const autoplay = opts.autoplay !== false;

    const videoId = track?.source?.videoId;
    const cleanedVideoId = (videoId || '').trim();
    if (!cleanedVideoId) throw new Error("YouTubeAdapter.load(): missing videoId");

    this._yt.init();
    this._yt.load(cleanedVideoId, { startSeconds, autoplay });

    // best-effort refresh of cached controls
    this._volume = clamp01(this._yt.getVolume() / 100);
    this._muted = !!this._yt.isMuted();
    this._rate = Number(this._yt.getRate()) || 1;

    this._startTimePump();
    this._emitCaps();
  }

  async play() { this._yt.play(); }
  async pause() { this._yt.pause(); }
  async stop() { this._yt.stop(); this._setState("idle"); }

  async seekToMs(ms) {
    if (!DEFAULT_CAPS.canSeek) throw new Error("seek not supported");
    const sec = Math.max(0, ms / 1000);
    this._yt.seekTo(sec, true);
  }

  async setVolume(v01) {
    const v = clamp01(v01);
    this._volume = v;
    this._yt.setVolume(Math.round(v * 100));
    this._em.emit("capabilities", this.getCapabilities());
  }

  async setMuted(m) {
    this._muted = !!m;
    this._yt.setMuted(this._muted);
  }

  async setRate(r) {
    const rate = Number(r);
    if (!Number.isFinite(rate)) return;
    this._rate = rate;
    this._yt.setRate(rate);
  }

  getInfo() {
    const posMs = Math.max(0, Math.floor(this._yt.getCurrentTime() * 1000));
    const dur = this._yt.getDuration();
    const durMs = dur > 0 ? Math.floor(dur * 1000) : (this._track?.durationMs);
    return {
      state: this._state,
      muted: this._muted,
      volume: this._volume,
      rate: this._rate,
      time: { positionMs: posMs, durationMs: durMs, bufferedMs: undefined },
      activeTrackId: this._track?.id
    };
  }

  async dispose() {
    this._stopTimePump();
    this._yt.destroy();
    this._em.clear();
  }

  _setState(s) {
    if (this._state === s) return;
    this._state = s;
    this._em.emit("state", s);
  }

  _emitCaps() { this._em.emit("capabilities", this.getCapabilities()); }

  _startTimePump() {
    if (this._timeTimer) return;
    this._timeTimer = setInterval(() => {
      if (this._state !== "playing" && this._state !== "paused" && this._state !== "buffering") return;
      const info = this.getInfo();
      this._em.emit("time", info.time);
    }, 250);
  }

  _stopTimePump() {
    if (this._timeTimer) {
      clearInterval(this._timeTimer);
      this._timeTimer = null;
    }
  }
}
