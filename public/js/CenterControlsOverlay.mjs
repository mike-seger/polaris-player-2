import { isTextInputActive } from './OverlayShared.mjs';

export class CenterControlsOverlay {
  constructor(options = {}) {
    const {
      overlayEl,
      hitEl,
      panelEl,
      playerContainerEl,
      sidebarDrawerEl,
      hideAfterMs = 8000,
      onPrev = () => {},
      onNext = () => {},
      onTogglePlayback = () => {},
      getPlayerMode = () => 'youtube',
      isSidebarHidden = () => false,
      setSidebarHidden = (_hidden, _options) => {},
      buttons = {},
    } = options;

    this.hitEl = hitEl || overlayEl;
    this.panelEl = panelEl;
    this.playerContainerEl = playerContainerEl;
    this.sidebarDrawerEl = sidebarDrawerEl;

    this.hideAfterMs = Math.max(0, hideAfterMs || 0);

    this.onPrev = onPrev;
    this.onNext = onNext;
    this.onTogglePlayback = onTogglePlayback;

    this.getPlayerMode = getPlayerMode;
    this.isSidebarHidden = isSidebarHidden;
    this.setSidebarHidden = setSidebarHidden;

    this.buttons = buttons;

    this._visible = false;
    this._hideTimer = null;
    this._resizeObs = null;
    this._bodyClassObs = null;
    this._lastHoverShowAt = 0;

    this._boundOnPointer = (e) => this._onPointerEvent(e);
    this._boundOnPointerMove = (e) => this._onPointerMove(e);
    this._boundOnKeydown = (e) => this._onKeydown(e);
    this._boundOnFocusIn = (e) => this._onFocusIn(e);
    this._boundOnResize = () => this.updateLayout();
    this._boundOnSidebarToggleChange = (e) => this._onSidebarToggleChange(e);
  }

  setup() {
    if (!(this.hitEl instanceof HTMLElement)) return;
    if (!(this.panelEl instanceof HTMLElement)) return;

    this.updateForMode(this.getPlayerMode());
    this.setVisible(false);

    const b = this.buttons || {};
    if (b.prevBtn) b.prevBtn.addEventListener('click', (e) => this._wrapClick(e, () => this.onPrev()));
    if (b.playPauseBtn) b.playPauseBtn.addEventListener('click', (e) => this._wrapClick(e, () => this.onTogglePlayback()));
    if (b.nextBtn) b.nextBtn.addEventListener('click', (e) => this._wrapClick(e, () => this.onNext()));
    // Edge buttons should never reveal the rest of the overlay.
    if (b.edgePrevBtn) b.edgePrevBtn.addEventListener('click', (e) => this._wrapEdgeClick(e, () => this.onPrev()));
    if (b.edgeNextBtn) b.edgeNextBtn.addEventListener('click', (e) => this._wrapEdgeClick(e, () => this.onNext()));

    if (b.sidebarToggleInput) {
      try {
        // checked=true means sidebar is visible.
        b.sidebarToggleInput.checked = !this.isSidebarHidden();
      } catch { /* ignore */ }
      b.sidebarToggleInput.addEventListener('change', this._boundOnSidebarToggleChange);
    }

    // Show overlay on interactions with the player surface.
    // When hidden, intercept events (best-effort) so they don't bubble through.
    document.addEventListener('pointerdown', this._boundOnPointer, { capture: true, passive: false });
    document.addEventListener('touchstart', this._boundOnPointer, { capture: true, passive: false });
    document.addEventListener('pointermove', this._boundOnPointerMove, { capture: true, passive: true });
    document.addEventListener('focusin', this._boundOnFocusIn, { capture: true });
    document.addEventListener('keydown', this._boundOnKeydown, { capture: true });

    // Keep icon sizing synced.
    window.addEventListener('resize', this._boundOnResize, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObs = new ResizeObserver(() => this.updateLayout());
      try { this._resizeObs.observe(this.hitEl); } catch { /* ignore */ }
    }

    // Keep toggle state synced with sidebar class changes (e.g., other UI actions).
    if (typeof MutationObserver !== 'undefined') {
      this._bodyClassObs = new MutationObserver(() => {
        this.updateLayout();
      });
      try { this._bodyClassObs.observe(document.body, { attributes: true, attributeFilter: ['class'] }); } catch { /* ignore */ }
    }

    this.updateLayout();
  }

  destroy() {
    document.removeEventListener('pointerdown', this._boundOnPointer, { capture: true });
    document.removeEventListener('touchstart', this._boundOnPointer, { capture: true });
    document.removeEventListener('pointermove', this._boundOnPointerMove, { capture: true });
    document.removeEventListener('focusin', this._boundOnFocusIn, { capture: true });
    document.removeEventListener('keydown', this._boundOnKeydown, { capture: true });
    window.removeEventListener('resize', this._boundOnResize);
    const b = this.buttons || {};
    if (b.sidebarToggleInput) {
      try { b.sidebarToggleInput.removeEventListener('change', this._boundOnSidebarToggleChange); } catch { /* ignore */ }
    }
    if (this._resizeObs) {
      try { this._resizeObs.disconnect(); } catch { /* ignore */ }
      this._resizeObs = null;
    }
    if (this._bodyClassObs) {
      try { this._bodyClassObs.disconnect(); } catch { /* ignore */ }
      this._bodyClassObs = null;
    }
    this._clearHideTimer();
  }

  updateForMode(mode) {
    if (!(this.hitEl instanceof HTMLElement)) return;
    const m = String(mode || '').trim().toLowerCase();

    // Respect YouTube's own UI stripes; other modes can use the full height.
    const safeTop = (m === 'youtube') ? 70 : 0;
    const safeBottom = (m === 'youtube') ? 155 : 0;

    this.hitEl.style.setProperty('--center-overlay-safe-top', `${safeTop}px`);
    this.hitEl.style.setProperty('--center-overlay-safe-bottom', `${safeBottom}px`);
    if (this.playerContainerEl instanceof HTMLElement) {
      this.playerContainerEl.style.setProperty('--center-overlay-safe-top', `${safeTop}px`);
      this.playerContainerEl.style.setProperty('--center-overlay-safe-bottom', `${safeBottom}px`);
    }

    // Let callers style based on adapter if desired.
    try { document.body.dataset.activeAdapter = (m || 'youtube'); } catch { /* ignore */ }

    this.updateLayout();
  }

  updateLayout() {
    if (!(this.hitEl instanceof HTMLElement)) return;
    if (!(this.panelEl instanceof HTMLElement)) return;

    // Icon sizing based on actual overlay height.
    let h = 0;
    try { h = this.hitEl.getBoundingClientRect().height; } catch { h = 0; }

    // Target: 1/6 of overlay height, clamped.
    const iconPx = Math.round(Math.max(32, Math.min(64, (h || 300) / 6)));
    this.panelEl.style.setProperty('--center-overlay-icon-size', `${iconPx}px`);

    // Keep toggle in sync (checked=true means sidebar visible).
    const hidden = !!this.isSidebarHidden();
    const b = this.buttons || {};
    if (b.sidebarToggleInput) {
      try {
        const wantsChecked = !hidden;
        if (b.sidebarToggleInput.checked !== wantsChecked) b.sidebarToggleInput.checked = wantsChecked;
      } catch { /* ignore */ }
    }
  }

  noteActivity() {
    this.setVisible(true);
    this._armHideTimer();
  }

  setVisible(visible) {
    if (!(this.hitEl instanceof HTMLElement)) return;
    if (!(this.panelEl instanceof HTMLElement)) return;
    const next = !!visible;
    if (this._visible === next) {
      if (next) this._armHideTimer();
      return;
    }
    this._visible = next;
    const v = next ? 'true' : 'false';
    this.hitEl.dataset.visible = v;
    this.panelEl.dataset.visible = v;
    this.hitEl.setAttribute('aria-hidden', next ? 'false' : 'true');
    this.panelEl.setAttribute('aria-hidden', next ? 'false' : 'true');

    const b = this.buttons || {};
    if (b.edgePrevBtn) b.edgePrevBtn.dataset.visible = v;
    if (b.edgeNextBtn) b.edgeNextBtn.dataset.visible = v;

    if (next) this.updateLayout();
  }

  _wrapClick(event, fn) {
    try { if (event) event.preventDefault(); } catch { /* ignore */ }
    try { if (event) event.stopPropagation(); } catch { /* ignore */ }
    this.noteActivity();
    try { fn(); } catch { /* ignore */ }
  }

  _wrapEdgeClick(event, fn) {
    try { if (event) event.preventDefault(); } catch { /* ignore */ }
    try { if (event) event.stopPropagation(); } catch { /* ignore */ }
    try { fn(); } catch { /* ignore */ }
  }

  _armHideTimer() {
    this._clearHideTimer();
    if (!this.hideAfterMs) return;
    this._hideTimer = setTimeout(() => {
      this.setVisible(false);
    }, this.hideAfterMs);
  }

  _clearHideTimer() {
    if (this._hideTimer) {
      clearTimeout(this._hideTimer);
      this._hideTimer = null;
    }
  }

  _onPointerEvent(event) {
    if (!event || event.defaultPrevented) return;
    const t = (event.target instanceof Element) ? event.target : null;
    if (!t) return;

    // Never reveal controls due to interactions on the invisible edge nav targets.
    if (t.closest('.cco-edge')) return;

    // Ignore interactions inside the sidebar drawer and overlays.
    if (this.sidebarDrawerEl && this.sidebarDrawerEl.contains(t)) return;
    if (t.closest('#alertOverlay')) return;
    if (t.closest('#playlistIOOverlay') || t.closest('.playlist-overlay-content')) return;
    if (t.closest('.track-details-overlay')) return;

    // Only show when interacting with the player surface.
    if (t.closest('#player-container') || t.closest('#player')) {
      if (!this._visible) {
        // When hidden: don't let the interaction fall through (best-effort).
        try {
          if (event.cancelable) event.preventDefault();
          if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
          event.stopPropagation();
        } catch { /* ignore */ }
      }
      this.noteActivity();
    }
  }

  _onPointerMove(event) {
    if (!event || event.defaultPrevented) return;
    if (this._visible) return;

    const t = (event.target instanceof Element) ? event.target : null;
    if (!t) return;

    // Don't reveal controls due to hover/move inside edge nav targets.
    if (t.closest('.cco-edge')) return;

    // Ignore hover inside drawers/overlays.
    if (this.sidebarDrawerEl && this.sidebarDrawerEl.contains(t)) return;
    if (t.closest('#alertOverlay')) return;
    if (t.closest('#playlistIOOverlay') || t.closest('.playlist-overlay-content')) return;
    if (t.closest('.track-details-overlay')) return;

    if (!(t.closest('#player-container') || t.closest('#player'))) return;

    // Throttle hover-triggered reveals.
    const now = Date.now();
    if (this._lastHoverShowAt && (now - this._lastHoverShowAt) < 200) return;
    this._lastHoverShowAt = now;
    this.noteActivity();
  }

  _onSidebarToggleChange(_event) {
    const b = this.buttons || {};
    const input = b.sidebarToggleInput;
    if (!(input instanceof HTMLInputElement)) return;

    // checked=true means sidebar visible.
    const wantsHidden = !input.checked;
    this.noteActivity();
    try { this.setSidebarHidden(wantsHidden, { force: true, source: 'center-overlay' }); } catch { /* ignore */ }
    this.updateLayout();
  }

  _onFocusIn(event) {
    const t = (event && event.target instanceof Element) ? event.target : null;
    if (!t) return;
    if (t instanceof HTMLElement && t.tagName === 'IFRAME') {
      if (t.closest('#player-container') || t.closest('#player')) {
        this.noteActivity();
      }
    }
  }

  _onKeydown(event) {
    if (!event || event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (isTextInputActive()) return;

    // Don't show overlay for pure modifier presses.
    const key = String(event.key || '');
    if (!key) return;

    this.noteActivity();
  }
}
