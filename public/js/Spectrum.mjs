export class Spectrum {
  constructor({ canvas = null, controller = null, cacheDir = './spectrum-cache' } = {}) {
    this.canvas = canvas;
    this.controller = controller;
    this.cacheDir = cacheDir;

    this.enabled = true;
    this.state = {
      bins: 16,
      fps: 20,
      frameCount: 0,
      durationMs: 0,
      frames: null,
      peaks: null,
      rafId: null,
      lastVideoId: '',
      dpr: 1,
    };
  }

  setCanvas(canvas) {
    this.canvas = canvas;
  }

  setController(controller) {
    this.controller = controller;
  }

  isEnabled() {
    return !!this.enabled;
  }

  setEnabled(enabled) {
    const next = !!enabled;
    if (this.enabled === next) return;
    this.enabled = next;
    if (!this.enabled) {
      this.disable();
    }
  }

  clearCanvas() {
    const canvas = this.canvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  disable() {
    this.enabled = false;
    this.stop();
    this.state.frames = null;
    this.state.frameCount = 0;
    this.state.durationMs = 0;
    this.state.lastVideoId = '';
    document.body.classList.add('spectrum-missing');
    this.clearCanvas();
  }

  ensurePeaks(binCount) {
    if (this.state.peaks && this.state.peaks.length === binCount) return;
    this.state.peaks = new Float32Array(binCount);
    this.state.peaks.fill(0);
  }

  u8ToHex(u8) {
    return Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  async sha256First8Bytes(str) {
    if (!window.crypto?.subtle) return null;
    const data = new TextEncoder().encode(str);
    const digest = await window.crypto.subtle.digest('SHA-256', data);
    return new Uint8Array(digest).slice(0, 8);
  }

  drawFrame(frameU8) {
    const canvas = this.canvas;
    if (!canvas || !frameU8) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cssW = canvas.clientWidth || 1;
    const cssH = canvas.clientHeight || 1;
    const dpr = window.devicePixelRatio || 1;
    if (
      this.state.dpr !== dpr ||
      canvas.width !== Math.round(cssW * dpr) ||
      canvas.height !== Math.round(cssH * dpr)
    ) {
      this.state.dpr = dpr;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }

    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Background grid-like dots (subtle Winamp vibe)
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    const grid = Math.max(4, Math.floor(8 * this.state.dpr));
    for (let y = grid; y < H; y += grid) {
      for (let x = grid; x < W; x += grid) {
        ctx.fillRect(x, y, 1, 1);
      }
    }

    const binCount = Math.min(frameU8.length, this.state.bins);
    this.ensurePeaks(binCount);

    const gap = Math.max(1, Math.round(1.5 * this.state.dpr));
    const barW = Math.max(2, Math.floor((W - gap * (binCount + 1)) / binCount));
    const maxBarH = H - Math.round(6 * this.state.dpr);
    const baseY = H - Math.round(3 * this.state.dpr);

    const peakFallPerFrame = 0.018; // fraction per animation frame
    const peakCapH = Math.max(1, Math.round(1 * this.state.dpr));

    for (let i = 0; i < binCount; i++) {
      const v = frameU8[i] / 255;
      const h = Math.max(1, Math.round(v * maxBarH));
      const x = gap + i * (barW + gap);
      const y = baseY - h;

      const grad = ctx.createLinearGradient(0, y, 0, baseY);
      grad.addColorStop(0.00, '#ff0033');
      grad.addColorStop(0.18, '#ff6a00');
      grad.addColorStop(0.40, '#ffe600');
      grad.addColorStop(1.00, '#00ff57');
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, barW, h);

      const peaks = this.state.peaks;
      const nextPeak = Math.max(v, (peaks[i] || 0) - peakFallPerFrame);
      peaks[i] = nextPeak;

      const peakH = Math.max(1, Math.round(nextPeak * maxBarH));
      const peakY = Math.max(0, baseY - peakH);
      const capY = Math.max(0, peakY);
      const capH = Math.min(peakCapH, baseY - capY);

      let capColor = '#00ff57';
      if (nextPeak >= 0.88) capColor = '#ff0033';
      else if (nextPeak >= 0.76) capColor = '#ff6a00';
      else if (nextPeak >= 0.60) capColor = '#ffe600';
      ctx.fillStyle = capColor;
      ctx.fillRect(x, capY, barW, capH);
    }
  }

  stop() {
    if (this.state.rafId) {
      cancelAnimationFrame(this.state.rafId);
      this.state.rafId = null;
    }
  }

  start() {
    this.stop();
    if (!this.enabled) return;
    if (!this.canvas || !this.state.frames || !this.controller) return;

    const tick = () => {
      if (!this.state.frames || !this.controller) {
        this.state.rafId = null;
        return;
      }
      const t = this.controller.getCurrentTime();
      const frameIndex = Math.max(
        0,
        Math.min(this.state.frameCount - 1, Math.floor(t * this.state.fps))
      );
      const offset = frameIndex * this.state.bins;
      const frame = this.state.frames.subarray(offset, offset + this.state.bins);
      this.drawFrame(frame);
      this.state.rafId = requestAnimationFrame(tick);
    };

    this.state.rafId = requestAnimationFrame(tick);
  }

  async loadForVideoId(videoId) {
    if (!this.enabled) return false;
    if (!videoId) return false;
    if (videoId === this.state.lastVideoId && this.state.frames) return true;

    this.stop();
    this.state.lastVideoId = videoId;
    this.state.frames = null;
    this.state.frameCount = 0;
    this.state.durationMs = 0;
    document.body.classList.add('spectrum-missing');

    const url = `${this.cacheDir}/${encodeURIComponent(videoId)}.spc32`;
    let buf;
    try {
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) return false;
      buf = await resp.arrayBuffer();
    } catch {
      return false;
    }

    if (buf.byteLength < 32) return false;
    const view = new DataView(buf);
    const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (magic !== 'SPC1') return false;
    const version = view.getUint8(4);
    if (version !== 1) return false;

    const bins = view.getUint8(5);
    const fps = view.getUint8(6);
    const durationMs = view.getUint32(12, true);
    const frameCount = view.getUint32(16, true);
    const hashBytes = new Uint8Array(buf.slice(20, 28));

    // Optional integrity check (best-effort).
    try {
      const expect = await this.sha256First8Bytes(videoId);
      if (expect) {
        for (let i = 0; i < 8; i++) {
          if (expect[i] !== hashBytes[i]) {
            console.warn(
              'Spectrum cache hash mismatch for',
              videoId,
              'got',
              this.u8ToHex(hashBytes),
              'expected',
              this.u8ToHex(expect)
            );
            break;
          }
        }
      }
    } catch {
      // ignore
    }

    const payloadOffset = 32;
    const expectedBytes = payloadOffset + frameCount * bins;
    if (buf.byteLength < expectedBytes) return false;

    this.state.bins = bins;
    this.state.fps = fps;
    this.state.durationMs = durationMs;
    this.state.frameCount = frameCount;
    this.state.frames = new Uint8Array(buf, payloadOffset, frameCount * bins);
    this.state.peaks = null;

    document.body.classList.remove('spectrum-missing');
    return true;
  }
}
