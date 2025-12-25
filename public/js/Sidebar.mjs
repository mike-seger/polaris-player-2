export class Sidebar {
  constructor(options = {}) {
    const {
      sidebarMenuBtn = null,
      sidebarDrawer = null,
      playerGestureLayer = null,
      isInteractionBlockingHide = () => false,
      isAutoHideEnabled = () => true,
      allowScrollSelectors = [],
    } = options;

    this.sidebarMenuBtn = sidebarMenuBtn;
    this.sidebarDrawer = sidebarDrawer;
    this.playerGestureLayer = playerGestureLayer;
    this.isInteractionBlockingHide = isInteractionBlockingHide;
    this.isAutoHideEnabled = (typeof isAutoHideEnabled === 'function') ? isAutoHideEnabled : (() => true);
    this.allowScrollSelectors = Array.isArray(allowScrollSelectors) ? allowScrollSelectors : [];

    this.SIDEBAR_AUTO_HIDE_MS = 80000;
    this.sidebarInactivityInterval = null;
    this.sidebarLastActivityTs = 0;
    this.sidebarHideSuppressedUntil = 0;

    this.lastPointerTs = 0;
    this.lastPointerWasInDrawer = false;
    this.lastPointerWasInPlayer = false;

    this.isIOS = Sidebar.detectIOS();
  }

  static detectIOS() {
    const ua = navigator.userAgent || '';
    const platform = navigator.platform || '';
    const isAppleMobile = /iP(hone|od|ad)/.test(ua);
    const isIpadOS = platform === 'MacIntel' && navigator.maxTouchPoints > 1;
    return isAppleMobile || isIpadOS;
  }

  suppressHide(ms = 1500) {
    const until = Date.now() + Math.max(0, ms || 0);
    if (until > this.sidebarHideSuppressedUntil) this.sidebarHideSuppressedUntil = until;
  }

  isHidden() {
    return document.body.classList.contains('sidebar-hidden');
  }

  setHidden(hidden) {
    const wantsHidden = !!hidden;
    document.body.classList.toggle('sidebar-hidden', wantsHidden);
    document.body.classList.remove('sidebar-collapsed');
    if (wantsHidden) {
      this.clearInactivityInterval();
      return;
    }
    this.sidebarLastActivityTs = Date.now();
    this.ensureInactivityInterval();
  }

  maybeHideFromPlayerStateChange(playerState) {
    if (!this.isAutoHideEnabled()) return;
    if (this.isHidden()) return;
    if (this.isInteractionBlockingHide()) return;
    if (Date.now() < this.sidebarHideSuppressedUntil) return;

    // Only hide the sidebar in response to player state changes when a recent
    // pointer interaction happened in the player surface (e.g., YouTube iframe).
    // This prevents routine state polling (especially Spotify) from collapsing
    // the sidebar while the user is interacting with controls like <select>.
    const now = Date.now();
    if (!this.lastPointerTs || (now - this.lastPointerTs) > 5000) return;
    if (this.lastPointerWasInDrawer) return;
    if (!this.lastPointerWasInPlayer) return;

    // Accept either generic string states (PlayerHost) or legacy numeric YT states.
    const s = playerState;
    const isActiveString = s === 'playing' || s === 'paused' || s === 'buffering';
    // YT IFrame numeric constants: PLAYING=1, PAUSED=2, BUFFERING=3
    const isActiveNumeric = s === 1 || s === 2 || s === 3;
    if (isActiveString || isActiveNumeric) this.setHidden(true);
  }

  clearInactivityInterval() {
    if (this.sidebarInactivityInterval) {
      clearInterval(this.sidebarInactivityInterval);
      this.sidebarInactivityInterval = null;
    }
  }

  ensureInactivityInterval() {
    if (!this.isAutoHideEnabled()) {
      this.clearInactivityInterval();
      return;
    }
    if (this.sidebarInactivityInterval) return;
    this.sidebarInactivityInterval = setInterval(() => {
      if (!this.isAutoHideEnabled()) {
        this.clearInactivityInterval();
        return;
      }
      if (this.isHidden()) {
        this.clearInactivityInterval();
        return;
      }
      if (!this.sidebarLastActivityTs) this.sidebarLastActivityTs = Date.now();
      if (Date.now() - this.sidebarLastActivityTs >= this.SIDEBAR_AUTO_HIDE_MS) {
        this.setHidden(true);
      }
    }, 500);
  }

  noteActivity() {
    if (this.isHidden()) return;
    if (!this.isAutoHideEnabled()) {
      this.clearInactivityInterval();
      return;
    }
    this.sidebarLastActivityTs = Date.now();
    this.ensureInactivityInterval();
  }

  shouldAllowScrollTarget(target) {
    if (!target) return false;
    for (const selector of this.allowScrollSelectors) {
      try {
        if (target.closest(selector)) return true;
      } catch {
        // ignore invalid selectors
      }
    }
    return false;
  }

  installIOSTouchScrollLock() {
    if (!this.isIOS) return;

    document.addEventListener('touchmove', (event) => {
      if (event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;

      // Allow normal scrolling in scrollable UI surfaces.
      if (this.shouldAllowScrollTarget(target)) {
        return;
      }

      // Prevent iOS page scroll/bounce when touching the player/iframe area.
      if (target.closest('#player-container') || target.closest('#player')) {
        event.preventDefault();
      }
    }, { passive: false });
  }

  setup() {
    this.installIOSTouchScrollLock();

    // Menu button hides the sidebar.
    if (this.sidebarMenuBtn) {
      this.sidebarMenuBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.setHidden(true);
      });
    }

    // Clicking outside the drawer hides it, but must NOT block or swallow the click,
    // so the YouTube iframe still receives it.
    const hideFromOutside = (event) => {
      if (this.isHidden()) return;
      if (!this.sidebarDrawer) return;

      // Playlist/Settings overlay is rendered outside the drawer (attached to <body>),
      // but should still count as an "inside" interaction.
      const tEl = (event && event.target instanceof Element) ? event.target : null;
      if (tEl && (tEl.closest('#playlistIOOverlay') || tEl.closest('.playlist-overlay-content'))) {
        return;
      }

      // iOS (and some browsers) can dispatch pointer events with surprising targets
      // (e.g. document/body/html) when native UI (keyboard, select dropdown) appears.
      // If a form field inside the drawer is focused, treat ambiguous targets as inside
      // so the drawer doesn't immediately slide away while typing.
      const activeEl = document.activeElement;
      const isFocusedFieldInDrawer = (() => {
        if (!(activeEl instanceof HTMLElement)) return false;
        if (!this.sidebarDrawer.contains(activeEl)) return false;
        const tag = String(activeEl.tagName || '').toUpperCase();
        if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA') return true;
        if (activeEl.isContentEditable) return true;
        return false;
      })();

      const target = event.target;
      if (isFocusedFieldInDrawer) {
        // Only ignore events whose targets don't clearly indicate an outside click.
        // This keeps normal outside taps working, but prevents iOS keyboard/focus quirks
        // from closing the drawer.
        if (!(target instanceof Node)) return;
        if (target === document.body || target === document.documentElement) return;
      }
      if (target instanceof Node && this.sidebarDrawer.contains(target)) return;
      this.setHidden(true);
    };
    document.addEventListener('pointerdown', hideFromOutside, { capture: true, passive: true });

    // Clicks inside cross-origin iframes don't bubble to the parent document.
    // Best-effort: when the YouTube iframe gains focus, treat it as an outside interaction.
    const hideFromIframeFocus = (event) => {
      if (this.isHidden()) return;
      if (!this.sidebarDrawer) return;
      const target = event.target;
      if (target instanceof Node && this.sidebarDrawer.contains(target)) return;
      if (!(target instanceof HTMLElement)) return;
      if (target.tagName !== 'IFRAME') return;
      this.setHidden(true);
    };
    document.addEventListener('focusin', hideFromIframeFocus, { capture: true });

    // When hidden, a tap/click on the video shows the sidebar.
    if (this.playerGestureLayer) {
      const showFromVideo = (event) => {
        if (!this.isHidden()) return;
        event.preventDefault();
        event.stopPropagation();
        // In fullscreen, revealing the sidebar is itself a player-surface interaction.
        // Don't immediately auto-hide again on the next player state poll/change.
        this.suppressHide(5000);
        this.lastPointerTs = 0;
        this.lastPointerWasInDrawer = false;
        this.lastPointerWasInPlayer = false;
        this.setHidden(false);
      };
      this.playerGestureLayer.addEventListener('pointerdown', showFromVideo, { passive: false });
      this.playerGestureLayer.addEventListener('click', showFromVideo, { passive: false });
    }

    // Any interaction while visible resets the inactivity timer.
    const bumpPointer = (event) => {
      this.noteActivity();
      this.lastPointerTs = Date.now();

      const target = (event && event.target instanceof Element) ? event.target : null;
      if (!target) {
        this.lastPointerWasInDrawer = false;
        this.lastPointerWasInPlayer = false;
        return;
      }

      this.lastPointerWasInDrawer = !!(this.sidebarDrawer && target instanceof Node && this.sidebarDrawer.contains(target));
      this.lastPointerWasInPlayer = !!(
        target.closest('#player-container')
        || target.closest('#player')
        || (target instanceof HTMLElement && target.tagName === 'IFRAME')
      );
    };
    const bump = () => this.noteActivity();

    document.addEventListener('pointerdown', bumpPointer, { capture: true, passive: true });
    document.addEventListener('touchstart', bumpPointer, { capture: true, passive: true });
    document.addEventListener('keydown', bump, { capture: true });
    document.addEventListener('wheel', bump, { capture: true, passive: true });

    // Start the timer if the sidebar begins visible.
    this.noteActivity();
  }
}
