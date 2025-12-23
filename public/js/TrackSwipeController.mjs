export class TrackSwipeController {
  constructor({
    layerEl,
    shouldIgnoreStart,
    onNext,
    onPrev,
    minDyPx = 60,
    maxDtMs = 900,
    verticalBias = 1.2
  } = {}) {
    this.layerEl = layerEl || null;
    this.shouldIgnoreStart = typeof shouldIgnoreStart === 'function' ? shouldIgnoreStart : () => false;
    this.onNext = typeof onNext === 'function' ? onNext : () => {};
    this.onPrev = typeof onPrev === 'function' ? onPrev : () => {};

    this.minDyPx = Number.isFinite(minDyPx) ? minDyPx : 60;
    this.maxDtMs = Number.isFinite(maxDtMs) ? maxDtMs : 900;
    this.verticalBias = Number.isFinite(verticalBias) ? verticalBias : 1.2;

    this._active = false;
    this._pointerId = null;
    this._startX = 0;
    this._startY = 0;
    this._startTs = 0;

    this._onPointerDown = (event) => this._handlePointerDown(event);
    this._onPointerUp = (event) => this._handlePointerUp(event);
    this._onPointerCancel = () => this._handlePointerCancel();
    this._onTouchStart = (event) => this._handleTouchStart(event);
    this._onTouchEnd = (event) => this._handleTouchEnd(event);
    this._onTouchCancel = () => this._handleTouchCancel();

    this._attached = false;
  }

  attach() {
    if (this._attached) return;
    if (!this.layerEl) return;

    this.layerEl.addEventListener('pointerdown', this._onPointerDown, { passive: true });
    this.layerEl.addEventListener('pointerup', this._onPointerUp, { passive: true });
    this.layerEl.addEventListener('pointercancel', this._onPointerCancel, { passive: true });

    this.layerEl.addEventListener('touchstart', this._onTouchStart, { passive: true });
    this.layerEl.addEventListener('touchend', this._onTouchEnd, { passive: true });
    this.layerEl.addEventListener('touchcancel', this._onTouchCancel, { passive: true });

    this._attached = true;
  }

  detach() {
    if (!this._attached) return;
    if (!this.layerEl) return;

    this.layerEl.removeEventListener('pointerdown', this._onPointerDown);
    this.layerEl.removeEventListener('pointerup', this._onPointerUp);
    this.layerEl.removeEventListener('pointercancel', this._onPointerCancel);

    this.layerEl.removeEventListener('touchstart', this._onTouchStart);
    this.layerEl.removeEventListener('touchend', this._onTouchEnd);
    this.layerEl.removeEventListener('touchcancel', this._onTouchCancel);

    this._attached = false;
  }

  _shouldIgnore(eventTarget) {
    try {
      return !!this.shouldIgnoreStart(eventTarget);
    } catch {
      return false;
    }
  }

  _handleSwipeEnd(clientX, clientY) {
    if (!this._active) return;
    const dt = Date.now() - this._startTs;
    this._active = false;
    this._pointerId = null;

    if (dt > this.maxDtMs) return;
    const dx = clientX - this._startX;
    const dy = clientY - this._startY;
    if (Math.abs(dy) < this.minDyPx) return;
    if (Math.abs(dy) < Math.abs(dx) * this.verticalBias) return;

    if (dy < 0) {
      this.onNext();
    } else {
      this.onPrev();
    }
  }

  _handlePointerDown(event) {
    if (event.defaultPrevented) return;
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    if (this._shouldIgnore(event.target)) return;

    this._active = true;
    this._pointerId = event.pointerId;
    this._startX = event.clientX;
    this._startY = event.clientY;
    this._startTs = Date.now();

    try {
      this.layerEl.setPointerCapture(event.pointerId);
    } catch {
      // Ignore capture failures.
    }
  }

  _handlePointerUp(event) {
    if (!this._active) return;
    if (this._pointerId !== null && event.pointerId !== this._pointerId) return;
    this._handleSwipeEnd(event.clientX, event.clientY);
  }

  _handlePointerCancel() {
    this._active = false;
    this._pointerId = null;
  }

  _handleTouchStart(event) {
    if (!event.touches || event.touches.length !== 1) return;
    if (this._shouldIgnore(event.target)) return;

    const t = event.touches[0];
    this._active = true;
    this._pointerId = null;
    this._startX = t.clientX;
    this._startY = t.clientY;
    this._startTs = Date.now();
  }

  _handleTouchEnd(event) {
    if (!this._active) return;
    const t = (event.changedTouches && event.changedTouches[0]) ? event.changedTouches[0] : null;
    if (!t) {
      this._active = false;
      return;
    }
    this._handleSwipeEnd(t.clientX, t.clientY);
  }

  _handleTouchCancel() {
    this._active = false;
  }
}
