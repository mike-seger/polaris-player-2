import {
  installOverlayListKeydownHandler,
  scheduleScrollFirstSelectedOptionIntoView,
} from './OverlayShared.mjs';

export class CombinedFilterOverlay {
  constructor(options = {}) {
    const {
      buttonEl = null,
      overlayEl = null,
      wrapperEl = null,
      filterInputEl = null,

      artistOptionsEl = null,
      countryOptionsEl = null,

      onBeforeOpen = () => {},

      getIsEffectivelyFiltering = null,

      getArtistFilters = () => [],
      getCountryFilters = () => [],

      updateArtistOptions = () => {},
      updateCountryOptions = () => {},

      onArtistTypeaheadChar = () => {},
      onCountryTypeaheadChar = () => {},
    } = options;

    this.buttonEl = buttonEl;
    this.overlayEl = overlayEl;
    this.wrapperEl = wrapperEl;
    this.filterInputEl = filterInputEl;

    this.artistOptionsEl = artistOptionsEl;
    this.countryOptionsEl = countryOptionsEl;

    this.onBeforeOpen = typeof onBeforeOpen === 'function' ? onBeforeOpen : () => {};

    this.getIsEffectivelyFiltering = typeof getIsEffectivelyFiltering === 'function' ? getIsEffectivelyFiltering : null;

    this.getArtistFilters = typeof getArtistFilters === 'function' ? getArtistFilters : () => [];
    this.getCountryFilters = typeof getCountryFilters === 'function' ? getCountryFilters : () => [];

    this.updateArtistOptions = typeof updateArtistOptions === 'function' ? updateArtistOptions : () => {};
    this.updateCountryOptions = typeof updateCountryOptions === 'function' ? updateCountryOptions : () => {};

    this.onArtistTypeaheadChar = typeof onArtistTypeaheadChar === 'function' ? onArtistTypeaheadChar : () => {};
    this.onCountryTypeaheadChar = typeof onCountryTypeaheadChar === 'function' ? onCountryTypeaheadChar : () => {};

    this.visible = false;
    this.activeList = 'artist';

    this._lastPointerDownInsideTs = 0;
    this._handleDocumentPointerDown = (event) => {
      if (!this.isVisible()) return;
      if (!this.wrapperEl) return;
      if (event.target instanceof Node && this.wrapperEl.contains(event.target)) {
        this._lastPointerDownInsideTs = Date.now();
      }
    };

    this.handleOutsideClick = (event) => {
      if (!this.isVisible()) return;
      if (Date.now() - this._lastPointerDownInsideTs < 750) return;
      if (this.wrapperEl && this.wrapperEl.contains(event.target)) return;
      this.close();
    };

    this.removeKeydownHandler = null;
  }

  isVisible() {
    return !!this.visible;
  }

  updateButtonState() {
    if (!this.buttonEl) return;
    let active = false;
    if (this.getIsEffectivelyFiltering) {
      try {
        active = !!this.getIsEffectivelyFiltering();
      } catch {
        active = false;
      }
    } else {
      const artist = this.getArtistFilters();
      const country = this.getCountryFilters();
      active = (Array.isArray(artist) && artist.length > 0) || (Array.isArray(country) && country.length > 0);
    }
    this.buttonEl.classList.toggle('active', active);
    this.buttonEl.setAttribute('aria-expanded', String(this.isVisible()));
    this.buttonEl.setAttribute('aria-pressed', String(this.isVisible()));
  }

  _setActiveListFromEventTarget(target) {
    const t = target instanceof Element ? target : null;
    if (!t) return;
    if (this.artistOptionsEl && this.artistOptionsEl.contains(t)) {
      this.activeList = 'artist';
      return;
    }
    if (this.countryOptionsEl && this.countryOptionsEl.contains(t)) {
      this.activeList = 'country';
    }
  }

  open() {
    if (!this.overlayEl) return;
    this.onBeforeOpen();

    this.updateArtistOptions();
    this.updateCountryOptions();

    this.overlayEl.classList.add('visible');
    this.overlayEl.setAttribute('aria-hidden', 'false');
    this.visible = true;
    this.updateButtonState();

    if (this.artistOptionsEl) scheduleScrollFirstSelectedOptionIntoView(this.artistOptionsEl);
    if (this.countryOptionsEl) scheduleScrollFirstSelectedOptionIntoView(this.countryOptionsEl);
  }

  close(options = {}) {
    if (!this.overlayEl) return;
    this.overlayEl.classList.remove('visible');
    this.overlayEl.setAttribute('aria-hidden', 'true');
    this.visible = false;
    this.updateButtonState();

    if (options.focusButton && this.buttonEl && typeof this.buttonEl.focus === 'function') {
      this.buttonEl.focus({ preventScroll: true });
    }
  }

  toggle() {
    if (this.isVisible()) {
      this.close();
    } else {
      this.open();
    }
  }

  setup() {
    if (this.buttonEl) {
      this.buttonEl.addEventListener('click', (event) => {
        event.stopPropagation();
        this.toggle();
      });
    }

    if (this.overlayEl) {
      this.overlayEl.addEventListener('click', (event) => {
        event.stopPropagation();
        this._setActiveListFromEventTarget(event.target);
      });

      this.overlayEl.addEventListener('pointerdown', (event) => {
        this._setActiveListFromEventTarget(event.target);
      }, { passive: true });

      this.overlayEl.addEventListener('focusin', (event) => {
        this._setActiveListFromEventTarget(event.target);
      });
    }

    document.addEventListener('pointerdown', this._handleDocumentPointerDown, { capture: true, passive: true });
    document.addEventListener('mousedown', this._handleDocumentPointerDown, { capture: true, passive: true });
    document.addEventListener('click', this.handleOutsideClick);

    if (!this.removeKeydownHandler) {
      this.removeKeydownHandler = installOverlayListKeydownHandler({
        isOverlayVisible: () => this.isVisible(),
        getOptionsEl: () => (this.activeList === 'country' ? this.countryOptionsEl : this.artistOptionsEl),
        filterInputEl: this.filterInputEl,
        onTypeaheadChar: (key) => {
          if (this.activeList === 'country') {
            this.onCountryTypeaheadChar(key);
          } else {
            this.onArtistTypeaheadChar(key);
          }
        },
      });
    }

    this.updateButtonState();
  }
}
