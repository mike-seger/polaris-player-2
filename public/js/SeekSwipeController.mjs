export class SeekSwipeController {
  constructor({
    layerEl,
    isBlocked,
    getDuration,
    getCurrentTime,
    seekTo,
    setActive,
    onFeedbackFraction,
    suppressSidebarHide
  } = {}) {
    this.layerEl = layerEl || null;
    this.isBlocked = typeof isBlocked === 'function' ? isBlocked : () => false;
    this.getDuration = typeof getDuration === 'function' ? getDuration : () => 0;
    this.getCurrentTime = typeof getCurrentTime === 'function' ? getCurrentTime : () => 0;
    this.seekTo = typeof seekTo === 'function' ? seekTo : () => {};
    this.setActive = typeof setActive === 'function' ? setActive : () => {};
    this.onFeedbackFraction = typeof onFeedbackFraction === 'function' ? onFeedbackFraction : () => {};
    this.suppressSidebarHide = typeof suppressSidebarHide === 'function' ? suppressSidebarHide : () => {};

    this.SEEK_UPDATE_THROTTLE_MS = 120;
    this.SEEK_SWIPE_MIN_FRAC = 0;
    this.SEEK_SWIPE_MAX_FRAC = 0.99;

    this._active = false;
    this._pointerId = null;
    this._lastUpdateTs = 0;
    this._startClientX = 0;
    this._startFrac = 0;

    this._onPointerDown = (event) => this._handlePointerDown(event);
    this._onPointerMove = (event) => this._handlePointerMove(event);
    this._onPointerUp = (event) => this._handlePointerUp(event);
    this._onPointerCancel = () => this._handlePointerCancel();
    this._onTouchStart = (event) => this._handleTouchStart(event);
    this._onTouchMove = (event) => this._handleTouchMove(event);
    this._onTouchEnd = (event) => this._handleTouchEnd(event);
    this._onTouchCancel = () => this._handleTouchCancel();

    this._attached = false;
  }

  attach() {
    if (this._attached) return;
    if (!this.layerEl) return;

    this.layerEl.addEventListener('pointerdown', this._onPointerDown, { passive: true });
    this.layerEl.addEventListener('pointermove', this._onPointerMove, { passive: true });
    this.layerEl.addEventListener('pointerup', this._onPointerUp, { passive: true });
    this.layerEl.addEventListener('pointercancel', this._onPointerCancel, { passive: true });

    this.layerEl.addEventListener('touchstart', this._onTouchStart, { passive: true });
    this.layerEl.addEventListener('touchmove', this._onTouchMove, { passive: true });
    this.layerEl.addEventListener('touchend', this._onTouchEnd, { passive: true });
    this.layerEl.addEventListener('touchcancel', this._onTouchCancel, { passive: true });

    this._attached = true;
  }

  detach() {
    if (!this._attached) return;
    if (!this.layerEl) return;

    this.layerEl.removeEventListener('pointerdown', this._onPointerDown);
    this.layerEl.removeEventListener('pointermove', this._onPointerMove);
    this.layerEl.removeEventListener('pointerup', this._onPointerUp);
    this.layerEl.removeEventListener('pointercancel', this._onPointerCancel);

    this.layerEl.removeEventListener('touchstart', this._onTouchStart);
    this.layerEl.removeEventListener('touchmove', this._onTouchMove);
    this.layerEl.removeEventListener('touchend', this._onTouchEnd);
    this.layerEl.removeEventListener('touchcancel', this._onTouchCancel);

    this._attached = false;
  }

  _clampFraction(frac) {
    if (!isFinite(frac)) return this.SEEK_SWIPE_MIN_FRAC;
    return Math.max(this.SEEK_SWIPE_MIN_FRAC, Math.min(this.SEEK_SWIPE_MAX_FRAC, frac));
  }

  _getCurrentPlaybackFraction() {
    const duration = this.getDuration();
    const t = this.getCurrentTime();
    if (!duration || !isFinite(duration) || duration <= 0) return 0;
    if (!isFinite(t) || t < 0) return 0;
    return this._clampFraction(t / duration);
  }

  _fractionFromClientX(clientX) {
    const rect = this.layerEl.getBoundingClientRect();
    if (!rect.width || rect.width <= 0) return this._clampFraction(this._startFrac);
    const deltaFrac = (clientX - this._startClientX) / rect.width;
    return this._clampFraction(this._startFrac + deltaFrac);
  }

  _seekFromFraction(frac, force = false) {
    const duration = this.getDuration();
    if (!duration || !isFinite(duration) || duration <= 0) return;

    const clamped = this._clampFraction(frac);
    this.onFeedbackFraction(clamped);

    const now = Date.now();
    if (!force && now - this._lastUpdateTs < this.SEEK_UPDATE_THROTTLE_MS) return;
    this._lastUpdateTs = now;

    this.suppressSidebarHide(8000);
    this.seekTo(clamped * duration, true);
  }

  _begin(pointerId, startClientX) {
    this._active = true;
    this._pointerId = pointerId;
    this._lastUpdateTs = 0;
    this._startClientX = startClientX;
    this._startFrac = this._getCurrentPlaybackFraction();

    this.onFeedbackFraction(this._startFrac);
    this.setActive(true);
    this.suppressSidebarHide(8000);
  }

  _end() {
    this._active = false;
    this._pointerId = null;
    this.setActive(false);
    this.suppressSidebarHide(1500);
  }

  _handlePointerDown(event) {
    if (event.defaultPrevented) return;
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    if (this.isBlocked()) return;

    this._begin(event.pointerId, event.clientX);
    try {
      this.layerEl.setPointerCapture(event.pointerId);
    } catch {
      // Ignore capture failures.
    }
  }

  _handlePointerMove(event) {
    if (!this._active) return;
    if (this._pointerId !== null && event.pointerId !== this._pointerId) return;
    this._seekFromFraction(this._fractionFromClientX(event.clientX), false);
  }

  _handlePointerUp(event) {
    if (!this._active) return;
    if (this._pointerId !== null && event.pointerId !== this._pointerId) return;
    this._seekFromFraction(this._fractionFromClientX(event.clientX), true);
    this._end();
  }

  _handlePointerCancel() {
    if (!this._active) return;
    this._end();
  }

  _handleTouchStart(event) {
    if (!event.touches || event.touches.length !== 1) return;
    if (this.isBlocked()) return;
    const t = event.touches[0];
    this._begin(null, t.clientX);
  }

  _handleTouchMove(event) {
    if (!this._active) return;
    const t = event.touches && event.touches[0] ? event.touches[0] : null;
    if (!t) return;
    this._seekFromFraction(this._fractionFromClientX(t.clientX), false);
  }

  _handleTouchEnd(event) {
    if (!this._active) return;
    const t = (event.changedTouches && event.changedTouches[0]) ? event.changedTouches[0] : null;
    if (t) {
      this._seekFromFraction(this._fractionFromClientX(t.clientX), true);
    }
    this._end();
  }

  _handleTouchCancel() {
    if (!this._active) return;
    this._end();
  }
}
