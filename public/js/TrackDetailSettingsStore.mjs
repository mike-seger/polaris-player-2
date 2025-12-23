export class TrackDetailSettingsStore {
  constructor({ defaults, getSettings, saveSettings } = {}) {
    if (!defaults || typeof defaults !== 'object') {
      throw new Error('TrackDetailSettingsStore requires `defaults`');
    }
    this.defaults = Object.freeze({ ...defaults });
    this.getSettings = typeof getSettings === 'function' ? getSettings : () => ({});
    this.saveSettings = typeof saveSettings === 'function' ? saveSettings : () => {};

    const settings = this.getSettings() || {};

    const rawPrefs = (settings.trackDetailPreferences && typeof settings.trackDetailPreferences === 'object' && !Array.isArray(settings.trackDetailPreferences))
      ? settings.trackDetailPreferences
      : null;

    const legacyShowThumbnails = typeof settings.showThumbnails === 'boolean'
      ? settings.showThumbnails
      : null;

    this.sortAlphabetically = (typeof settings.sortAlphabetically === 'boolean')
      ? settings.sortAlphabetically
      : false;

    const merged = rawPrefs
      ? { ...this.defaults, ...rawPrefs }
      : { ...this.defaults };

    if (!rawPrefs && legacyShowThumbnails !== null) {
      merged.thumbnail = legacyShowThumbnails;
    }

    merged.sortAZ = !!this.sortAlphabetically;
    this.preferences = this._normalizePreferences(merged);
  }

  snapshot() {
    return {
      preferences: { ...this.preferences },
      sortAlphabetically: !!this.sortAlphabetically
    };
  }

  getPreferences() {
    return this.preferences;
  }

  getSortAlphabetically() {
    return !!this.sortAlphabetically;
  }

  setPreferences(nextPreferences) {
    this.preferences = this._normalizePreferences({ ...this.defaults, ...(nextPreferences || {}) });
    this.saveSettings({ trackDetailPreferences: { ...this.preferences } });
    return this.preferences;
  }

  setSortAlphabetically(next) {
    this.sortAlphabetically = !!next;
    this.preferences = this._normalizePreferences({ ...this.preferences, sortAZ: !!this.sortAlphabetically });
    this.saveSettings({ sortAlphabetically: !!this.sortAlphabetically });
    return this.sortAlphabetically;
  }

  resetInMemory() {
    this.sortAlphabetically = false;
    this.preferences = this._normalizePreferences({ ...this.defaults, sortAZ: false });
    return this.snapshot();
  }

  _normalizePreferences(value) {
    const base = { ...this.defaults, ...(value || {}) };
    const out = {};
    Object.keys(this.defaults).forEach((key) => {
      out[key] = !!base[key];
    });
    // Ensure sortAZ is always present even if defaults omitted it.
    out.sortAZ = !!base.sortAZ;
    return out;
  }
}
