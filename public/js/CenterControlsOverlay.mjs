import { isTextInputActive } from './OverlayShared.mjs';

export class CenterControlsOverlay {
  constructor(options = {}) {
    const {
      overlayEl,
      hitEl,
      panelEl,
      playerContainerEl,
      sidebarDrawerEl,
      hideAfterMs = 5000,
      onActivity = () => {},
      onIdleHide = () => {},
      onPrev = () => {},
      onNext = () => {},
      onTogglePlayback = () => {},
      onToggleMarkTrack = () => {},
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

    this.onActivity = onActivity;
    this.onIdleHide = onIdleHide;

    this.onPrev = onPrev;
    this.onNext = onNext;
    this.onTogglePlayback = onTogglePlayback;
    this.onToggleMarkTrack = onToggleMarkTrack;

    this.getPlayerMode = getPlayerMode;
    this.isSidebarHidden = isSidebarHidden;
    this.setSidebarHidden = setSidebarHidden;

    this.buttons = buttons;

    this._visible = false;
    this._hideTimer = null;
    this._resizeObs = null;
    this._bodyClassObs = null;
    this._lastHoverShowAt = 0;

    this._mode = '';
    this._baseSafeTop = 0;
    this._baseSafeBottom = 0;

    this._availableLeft = 0;
    this._availableWidth = 0;
    this._canShowPanel = true;

    this._pillTopInPanelPx = null;

    this._boundOnPointer = (e) => this._onPointerEvent(e);
    this._boundOnPointerMove = (e) => this._onPointerMove(e);
    this._boundOnKeydown = (e) => this._onKeydown(e);
    this._boundOnFocusIn = (e) => this._onFocusIn(e);
    this._boundOnResize = () => this.updateLayout();
    this._boundOnSidebarToggleChange = (e) => this._onSidebarToggleChange(e);

    this._boundOnEdgePrevPointerDown = (e) => this._onEdgePointerDown(e, 'prev');
    this._boundOnEdgeNextPointerDown = (e) => this._onEdgePointerDown(e, 'next');
  }

  _onEdgePointerDown(event, which) {
    try {
      if (event && event.cancelable) event.preventDefault();
      if (event && typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      if (event) event.stopPropagation();
    } catch { /* ignore */ }

    this.noteActivity();
    if (which === 'prev') {
      try { this.onPrev(); } catch { /* ignore */ }
    } else {
      try { this.onNext(); } catch { /* ignore */ }
    }
  }

  _isMobileMode() {
    // Keep this aligned with the CSS “portrait/mobile” breakpoint used for the full-width sidebar.
    // Also treat coarse-pointer devices as mobile-ish for safer layout defaults.
    try {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
      const portraitMobile = window.matchMedia('(max-width: 800px) and (max-aspect-ratio: 2/3)').matches;
      const coarsePointer = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
      return portraitMobile || coarsePointer;
    } catch {
      return false;
    }
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
    if (b.markBtn) b.markBtn.addEventListener('click', (e) => this._wrapClick(e, () => this.onToggleMarkTrack()));
    // Edge buttons: always-active hit zones. Use pointerdown for reliability across browsers.
    if (b.edgePrevBtn) b.edgePrevBtn.addEventListener('pointerdown', this._boundOnEdgePrevPointerDown, { passive: false });
    if (b.edgeNextBtn) b.edgeNextBtn.addEventListener('pointerdown', this._boundOnEdgeNextPointerDown, { passive: false });

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
    if (b.edgePrevBtn) {
      try { b.edgePrevBtn.removeEventListener('pointerdown', this._boundOnEdgePrevPointerDown); } catch { /* ignore */ }
    }
    if (b.edgeNextBtn) {
      try { b.edgeNextBtn.removeEventListener('pointerdown', this._boundOnEdgeNextPointerDown); } catch { /* ignore */ }
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

    this._mode = m;

    // Respect YouTube's own UI stripes; other modes can use the full height.
    // NOTE: On some mobile layouts (notably iOS Safari with rotated/portrait hacks),
    // these bands can consume too much of the available height. We clamp them in
    // updateLayout() so the overlay stays visually centered.
    const isMobile = this._isMobileMode();
    const ytSafeScale = isMobile ? 0.1 : 1;
    this._baseSafeTop = (m === 'youtube') ? Math.round(70 * ytSafeScale) : 0;
    this._baseSafeBottom = (m === 'youtube') ? Math.round(155 * ytSafeScale) : 0;

    // Let callers style based on adapter if desired.
    try { document.body.dataset.activeAdapter = (m || 'youtube'); } catch { /* ignore */ }

    this.updateLayout();
  }

  updateLayout() {
    if (!(this.hitEl instanceof HTMLElement)) return;
    if (!(this.panelEl instanceof HTMLElement)) return;

    // Apply safe-area bands, but drop them if they'd leave too little vertical room.
    // This keeps the center overlay centered on small/tall mobile viewports.
    let containerHeight = 0;
    try {
      const el = (this.playerContainerEl instanceof HTMLElement) ? this.playerContainerEl : this.hitEl;
      containerHeight = el.getBoundingClientRect().height;
    } catch { containerHeight = 0; }

    // Compute the horizontal "available" region: the remaining player width not covered by the sidebar drawer.
    // The sidebar drawer is fixed-position and visually covers the left portion of the player.
    let containerWidth = 0;
    try {
      const el = (this.playerContainerEl instanceof HTMLElement) ? this.playerContainerEl : this.hitEl;
      containerWidth = el.getBoundingClientRect().width;
    } catch { containerWidth = 0; }

    let sidebarWidth = 0;
    try {
      const sidebarHidden = !!this.isSidebarHidden();
      if (!sidebarHidden && this.sidebarDrawerEl instanceof HTMLElement) {
        sidebarWidth = this.sidebarDrawerEl.getBoundingClientRect().width;
      }
    } catch { sidebarWidth = 0; }

    const availableLeft = Math.max(0, Math.round(sidebarWidth || 0));
    const availableWidth = Math.max(0, Math.round((containerWidth || 0) - availableLeft));
    this._availableLeft = availableLeft;
    this._availableWidth = availableWidth;

    // Hide the visible overlay UI entirely when the remaining space is too narrow.
    // Keep edge hit-zones active at all times.
    this._canShowPanel = !availableWidth || availableWidth >= 400;

    let safeTop = Number(this._baseSafeTop) || 0;
    let safeBottom = Number(this._baseSafeBottom) || 0;

    // If the remaining usable space would be tiny, ignore the band constraints.
    // (e.g., iPhone portrait/rotated layout)
    const MIN_USABLE_CENTER_PX = 260;
    if (containerHeight && (containerHeight - safeTop - safeBottom) < MIN_USABLE_CENTER_PX) {
      safeTop = 0;
      safeBottom = 0;
    }

    try {
      this.hitEl.style.setProperty('--center-overlay-safe-top', `${safeTop}px`);
      this.hitEl.style.setProperty('--center-overlay-safe-bottom', `${safeBottom}px`);
      this.hitEl.style.setProperty('--cco-available-left', `${availableLeft}px`);
      this.hitEl.style.setProperty('--cco-available-width', availableWidth ? `${availableWidth}px` : '100%');
    } catch { /* ignore */ }
    if (this.playerContainerEl instanceof HTMLElement) {
      try {
        this.playerContainerEl.style.setProperty('--center-overlay-safe-top', `${safeTop}px`);
        this.playerContainerEl.style.setProperty('--center-overlay-safe-bottom', `${safeBottom}px`);
        this.playerContainerEl.style.setProperty('--cco-available-left', `${availableLeft}px`);
        this.playerContainerEl.style.setProperty('--cco-available-width', availableWidth ? `${availableWidth}px` : '100%');
      } catch { /* ignore */ }
    }
    try {
      this.panelEl.style.setProperty('--cco-available-left', `${availableLeft}px`);
      this.panelEl.style.setProperty('--cco-available-width', availableWidth ? `${availableWidth}px` : '100%');
    } catch { /* ignore */ }

    // If too narrow, force the visible overlay UI hidden and keep the player surface interactive.
    if (!this._canShowPanel) {
      this._clearHideTimer();
      this._visible = false;
      try {
        // Ensure the visible panel is hidden.
        this.panelEl.dataset.visible = 'false';
        this.panelEl.setAttribute('aria-hidden', 'true');
        // Ensure the full-size hit layer does NOT intercept player interactions.
        this.hitEl.dataset.visible = 'true';
        this.hitEl.setAttribute('aria-hidden', 'true');
      } catch { /* ignore */ }
      return;
    }

    // Icon sizing based on actual overlay height (after safe-area is applied).
    let h = 0;
    try { h = this.hitEl.getBoundingClientRect().height; } catch { h = 0; }

    // Target: 1/6 of overlay height, clamped.
    const iconPx = Math.round(Math.max(32, Math.min(64, (h || 300) / 6)));
    this.panelEl.style.setProperty('--center-overlay-icon-size', `${iconPx}px`);

    // Expose the top of the bottom pill (progress/title cluster) so CSS can size the middle play hit zone.
    try {
      const pillEl = this.panelEl.querySelector('.cco-progress');
      const panelRect = this.panelEl.getBoundingClientRect();
      if (pillEl instanceof HTMLElement && panelRect && panelRect.height) {
        const pillRect = pillEl.getBoundingClientRect();
        const pillTop = Math.max(0, Math.min(panelRect.height, Math.round(pillRect.top - panelRect.top)));
        this.panelEl.style.setProperty('--cco-pill-top', `${pillTop}px`);
        this._pillTopInPanelPx = pillTop;
        if (this.playerContainerEl instanceof HTMLElement) {
          try { this.playerContainerEl.style.setProperty('--cco-pill-top', `${pillTop}px`); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }

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
    this._noteActivity({ showOverlay: true });
  }

  _noteActivity(options = {}) {
    const showOverlay = options && options.showOverlay !== false;
    try { this.onActivity(); } catch { /* ignore */ }
    if (showOverlay) this.setVisible(true);
    else this._armHideTimer();
  }

  setVisible(visible) {
    if (!(this.hitEl instanceof HTMLElement)) return;
    if (!(this.panelEl instanceof HTMLElement)) return;

    // If the visible UI is disabled due to narrow width, keep it hidden.
    if (!!visible && !this._canShowPanel) {
      this._clearHideTimer();
      this._visible = false;
      try {
        this.panelEl.dataset.visible = 'false';
        this.panelEl.setAttribute('aria-hidden', 'true');
        // Don't block interactions with the player surface.
        this.hitEl.dataset.visible = 'true';
        this.hitEl.setAttribute('aria-hidden', 'true');
      } catch { /* ignore */ }
      return;
    }
    const next = !!visible;
    const v = next ? 'true' : 'false';

    // Keep DOM state authoritative: if attributes drift (e.g., from DOM mutations),
    // re-sync even when our internal flag already matches.
    const needsSync = (this.hitEl.dataset.visible !== v) || (this.panelEl.dataset.visible !== v);
    if (this._visible === next && !needsSync) {
      if (next) this._armHideTimer();
      return;
    }

    this._visible = next;
    this.hitEl.dataset.visible = v;
    this.panelEl.dataset.visible = v;
    this.hitEl.setAttribute('aria-hidden', next ? 'false' : 'true');
    this.panelEl.setAttribute('aria-hidden', next ? 'false' : 'true');

    const b = this.buttons || {};
    // Edge hit-zones should remain active at all times.

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
    this.noteActivity();
    try { fn(); } catch { /* ignore */ }
  }

  _armHideTimer() {
    this._clearHideTimer();
    if (!this.hideAfterMs) return;
    this._hideTimer = setTimeout(() => {
      this.setVisible(false);
      try { this.onIdleHide(); } catch { /* ignore */ }
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

    // Middle-click hides the controls immediately (with transition).
    // Use pointerdown so it works reliably across browsers.
    const isMiddleClick = (typeof event.button === 'number') && event.button === 1;
    if (isMiddleClick) {
      if (t.closest('#player-container') || t.closest('#player') || t.closest('#cursorWakeOverlay') || (this.panelEl instanceof HTMLElement && this.panelEl.contains(t))) {
        try {
          if (event.cancelable) event.preventDefault();
          if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
          event.stopPropagation();
        } catch { /* ignore */ }
        this._clearHideTimer();
        this.setVisible(false);
        try { this.onIdleHide(); } catch { /* ignore */ }
      }
      return;
    }

    // Edge nav targets should also reveal the overlay.
    if (t.closest('.cco-edge')) {
      this.noteActivity();
      return;
    }

    // Ignore interactions inside the sidebar drawer and overlays.
    if (this.sidebarDrawerEl && this.sidebarDrawerEl.contains(t)) {
      this._noteActivity({ showOverlay: false });
      return;
    }
    if (t.closest('#alertOverlay')) {
      this._noteActivity({ showOverlay: false });
      return;
    }
    if (t.closest('#playlistIOOverlay') || t.closest('.playlist-overlay-content')) {
      this._noteActivity({ showOverlay: false });
      return;
    }
    if (t.closest('.track-details-overlay')) {
      this._noteActivity({ showOverlay: false });
      return;
    }

    // Only show when interacting with the player surface.
    if (t.closest('#player-container') || t.closest('#player') || t.closest('#cursorWakeOverlay')) {
      // If the click falls inside the middle third zone, toggle play/pause.
      // This is active at all times (even when the visible overlay UI is hidden).
      // Avoid interfering with clicks on the visible overlay UI itself.
      if (this.panelEl instanceof HTMLElement && !this.panelEl.contains(t)) {
        try {
          const containerEl = (this.playerContainerEl instanceof HTMLElement) ? this.playerContainerEl : this.hitEl;
          const rect = containerEl.getBoundingClientRect();
          const x = typeof event.clientX === 'number' ? event.clientX : null;
          const y = typeof event.clientY === 'number' ? event.clientY : null;
          if (rect && x !== null && y !== null) {
            const safeTop = Number(this._baseSafeTop) || 0;
            const safeBottom = Number(this._baseSafeBottom) || 0;
            const safeH = Math.max(0, rect.height - safeTop - safeBottom);

            const availLeft = Number(this._availableLeft) || 0;
            const availW = Number(this._availableWidth) || rect.width;
            const x0 = rect.left + availLeft;
            const x1 = x0 + availW;

            const midL = x0 + (availW / 3);
            const midR = x0 + (availW * 2 / 3);

            const zoneTop = rect.top + safeTop + (safeH * 0.15);
            let zoneBottom = rect.top + safeTop + (safeH * 0.85);
            if (typeof this._pillTopInPanelPx === 'number') {
              const panelRect = this.panelEl.getBoundingClientRect();
              const pillTopAbs = panelRect.top + this._pillTopInPanelPx;
              zoneBottom = Math.min(zoneBottom, pillTopAbs);
            }

            const inMiddle = x >= midL && x <= midR && x >= x0 && x <= x1;
            const inY = y >= zoneTop && y <= zoneBottom;
            if (inMiddle && inY) {
              // Best-effort prevent the click from reaching the underlying player.
              try {
                if (event.cancelable) event.preventDefault();
                if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
                event.stopPropagation();
              } catch { /* ignore */ }

              this.noteActivity();
              try { this.onTogglePlayback(); } catch { /* ignore */ }
              return;
            }
          }
        } catch { /* ignore */ }
      }

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

    const t = (event.target instanceof Element) ? event.target : null;
    if (!t) return;

    // When hidden, don't reveal controls due to movement inside the panel region.
    // The panel stays in layout even when hidden (opacity/pointer-events), so we can
    // use its bounding box as an exclusion zone.
    if (!this._visible && this.panelEl instanceof HTMLElement && typeof event.clientX === 'number' && typeof event.clientY === 'number') {
      try {
        const r = this.panelEl.getBoundingClientRect();
        if (event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom) {
          return;
        }
      } catch { /* ignore */ }
    }

    // Don't reveal controls due to hover/move inside edge nav targets.
    if (t.closest('.cco-edge')) {
      this._noteActivity({ showOverlay: false });
      return;
    }

    // Ignore hover inside drawers/overlays.
    if (this.sidebarDrawerEl && this.sidebarDrawerEl.contains(t)) {
      this._noteActivity({ showOverlay: false });
      return;
    }
    if (t.closest('#alertOverlay')) {
      this._noteActivity({ showOverlay: false });
      return;
    }
    if (t.closest('#playlistIOOverlay') || t.closest('.playlist-overlay-content')) {
      this._noteActivity({ showOverlay: false });
      return;
    }
    if (t.closest('.track-details-overlay')) {
      this._noteActivity({ showOverlay: false });
      return;
    }

    if (!(t.closest('#player-container') || t.closest('#player') || t.closest('#cursorWakeOverlay'))) return;

    // If already visible, treat movement as activity to keep it visible.
    if (this._visible) {
      this._noteActivity({ showOverlay: false });
      return;
    }

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

    // Ignore visualizer cycling keys so they don't surface the overlay.
    if (
      event.code === 'NumpadAdd'
      || event.code === 'NumpadSubtract'
      || event.code === 'Digit1'
      || event.code === 'Digit2'
      || event.key === '1'
      || event.key === '2'
    ) return;

    // Don't show overlay for pure modifier presses.
    const key = String(event.key || '');
    if (!key) return;

    // X hides the overlay immediately (same behavior as middle-click).
    if (key === 'x' || key === 'X') {
      try {
        if (event.cancelable) event.preventDefault();
        if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
        event.stopPropagation();
      } catch { /* ignore */ }
      this._clearHideTimer();
      this.setVisible(false);
      try { this.onIdleHide(); } catch { /* ignore */ }
      return;
    }

    this.noteActivity();
  }
}
