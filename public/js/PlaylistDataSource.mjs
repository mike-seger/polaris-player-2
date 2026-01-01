export class PlaylistDataSource {
  constructor(options = {}) {
    const {
      statusEndpoint,
      playlistEndpoint,
      localPlaylistPath,

      defaultPlaylistIndexPath,
      syncDefaultPlaylists,

      spectrum,

      initPlaylistIO,
      playlistIOBtn,

      getSettings,
      saveSettings,
      getActivePlaylistId,
      getCurrentVideoMap,

      getUseLocalMode,
      setUseLocalMode,

      getLocalPlaylistLibrary,
      setLocalPlaylistLibrary,

      getLocalFallbackNotified,
      setLocalFallbackNotified,

      getPlaylistIOInstance,
      setPlaylistIOInstance,

      getPlaylistHistory,
      removePlaylistFromHistory,
      resetUserSettings,
      showAlert,

      downloadCurrentPlaylist,

      updatePlaylistHistorySelect,
      updateUrlPlaylistParam,

      getFilterInputValue,
      setFilterTextFromValue,

      setPlaylistItems,
      getPlaylistItems,
      bumpPlaylistVersion,

      shuffleQueue,
      resetVisibleIndices,

      refreshFilterOverlays,

      computeFilteredIndices,
      renderTrackList,
      updateNowPlaying,
      updatePlayPauseButton,
      playIndex,

      addPlaylistToHistory,

      setNotifySettingsUpdated,

      getController,
      getCurrentIndex,
      setCurrentIndex,

      listSpotifyDevices,
      transferSpotifyPlayback,
      getSpotifyLocalDeviceId,
      getOutputVolume01,
      setOutputVolume01,
    } = options;

    this.statusEndpoint = statusEndpoint;
    this.playlistEndpoint = playlistEndpoint;
    this.localPlaylistPath = localPlaylistPath;

    this.defaultPlaylistIndexPath = defaultPlaylistIndexPath || './video/default-playlists.json';
    this.syncDefaultPlaylists = typeof syncDefaultPlaylists === 'function' ? syncDefaultPlaylists : async (_defaults) => {};

    this.spectrum = spectrum;

    this.initPlaylistIO = initPlaylistIO;
    this.playlistIOBtn = playlistIOBtn;

    this.getSettings = getSettings;
    this.saveSettings = saveSettings;
    this.getActivePlaylistId = getActivePlaylistId;
    this.getCurrentVideoMap = getCurrentVideoMap;

    this.getUseLocalMode = getUseLocalMode;
    this.setUseLocalMode = setUseLocalMode;

    this.getLocalPlaylistLibrary = getLocalPlaylistLibrary;
    this.setLocalPlaylistLibrary = setLocalPlaylistLibrary;

    this.getLocalFallbackNotified = getLocalFallbackNotified;
    this.setLocalFallbackNotified = setLocalFallbackNotified;

    this.getPlaylistIOInstance = getPlaylistIOInstance;
    this.setPlaylistIOInstance = setPlaylistIOInstance;

    this.getPlaylistHistory = getPlaylistHistory;
    this.removePlaylistFromHistory = removePlaylistFromHistory;
    this.resetUserSettings = resetUserSettings;
    this.showAlert = showAlert;

    this.downloadCurrentPlaylist = downloadCurrentPlaylist;

    this.updatePlaylistHistorySelect = updatePlaylistHistorySelect;
    this.updateUrlPlaylistParam = updateUrlPlaylistParam;

    this.getFilterInputValue = getFilterInputValue;
    this.setFilterTextFromValue = setFilterTextFromValue;

    this.setPlaylistItems = setPlaylistItems;
    this.getPlaylistItems = typeof getPlaylistItems === 'function' ? getPlaylistItems : () => [];
    this.bumpPlaylistVersion = bumpPlaylistVersion;

    this.shuffleQueue = shuffleQueue;
    this.resetVisibleIndices = resetVisibleIndices;

    this.refreshFilterOverlays = refreshFilterOverlays;

    this.computeFilteredIndices = computeFilteredIndices;
    this.renderTrackList = renderTrackList;
    this.updateNowPlaying = updateNowPlaying;
    this.updatePlayPauseButton = updatePlayPauseButton;
    this.playIndex = playIndex;

    this.addPlaylistToHistory = addPlaylistToHistory;

    this.setNotifySettingsUpdated = setNotifySettingsUpdated;

    this.getController = getController;
    this.getCurrentIndex = getCurrentIndex;
    this.setCurrentIndex = setCurrentIndex;

    this.listSpotifyDevices = typeof listSpotifyDevices === 'function' ? listSpotifyDevices : async () => [];
    this.transferSpotifyPlayback = typeof transferSpotifyPlayback === 'function' ? transferSpotifyPlayback : async () => {};
    this.getSpotifyLocalDeviceId = typeof getSpotifyLocalDeviceId === 'function' ? getSpotifyLocalDeviceId : () => '';
    this.getOutputVolume01 = typeof getOutputVolume01 === 'function' ? getOutputVolume01 : () => 0.3;
    this.setOutputVolume01 = typeof setOutputVolume01 === 'function' ? setOutputVolume01 : () => {};
  }

  setupPlaylistOverlay({ onLoadPlaylist } = {}) {
    if (this.getPlaylistIOInstance() || typeof this.initPlaylistIO !== 'function') {
      return;
    }

    if (this.playlistIOBtn) {
      this.playlistIOBtn.style.display = '';
      this.playlistIOBtn.removeAttribute('aria-hidden');
    }

    const instance = this.initPlaylistIO({
      triggerElement: this.playlistIOBtn,
      getPlaylistId: () => {
        const settings = this.getSettings();
        return typeof settings.playlistId === 'string' ? settings.playlistId : '';
      },
      getPlaylistHistory: () => this.getPlaylistHistory().slice(),
      removePlaylist: (id) => this.removePlaylistFromHistory(id),
      getUserSettings: () => {
        const settings = this.getSettings();
        try {
          return JSON.parse(JSON.stringify(settings));
        } catch {
          return settings;
        }
      },
      getPlayerMode: () => {
        const settings = this.getSettings();
        return (settings && typeof settings.playerMode === 'string') ? settings.playerMode : 'youtube';
      },
      setPlayerMode: (mode) => {
        const next = (mode === 'local' || mode === 'spotify') ? mode : 'youtube';
        if (typeof this.saveSettings === 'function') {
          this.saveSettings({ playerMode: next });
        }
      },
      getSpotifyClientId: () => {
        const settings = this.getSettings();
        return (settings && typeof settings.spotifyClientId === 'string') ? settings.spotifyClientId : '';
      },
      setSpotifyClientId: (clientId) => {
        const next = String(clientId || '').trim();
        if (typeof this.saveSettings === 'function') {
          this.saveSettings({ spotifyClientId: next });
        }
      },

      listSpotifyDevices: () => this.listSpotifyDevices(),
      transferSpotifyPlayback: (deviceId) => this.transferSpotifyPlayback(deviceId),
      getSpotifyLocalDeviceId: () => this.getSpotifyLocalDeviceId(),
      getOutputVolume01: () => this.getOutputVolume01(),
      setOutputVolume01: (v01) => this.setOutputVolume01(v01),

      resetUserSettings: () => this.resetUserSettings(),
      onLoad: async ({ playlistId, forceRefresh }) => {
        await onLoadPlaylist({ playlistId, forceRefresh: Boolean(forceRefresh) });
      },
      onDownload: () => this.downloadCurrentPlaylist(),
      getPlaylistItems: () => this.getPlaylistItems(),
      showAlert: this.showAlert,
    });

    this.setPlaylistIOInstance(instance);

    if (instance && typeof instance.refreshSettings === 'function') {
      this.setNotifySettingsUpdated(() => {
        try {
          instance.refreshSettings();
        } catch (error) {
          console.warn('Failed to refresh playlist overlay settings view:', error);
        }
      });
    } else {
      this.setNotifySettingsUpdated(() => {});
    }

    if (instance && typeof instance.setServerAvailability === 'function') {
      instance.setServerAvailability(!this.getUseLocalMode());
    }
  }

  enableLocalModeUi() {
    this.setUseLocalMode(true);

    this.setupPlaylistOverlay({
      onLoadPlaylist: async ({ playlistId, forceRefresh }) => {
        await this.loadPlaylistFromServer(Boolean(forceRefresh), playlistId);
      }
    });

    const instance = this.getPlaylistIOInstance();
    if (instance && typeof instance.setServerAvailability === 'function') {
      instance.setServerAvailability(false);
    }

    // Ensure defaults are available in the selector even when we enter local mode later.
    this.ensureDefaultPlaylistsSynced()
      .then(() => this.updatePlaylistHistorySelect((this.getSettings().playlistId || '')))
      .catch(() => {});
  }

  async checkServerAvailability() {
    try {
      const resp = await fetch(this.statusEndpoint, { cache: 'no-store' });
      if (!resp || !resp.ok) {
        this.spectrum.disable();
        return false;
      }
      try {
        const body = await resp.json();
        if (body && typeof body === 'object' && !Array.isArray(body)) {
          if (Object.prototype.hasOwnProperty.call(body, 'spectrum-cache')) {
            if (body['spectrum-cache'] === false) {
              this.spectrum.disable();
            } else if (body['spectrum-cache'] === true) {
              this.spectrum.setEnabled(true);
            }
          }
        }
        if (body && body.ok === false) {
          this.spectrum.disable();
          return false;
        }
      } catch {
        // ignore JSON parse errors
      }
      return true;
    } catch (error) {
      console.warn('Server status check failed:', error);
      this.spectrum.disable();
      return false;
    }
  }

  async ensureLocalPlaylistData() {
    // Only used as a file:// fallback.
    const cached = this.getLocalPlaylistLibrary();
    if (cached) return cached;

    // Prefer the new embedded default playlist library (per-playlist files).
    try {
      const embeddedDefaultLib = /** @type {any} */ (globalThis).__POLARIS_DEFAULT_PLAYLIST_LIBRARY__;
      if (embeddedDefaultLib && typeof embeddedDefaultLib === 'object') {
        this.setLocalPlaylistLibrary(embeddedDefaultLib);
        return embeddedDefaultLib;
      }
    } catch {
      // ignore
    }

    // Backward compatibility: older file builds may embed the legacy monolithic map.
    try {
      const embeddedLegacy = /** @type {any} */ (globalThis).__POLARIS_LOCAL_PLAYLIST_LIBRARY__;
      if (embeddedLegacy && typeof embeddedLegacy === 'object') {
        this.setLocalPlaylistLibrary(embeddedLegacy);
        return embeddedLegacy;
      }
    } catch {
      // ignore
    }

    return null;
  }

  async ensureDefaultPlaylistsSynced() {
    let defaults = null;

    // File-builds may embed the default playlist index directly.
    try {
      const embeddedIndex = /** @type {any} */ (globalThis).__POLARIS_DEFAULT_PLAYLIST_INDEX__;
      if (Array.isArray(embeddedIndex)) {
        defaults = embeddedIndex;
      }
    } catch {
      // ignore
    }

    if (!defaults) {
      try {
        const resp = await fetch(this.defaultPlaylistIndexPath, { cache: 'no-store' });
        if (resp && resp.ok) {
          const data = await resp.json();
          if (Array.isArray(data)) defaults = data;
        }
      } catch {
        // ignore
      }
    }

    // As a last resort, derive defaults from the embedded/legacy monolithic library map.
    if (!defaults) {
      try {
        const lib = await this.ensureLocalPlaylistData();
        if (lib && typeof lib === 'object' && !Array.isArray(lib)) {
          defaults = Object.entries(lib).map(([id, entry]) => {
            const title = (entry && typeof entry === 'object' && typeof entry.title === 'string' && entry.title.trim().length)
              ? entry.title.trim()
              : id;
            const fetchedAt = (entry && typeof entry === 'object' && typeof entry.fetchedAt === 'string')
              ? entry.fetchedAt
              : '';
            return {
              id,
              title,
              uri: `./video/${id}.json`,
              fetchedAt,
              default: true,
              type: 'polaris',
            };
          });
        }
      } catch {
        // ignore
      }
    }

    if (defaults && Array.isArray(defaults) && defaults.length) {
      try { await this.syncDefaultPlaylists(defaults); } catch { /* ignore */ }
    }

    if (this.getUseLocalMode()) {
      try { this.updatePlaylistHistorySelect((this.getSettings().playlistId || '')); } catch { /* ignore */ }
    }

    return defaults;
  }

  async loadPlaylistFromLocal(playlistIdOverride = '') {
    await this.ensureDefaultPlaylistsSynced();

    const list = this.getPlaylistHistory();
    const localEntries = Array.isArray(list)
      ? list.filter((e) => e && typeof e === 'object' && e.type === 'polaris')
      : [];

    const availableIds = localEntries.map((e) => e.id).filter(Boolean);
    if (!availableIds.length) {
      this.showAlert('No local playlists available.');
      return undefined;
    }

    const settings = this.getSettings();
    const override = typeof playlistIdOverride === 'string' ? playlistIdOverride.trim() : '';
    const fallback = typeof settings.playlistId === 'string' ? settings.playlistId.trim() : '';
    let targetId = override || fallback;
    if (!targetId || !availableIds.includes(targetId)) {
      targetId = availableIds[0];
    }

    const meta = localEntries.find((e) => e.id === targetId) || null;
    const uri = (meta && typeof meta.uri === 'string' && meta.uri.trim().length)
      ? meta.uri.trim()
      : `./video/${targetId}.json`;

    let entry = null;

    // Prefer embedded/legacy library map (works under file://), else fetch the per-playlist JSON.
    try {
      const embedded = await this.ensureLocalPlaylistData();
      if (embedded && typeof embedded === 'object' && !Array.isArray(embedded) && embedded[targetId]) {
        entry = embedded[targetId];
      }
    } catch {
      // ignore
    }

    if (!entry) {
      try {
        const url = new URL(uri, window.location.href).toString();
        const resp = await fetch(url, { cache: 'no-store' });
        if (!resp.ok) {
          this.showAlert('Failed to load local playlist file.');
          return undefined;
        }
        entry = await resp.json();
      } catch (error) {
        console.error('Failed to load local playlist file:', error);
        this.showAlert('Local playlist data is unavailable.');
        return undefined;
      }
    }

    const playlistTitle = (entry && typeof entry.title === 'string' && entry.title.trim().length)
      ? entry.title.trim()
      : targetId;

    this.setPlaylistItems(entry && Array.isArray(entry.items) ? entry.items.slice() : []);
    this.bumpPlaylistVersion();
    this.shuffleQueue.resetAll();
    this.resetVisibleIndices();

    this.refreshFilterOverlays();
    this.saveSettings({ playlistId: targetId });

    const savedMap = this.getCurrentVideoMap();
    const storedVideoId = savedMap[targetId];
    let idxFromStorage = -1;
    if (storedVideoId) {
      const items = this.getPlaylistItems();
      idxFromStorage = items.findIndex((it) => it.videoId === storedVideoId);
    }
    const items = this.getPlaylistItems();
    this.setCurrentIndex(idxFromStorage >= 0 ? idxFromStorage : (items.length ? 0 : -1));

    this.setFilterTextFromValue(this.getFilterInputValue());
    this.computeFilteredIndices();
    this.renderTrackList();
    this.updateNowPlaying();
    this.updatePlayPauseButton();
    this.addPlaylistToHistory(targetId, playlistTitle, {
      uri,
      fetchedAt: (entry && typeof entry.fetchedAt === 'string') ? entry.fetchedAt : (meta && meta.fetchedAt) || '',
      type: 'polaris',
      default: meta ? !!meta.default : false,
    });
    this.updateUrlPlaylistParam(targetId);

    const currentIndex = this.getCurrentIndex();
    if (currentIndex >= 0 && this.getController()) {
      this.playIndex(currentIndex);
    }

    return targetId;
  }

  async enterLocalFallback(playlistIdOverride = '') {
    if (!this.getUseLocalMode()) {
      this.enableLocalModeUi();
      if (!this.getLocalFallbackNotified()) {
        console.warn('Server unavailable. Falling back to local playlist data.');
        this.setLocalFallbackNotified(true);
      }
    }
    return this.loadPlaylistFromLocal(playlistIdOverride);
  }

  async loadPlaylistFromServer(forceRefresh = false, playlistIdOverride = '') {
    if (this.getUseLocalMode()) {
      return this.loadPlaylistFromLocal(playlistIdOverride);
    }

    const settings = this.getSettings();
    const override = typeof playlistIdOverride === 'string' ? playlistIdOverride.trim() : '';
    const fallback = typeof settings.playlistId === 'string' ? settings.playlistId.trim() : '';
    const targetId = override || fallback;
    if (!targetId) {
      return undefined;
    }

    const url = `${this.playlistEndpoint}?playlistId=${encodeURIComponent(targetId)}${forceRefresh ? '&forceRefresh=1' : ''}`;

    let resp;
    try {
      resp = await fetch(url);
    } catch (networkError) {
      console.error('Playlist request failed:', networkError);
      return this.enterLocalFallback(playlistIdOverride);
    }

    if (!resp.ok) {
      try {
        const err = await resp.json();
        const detail = err?.error || err?.message;
        if (detail && typeof detail === 'string') {
          console.warn('Playlist request failed:', detail);
        }
      } catch (parseErr) {
        console.warn('Failed to parse playlist error response:', parseErr);
      }
      return this.enterLocalFallback(playlistIdOverride);
    }

    const data = await resp.json();
    this.setPlaylistItems(data.items || []);
    this.bumpPlaylistVersion();
    this.shuffleQueue.resetAll();
    this.resetVisibleIndices();

    this.refreshFilterOverlays();

    const resolvedPlaylistId =
      (typeof data.playlistId === 'string' && data.playlistId.trim().length
        ? data.playlistId.trim()
        : targetId) || targetId;

    const playlistTitle =
      (typeof data.title === 'string' && data.title.trim().length ? data.title.trim() : '') ||
      (typeof data.playlistTitle === 'string' && data.playlistTitle.trim().length ? data.playlistTitle.trim() : '') ||
      resolvedPlaylistId;

    this.saveSettings({ playlistId: resolvedPlaylistId });

    const savedMap = this.getCurrentVideoMap();
    const storedVideoId = savedMap[resolvedPlaylistId];
    let idxFromStorage = -1;
    if (storedVideoId) {
      const items = this.getPlaylistItems();
      idxFromStorage = items.findIndex((it) => it.videoId === storedVideoId);
    }

    const items = this.getPlaylistItems();
    this.setCurrentIndex(idxFromStorage >= 0 ? idxFromStorage : (items.length ? 0 : -1));

    this.setFilterTextFromValue(this.getFilterInputValue());
    this.computeFilteredIndices();
    this.renderTrackList();
    this.updateNowPlaying();
    this.updatePlayPauseButton();

    const currentIndex = this.getCurrentIndex();
    if (currentIndex >= 0 && this.getController()) {
      this.playIndex(currentIndex);
    }

    this.addPlaylistToHistory(resolvedPlaylistId, playlistTitle, {
      uri: targetId,
      fetchedAt: (typeof data.fetchedAt === 'string') ? data.fetchedAt : new Date().toISOString(),
      type: 'youtube',
      default: false,
    });
    this.updateUrlPlaylistParam(resolvedPlaylistId);

    return resolvedPlaylistId;
  }

  async initialize({ startupPlaylistId } = {}) {
    try {
      await this.ensureDefaultPlaylistsSynced();
    } catch (error) {
      console.warn('Failed to sync default playlists:', error);
    }

    const available = await this.checkServerAvailability();

    this.setupPlaylistOverlay({
      onLoadPlaylist: async ({ playlistId, forceRefresh }) => {
        await this.loadPlaylistFromServer(Boolean(forceRefresh), playlistId);
      }
    });

    if (available) {
      this.setUseLocalMode(false);
      const instance = this.getPlaylistIOInstance();
      if (instance && typeof instance.setServerAvailability === 'function') {
        instance.setServerAvailability(true);
      }
      return true;
    }

    this.enableLocalModeUi();
    try {
      await this.loadPlaylistFromLocal(startupPlaylistId || '');
    } catch (error) {
      console.warn('Failed to initialize local playlist fallback:', error);
    }

    return false;
  }
}
