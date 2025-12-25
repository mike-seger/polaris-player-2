import {
  installOverlayListKeydownHandler,
  scheduleScrollFirstSelectedOptionIntoView,
} from './OverlayShared.mjs';

export class CountryFilterOverlay {
  constructor(options = {}) {
    const {
      buttonEl = null,
      overlayEl = null,
      wrapperEl = null,
      optionsEl = null,
      filterInputEl = null,

      onBeforeOpen = () => {},

      getPlaylistItems = () => [],
      getFilters = () => [],
      setFilters = (next) => next,
      onFiltersChanged = () => {},

      normalizeIso3 = (code) => (code || '').trim().toUpperCase(),
      normalizeCountryFilterList = (list) => (Array.isArray(list) ? list : []),
      splitCountryCodes = () => [],

      makeSortKey = (s) => String(s || ''),
      getFlagEmojiForIso3 = () => '',
    } = options;

    this.buttonEl = buttonEl;
    this.overlayEl = overlayEl;
    this.wrapperEl = wrapperEl;
    this.optionsEl = optionsEl;
    this.filterInputEl = filterInputEl;

    this.onBeforeOpen = typeof onBeforeOpen === 'function' ? onBeforeOpen : () => {};

    this.getPlaylistItems = typeof getPlaylistItems === 'function' ? getPlaylistItems : () => [];
    this.getFilters = typeof getFilters === 'function' ? getFilters : () => [];
    this.setFilters = typeof setFilters === 'function' ? setFilters : (next) => next;
    this.onFiltersChanged = typeof onFiltersChanged === 'function' ? onFiltersChanged : () => {};

    this.normalizeIso3 = normalizeIso3;
    this.normalizeCountryFilterList = normalizeCountryFilterList;
    this.splitCountryCodes = splitCountryCodes;

    this.makeSortKey = makeSortKey;
    this.getFlagEmojiForIso3 = getFlagEmojiForIso3;

    this.visible = false;
    this.sortMode = 'az';

    this.removeKeydownHandler = null;

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
      });
    }

    document.addEventListener('pointerdown', this._handleDocumentPointerDown, { capture: true, passive: true });
    document.addEventListener('mousedown', this._handleDocumentPointerDown, { capture: true, passive: true });
    document.addEventListener('click', this.handleOutsideClick);

    if (!this.removeKeydownHandler) {
      this.removeKeydownHandler = installOverlayListKeydownHandler({
        isOverlayVisible: () => this.isVisible(),
        getOptionsEl: () => this.optionsEl,
        filterInputEl: this.filterInputEl,
        onTypeaheadChar: (key) => this.handleTypeaheadChar(key),
      });
    }

    this.updateOptions();
    this.updateButtonState();
  }

  isVisible() {
    return !!this.visible;
  }

  updateButtonState() {
    if (!this.buttonEl) return;
    const filters = this.getFilters();
    const active = Array.isArray(filters) && filters.length > 0;
    this.buttonEl.classList.toggle('active', active);
    this.buttonEl.setAttribute('aria-expanded', String(this.isVisible()));
    this.buttonEl.setAttribute('aria-pressed', String(this.isVisible()));
  }

  open() {
    if (!this.overlayEl) return;
    this.onBeforeOpen();

    this.updateOptions();

    this.overlayEl.classList.add('visible');
    this.overlayEl.setAttribute('aria-hidden', 'false');
    this.visible = true;
    this.updateButtonState();

    if (this.optionsEl) {
      scheduleScrollFirstSelectedOptionIntoView(this.optionsEl);
    }
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

  collectCounts() {
    const counts = new Map();
    (this.getPlaylistItems() || []).forEach((item) => {
      const codes = this.splitCountryCodes(item && typeof item === 'object' ? item.country : '');
      if (!codes.length) {
        counts.set('?', (counts.get('?') || 0) + 1);
        return;
      }

      // Count each track once per country code.
      const uniq = new Set(codes);
      uniq.forEach((code) => {
        counts.set(code, (counts.get(code) || 0) + 1);
      });
    });

    const codes = Array.from(counts.keys())
      .filter((c) => c !== '?')
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    if (counts.has('?')) {
      codes.unshift('?');
    }

    return { codes, counts };
  }

  getFlagEmoji(iso3) {
    if (iso3 === '?') return '🏳️';
    return this.getFlagEmojiForIso3(iso3);
  }

  formatOptionText(iso3, count) {
    if (iso3 === '?') return `? (${count})`;
    return `${iso3} (${count})`;
  }

  handleTypeaheadChar(rawChar) {
    if (!this.optionsEl) return;
    if (!this.typeahead) {
      this.typeahead = { buffer: '', lastTs: 0 };
    }

    const now = Date.now();
    if (now - this.typeahead.lastTs > 700) {
      this.typeahead.buffer = '';
    }
    this.typeahead.lastTs = now;
    this.typeahead.buffer += rawChar;

    const query = this.makeSortKey(this.typeahead.buffer);
    if (!query) return;

    const labels = Array.from(this.optionsEl.querySelectorAll('label.track-details-option'));
    for (const label of labels) {
      if (label.dataset && label.dataset.role === 'all') continue;
      const key = (label.dataset && typeof label.dataset.searchKey === 'string')
        ? label.dataset.searchKey
        : this.makeSortKey(label.textContent || '');
      if (key.startsWith(query)) {
        label.scrollIntoView({ block: 'nearest' });
        break;
      }
    }
  }

  toggleCode(code) {
    const normalizedCode = this.normalizeIso3(code);
    if (!normalizedCode) return;
    const next = new Set(this.normalizeCountryFilterList(this.getFilters()));
    if (next.has(normalizedCode)) {
      next.delete(normalizedCode);
    } else {
      next.add(normalizedCode);
    }

    this.setFilters(Array.from(next));
    this.updateButtonState();
    this.onFiltersChanged();

    if (this.isVisible()) {
      this.updateOptions();
    }
  }

  updateOptions() {
    if (!this.buttonEl || !this.optionsEl) return;

    const { codes, counts } = this.collectCounts();
    this.optionsEl.innerHTML = '';

    if (!codes.length) {
      this.buttonEl.disabled = true;
      this.buttonEl.title = 'No country tags available';
      this.setFilters([]);
      this.updateButtonState();
      return;
    }

    this.buttonEl.disabled = false;
    this.buttonEl.title = 'Filter by country';

    const selected = new Set(this.normalizeCountryFilterList(this.getFilters()));

    const sortedCodes = (() => {
      const hasUnknown = codes.length > 0 && codes[0] === '?';
      const rest = hasUnknown ? codes.slice(1) : codes.slice();
      if (this.sortMode === 'count') {
        rest.sort((a, b) => {
          const countA = counts.get(a) || 0;
          const countB = counts.get(b) || 0;
          if (countB !== countA) return countB - countA;
          return a.localeCompare(b, undefined, { sensitivity: 'base' });
        });
      } else {
        rest.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      }
      return hasUnknown ? ['?'].concat(rest) : rest;
    })();

    const headerRow = document.createElement('div');
    headerRow.className = 'track-details-option';
    headerRow.dataset.role = 'all';

    const allLabel = document.createElement('label');
    allLabel.className = 'track-details-inline';
    const allInput = document.createElement('input');
    allInput.type = 'checkbox';
    allInput.checked = selected.size === 0;
    allInput.setAttribute('aria-label', 'All countries');
    const allText = document.createElement('span');
    allText.textContent = 'All';
    allLabel.appendChild(allInput);
    allLabel.appendChild(allText);

    const sortLabel = document.createElement('span');
    sortLabel.className = 'track-details-inline-label';
    sortLabel.textContent = 'sort';

    const sortSelect = document.createElement('select');
    sortSelect.className = 'track-details-select';
    sortSelect.setAttribute('aria-label', 'Sort countries');
    const sortOptions = [
      { value: 'az', label: 'a-z' },
      { value: 'count', label: 'count' }
    ];
    sortOptions.forEach(({ value, label }) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      sortSelect.appendChild(opt);
    });
    sortSelect.value = this.sortMode;

    headerRow.appendChild(allLabel);
    headerRow.appendChild(sortLabel);
    headerRow.appendChild(sortSelect);
    this.optionsEl.appendChild(headerRow);

    allInput.addEventListener('change', () => {
      if (allInput.checked) {
        this.setFilters([]);
        this.updateButtonState();
        this.onFiltersChanged();
        this.updateOptions();
      }
    });

    sortSelect.addEventListener('change', () => {
      this.sortMode = sortSelect.value === 'count' ? 'count' : 'az';
      this.updateOptions();
    });

    sortedCodes.forEach((code) => {
      const optLabel = document.createElement('label');
      optLabel.className = 'track-details-option';
      optLabel.dataset.searchKey = this.makeSortKey(code);

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = selected.has(code);
      input.value = code;

      const flag = this.getFlagEmoji(code);
      if (flag) {
        const flagSpan = document.createElement('span');
        flagSpan.className = 'country-flag-emoji';
        flagSpan.textContent = flag;
        optLabel.appendChild(input);
        optLabel.appendChild(flagSpan);
      } else {
        optLabel.appendChild(input);
      }

      const text = document.createElement('span');
      text.textContent = this.formatOptionText(code, counts.get(code) || 0);
      optLabel.appendChild(text);
      this.optionsEl.appendChild(optLabel);

      input.addEventListener('change', () => {
        const next = new Set(this.normalizeCountryFilterList(this.getFilters()));
        const normalizedCode = this.normalizeIso3(code);
        if (input.checked) {
          next.add(normalizedCode);
        } else {
          next.delete(normalizedCode);
        }

        this.setFilters(Array.from(next));
        this.updateButtonState();
        this.onFiltersChanged();
        this.updateOptions();
      });
    });
  }
}
