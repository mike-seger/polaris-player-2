export class PlaylistLibraryStore {
  constructor({ getSettings, saveSettings } = {}) {
    this.getSettings = typeof getSettings === 'function' ? getSettings : () => ({ });
    this.saveSettings = typeof saveSettings === 'function' ? saveSettings : () => {};
  }

  get() {
    const settings = this.getSettings() || {};
    return this.normalize(settings.playlistLibrary);
  }

  replace(nextValue, { persist = true } = {}) {
    const cleaned = this.normalize(nextValue);
    if (persist) {
      this.saveSettings({ playlistLibrary: cleaned });
    }
    return cleaned;
  }

  remove(id) {
    const target = String(id || '').trim();
    if (!target) return this.get();
    const next = this.get().filter((e) => e.id !== target);
    return this.replace(next, { persist: true });
  }

  upsert(entry, { persist = true } = {}) {
    const cleaned = this.normalize([entry]);
    if (!cleaned.length) return this.get();

    const nextEntry = cleaned[0];
    const prev = this.get();
    const next = [nextEntry, ...prev.filter((e) => e.id !== nextEntry.id)];
    return this.replace(next, { persist });
  }

  syncDefaults(defaultEntries) {
    const defaults = this.normalize(defaultEntries);
    const defaultsById = new Map(defaults.filter((d) => d.default).map((d) => [d.id, d]));

    const prev = this.get();
    const prevById = new Map(prev.map((e) => [e.id, e]));

    // Start with non-default entries, plus defaults that still exist.
    const next = [];

    for (const e of prev) {
      if (e.default) {
        // No user edits for defaults: remove if not in current defaults.
        if (!defaultsById.has(e.id)) continue;
        continue;
      }
      next.push(e);
    }

    // Add/overwrite defaults from the current build.
    for (const d of defaults) {
      if (!d.default) continue;
      const existing = prevById.get(d.id);
      // Preserve nothing for defaults (explicit requirement).
      // Keep id stable; overwrite other fields.
      next.push({ ...d, id: d.id, default: true });

      // If there was an existing non-default entry with same id (unlikely), it is replaced.
      if (existing && !existing.default) {
        // already filtered out above by id replacement behavior
      }
    }

    // Stable ordering:
    // - defaults first, in the order provided by the defaults index (default-playlists.json)
    // - then non-default entries sorted by title
    const byTitle = (a, b) => String(a.title || a.id).localeCompare(String(b.title || b.id));
    const defaultsOut = defaults.filter((e) => e && e.default).map((d) => ({
      ...d,
      id: d.id,
      default: true,
    }));
    const nonDefaultsOut = next.filter((e) => !e.default).sort(byTitle);

    const merged = [...defaultsOut, ...nonDefaultsOut];

    // Only persist if different.
    try {
      if (JSON.stringify(prev) !== JSON.stringify(merged)) {
        this.saveSettings({ playlistLibrary: merged });
      }
    } catch {
      this.saveSettings({ playlistLibrary: merged });
    }

    return merged;
  }

  normalize(raw) {
    if (!Array.isArray(raw)) return [];

    /** @type {Array<any>} */
    const cleaned = [];
    const seen = new Set();

    for (const entry of raw) {
      if (!entry) continue;

      let id = '';
      let title = '';
      let uri = '';
      let fetchedAt = '';
      let isDefault = false;
      let type = 'polaris';

      if (typeof entry === 'string') {
        id = entry.trim();
        title = id;
      } else if (typeof entry === 'object') {
        if (typeof entry.id === 'string') id = entry.id.trim();
        else if (typeof entry.playlistId === 'string') id = entry.playlistId.trim();

        if (typeof entry.title === 'string' && entry.title.trim().length) {
          title = entry.title.trim();
        }

        if (typeof entry.uri === 'string' && entry.uri.trim().length) {
          uri = entry.uri.trim();
        } else if (typeof entry.url === 'string' && entry.url.trim().length) {
          uri = entry.url.trim();
        }

        if (typeof entry.fetchedAt === 'string' && entry.fetchedAt.trim().length) {
          fetchedAt = entry.fetchedAt.trim();
        }

        isDefault = !!entry.default;

        const rawType = String(entry.type || '').trim().toLowerCase();
        if (rawType === 'youtube' || rawType === 'spotify' || rawType === 'polaris') {
          type = rawType;
        }
      }

      if (!id) continue;
      if (seen.has(id)) continue;
      seen.add(id);

      // Back-compat: older settings may only have an id/title. For polaris/local playlists
      // that means the default/legacy location is under ./video/<id>.json.
      // For non-polaris entries, keep using the id as the default URI.
      const defaultUri = (type === 'polaris') ? `./video/${id}.json` : id;

      cleaned.push({
        id,
        title: title || id,
        uri: uri || defaultUri,
        fetchedAt,
        default: isDefault,
        type,
      });
    }

    return cleaned;
  }
}
