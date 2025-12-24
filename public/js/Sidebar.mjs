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
      const target = event.target;
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
        this.setHidden(false);
      };
      this.playerGestureLayer.addEventListener('pointerdown', showFromVideo, { passive: false });
      this.playerGestureLayer.addEventListener('click', showFromVideo, { passive: false });
    }

    // Any interaction while visible resets the inactivity timer.
    const bump = () => this.noteActivity();
    document.addEventListener('pointerdown', bump, { capture: true, passive: true });
    document.addEventListener('touchstart', bump, { capture: true, passive: true });
    document.addEventListener('keydown', bump, { capture: true });
    document.addEventListener('wheel', bump, { capture: true, passive: true });

    // Start the timer if the sidebar begins visible.
    this.noteActivity();
  }
}
