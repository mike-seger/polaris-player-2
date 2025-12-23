export class PlaylistHistoryStore {
  constructor({ limit, getSettings, saveSettings } = {}) {
    this.limit = Number.isFinite(limit) ? limit : 25;
    this.getSettings = typeof getSettings === 'function' ? getSettings : () => ({});
    this.saveSettings = typeof saveSettings === 'function' ? saveSettings : () => {};

    const settings = this.getSettings() || {};
    const raw = Array.isArray(settings.playlistHistory) ? settings.playlistHistory : [];
    this.value = this.normalize(raw);

    const historyNeedsPersist = JSON.stringify(raw) !== JSON.stringify(this.value);
    if (historyNeedsPersist) {
      this.persist();
    }
  }

  replace(nextValue, { persist = true } = {}) {
    this.value = this.normalize(nextValue);
    if (persist) {
      this.persist();
    }
    return this.value;
  }

  get() {
    return this.value;
  }

  normalize(raw) {
    if (!Array.isArray(raw)) return [];
    const cleaned = [];
    const seen = new Set();
    for (const entry of raw) {
      if (!entry) continue;

      let id = '';
      let title = '';

      if (typeof entry === 'string') {
        id = entry.trim();
        title = id;
      } else if (typeof entry === 'object') {
        if (typeof entry.id === 'string') {
          id = entry.id.trim();
        } else if (typeof entry.playlistId === 'string') {
          id = entry.playlistId.trim();
        } else if (typeof entry.url === 'string') {
          const url = entry.url.trim();
          const match = url.match(/[?&]list=([^&#]+)/);
          id = match ? decodeURIComponent(match[1]) : url;
        }

        if (typeof entry.title === 'string' && entry.title.trim().length) {
          title = entry.title.trim();
        } else if (typeof entry.name === 'string' && entry.name.trim().length) {
          title = entry.name.trim();
        }
      }

      if (!id) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      cleaned.push({ id, title: title || id });
      if (cleaned.length >= this.limit) break;
    }
    return cleaned;
  }

  persist() {
    this.saveSettings({ playlistHistory: this.value });
  }

  add(id, title) {
    if (!id) return;
    const cleanedTitle = title && title.trim().length ? title.trim() : id;

    const existing = this.value.filter((entry) => entry.id !== id);
    this.value = [{ id, title: cleanedTitle }, ...existing];
    if (this.value.length > this.limit) {
      this.value = this.value.slice(0, this.limit);
    }
    this.persist();
  }

  remove(id) {
    if (!id) return;
    this.value = this.value.filter((entry) => entry.id !== id);
    this.persist();
  }

  clear() {
    this.value = [];
    this.persist();
  }
}
