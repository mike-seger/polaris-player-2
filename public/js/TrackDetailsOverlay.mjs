export class TrackDetailsOverlay {
  constructor(options = {}) {
    const {
      wrapperEl,
      overlayEl,
      toggleButtonEl,
      toggleIconEl,
      checkboxMap,

      defaults,

      getPreferences,
      setPreferences,
      persistPreferences,

      getSortAlphabetically,
      setSortAlphabetically,

      renderTrackList,

      onBeforeOpen,
    } = options;

    this.wrapperEl = wrapperEl;
    this.overlayEl = overlayEl;
    this.toggleButtonEl = toggleButtonEl;
    this.toggleIconEl = toggleIconEl;
    this.checkboxMap = checkboxMap || {};

    this.defaults = defaults || {};

    this.getPreferences = typeof getPreferences === 'function' ? getPreferences : () => ({ ...this.defaults });
    this.setPreferences = typeof setPreferences === 'function' ? setPreferences : (next) => next;
    this.persistPreferences = typeof persistPreferences === 'function' ? persistPreferences : (next) => next;

    this.getSortAlphabetically = typeof getSortAlphabetically === 'function' ? getSortAlphabetically : () => false;
    this.setSortAlphabetically = typeof setSortAlphabetically === 'function' ? setSortAlphabetically : (next) => next;

    this.renderTrackList = typeof renderTrackList === 'function' ? renderTrackList : () => {};

    this.onBeforeOpen = typeof onBeforeOpen === 'function' ? onBeforeOpen : () => {};

    this.visible = false;

    this._lastPointerDownInsideTs = 0;
    this._handleDocumentPointerDown = (event) => {
      if (!this.visible) return;
      if (!this.wrapperEl) return;
      if (event.target instanceof Node && this.wrapperEl.contains(event.target)) {
        this._lastPointerDownInsideTs = Date.now();
      }
    };
  }

  isVisible() {
    return !!this.visible;
  }

  applyPreferences(options = {}) {
    const { refreshThumbnails = false, preserveScroll = true } = options || {};

    const prefs = this.getPreferences() || this.defaults || {};
    document.body.classList.toggle('hide-track-number', !prefs.trackNumber);
    document.body.classList.toggle('no-thumbs', !prefs.thumbnail);
    document.body.classList.toggle('no-wrap-lines', !prefs.wrapLines);
    document.body.classList.toggle('show-track-country', !!prefs.country);
    document.body.classList.toggle('hide-track-check', !prefs.checkTrack);

    const nextSort = !!prefs.sortAZ;
    const sortChanged = this.getSortAlphabetically() !== nextSort;
    if (sortChanged) {
      this.setSortAlphabetically(nextSort);
      this.renderTrackList({ preserveScroll, skipActiveScroll: preserveScroll });
    }

    if (refreshThumbnails) {
      this.renderTrackList({ preserveScroll, skipActiveScroll: preserveScroll });
    }
  }

  syncControls() {
    const prefs = this.getPreferences() || this.defaults || {};
    Object.entries(this.checkboxMap).forEach(([key, checkbox]) => {
      if (!checkbox) return;
      checkbox.checked = !!prefs[key];
    });
  }

  updateToggleButtonState() {
    const btn = this.toggleButtonEl;
    const icon = this.toggleIconEl;
    if (!btn || !icon) return;

    btn.setAttribute('aria-expanded', String(this.visible));
    btn.setAttribute('aria-pressed', String(this.visible));
    btn.setAttribute('aria-label', 'Track details');
    btn.title = 'Track details';
    btn.classList.toggle('active', this.visible);
    icon.className = 'icon tune';
    icon.textContent = 'tune';
  }

  open() {
    if (!this.overlayEl) return;

    this.onBeforeOpen();
    this.syncControls();

    this.overlayEl.classList.add('visible');
    this.overlayEl.setAttribute('aria-hidden', 'false');
    this.visible = true;
    this.updateToggleButtonState();
  }

  close(options = {}) {
    if (!this.overlayEl) return;

    this.overlayEl.classList.remove('visible');
    this.overlayEl.setAttribute('aria-hidden', 'true');
    this.visible = false;
    this.updateToggleButtonState();

    if (options && options.focusButton && this.toggleButtonEl && typeof this.toggleButtonEl.focus === 'function') {
      this.toggleButtonEl.focus({ preventScroll: true });
    }
  }

  toggle() {
    if (this.visible) {
      this.close();
    } else {
      this.open();
    }
  }

  setup() {
    if (this.toggleButtonEl) {
      this.toggleButtonEl.addEventListener('click', (event) => {
        event.stopPropagation();
        this.toggle();
      });
    }

    if (this.overlayEl) {
      this.overlayEl.addEventListener('click', (event) => {
        event.stopPropagation();
      });
    }

    document.addEventListener('pointerdown', this._handleDocumentPointerDown, { capture: true, passive: true });
    document.addEventListener('mousedown', this._handleDocumentPointerDown, { capture: true, passive: true });

    document.addEventListener('click', (event) => {
      if (!this.visible) return;
      if (Date.now() - this._lastPointerDownInsideTs < 750) return;
      if (this.wrapperEl && this.wrapperEl.contains(event.target)) return;
      this.close();
    });

    Object.entries(this.checkboxMap).forEach(([key, checkbox]) => {
      if (!checkbox) return;
      checkbox.addEventListener('change', () => {
        const current = this.getPreferences() || this.defaults || {};
        const next = { ...current, [key]: checkbox.checked };
        this.setPreferences(next);

        const shouldRerenderList = key === 'thumbnail' || key === 'showFiltered';
        this.applyPreferences({ refreshThumbnails: shouldRerenderList, preserveScroll: true });

        this.persistPreferences(next);
      });
    });

    this.updateToggleButtonState();
  }
}
