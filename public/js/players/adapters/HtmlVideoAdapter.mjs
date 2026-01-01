import { Emitter } from "../core/Emitter.mjs";

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Adapter that plays TrackSource.kind === "file" using <video> (or <audio> if you tweak it).
 * @implements {import("../core/types.mjs").IPlayerAdapter}
 */
export class HtmlVideoAdapter {
  constructor(options = {}) {
    this.name = "html-video";
    this._em = new Emitter();

    this._track = null;
    this._state = "idle";

    this._knownDurationMs = undefined;

    this._container = null;
    this._el = document.createElement("video");
    // Helps suppress the browser/WebView default poster/glyph between source switches.
    // Use a 1x1 transparent GIF poster so there's always a poster.
    this._el.poster = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
    this._el.preload = "metadata";
    this._el.playsInline = true;
    this._el.controls = false;

    this._el.addEventListener("play", () => this._setState("playing"));
    this._el.addEventListener("pause", () => {
      // Setting `src` / calling `load()` can synchronously trigger a `pause` event.
      // If that happens while we're in `loading`, don't let it prevent the
      // subsequent metadata events from transitioning us to `ready`.
      if (this._state === "loading") return;
      this._setState(this._el.ended ? "ended" : "paused");
    });
    this._el.addEventListener("waiting", () => this._setState("buffering"));
    this._el.addEventListener("ended", () => { this._setState("ended"); this._em.emit("ended"); });

    const markReady = () => {
      // The UI relies on at least one "ready" transition to start its timers.
      // For <video>, metadata availability is a good proxy for being "ready".
      // Some browsers can fire a `pause` during `load()`; don't let that block
      // the `ready` transition.
      if (this._state !== "playing" && this._state !== "ended" && this._state !== "error") {
        this._setState("ready");
      }
    };

    const refreshDuration = () => {
      const dur = this._el.duration;
      if (Number.isFinite(dur) && dur > 0) {
        this._knownDurationMs = Math.floor(dur * 1000);
        return;
      }

      // Some servers/encodes cause duration to be Infinity/NaN even though the
      // media is seekable. In that case, use the end of the seekable range.
      const seekable = this._el.seekable;
      if (seekable && seekable.length) {
        try {
          const end = seekable.end(seekable.length - 1);
          if (Number.isFinite(end) && end > 0) {
            this._knownDurationMs = Math.floor(end * 1000);
          }
        } catch {
          /* ignore */
        }
      }
    };

    // Duration may only become known after the browser fetches metadata (or moov atom).
    this._el.addEventListener("loadedmetadata", () => {
      markReady();
      refreshDuration();
      this._em.emit("time", this.getInfo().time);
    });
    this._el.addEventListener("loadeddata", () => {
      markReady();
      refreshDuration();
      this._em.emit("time", this.getInfo().time);
    });
    this._el.addEventListener("canplay", () => {
      markReady();
      refreshDuration();
      this._em.emit("time", this.getInfo().time);
    });
    this._el.addEventListener("durationchange", () => {
      refreshDuration();
      this._em.emit("time", this.getInfo().time);
    });
    this._el.addEventListener("progress", () => {
      refreshDuration();
      this._em.emit("time", this.getInfo().time);
    });

    this._el.addEventListener("timeupdate", () => {
      refreshDuration();
      this._em.emit("time", this.getInfo().time);
    });
    this._el.addEventListener("error", () => {
      this._setState("error");
      this._em.emit("error", { code: "MEDIA_ERROR", message: "HTML media element error", detail: this._el.error });
    });
  }

  supports(kind) { return kind === "file"; }

  getThumbnailUrl(track) {
    const videoId = track && typeof track.id === 'string' ? track.id.trim() : '';
    if (!videoId) return undefined;
    const base = `vid_${videoId}`;
    try {
      const mediaUrl = track?.source?.url;
      if (typeof mediaUrl === 'string' && mediaUrl.trim().length) {
        const resolved = new URL(mediaUrl, window.location.href);
        const baseDir = new URL('./', resolved);
        return new URL(`thumbnail/${encodeURIComponent(base)}.jpg`, baseDir).toString();
      }

      // Fallback (legacy): thumbnails under ./video/thumbnail
      return new URL(`./video/thumbnail/${encodeURIComponent(base)}.jpg`, window.location.href).toString();
    } catch {
      return `./video/thumbnail/${encodeURIComponent(base)}.jpg`;
    }
  }

  mount(container) {
    this._container = container;
    if (container && !container.contains(this._el)) container.appendChild(this._el);
    this._em.emit("capabilities", this.getCapabilities());
  }

  unmount() {
    if (this._container && this._container.contains(this._el)) {
      try { this._container.removeChild(this._el); } catch { /* ignore */ }
    }
    this._container = null;
  }

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
      hasAudioPipeline: true, // you can attach WebAudio analyser to this._el
      hasVideo: true
    };
  }

  getMediaPane() { return { kind: "video", element: this._el }; }
  on(event, fn) { return this._em.on(event, fn); }

  async load(track, opts = {}) {
    this._track = track;
    this._setState("loading");

    this._knownDurationMs = undefined;

    const url = track?.source?.url;
    if (!url) throw new Error("HtmlVideoAdapter.load(): missing url");

    this._el.src = url;
    // Ensure a network request starts promptly and metadata events fire.
    try { this._el.load(); } catch { /* ignore */ }

    const startMs = Number.isFinite(opts.startMs) ? opts.startMs : (track.startMs || 0);
    if (startMs > 0) {
      // best-effort: seek after metadata load
      await new Promise((resolve) => {
        const onMeta = () => { this._el.removeEventListener("loadedmetadata", onMeta); resolve(); };
        this._el.addEventListener("loadedmetadata", onMeta);
      });
      try { this._el.currentTime = Math.max(0, startMs / 1000); } catch { /* ignore */ }
    }

    if (opts.autoplay !== false) {
      try {
        await this._el.play();
      } catch {
        // If autoplay is blocked, still transition out of `loading` so the UI
        // can display duration/position once metadata arrives.
        this._setState("ready");
      }
    } else {
      this._setState("ready");
    }

    this._em.emit("capabilities", this.getCapabilities());
  }

  async play() {
    try {
      await this._el.play();
    } catch {
      /* ignore */
    }
    // Some browsers can delay/skip emitting `play`/`pause` events in odd edge cases.
    // Keep state aligned with the element's actual properties.
    if (!this._el.paused && !this._el.ended) {
      this._setState("playing");
    }
  }

  async pause() {
    try {
      this._el.pause();
    } catch {
      /* ignore */
    }
    if (this._state !== "loading" && this._el.paused && !this._el.ended) {
      this._setState("paused");
    }
  }

  async stop() {
    try { this._el.pause(); } catch { /* ignore */ }
    try { this._el.currentTime = 0; } catch { /* ignore */ }
    this._setState("idle");
  }

  async seekToMs(ms) {
    try { this._el.currentTime = Math.max(0, ms / 1000); } catch { /* ignore */ }
  }

  async setVolume(v01) { this._el.volume = clamp01(v01); }
  async setMuted(m) { this._el.muted = !!m; }
  async setRate(r) { this._el.playbackRate = Number(r) || 1; }

  getInfo() {
    // Derive the effective state from the element to avoid stale UI when events
    // are delayed (common on iOS/Safari with inline media).
    let effectiveState = this._state;
    if (effectiveState !== "error") {
      const hasSource = !!(this._el.currentSrc || this._el.src);
      if (!hasSource) {
        effectiveState = "idle";
      } else if (this._el.ended) {
        effectiveState = "ended";
      } else if (this._el.paused) {
        effectiveState = (this._state === "loading") ? "loading" : "paused";
      } else {
        // If we already decided we're buffering and the element isn't ready, keep buffering.
        if (this._state === "buffering" && this._el.readyState < 3) {
          effectiveState = "buffering";
        } else {
          effectiveState = "playing";
        }
      }
    }

    const dur = Number.isFinite(this._el.duration) ? this._el.duration : NaN;
    const durMs = Number.isFinite(dur) && dur > 0
      ? Math.floor(dur * 1000)
      : (this._knownDurationMs ?? this._track?.durationMs);
    return {
      state: effectiveState,
      muted: !!this._el.muted,
      volume: clamp01(this._el.volume),
      rate: Number(this._el.playbackRate) || 1,
      time: {
        positionMs: Math.max(0, Math.floor((this._el.currentTime || 0) * 1000)),
        durationMs: durMs,
        bufferedMs: undefined
      },
      activeTrackId: this._track?.id
    };
  }

  async dispose() {
    this.unmount();
    try { this._el.removeAttribute("src"); this._el.load(); } catch { /* ignore */ }
    this._em.clear();
  }

  _setState(s) {
    if (this._state === s) return;
    this._state = s;
    this._em.emit("state", s);
  }
}
