import { Emitter } from "../core/Emitter.mjs";
import { makePlaceholderSvgDataUrl } from "../core/placeholder.mjs";

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * VLC adapter via VLC's HTTP interface (requires VLC "Web" interface enabled).
 * NOTE: This is a skeleton. Endpoints/params may vary with VLC version/config.
 *
 * It intentionally renders *no video element*; instead getMediaPane() returns an image placeholder.
 *
 * @implements {import("../core/types.mjs").IPlayerAdapter}
 */
export class VlcHttpAdapter {
  /**
   * @param {Object} cfg
   * @param {string} cfg.baseUrl e.g. "http://127.0.0.1:8080"
   * @param {string=} cfg.username
   * @param {string=} cfg.password
   * @param {number=} cfg.pollMs
   */
  constructor(cfg) {
    this.name = "vlc-http";
    this._em = new Emitter();

    this._cfg = {
      baseUrl: cfg?.baseUrl || "http://127.0.0.1:8080",
      username: cfg?.username || "",
      password: cfg?.password || "",
      pollMs: cfg?.pollMs || 500
    };

    this._track = null;
    this._state = "idle";
    this._muted = false;
    this._volume = 1;
    this._rate = 1;

    this._timer = null;

    this._placeholder = makePlaceholderSvgDataUrl({
      title: "VLC (external)",
      subtitle: "Video is displayed outside the browser",
      theme: "dark"
    });
  }

  supports(kind) { return kind === "vlc"; }

  mount(_container) { this._em.emit("capabilities", this.getCapabilities()); }
  unmount() {}

  getCapabilities() {
    return {
      canPlay: true,
      canPause: true,
      canStop: true,
      canSeek: true,
      canSetRate: false,      // VLC can do rate, but keep false until you wire it
      canSetVolume: true,
      canMute: true,
      hasAccurateTime: false, // polled
      hasAudioPipeline: false,
      hasVideo: true
    };
  }

  getMediaPane() {
    // Placeholder requested by you: adapter supplies the substitution image.
    const t = this._track;
    const subtitle = t?.title ? `Now controlling VLC: ${t.title}` : "Now controlling VLC";
    return { kind: "image", imageUrl: this._placeholder, title: "VLC", subtitle };
  }

  on(event, fn) { return this._em.on(event, fn); }

  async load(track, opts = {}) {
    this._track = track;
    this._setState("loading");

    const input = track?.source?.input;
    if (!input) throw new Error("VlcHttpAdapter.load(): missing input");

    // VLC command: in_play with input
    // TODO: confirm if your VLC uses /requests/status.json + ?command=in_play&input=...
    await this._vlcStatus({ command: "in_play", input });

    // optional seek
    const startMs = Number.isFinite(opts.startMs) ? opts.startMs : (track.startMs || 0);
    if (startMs > 0) {
      await this.seekToMs(startMs);
    }

    if (opts.autoplay === false) {
      await this.pause();
      this._setState("ready");
    } else {
      await this.play();
    }

    this._startPoll();
    this._em.emit("capabilities", this.getCapabilities());
  }

  async play() {
    await this._vlcStatus({ command: "pl_play" });
    this._setState("playing");
  }

  async pause() {
    await this._vlcStatus({ command: "pl_pause" });
    this._setState("paused");
  }

  async stop() {
    await this._vlcStatus({ command: "pl_stop" });
    this._setState("idle");
  }

  async seekToMs(ms) {
    // VLC uses seconds or percent depending on API. Common: command=seek&val=+10s or val=120
    const sec = Math.max(0, Math.floor(ms / 1000));
    await this._vlcStatus({ command: "seek", val: String(sec) });
  }

  async setVolume(v01) {
    const v = clamp01(v01);
    this._volume = v;
    // VLC's volume scale is often 0..512 or 0..320. Keep placeholder until you map it.
    // Many configs accept val=256 as 100%.
    const val = Math.round(v * 256);
    await this._vlcStatus({ command: "volume", val: String(val) });
  }

  async setMuted(m) {
    this._muted = !!m;
    // VLC has "volume&val=0" or "fullscreen" etc; mute may be "volume&val=0" or "muted" in status.
    // TODO: wire proper mute command for your VLC build.
    if (this._muted) await this._vlcStatus({ command: "volume", val: "0" });
  }

  async setRate(_rate) {
    // TODO: implement if you need it (command=rate&val=...)
    throw new Error("VLC rate not wired yet");
  }

  getInfo() {
    // Best-effort local snapshot; you can overwrite this with polled status fields.
    return {
      state: this._state,
      muted: this._muted,
      volume: this._volume,
      rate: this._rate,
      time: { positionMs: 0, durationMs: this._track?.durationMs, bufferedMs: undefined },
      activeTrackId: this._track?.id
    };
  }

  async dispose() {
    this._stopPoll();
    this._em.clear();
  }

  _setState(s) {
    if (this._state === s) return;
    this._state = s;
    this._em.emit("state", s);
    if (s === "ended") this._em.emit("ended");
  }

  _startPoll() {
    if (this._timer) return;
    this._timer = setInterval(async () => {
      // Poll status; emit time/state if you parse them.
      // TODO: parse response JSON fields like time, length, state, volume, rate, etc.
      try {
        const st = await this._vlcStatus();
        // Minimal example (fields vary): { state: "playing", time: 123, length: 300, volume: 256 }
        if (st && typeof st.time === "number") {
          const durationMs = (typeof st.length === "number" && st.length > 0) ? st.length * 1000 : this._track?.durationMs;
          this._em.emit("time", { positionMs: st.time * 1000, durationMs, bufferedMs: undefined });
        }
        if (st && typeof st.state === "string") {
          const s = st.state === "playing" ? "playing"
            : st.state === "paused" ? "paused"
            : st.state === "stopped" ? "idle"
            : "buffering";
          this._setState(s);
        }
      } catch (e) {
        this._em.emit("error", { code: "VLC_POLL", message: "Failed to poll VLC status", detail: e });
      }
    }, this._cfg.pollMs);
  }

  _stopPoll() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async _vlcStatus(params = null) {
    const url = new URL(this._cfg.baseUrl.replace(/\/$/, "") + "/requests/status.json");
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        url.searchParams.set(k, String(v));
      }
    }
    const headers = {};
    if (this._cfg.password || this._cfg.username) {
      const token = btoa(`${this._cfg.username}:${this._cfg.password}`);
      headers["Authorization"] = `Basic ${token}`;
    }
    const resp = await fetch(url.toString(), { headers });
    if (!resp.ok) throw new Error(`VLC HTTP ${resp.status}`);
    return await resp.json();
  }
}
