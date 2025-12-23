import {
  installOverlayListKeydownHandler,
  scheduleScrollFirstSelectedOptionIntoView,
} from './OverlayShared.mjs';

export class ArtistFilterOverlay {
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

      normalizeArtistName = (name) => (name || '').trim(),
      normalizeArtistKey = (name) => (name || '').trim().toLowerCase(),

      makeSortKey = (s) => String(s || ''),
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

    this.normalizeArtistName = normalizeArtistName;
    this.normalizeArtistKey = normalizeArtistKey;

    this.makeSortKey = makeSortKey;

    this.visible = false;
    this.sortMode = 'az';

    this.removeKeydownHandler = null;

    this.handleOutsideClick = (event) => {
      if (!this.isVisible()) return;
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

  normalizeFilterList(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    const seen = new Set();
    value.forEach((entry) => {
      const cleaned = this.normalizeArtistName(entry);
      if (!cleaned) return;
      const key = this.normalizeArtistKey(cleaned);
      if (!key) return;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(cleaned);
    });
    return out;
  }

  toggleName(name, options = {}) {
    const cleaned = this.normalizeArtistName(name);
    if (!cleaned) return;
    const key = this.normalizeArtistKey(cleaned);
    if (!key) return;

    const next = new Map();
    this.getFilters().forEach((entry) => {
      const entryKey = this.normalizeArtistKey(entry);
      if (!entryKey) return;
      next.set(entryKey, this.normalizeArtistName(entry));
    });

    if (next.has(key)) {
      next.delete(key);
    } else {
      next.set(key, cleaned);
    }

    this.setFilters(Array.from(next.values()));
    this.updateButtonState();
    this.onFiltersChanged(options);
    this.updateOptions();
  }

  getArtistSourceText(item) {
    if (!item || typeof item !== 'object') return '';
    if (typeof item.userTitle === 'string' && item.userTitle.trim().length) {
      return item.userTitle;
    }
    if (typeof item.title === 'string') return item.title;
    return '';
  }

  splitArtists(value) {
    if (typeof value !== 'string') return [];
    const raw = value.trim();
    if (!raw) return [];
    const dashIndex = raw.indexOf(' - ');
    const artistPart = dashIndex >= 0 ? raw.slice(0, dashIndex) : raw;
    return artistPart
      .split(';')
      .map((part) => this.normalizeArtistName(part))
      .filter(Boolean);
  }

  collectCounts() {
    const displayByKey = new Map();
    const counts = new Map();

    (this.getPlaylistItems() || []).forEach((item) => {
      const artists = this.splitArtists(this.getArtistSourceText(item));
      if (!artists.length) return;

      // Count each track once per artist key.
      const uniq = new Map();
      artists.forEach((artist) => {
        const key = this.normalizeArtistKey(artist);
        if (!key) return;
        if (!uniq.has(key)) {
          uniq.set(key, artist);
        }
      });

      uniq.forEach((artist, key) => {
        if (!displayByKey.has(key)) {
          displayByKey.set(key, artist);
        }
        counts.set(key, (counts.get(key) || 0) + 1);
      });
    });

    const artists = Array.from(displayByKey.entries())
      .sort((a, b) => {
        const keyA = this.makeSortKey(a[1]);
        const keyB = this.makeSortKey(b[1]);
        if (keyA < keyB) return -1;
        if (keyA > keyB) return 1;
        return a[1].localeCompare(b[1], undefined, { sensitivity: 'base' });
      })
      .map(([, display]) => display);

    return { artists, counts };
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

  updateOptions() {
    if (!this.buttonEl || !this.optionsEl) return;

    const { artists, counts } = this.collectCounts();
    this.optionsEl.innerHTML = '';

    if (!artists.length) {
      this.buttonEl.disabled = true;
      this.buttonEl.title = 'No artists detected';
      this.setFilters([]);
      this.updateButtonState();
      return;
    }

    this.buttonEl.disabled = false;
    this.buttonEl.title = 'Filter by artist';

    const selectedKeys = new Set(this.getFilters().map((a) => this.normalizeArtistKey(a)).filter(Boolean));

    const sortedArtists = (this.sortMode === 'count')
      ? [...artists].sort((a, b) => {
        const keyA = this.normalizeArtistKey(a);
        const keyB = this.normalizeArtistKey(b);
        const countA = counts.get(keyA) || 0;
        const countB = counts.get(keyB) || 0;
        if (countB !== countA) return countB - countA;
        const sortA = this.makeSortKey(a);
        const sortB = this.makeSortKey(b);
        if (sortA < sortB) return -1;
        if (sortA > sortB) return 1;
        return a.localeCompare(b, undefined, { sensitivity: 'base' });
      })
      : artists;

    const headerRow = document.createElement('div');
    headerRow.className = 'track-details-option';
    headerRow.dataset.role = 'all';

    const allLabel = document.createElement('label');
    allLabel.className = 'track-details-inline';
    const allInput = document.createElement('input');
    allInput.type = 'checkbox';
    allInput.checked = selectedKeys.size === 0;
    allInput.setAttribute('aria-label', 'All artists');
    const allText = document.createElement('span');
    allText.textContent = 'All';
    allLabel.appendChild(allInput);
    allLabel.appendChild(allText);

    const sortLabel = document.createElement('span');
    sortLabel.className = 'track-details-inline-label';
    sortLabel.textContent = 'sort';

    const sortSelect = document.createElement('select');
    sortSelect.className = 'track-details-select';
    sortSelect.setAttribute('aria-label', 'Sort artists');
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
      if (!allInput.checked) return;
      this.setFilters([]);
      this.updateButtonState();
      this.onFiltersChanged();
      this.updateOptions();
    });

    sortSelect.addEventListener('change', () => {
      this.sortMode = sortSelect.value === 'count' ? 'count' : 'az';
      this.updateOptions();
    });

    sortedArtists.forEach((artist) => {
      const key = this.normalizeArtistKey(artist);
      if (!key) return;

      const optLabel = document.createElement('label');
      optLabel.className = 'track-details-option';
      optLabel.dataset.searchKey = this.makeSortKey(artist);

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = selectedKeys.has(key);
      input.value = artist;

      const text = document.createElement('span');
      text.textContent = `${artist} (${counts.get(key) || 0})`;

      optLabel.appendChild(input);
      optLabel.appendChild(text);
      this.optionsEl.appendChild(optLabel);

      input.addEventListener('change', () => {
        const next = new Map();
        this.getFilters().forEach((entry) => {
          const entryKey = this.normalizeArtistKey(entry);
          if (entryKey) next.set(entryKey, this.normalizeArtistName(entry));
        });

        if (input.checked) {
          next.set(key, artist);
        } else {
          next.delete(key);
        }

        this.setFilters(Array.from(next.values()));
        this.updateButtonState();
        this.onFiltersChanged();
        this.updateOptions();
      });
    });
  }
}
