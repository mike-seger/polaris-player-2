export class FilterStateStore {
  constructor({ getSettings, saveSettings } = {}) {
    this.getSettings = typeof getSettings === 'function' ? getSettings : () => ({});
    this.saveSettings = typeof saveSettings === 'function' ? saveSettings : () => {};

    const settings = this.getSettings() || {};

    this.filterText = (typeof settings.filterText === 'string') ? settings.filterText : '';
    this.onlyMarked = !!settings.onlyMarked;
    this.artistFilters = Array.isArray(settings.artistFilters)
      ? this.normalizeArtistFilterList(settings.artistFilters)
      : [];

    if (Array.isArray(settings.countryFilters)) {
      this.countryFilters = this.normalizeCountryFilterList(settings.countryFilters);
    } else if (typeof settings.countryFilter === 'string') {
      const legacy = this.normalizeIso3(settings.countryFilter);
      this.countryFilters = legacy ? [legacy] : [];
    } else {
      this.countryFilters = [];
    }

    // In-memory UI state only (not persisted)
    this.artistFilterOverlayVisible = false;
    this.countryFilterOverlayVisible = false;
    this.artistSortMode = 'az';
    this.countrySortMode = 'az';
  }

  snapshot() {
    return {
      filterText: this.filterText,
      onlyMarked: !!this.onlyMarked,
      artistFilters: this.artistFilters.slice(),
      countryFilters: this.countryFilters.slice(),
      artistFilterOverlayVisible: this.artistFilterOverlayVisible,
      countryFilterOverlayVisible: this.countryFilterOverlayVisible,
      artistSortMode: this.artistSortMode,
      countrySortMode: this.countrySortMode
    };
  }

  setFilterText(value) {
    this.filterText = (typeof value === 'string') ? value : '';
    this.saveSettings({ filterText: this.filterText });
    return this.filterText;
  }

  clearFilterText() {
    return this.setFilterText('');
  }

  setOnlyMarked(value) {
    this.onlyMarked = !!value;
    this.saveSettings({ onlyMarked: this.onlyMarked });
    return this.onlyMarked;
  }

  clearOnlyMarked() {
    return this.setOnlyMarked(false);
  }

  setArtistFilters(next) {
    this.artistFilters = this.normalizeArtistFilterList(next);
    this.saveSettings({ artistFilters: this.artistFilters });
    return this.artistFilters;
  }

  clearArtistFilters() {
    return this.setArtistFilters([]);
  }

  setCountryFilters(next) {
    this.countryFilters = this.normalizeCountryFilterList(next);
    // Keep legacy single-value for older builds; first selection wins.
    this.saveSettings({ countryFilters: this.countryFilters, countryFilter: this.countryFilters[0] || '' });
    return this.countryFilters;
  }

  clearCountryFilters() {
    return this.setCountryFilters([]);
  }

  resetInMemory() {
    this.filterText = '';
    this.onlyMarked = false;
    this.artistFilters = [];
    this.countryFilters = [];
    this.artistFilterOverlayVisible = false;
    this.countryFilterOverlayVisible = false;
    this.artistSortMode = 'az';
    this.countrySortMode = 'az';
    return this.snapshot();
  }

  normalizeIso3(code) {
    return (code || '').trim().toUpperCase();
  }

  normalizeCountryFilterList(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const entry of list) {
      const normalized = this.normalizeIso3(entry);
      if (!normalized) continue;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    }
    return out;
  }

  normalizeArtistFilterList(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const entry of list) {
      const name = this.normalizeArtistName(entry);
      const key = this.normalizeArtistKey(name);
      if (!key) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
    return out;
  }

  normalizeArtistName(value) {
    return (typeof value === 'string') ? value.trim().toLowerCase() : '';
  }

  normalizeArtistKey(value) {
    return this.normalizeArtistName(value);
  }
}
