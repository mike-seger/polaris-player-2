  import { PlayerHost } from './players/PlayerHost.mjs';
  import { YouTubeAdapter } from './players/adapters/YouTubeAdapter.mjs';
  import { HtmlVideoAdapter } from './players/adapters/HtmlVideoAdapter.mjs';
  import { SpotifyAdapter } from './players/adapters/SpotifyAdapter.mjs';
  import { SpotifyAuth } from './players/SpotifyAuth.mjs';
  import { SettingsStore } from './SettingsStore.mjs';
  import { PlaylistLibraryStore } from './PlaylistLibraryStore.mjs';
  import { FilterStateStore } from './FilterStateStore.mjs';
  import { TrackDetailSettingsStore } from './TrackDetailSettingsStore.mjs';
  import { getFlagEmojiForIso3 } from './CountryFlags.mjs';
  import { initPlaylistIO } from './PlaylistManagement.mjs';
  import { Spectrum } from './Spectrum.mjs';
  import { TextUtils } from './TextUtils.mjs';
  import { ShuffleQueue } from './ShuffleQueue.mjs';
  import { createAlert } from './Alert.mjs';
  import { Sidebar } from './Sidebar.mjs';
  import { ArtistFilterOverlay } from './ArtistFilterOverlay.mjs';
  import { CountryFilterOverlay } from './CountryFilterOverlay.mjs';
  import { CombinedFilterOverlay } from './CombinedFilterOverlay.mjs';
  import { computeFilteredIndices as computeFilteredIndicesPure } from './FilterEngine.mjs';
  import { getSortKeyForTitle, splitTrackDisplayText } from './TrackParsing.mjs';
  import { TrackListView } from './TrackListView.mjs';
  import { TrackDetailsOverlay } from './TrackDetailsOverlay.mjs';
  import { PlaylistDataSource } from './PlaylistDataSource.mjs';
  import { addYtEmbedError150, hasYtEmbedError150, removeYtEmbedError150 } from './ErrorLists.mjs';
  import { CenterControlsOverlay } from './CenterControlsOverlay.mjs';

  let playerHost;
  let ytAdapter = null;
  let spotifyAdapter = null;
  let ytEmbedError150SkipTimer = null;
  let ytEmbedError150SkipKey = '';
  let ytEmbedError150CheckingVideoId = '';
  let videoCheckOverlayEl = null;
  let centerControlsOverlayController = null;

  function ensureVideoCheckOverlay() {
    if (videoCheckOverlayEl) return videoCheckOverlayEl;
    const container = document.getElementById('player-container');
    if (!(container instanceof HTMLElement)) return null;

    const overlay = document.createElement('div');
    overlay.id = 'videoCheckOverlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.position = 'absolute';
    overlay.style.inset = '0';
    overlay.style.display = 'none';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.background = '#000';
    overlay.style.zIndex = '4';
    overlay.style.pointerEvents = 'none';

    const msg = document.createElement('div');
    msg.textContent = 'Checking video';
    msg.style.color = '#f5f7fa';
    msg.style.fontSize = '1.05rem';
    msg.style.fontWeight = '700';
    msg.style.letterSpacing = '0.04em';
    msg.style.textTransform = 'uppercase';
    msg.style.opacity = '0.9';
    overlay.appendChild(msg);

    container.appendChild(overlay);
    videoCheckOverlayEl = overlay;
    return overlay;
  }

  function showVideoCheckOverlay() {
    const el = ensureVideoCheckOverlay();
    if (!el) return;
    el.style.display = 'flex';
    el.setAttribute('aria-hidden', 'false');
  }

  function hideVideoCheckOverlay() {
    const el = videoCheckOverlayEl;
    if (!el) return;
    el.style.display = 'none';
    el.setAttribute('aria-hidden', 'true');
  }

  function clearPendingYtEmbedError150Skip() {
    if (ytEmbedError150SkipTimer !== null) {
      clearTimeout(ytEmbedError150SkipTimer);
      ytEmbedError150SkipTimer = null;
    }
    ytEmbedError150SkipKey = '';
  }
    let playlistItems = [];
    let currentIndex = -1;
    let isPlaying = false;
    let sortAlphabetically = false;
    const DEFAULT_TRACK_DETAILS = Object.freeze({
      trackNumber: true,
      thumbnail: true,
      noAudio: false,
      wrapLines: true,
      country: true,
      checkTrack: false,
      showFiltered: false,
      sortAZ: false
    });
    let trackDetailSettings = { ...DEFAULT_TRACK_DETAILS };

    let trackDetailStore = null;

    let filterStateStore = null;
    let filterText = '';
    let onlyMarked = false;
    let artistFilters = [];
    let countryFilters = [];
    let filteredIndices = [];
    let visibleIndices = [];
    let visibleIndicesHash = 0;
    let visibleIndicesVersion = 0;
    let useLocalMode = false;
    let localPlaylistLibrary = null;
    let localFallbackNotified = false;
    let playlistIOInstance = null;
    let playerReady = false;
    let pendingPlayIndex = null;
    let holdPlayingUiUntilMs = 0;
    let lastAutoScrollIndex = null;

    // Media Session (lock screen / hardware controls)
    let mediaSessionInitialized = false;
    let lastMediaPositionUpdateAt = 0;

    const STORAGE_KEY = 'PolarisPlayer.settings';
    let notifySettingsUpdated = () => {};
    const settingsStore = new SettingsStore(STORAGE_KEY, { onChange: () => notifySettingsUpdated() });
    let settings = settingsStore.load();

    const spotifyAuth = new SpotifyAuth({
      clientId: (settings && typeof settings.spotifyClientId === 'string') ? settings.spotifyClientId : '',
      // Use SpotifyAuth's stable default redirectUri (directory root, no index.html).
      redirectUri: undefined,
    });

    function _safeSlug(value, maxLen = 24) {
      const s = String(value || '').trim();
      if (!s) return '';
      const cleaned = s
        .replace(/^https?:\/\//i, '')
        .replace(/[^0-9A-Za-z._-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
      return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
    }

    function _getOrCreateInstanceId() {
      const key = 'polaris.instanceId.v1';
      try {
        const existing = localStorage.getItem(key);
        if (existing && typeof existing === 'string' && existing.trim().length >= 6) {
          return existing.trim();
        }
      } catch {
        // ignore
      }

      let id = '';
      try {
        const bytes = new Uint8Array(5);
        crypto.getRandomValues(bytes);
        id = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
      } catch {
        id = String(Math.floor(Math.random() * 1e10));
      }

      try {
        localStorage.setItem(key, id);
      } catch {
        // ignore
      }

      return id;
    }

    function _detectOsTag() {
      const ua = String(navigator.userAgent || '');
      if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
      if (/Android/i.test(ua)) return 'Android';
      if (/Macintosh|Mac OS X/i.test(ua)) return 'macOS';
      if (/Windows/i.test(ua)) return 'Windows';
      if (/Linux/i.test(ua)) return 'Linux';
      return 'UnknownOS';
    }

    function _detectBrowserTag() {
      const ua = String(navigator.userAgent || '');
      // Order matters (Chrome on iOS includes "CriOS" and Safari tokens).
      if (/CriOS\//i.test(ua)) return 'Chrome';
      if (/FxiOS\//i.test(ua)) return 'Firefox';
      if (/EdgiOS\//i.test(ua)) return 'Edge';
      if (/OPiOS\//i.test(ua)) return 'Opera';
      if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua) && !/Chromium\//i.test(ua)) return 'Safari';
      if (/Chrome\//i.test(ua) || /Chromium\//i.test(ua)) return 'Chrome';
      return 'Browser';
    }

    function buildSpotifySdkName() {
      // NOTE: Browsers do not allow reliable access to local IP address.
      // Spotify clients also append their own labels (e.g. "this browser", "active").
      // Keep our name focused on identity: OS + (hostname when useful) + stable instance id.
      const rawHost = String(window.location.hostname || '').trim();
      const hostIsUseless = !rawHost
        || rawHost === 'localhost'
        || rawHost === '127.0.0.1'
        || rawHost === '::1';

      const host = hostIsUseless ? '' : _safeSlug(rawHost, 18);
      const os = _safeSlug(_detectOsTag(), 10);
      const id = _safeSlug(_getOrCreateInstanceId(), 10);

      const parts = [os, host, id].filter(Boolean);
      const label = parts.join(' ');
      return label ? `Polaris ${label}` : 'Polaris';
    }

    let playlistVersion = 0;
    const shuffleQueue = new ShuffleQueue({
      enabled: typeof settings.shuffleEnabled === 'boolean' ? settings.shuffleEnabled : true,
      getQueueIndices: () => (Array.isArray(visibleIndices) && visibleIndices.length)
        ? visibleIndices
        : playlistItems.map((_, idx) => idx),
      getQueueVersion: () => visibleIndicesVersion,
      getCurrentIndex: () => currentIndex
    });
    const API_BASE_PATH = window.location.hostname.endsWith('polaris.net128.com') ? '/u2b' : '.';
    const STATUS_ENDPOINT = `${API_BASE_PATH}/api/status`;
    const PLAYLIST_ENDPOINT = `${API_BASE_PATH}/api/playlist`;
    const playlistLibraryStore = new PlaylistLibraryStore({
      getSettings: () => settings,
      saveSettings: (patch) => saveSettings(patch)
    });
    let playlistLibrary = playlistLibraryStore.get();
    const TRACK_STATE_DEFAULT = 'default';
    const TRACK_STATE_CHECKED = 'checked';
    const urlParams = new URLSearchParams(window.location.search);
    const initialPlaylistId = (urlParams.get('pl') || '').trim();
    const hadInitialPlaylistParam = urlParams.has('pl');
    const shouldResetSettingsFromQuery = ((urlParams.get('reset') || '').trim().toLowerCase() === 'true');

    // settings helpers
    function saveSettings(patch) {
      const prevMode = (settings && typeof settings.playerMode === 'string') ? settings.playerMode : 'youtube';
      settings = settingsStore.patch(patch);
      if (patch && typeof patch.spotifyClientId === 'string') {
        try { spotifyAuth.setClientId(patch.spotifyClientId); } catch { /* ignore */ }
      }
      const nextMode = (settings && typeof settings.playerMode === 'string') ? settings.playerMode : 'youtube';
      if (patch && typeof patch.playerMode === 'string' && nextMode !== prevMode) {
        handlePlayerModeChanged(prevMode, nextMode);
      }
    }

    function getPlayerMode() {
      const mode = (settings && typeof settings.playerMode === 'string') ? settings.playerMode : 'youtube';
      return (mode === 'local' || mode === 'spotify') ? mode : 'youtube';
    }

    function buildLocalVideoUrlForItem(item) {
      const activePlaylistId = (settings && typeof settings.playlistId === 'string') ? settings.playlistId.trim() : '';

      const preferredLocalPlaylistUri = (settings && typeof settings.localPlaylistUri === 'string' && settings.localPlaylistUri.trim().length)
        ? settings.localPlaylistUri.trim()
        : '';

      const playlistEntry = (Array.isArray(playlistLibrary) && activePlaylistId)
        ? (playlistLibrary.find((e) => e && typeof e === 'object' && e.id === activePlaylistId) || null)
        : null;

      const playlistUri = (playlistEntry && playlistEntry.type === 'polaris' && typeof playlistEntry.uri === 'string' && playlistEntry.uri.trim().length)
        ? playlistEntry.uri.trim()
        : '';

      const videoId = (item && (typeof item.videoId === 'string' || typeof item.videoId === 'number'))
        ? String(item.videoId).trim()
        : '';
      const spotifyId = (item && (typeof item.spotifyId === 'string' || typeof item.spotifyId === 'number'))
        ? String(item.spotifyId).trim()
        : '';
      const fallbackId = (item && (typeof item.id === 'string' || typeof item.id === 'number'))
        ? String(item.id).trim()
        : '';

      const chosenId = videoId || spotifyId || fallbackId || 'unmatched';
      const base = 'vid_' + chosenId;
      try {
        const baseUrl = (() => {
          const effectivePlaylistUri = preferredLocalPlaylistUri || playlistUri;
          if (!effectivePlaylistUri) return new URL('./video/', window.location.href);
          const playlistUrl = new URL(effectivePlaylistUri, window.location.href);
          return new URL('./', playlistUrl);
        })();
        return new URL(`${encodeURIComponent(base)}.mp4`, baseUrl).toString();
      } catch {
        return `./video/${encodeURIComponent(base)}.mp4`;
      }
    }

    filterStateStore = new FilterStateStore({
      getSettings: () => settings,
      saveSettings: (patch) => saveSettings(patch)
    });
    ({ filterText, onlyMarked, artistFilters, countryFilters } = filterStateStore.snapshot());

    trackDetailStore = new TrackDetailSettingsStore({
      defaults: DEFAULT_TRACK_DETAILS,
      getSettings: () => settings,
      saveSettings: (patch) => saveSettings(patch)
    });
    ({ preferences: trackDetailSettings, sortAlphabetically } = trackDetailStore.snapshot());

    function getCurrentVideoMap() {
      const map = settings.currentVideoMap;
      if (map && typeof map === 'object' && !Array.isArray(map)) {
        return map;
      }
      return {};
    }

    function getPlaylistItemStateMap() {
      const map = settings.playlistItemStates;
      if (map && typeof map === 'object' && !Array.isArray(map)) {
        return map;
      }
      return {};
    }

    function getTrackStateForPlaylist(playlistId, videoId) {
      if (!playlistId || !videoId) return TRACK_STATE_DEFAULT;
      const playlists = getPlaylistItemStateMap();
      const entry = playlists[playlistId];
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        return entry[videoId] === TRACK_STATE_CHECKED ? TRACK_STATE_CHECKED : TRACK_STATE_DEFAULT;
      }
      return TRACK_STATE_DEFAULT;
    }

    function setTrackStateForPlaylist(playlistId, videoId, state) {
      if (!playlistId || !videoId) return TRACK_STATE_DEFAULT;
      const playlists = getPlaylistItemStateMap();
      const nextStates = { ...playlists };
      const playlistStates = playlists[playlistId] && typeof playlists[playlistId] === 'object'
        ? { ...playlists[playlistId] }
        : {};

      if (state === TRACK_STATE_DEFAULT) {
        delete playlistStates[videoId];
      } else {
        playlistStates[videoId] = TRACK_STATE_CHECKED;
      }

      if (Object.keys(playlistStates).length === 0) {
        delete nextStates[playlistId];
      } else {
        nextStates[playlistId] = playlistStates;
      }

      saveSettings({ playlistItemStates: nextStates });
      return state;
    }

    function syncCenterMarkTrackButton() {
      const btn = document.getElementById('centerMarkBtn');
      const icon = document.getElementById('centerMarkIcon');
      if (!(btn instanceof HTMLElement)) return;
      if (!(icon instanceof HTMLElement)) return;

      const activePlaylistId = getActivePlaylistId();
      const activeItem = (currentIndex >= 0 && playlistItems[currentIndex]) ? playlistItems[currentIndex] : null;
      const videoId = activeItem && activeItem.videoId ? String(activeItem.videoId) : '';
      const checked = !!(activePlaylistId && videoId && isTrackChecked(activePlaylistId, videoId));

      try {
        if (!activePlaylistId || !videoId) {
          btn.setAttribute('aria-disabled', 'true');
          btn.setAttribute('aria-pressed', 'false');
          btn.setAttribute('aria-label', 'Mark track');
          btn.title = 'Mark track';
          icon.className = 'icon fill-0 circle';
          icon.textContent = 'circle';
          return;
        }

        btn.removeAttribute('aria-disabled');
        btn.setAttribute('aria-pressed', checked ? 'true' : 'false');
        if (checked) {
          btn.setAttribute('aria-label', 'Mark video as incomplete');
          btn.title = 'Mark video as incomplete';
          icon.className = 'icon fill-0 check-circle';
          icon.textContent = 'check_circle';
        } else {
          btn.setAttribute('aria-label', 'Mark video as completed');
          btn.title = 'Mark video as completed';
          icon.className = 'icon fill-0 circle';
          icon.textContent = 'circle';
        }
      } catch { /* ignore */ }
    }

    function syncCenterTrackInfo() {
      const titleEl = document.getElementById('centerTrackTitle');
      const artistLineEl = document.getElementById('centerTrackArtistLine');
      const artistEl = document.getElementById('centerTrackArtist');
      if (!(titleEl instanceof HTMLElement)) return;

      const artistContainerEl = (artistLineEl instanceof HTMLElement)
        ? artistLineEl
        : (artistEl instanceof HTMLElement && artistEl.parentElement instanceof HTMLElement)
            ? artistEl.parentElement
            : null;

      const item = (currentIndex >= 0 && playlistItems[currentIndex]) ? playlistItems[currentIndex] : null;
      if (!item) {
        titleEl.textContent = '–';
        if (artistEl instanceof HTMLElement) {
          artistEl.textContent = '';
        } else if (artistLineEl instanceof HTMLElement) {
          artistLineEl.textContent = '';
        }
        if (artistContainerEl instanceof HTMLElement) {
          artistContainerEl.style.display = 'none';
        }
        return;
      }

      const rawTitle = (typeof item.userTitle === 'string' && item.userTitle.trim().length)
        ? item.userTitle
        : (item.title || '');

      const parts = splitTrackDisplayText(rawTitle);
      const titleText = parts.title || rawTitle || '';
      const artistText = parts.artist || '';

      titleEl.textContent = titleText;
      if (artistEl instanceof HTMLElement) {
        artistEl.textContent = artistText;
      } else if (artistLineEl instanceof HTMLElement) {
        artistLineEl.textContent = artistText;
      }
      if (artistContainerEl instanceof HTMLElement) {
        artistContainerEl.style.display = artistText ? '' : 'none';
      }
    }

    function toggleTrackStateForPlaylist(playlistId, videoId) {
      if (!playlistId || !videoId) return TRACK_STATE_DEFAULT;
      const current = getTrackStateForPlaylist(playlistId, videoId);
      const next = current === TRACK_STATE_CHECKED ? TRACK_STATE_DEFAULT : TRACK_STATE_CHECKED;
      setTrackStateForPlaylist(playlistId, videoId, next);

      try { syncCenterMarkTrackButton(); } catch { /* ignore */ }

      if (onlyMarked) {
        computeFilteredIndices();
        renderTrackList({ preserveScroll: true });
      }
      return next;
    }

    function getActivePlaylistId() {
      return typeof settings.playlistId === 'string' ? settings.playlistId : '';
    }

    function isTrackChecked(playlistId, videoId) {
      return getTrackStateForPlaylist(playlistId, videoId) === TRACK_STATE_CHECKED;
    }

    function updateCurrentVideo(playlistId, videoId) {
      if (!playlistId || !videoId) {
        return;
      }
      const map = getCurrentVideoMap();
      map[playlistId] = videoId;
      saveSettings({ currentVideoMap: map });
    }

    function migrateLegacySettings() {
      const legacyPlaylistId =
        typeof settings.playlistId === 'string' ? settings.playlistId.trim() : '';
      const legacyVideoId =
        typeof settings.currentVideoId === 'string' ? settings.currentVideoId.trim() : '';
      if (!legacyPlaylistId || !legacyVideoId) {
        return;
      }
      const map = getCurrentVideoMap();
      if (!map[legacyPlaylistId]) {
        map[legacyPlaylistId] = legacyVideoId;
      }
      delete settings.currentVideoId;
      saveSettings({ currentVideoMap: map });
    }

    migrateLegacySettings();

    // DOM refs
    const sidebarMenuBtn = document.getElementById('sidebarMenuBtn');
    const playlistIOBtn = document.getElementById('playlistIOBtn');
    const filterInputEl = document.getElementById('filterInput');
    const filterWrapper = document.getElementById('filterWrapper');
    const clearFilterBtn = document.getElementById('clearFilterBtn');
    const combinedFilterWrapper = document.getElementById('combinedFilterWrapper');
    const combinedFilterBtn = document.getElementById('combinedFilterBtn');
    const combinedFilterOverlay = document.getElementById('combinedFilterOverlay');
    const filtersResetBtn = document.getElementById('filtersResetBtn');
    const markedOnlyCheckbox = document.getElementById('markedOnlyCheckbox');
    const artistResetBtn = document.getElementById('artistResetBtn');
    const countryResetBtn = document.getElementById('countryResetBtn');
    const markedFilterHeading = document.getElementById('markedFilterHeading');
    const artistFilterHeading = document.getElementById('artistFilterHeading');
    const countryFilterHeading = document.getElementById('countryFilterHeading');
    const artistFilterOptions = document.getElementById('artistFilterOptions');
    const countryFilterOptions = document.getElementById('countryFilterOptions');
    const fullscreenBtn = document.getElementById('fullscreenBtn');
    const fullscreenIcon = document.getElementById('fullscreenIcon');
    const shuffleBtn = document.getElementById('shuffleBtn');
    const shuffleIcon = document.getElementById('shuffleIcon');
    const thumbToggleBtn = document.getElementById('thumbToggleBtn');
    const thumbToggleIcon = document.getElementById('thumbToggleIcon');
    const trackDetailsWrapper = document.getElementById('trackDetailsWrapper');
    const trackDetailsOverlay = document.getElementById('trackDetailsOverlay');
    const detailTrackNumberCheckbox = document.getElementById('detailTrackNumber');
    const detailThumbnailCheckbox = document.getElementById('detailThumbnail');
    const detailNoAudioCheckbox = document.getElementById('detailNoAudio');
    const detailWrapLinesCheckbox = document.getElementById('detailWrapLines');
    const detailCountryCheckbox = document.getElementById('detailCountry');
    const detailCheckTrackCheckbox = document.getElementById('detailCheckTrack');
    const detailShowFilteredCheckbox = document.getElementById('detailShowFiltered');
    const detailSortAZCheckbox = document.getElementById('detailSortAZ');
    const detailCheckboxMap = {
      trackNumber: detailTrackNumberCheckbox,
      thumbnail: detailThumbnailCheckbox,
      noAudio: detailNoAudioCheckbox,
      wrapLines: detailWrapLinesCheckbox,
      country: detailCountryCheckbox,
      checkTrack: detailCheckTrackCheckbox,
      showFiltered: detailShowFilteredCheckbox,
      sortAZ: detailSortAZCheckbox
    };
    const progressRange = document.getElementById('progressRange');
    const timeLabel = document.getElementById('timeLabel');
    const playPauseIcon = document.getElementById('playPauseIcon');
    const trackControlsEl = document.getElementById('trackControls');
    const sidebarDrawer = document.getElementById('sidebarDrawer');
    const playerContainerEl = document.getElementById('player-container');
    const centerControlsHitEl = document.getElementById('centerControlsHit');
    const centerControlsPanelEl = document.getElementById('centerControlsPanel');
    const centerPrevBtn = document.getElementById('centerPrevBtn');
    const centerPlayPauseBtn = document.getElementById('centerPlayPauseBtn');
    const centerPlayPauseIcon = document.getElementById('centerPlayPauseIcon');
    const centerNextBtn = document.getElementById('centerNextBtn');
    const centerMarkBtn = document.getElementById('centerMarkBtn');
    const centerMarkIcon = document.getElementById('centerMarkIcon');
    const centerEdgePrevBtn = document.getElementById('centerEdgePrevBtn');
    const centerEdgeNextBtn = document.getElementById('centerEdgeNextBtn');
    const centerSidebarToggleInput = document.getElementById('centerSidebarToggleInput');
    const centerProgressRange = document.getElementById('centerProgressRange');
    const centerTimeLabel = document.getElementById('centerTimeLabel');
    const playlistHistorySelect = document.getElementById('playlistHistorySelect');
    const trackListContainerEl = document.getElementById('trackListContainer');
    const trackListEl = document.getElementById('trackList');
    const alertOverlay = document.getElementById('alertOverlay');
    const alertMessageEl = document.getElementById('alertMessage');
    const alertCloseBtn = document.getElementById('alertCloseBtn');
    const spectrumCanvas = document.getElementById('spectrumCanvas');
    const alert = createAlert({ overlayEl: alertOverlay, messageEl: alertMessageEl, closeBtn: alertCloseBtn });

    function getConfiguredVolume01() {
      // Always maximize element volume.
      // Note: this does NOT change Android system/media stream volume; it only sets the HTMLMediaElement gain (0..1).
      return 1;
    }

    let _noAudioEnabled = false;
    let _noAudioRestore = null; // { muted: boolean, volume: number }

    function _readNoAudioPreference() {
      return !!(trackDetailSettings && trackDetailSettings.noAudio);
    }

    async function _enforceNoAudioIfEnabled() {
      if (!_noAudioEnabled) return;
      if (!playerHost) return;
      const caps = playerHost.getCapabilities();
      if (caps && caps.canMute) {
        await playerHost.setMuted(true).catch(() => {});
      } else if (caps && caps.canSetVolume) {
        await playerHost.setVolume(0).catch(() => {});
      }
    }

    async function _restoreAudioIfPossible() {
      if (!playerHost) return;
      const restore = _noAudioRestore;
      const caps = playerHost.getCapabilities();

      const wantsMuted = restore && typeof restore.muted === 'boolean' ? restore.muted : false;
      const wantsVolume = getConfiguredVolume01();

      if (caps && caps.canMute) {
        await playerHost.setMuted(wantsMuted).catch(() => {});
      }

      if (!wantsMuted && caps && caps.canSetVolume) {
        await playerHost.setVolume(wantsVolume).catch(() => {});
      }
    }

    function _syncNoAudioFromPreferences({ source = 'unknown' } = {}) {
      const next = _readNoAudioPreference();
      const prev = _noAudioEnabled;
      _noAudioEnabled = next;

      if (prev === next) {
        if (next) void _enforceNoAudioIfEnabled();
        return;
      }

      if (next) {
        // Capture current audio state once so we can restore when turning it off.
        try {
          const info = playerHost ? playerHost.getInfo() : null;
          const muted = !!info?.muted;
          // We always restore to max volume when unmuting.
          _noAudioRestore = { muted, volume: getConfiguredVolume01() };
        } catch {
          _noAudioRestore = { muted: false, volume: getConfiguredVolume01() };
        }
        void _enforceNoAudioIfEnabled();
        return;
      }

      // Turning off: restore prior state if we have it.
      void _restoreAudioIfPossible().finally(() => {
        _noAudioRestore = null;
      });
      void source;
    }

    function applyConfiguredVolumeToHost() {
      if (!playerHost) return Promise.resolve(false);
      const caps = playerHost.getCapabilities();
      if (!caps || !caps.canSetVolume) {
        // Still enforce "No audio" even for adapters without volume.
        if (_noAudioEnabled) return _enforceNoAudioIfEnabled().then(() => false);
        return Promise.resolve(false);
      }

      const v = getConfiguredVolume01();
      return playerHost
        .setVolume(v)
        .catch(() => {})
        .then(() => _enforceNoAudioIfEnabled())
        .then(() => true);
    }

    async function ensureSpotifySession({ promptIfMissing = false, promptLogin = false } = {}) {
      let clientId = (settings && typeof settings.spotifyClientId === 'string') ? settings.spotifyClientId.trim() : '';
      if (!clientId && promptIfMissing) {
        const entered = window.prompt('Spotify Client ID (from Spotify Developer Dashboard):', '');
        if (entered && String(entered).trim()) {
          clientId = String(entered).trim();
          saveSettings({ spotifyClientId: clientId });
        }
      }

      try { spotifyAuth.setClientId(clientId); } catch { /* ignore */ }

      if (!clientId) {
        alert.show('Spotify mode requires a Spotify Client ID. Add it in Playlist → Video Player → Spotify Client ID (stored in PolarisPlayer.settings.spotifyClientId).');
        return false;
      }

      try {
        await spotifyAuth.getAccessToken();
        return true;
      } catch (err) {
        if (!promptLogin) {
          const msg = err && err.message ? err.message : String(err);
          alert.show(msg);
          return false;
        }
        const ok = window.confirm('Spotify is not logged in. Log in now?');
        if (!ok) {
          alert.show('Spotify login is required to use Spotify mode.');
          return false;
        }

        const spotifyRedirectUri = (() => {
          const isLocalHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
          if (isLocalHost) {
            const port = window.location.port ? `:${window.location.port}` : '';
            return `${window.location.protocol}//127.0.0.1${port}/spotify-callback.html`;
          }
          return new URL('/spotify-callback.html', window.location.origin).toString();
        })();

        try {
          if (typeof spotifyAuth.loginWithPopup === 'function') {
            const handled = await spotifyAuth.loginWithPopup({ redirectUri: spotifyRedirectUri });
            if (handled) {
              alert.show('Spotify login complete.');
              return true;
            }
            return false;
          }

          // Likely running a cached/older SpotifyAuth module. Fall back to the redirect-based login.
          spotifyAuth.redirectUri = spotifyRedirectUri;
          alert.show('Spotify login needs a hard refresh (cached JS). Falling back to redirect-based login.');
          await spotifyAuth.login();
          return false;
        } catch (loginErr) {
          const msg = loginErr && loginErr.message ? loginErr.message : String(loginErr);
          if (/popup was blocked/i.test(msg)) {
            try {
              spotifyAuth.redirectUri = spotifyRedirectUri;
              alert.show('Spotify popup was blocked. Falling back to redirect-based login.');
              await spotifyAuth.login();
              return false;
            } catch (fallbackErr) {
              const fallbackMsg = fallbackErr && fallbackErr.message ? fallbackErr.message : String(fallbackErr);
              alert.show(`Spotify login failed: ${fallbackMsg}`);
              return false;
            }
          }
          alert.show(`Spotify login failed: ${msg}`);
          return false;
        }
      }
    }

    // If we're returning from Spotify OAuth, complete the token exchange now.
    void spotifyAuth.handleRedirectCallback()
      .then((handled) => {
        if (handled) {
          alert.show('Spotify login complete.');
        }
      })
      .catch((err) => {
        const msg = err && err.message ? err.message : String(err);
        console.warn('Spotify auth callback failed:', err);
        alert.show(`Spotify login failed: ${msg}\n\nExpected Redirect URI in your Spotify app settings:\n${spotifyAuth.redirectUri}`);
      });

    const spectrum = new Spectrum({ canvas: spectrumCanvas });

    const trackListView = new TrackListView({
      ulEl: trackListEl,
      scrollContainerEl: trackListContainerEl,
      focusContainerEl: trackListContainerEl,

      getPlaylistItems: () => getPlaylistItemsForTrackList(),
      getCurrentIndex: () => currentIndex,

      getFilterText: () => filterText,
      getOnlyMarked: () => onlyMarked,
      getArtistFilters: () => artistFilters,
      getCountryFilters: () => countryFilters,
      getIsEffectivelyFiltering: () => {
        const total = Array.isArray(playlistItems) ? playlistItems.length : 0;
        const shown = Array.isArray(filteredIndices) ? filteredIndices.length : 0;
        return !!onlyMarked || (total > 0 && shown < total);
      },
      getFilteredIndices: () => filteredIndices,
      getSortAlphabetically: () => sortAlphabetically,

      getTrackDetailSettings: () => {
        return trackDetailSettings;
      },

      normalizeArtistName: (name) => normalizeArtistName(name),
      makeSortKey: (value) => makeSortKey(value),
      splitCountryCodes: (value) => splitCountryCodes(value),
      getCountryFlagEmoji: (iso3) => getCountryFlagEmoji(iso3),

      getActivePlaylistId: () => getActivePlaylistId(),
      getTrackStateForPlaylist: (playlistId, videoId) => getTrackStateForPlaylist(playlistId, videoId),
      toggleTrackStateForPlaylist: (playlistId, videoId) => toggleTrackStateForPlaylist(playlistId, videoId),
      trackStateCheckedValue: TRACK_STATE_CHECKED,

      onPlayIndex: (idx) => playIndex(idx),
      onToggleArtistFilterName: (name) => toggleArtistFilterName(name),
      onToggleCountryFilterCode: (code) => toggleCountryFilterCode(code),

      onVisibleIndicesComputed: (indices) => {
        visibleIndices = indices;
        const nextHash = hashIndexList(visibleIndices);
        if (nextHash !== visibleIndicesHash) {
          visibleIndicesHash = nextHash;
          visibleIndicesVersion += 1;
          shuffleQueue.onQueueChanged();
        }

        scheduleSpotifyArtworkPrefetchByIndices(visibleIndices);
      },
    });

    const sidebar = new Sidebar({
      sidebarMenuBtn,
      sidebarDrawer,
      isInteractionBlockingHide: () => isProgressScrubbing,
      isAutoHideEnabled: () => document.body.classList.contains('is-fullscreen'),
      allowScrollSelectors: [
        '#sidebarDrawer',
        '#trackListContainer',
        '#combinedFilterOverlay',
        '.playlist-overlay-content',
        '#alertOverlay'
      ]
    });
    const showAlert = (message) => alert.show(message);

    function focusTrackControls() {
      if (!trackControlsEl) return;
      try {
        if (!trackControlsEl.hasAttribute('tabindex')) {
          trackControlsEl.setAttribute('tabindex', '0');
        }
        trackControlsEl.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
    }

    function focusActivePlayerPane() {
      // Prefer focusing the actual active media element (<video> or <iframe>).
      const paneEl = (() => {
        try {
          const pane = playerHost ? playerHost.getMediaPane() : null;
          const el = pane && pane.element;
          return (el instanceof HTMLElement) ? el : null;
        } catch {
          return null;
        }
      })();

      if (paneEl) {
        try {
          // Ensure focus() works even if the element isn't normally tabbable.
          if (!paneEl.hasAttribute('tabindex')) paneEl.setAttribute('tabindex', '-1');
          paneEl.focus({ preventScroll: true });
          return;
        } catch {
          /* ignore */
        }
      }

      // Fallback: focus the player container.
      const playerEl = document.getElementById('player');
      if (playerEl instanceof HTMLElement) {
        try {
          if (!playerEl.hasAttribute('tabindex')) playerEl.setAttribute('tabindex', '-1');
          playerEl.focus({ preventScroll: true });
        } catch {
          /* ignore */
        }
      }
    }

    let trackListItemsCache = { version: -1, mode: '', items: [] };

    let spotifyArtworkPrefetchTimer = null;
    let spotifyArtworkPrefetchRunning = false;
    let spotifyArtworkIndicesSnapshot = [];
    let spotifyArtworkSession = 0;

    let spotifyThumbUpdateRaf = 0;
    /** @type {Map<number, string>} */
    const spotifyThumbUpdates = new Map();

    function isYouTubeThumbUrl(url) {
      const u = String(url || '');
      return u.includes('ytimg.com/') || u.includes('youtube.com/') || u.includes('youtu.be/');
    }

    function queueSpotifyThumbUpdate(idx, url) {
      if (typeof idx !== 'number') return;
      const u = String(url || '').trim();
      if (!u) return;
      spotifyThumbUpdates.set(idx, u);
      if (spotifyThumbUpdateRaf) return;
      spotifyThumbUpdateRaf = requestAnimationFrame(() => {
        spotifyThumbUpdateRaf = 0;
        for (const [i, nextUrl] of spotifyThumbUpdates.entries()) {
          try { trackListView.updateThumbnail(i, nextUrl); } catch { /* ignore */ }
        }
        spotifyThumbUpdates.clear();
      });
    }

    async function spotifyArtworkPrefetchTick(session) {
      if (spotifyArtworkPrefetchRunning) return;
      if (getPlayerMode() !== 'spotify') return;
      if (session !== spotifyArtworkSession) return;
      if (!spotifyAdapter || typeof spotifyAdapter.prefetchArtwork !== 'function') return;

      // If thumbnails are disabled, don't do background work.
      if (!trackDetailSettings || !trackDetailSettings.thumbnail) return;

      const indices = Array.isArray(spotifyArtworkIndicesSnapshot) ? spotifyArtworkIndicesSnapshot : [];
      if (!indices.length) return;

      spotifyArtworkPrefetchRunning = true;
      let hadError = false;
      let hadErrorDelayMs = 0;

      try {
        /** @type {{ idx: number, id: string }[]} */
        const pairs = [];
        const unique = new Set();
        const max = 40;

        for (let i = 0; i < indices.length && unique.size < max; i += 1) {
          const idx = indices[i];
          const item = playlistItems[idx];
          const id = item && item.spotifyId ? String(item.spotifyId).trim() : '';
          if (!id || id === 'unmatched') continue;

          // Skip if we already have a usable thumbnail (cached Spotify art or non-YouTube provided thumb).
          try {
            const track = buildTrackFromPlaylistItem(item);
            const cached = (playerHost && typeof playerHost.getThumbnailUrl === 'function')
              ? playerHost.getThumbnailUrl(track)
              : undefined;
            if (cached) continue;
          } catch {
            // ignore
          }

          const existing = (item && typeof item.thumbnail === 'string') ? item.thumbnail : '';
          if (existing && !isYouTubeThumbUrl(existing)) continue;

          if (!unique.has(id)) {
            unique.add(id);
            pairs.push({ idx, id });
          }
        }

        if (!unique.size) return;

        const ids = Array.from(unique);
        let map = new Map();
        try {
          map = (typeof spotifyAdapter.prefetchArtworkMany === 'function')
            ? await spotifyAdapter.prefetchArtworkMany(ids)
            : new Map(await Promise.all(ids.map(async (id) => [id, await spotifyAdapter.prefetchArtwork(id).catch(() => undefined)])));
        } catch (e) {
          hadError = true;
          hadErrorDelayMs = (e && typeof e.retryAfterMs === 'number') ? e.retryAfterMs : 0;
        }

        for (const { idx, id } of pairs) {
          const item = playlistItems[idx];
          if (!item) continue;

          let url = '';
          try {
            const track = buildTrackFromPlaylistItem(item);
            url = (playerHost && typeof playerHost.getThumbnailUrl === 'function')
              ? (playerHost.getThumbnailUrl(track) || '')
              : '';
          } catch {
            url = '';
          }

          if (!url && map && typeof map.get === 'function') {
            url = map.get(id) || '';
          }

          if (url) queueSpotifyThumbUpdate(idx, url);
        }
      } finally {
        spotifyArtworkPrefetchRunning = false;
      }

      // Continue fetching in small batches until we're done.
      if (getPlayerMode() !== 'spotify') return;
      if (session !== spotifyArtworkSession) return;
      const delayMs = hadError
        ? Math.max(2000, hadErrorDelayMs ? hadErrorDelayMs + 250 : 0)
        : 500;
      spotifyArtworkPrefetchTimer = setTimeout(() => {
        spotifyArtworkPrefetchTimer = null;
        void spotifyArtworkPrefetchTick(session);
      }, delayMs);
    }

    function scheduleSpotifyArtworkPrefetchByIndices(indices) {
      // Artwork warmup via Spotify Web API causes frequent 429 rate limits at scale.
      // We now rely on the Web Playback SDK state to populate artwork cache while playing.
      spotifyArtworkIndicesSnapshot = [];
      spotifyArtworkSession += 1;
      if (spotifyArtworkPrefetchTimer) {
        clearTimeout(spotifyArtworkPrefetchTimer);
        spotifyArtworkPrefetchTimer = null;
      }
      void indices;
    }

    function getThumbnailUrlForItem(item) {
      const mode = getPlayerMode();

      if (mode === 'local') {
        const localThumb = (playerHost && typeof playerHost.getThumbnailUrl === 'function')
          ? playerHost.getThumbnailUrl(buildTrackFromPlaylistItem(item))
          : '';
        return localThumb || '';
      }

      if (mode === 'spotify') {
        // If the playlist provides artwork, use it directly and do NOT touch the cache.
        const artwork = (item && typeof item.artwork === 'string') ? String(item.artwork).trim() : '';
        if (artwork) return artwork;

        // Otherwise prefer cached Spotify album art via adapter; never use YouTube thumbnails in Spotify mode.
        const cached = (playerHost && typeof playerHost.getThumbnailUrl === 'function')
          ? playerHost.getThumbnailUrl(buildTrackFromPlaylistItem(item))
          : undefined;
        if (cached) return cached;

        return './img/spotify-icon.png';
      }

      // YouTube mode: keep playlist-provided thumbnails, but provide a safe fallback.
      const existing = (item && typeof item.thumbnail === 'string') ? item.thumbnail : '';
      if (existing) return existing;
      if (playerHost && typeof playerHost.getThumbnailUrl === 'function') {
        const fallback = playerHost.getThumbnailUrl(buildTrackFromPlaylistItem(item));
        return fallback || '';
      }
      const videoId = item && item.videoId ? String(item.videoId).trim() : '';
      if (!videoId) return '';
      return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/mqdefault.jpg`;
    }

    function getPlaylistItemsForTrackList() {
      const mode = getPlayerMode();
      if (trackListItemsCache.version === playlistVersion && trackListItemsCache.mode === mode) {
        return trackListItemsCache.items;
      }
      const items = (playlistItems || []).map((it) => {
        const thumb = getThumbnailUrlForItem(it);
        if (!thumb) return it;
        // Override only what TrackListView reads.
        return { ...it, thumbnail: thumb };
      });
      trackListItemsCache = { version: playlistVersion, mode, items };
      return items;
    }

    let trackDetailsOverlayController;
    let combinedFilterOverlayController;

    const countryFilterOverlayController = new CountryFilterOverlay({
      buttonEl: null,
      overlayEl: null,
      wrapperEl: combinedFilterWrapper,
      optionsEl: countryFilterOptions,
      filterInputEl,
      getPlaylistItems: () => playlistItems,
      getFilters: () => countryFilters,
      setFilters: (next) => {
        countryFilters = filterStateStore.setCountryFilters(next);
        return countryFilters;
      },
      onFiltersChanged: () => {
        computeFilteredIndices();
        renderTrackList();
        combinedFilterOverlayController?.updateButtonState?.();
      },
      normalizeIso3: (code) => normalizeIso3(code),
      normalizeCountryFilterList: (value) => normalizeCountryFilterList(value),
      splitCountryCodes: (value) => splitCountryCodes(value),
      makeSortKey: (value) => makeSortKey(value),
      getFlagEmojiForIso3: (iso3) => getFlagEmojiForIso3(iso3),
    });

    const artistFilterOverlayController = new ArtistFilterOverlay({
      buttonEl: null,
      overlayEl: null,
      wrapperEl: combinedFilterWrapper,
      optionsEl: artistFilterOptions,
      filterInputEl,
      getPlaylistItems: () => playlistItems,
      getFilters: () => artistFilters,
      setFilters: (next) => {
        artistFilters = filterStateStore.setArtistFilters(next);
        return artistFilters;
      },
      onFiltersChanged: (renderOptions = {}) => {
        computeFilteredIndices();
        renderTrackList(renderOptions);
        combinedFilterOverlayController?.updateButtonState?.();
      },
      normalizeArtistName: (name) => normalizeArtistName(name),
      normalizeArtistKey: (name) => normalizeArtistKey(name),
      makeSortKey: (value) => makeSortKey(value),
    });

    combinedFilterOverlayController = new CombinedFilterOverlay({
      buttonEl: combinedFilterBtn,
      overlayEl: combinedFilterOverlay,
      wrapperEl: combinedFilterWrapper,
      filterInputEl,
      artistOptionsEl: artistFilterOptions,
      countryOptionsEl: countryFilterOptions,

      getIsEffectivelyFiltering: () => {
        const total = Array.isArray(playlistItems) ? playlistItems.length : 0;
        const shown = Array.isArray(filteredIndices) ? filteredIndices.length : 0;
        return !!onlyMarked || (total > 0 && shown < total);
      },

      onBeforeOpen: () => {
        if (trackDetailsOverlayController && trackDetailsOverlayController.isVisible()) {
          trackDetailsOverlayController.close();
        }
      },

      getArtistFilters: () => artistFilters,
      getCountryFilters: () => countryFilters,

      updateArtistOptions: () => artistFilterOverlayController.updateOptions(),
      updateCountryOptions: () => countryFilterOverlayController.updateOptions(),

      onArtistTypeaheadChar: (key) => artistFilterOverlayController.handleTypeaheadChar(key),
      onCountryTypeaheadChar: (key) => countryFilterOverlayController.handleTypeaheadChar(key),
    });
    combinedFilterOverlayController.setup();

    trackDetailsOverlayController = new TrackDetailsOverlay({
      wrapperEl: trackDetailsWrapper,
      overlayEl: trackDetailsOverlay,
      toggleButtonEl: thumbToggleBtn,
      toggleIconEl: thumbToggleIcon,
      checkboxMap: detailCheckboxMap,
      defaults: DEFAULT_TRACK_DETAILS,

      getPreferences: () => trackDetailSettings,
      setPreferences: (next) => {
        trackDetailSettings = next;
        return trackDetailSettings;
      },
      persistPreferences: (next) => {
        // Persist the preferences the overlay just set.
        trackDetailSettings = trackDetailStore.setPreferences(next);

        // Always sync audio enforcement from current preferences.
        _syncNoAudioFromPreferences({ source: 'track-details-overlay' });
        return trackDetailSettings;
      },

      getSortAlphabetically: () => sortAlphabetically,
      setSortAlphabetically: (next) => {
        sortAlphabetically = trackDetailStore.setSortAlphabetically(next);
        return sortAlphabetically;
      },

      renderTrackList: (options) => renderTrackList(options),

      onBeforeOpen: () => {
        if (combinedFilterOverlayController && combinedFilterOverlayController.isVisible()) {
          combinedFilterOverlayController.close();
        }
      },
    });
    trackDetailsOverlayController.setup();

    // Initialize "No audio" state from persisted preferences.
    _noAudioEnabled = _readNoAudioPreference();

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        let handled = false;
        handled = alert.handleEscape(event) || handled;
        if (trackDetailsOverlayController && trackDetailsOverlayController.isVisible()) {
          trackDetailsOverlayController.close({ focusButton: !handled });
          handled = true;
        }
        if (combinedFilterOverlayController && combinedFilterOverlayController.isVisible()) {
          combinedFilterOverlayController.close({ focusButton: !handled });
          handled = true;
        }
        if (handled) {
          event.preventDefault();
        }
      }
    });

    function getLocalPlaylistOptions() {
      const list = Array.isArray(playlistLibrary) ? playlistLibrary : [];
      const options = list
        .filter((e) => e && typeof e === 'object' && e.type === 'polaris')
        .map((e) => ({ id: e.id, title: e.title || e.id }));
      options.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
      return options;
    }

    function updateUrlPlaylistParam(playlistId) {
      if (!window || !window.history || typeof window.history.replaceState !== 'function') {
        return;
      }
      try {
        const url = new URL(window.location.href);
        if (!hadInitialPlaylistParam) {
          url.searchParams.delete('pl');
        } else if (playlistId) {
          url.searchParams.set('pl', playlistId);
        } else {
          url.searchParams.delete('pl');
        }
        window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
      } catch (err) {
        console.warn('Failed to update playlist URL parameter:', err);
      }
    }

    function updatePlaylistHistorySelect(selectedId = '') {
      if (!playlistHistorySelect) return;

      playlistHistorySelect.innerHTML = '';

      const localOptions = useLocalMode ? getLocalPlaylistOptions() : [];
      const useLocalOptions = useLocalMode && localOptions.length > 0;
      const options = useLocalOptions
        ? localOptions
        : (Array.isArray(playlistLibrary) ? playlistLibrary : [])
          .filter((e) => e && typeof e === 'object' && e.type !== 'polaris')
          .map((entry) => ({ id: entry.id, title: entry.title }));

      if (!options.length) {
        playlistHistorySelect.disabled = true;
        playlistHistorySelect.title = useLocalMode
          ? 'No local playlists available'
          : 'No saved playlists yet';
        playlistHistorySelect.value = '';
        return;
      }

      playlistHistorySelect.disabled = false;
      playlistHistorySelect.title = useLocalOptions
        ? 'Select a local playlist'
        : 'Select a saved playlist';

      let matched = false;
      options.forEach((entry) => {
        const option = document.createElement('option');
        option.value = entry.id;
        option.textContent = entry.title;
        if (entry.id === selectedId) {
          option.selected = true;
          matched = true;
        }
        playlistHistorySelect.appendChild(option);
      });

      if (!matched) {
        playlistHistorySelect.selectedIndex = 0;
      }
    }

    function addPlaylistToHistory(id, title, meta = {}) {
      const cleanedId = String(id || '').trim();
      if (!cleanedId) return;
      const cleanedTitle = String(title || '').trim() || cleanedId;

      const inferredType = (() => {
        const raw = String(meta.type || '').trim().toLowerCase();
        if (raw === 'polaris' || raw === 'youtube' || raw === 'spotify') return raw;
        if (useLocalMode) return 'polaris';
        const mode = getPlayerMode();
        return mode === 'spotify' ? 'spotify' : 'youtube';
      })();

      const uri = (typeof meta.uri === 'string' && meta.uri.trim().length)
        ? meta.uri.trim()
        : (inferredType === 'polaris' ? `./video/${cleanedId}.json` : cleanedId);

      const fetchedAt = (typeof meta.fetchedAt === 'string' && meta.fetchedAt.trim().length)
        ? meta.fetchedAt.trim()
        : new Date().toISOString();

      const entry = {
        id: cleanedId,
        title: cleanedTitle,
        uri,
        fetchedAt,
        default: !!meta.default,
        type: inferredType,
      };

      playlistLibraryStore.upsert(entry);
      playlistLibrary = playlistLibraryStore.get();
      updatePlaylistHistorySelect(cleanedId);
    }

    function removePlaylistFromHistory(id) {
      const cleanedId = String(id || '').trim();
      if (!cleanedId) return;
      playlistLibraryStore.remove(cleanedId);
      playlistLibrary = playlistLibraryStore.get();
      const patch = {};
      const map = getCurrentVideoMap();
      if (map[cleanedId]) {
        const nextMap = { ...map };
        delete nextMap[cleanedId];
        patch.currentVideoMap = nextMap;
      }
      const itemStates = getPlaylistItemStateMap();
      if (itemStates[cleanedId]) {
        const nextStates = { ...itemStates };
        delete nextStates[cleanedId];
        patch.playlistItemStates = nextStates;
      }
      if (Object.keys(patch).length) {
        saveSettings(patch);
      }
      updatePlaylistHistorySelect('');
    }

    function resetStoredSettings() {
      try {
        settingsStore.reset();
      } catch (error) {
        console.warn('Failed to clear stored settings:', error);
        throw error;
      }

      settings = settingsStore.get();
      playlistLibraryStore.replace([], { persist: false });
      playlistLibrary = playlistLibraryStore.get();
      updatePlaylistHistorySelect('');

      shuffleQueue.setEnabled(true);
      updateShuffleButtonState();

      filterText = '';
      if (filterStateStore) {
        filterStateStore.resetInMemory();
      }
      if (filterInputEl) {
        filterInputEl.value = '';
      }

      countryFilters = [];
      countryFilterOverlayController.updateOptions();
      combinedFilterOverlayController?.updateButtonState?.();

      artistFilters = [];
      artistFilterOverlayController.updateOptions();
      combinedFilterOverlayController?.updateButtonState?.();

      if (combinedFilterOverlayController && combinedFilterOverlayController.isVisible()) {
        combinedFilterOverlayController.close();
      }

      if (trackDetailStore) {
        ({ preferences: trackDetailSettings, sortAlphabetically } = trackDetailStore.resetInMemory());
      } else {
        trackDetailSettings = { ...DEFAULT_TRACK_DETAILS };
        sortAlphabetically = false;
      }
      trackDetailsOverlayController.applyPreferences();
      trackDetailsOverlayController.syncControls();
      trackDetailsOverlayController.close();
      updateFilterWrapperClass();

      filteredIndices = [];
      computeFilteredIndices();
      renderTrackList();
      updateNowPlaying();
      updatePlayPauseButton();

      try {
        notifySettingsUpdated();
      } catch (notifyError) {
        console.warn('Settings overlay update failed:', notifyError);
      }

      return true;
    }

    updatePlaylistHistorySelect(settings.playlistId || '');

    if (playlistHistorySelect) {
      playlistHistorySelect.addEventListener('change', () => {
        const selectedId = playlistHistorySelect.value;
        if (!selectedId) return;
        saveSettings({ playlistId: selectedId });
        loadPlaylistFromServer(false, selectedId);
      });
    }

    // viewport height adjustments for mobile browsers with dynamic toolbars
    function updateViewportHeight() {
      // In Android WebView, visualViewport.height can transiently report 0, which would
      // collapse any `height: calc(var(--app-vh, 1vh) * 100)` layouts to 0px.
      const vv = window.visualViewport;
      const vvH = vv && typeof vv.height === 'number' ? vv.height : 0;
      const innerH = typeof window.innerHeight === 'number' ? window.innerHeight : 0;

      // Prefer visualViewport when it looks sane; otherwise fall back to innerHeight.
      const baseH = (vvH >= 100 ? vvH : innerH);
      if (!baseH || baseH < 100) {
        // Let CSS fallback (`var(--app-vh, 1vh)`) apply.
        document.documentElement.style.removeProperty('--app-vh');
        return;
      }

      const vh = baseH * 0.01;
      document.documentElement.style.setProperty('--app-vh', `${vh}px`);
    }

    updateViewportHeight();
    window.addEventListener('resize', updateViewportHeight);
    window.addEventListener('orientationchange', updateViewportHeight);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', updateViewportHeight);
      window.visualViewport.addEventListener('scroll', updateViewportHeight);
    }

    // init from settings (handled by stores)
    if (filterInputEl) {
      filterInputEl.value = filterText;
    }
    updateFilterWrapperClass();
    trackDetailsOverlayController.applyPreferences();
    trackDetailsOverlayController.syncControls();
    trackDetailsOverlayController.updateToggleButtonState();

    function makeSortKey(value) {
      return TextUtils.makeSortKey(value);
    }

    function hashIndexList(indices) {
      if (!Array.isArray(indices) || indices.length === 0) return 0;
      let h = 2166136261;
      for (let i = 0; i < indices.length; i += 1) {
        h ^= (indices[i] | 0);
        h = Math.imul(h, 16777619);
      }
      h ^= indices.length;
      return h | 0;
    }

    function shuffleArrayInPlace(arr) {
      for (let i = arr.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
      }
      return arr;
    }

    function updateShuffleButtonState() {
      if (!shuffleBtn) return;
      shuffleBtn.classList.toggle('active', shuffleQueue.isEnabled());
      shuffleBtn.setAttribute('aria-pressed', String(shuffleQueue.isEnabled()));
      if (shuffleIcon) {
        shuffleIcon.className = 'icon shuffle';
        shuffleIcon.textContent = 'shuffle';
      }
    }

    function getFullscreenElement() {
      return document.fullscreenElement || document.webkitFullscreenElement || null;
    }

    function isPseudoFullscreen() {
      return document.body.classList.contains('pseudo-fullscreen');
    }

    function isAppFullscreen() {
      return !!getFullscreenElement() || isPseudoFullscreen();
    }

    let _lastAppFullscreen = isAppFullscreen();
    let _sidebarHiddenBeforeFullscreen = sidebar ? sidebar.isHidden() : false;

    function requestFullscreenFor(el) {
      if (!el) return null;
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (typeof req === 'function') {
        try {
          return req.call(el);
        } catch (e) {
          console.warn('Failed to request fullscreen:', e);
        }
      }
      return null;
    }

    function exitFullscreen() {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (typeof exit === 'function') {
        try {
          exit.call(document);
        } catch (e) {
          console.warn('Failed to exit fullscreen:', e);
        }
      }
    }

    function setPseudoFullscreen(enabled) {
      document.body.classList.toggle('pseudo-fullscreen', !!enabled);
      handleFullscreenChange();
    }

    function updateFullscreenButtonState() {
      if (!fullscreenBtn) return;
      const isFs = isAppFullscreen();
      fullscreenBtn.classList.toggle('active', isFs);
      fullscreenBtn.setAttribute('aria-pressed', String(isFs));
      fullscreenBtn.setAttribute('aria-label', isFs ? 'Exit fullscreen' : 'Enter fullscreen');
      if (fullscreenIcon) {
        fullscreenIcon.className = 'icon fullscreen';
        fullscreenIcon.textContent = isFs ? 'fullscreen_exit' : 'fullscreen';
      }
    }

    let isProgressScrubbing = false;
    let seekFeedbackHideTimer = null;

    // Local playback: some browsers can lag/omit state transitions while time still advances.
    // Track recent time progression to infer playing/paused for the play/pause button.
    let lastLocalPositionMs = 0;
    let lastLocalTimeAdvanceAt = 0;

    function setSeekFeedbackVisible(visible) {
      void visible;
      // TEMP: seek swipe overlay removed.
    }

    function updateSeekFeedbackFromFraction(frac) {
      void frac;
      // TEMP: seek swipe overlay removed.
    }

    function scheduleSeekFeedbackFadeOut(delayMs = 0) {
      if (seekFeedbackHideTimer) {
        clearTimeout(seekFeedbackHideTimer);
        seekFeedbackHideTimer = null;
      }
      const delay = Math.max(0, delayMs || 0);
      seekFeedbackHideTimer = setTimeout(() => {
        seekFeedbackHideTimer = null;
        setSeekFeedbackVisible(false);
      }, delay);
    }

    const CURSOR_IDLE_HIDE_DELAY_MS = 5000;
    let _cursorIdleHideTimer = null;
    let _cursorIdleListenersAttached = false;
    let _cursorWakeOverlay = null;
    let _cursorWakeOverlayListenersAttached = false;

    function clearCursorIdleTimer() {
      if (_cursorIdleHideTimer) {
        clearTimeout(_cursorIdleHideTimer);
        _cursorIdleHideTimer = null;
      }
    }

    function ensureCursorWakeOverlay() {
      if (_cursorWakeOverlay) return _cursorWakeOverlay;
      const el = document.createElement('div');
      el.id = 'cursorWakeOverlay';
      el.setAttribute('aria-hidden', 'true');
      el.style.position = 'fixed';
      el.style.inset = '0';
      el.style.zIndex = '2147483647';
      el.style.display = 'none';
      el.style.cursor = 'none';
      el.style.background = 'transparent';
      el.style.pointerEvents = 'auto';
      // Prevent text selection/magnifier on iOS while cursor is hidden.
      el.style.webkitUserSelect = 'none';
      el.style.userSelect = 'none';
      document.body.appendChild(el);
      _cursorWakeOverlay = el;
      return el;
    }

    function showCursor() {
      document.body.classList.remove('cursor-hidden');
      if (_cursorWakeOverlay) {
        _cursorWakeOverlay.style.display = 'none';
      }
    }

    function hideCursor() {
      document.body.classList.add('cursor-hidden');
      const overlay = ensureCursorWakeOverlay();
      overlay.style.display = 'block';
    }

    function scheduleCursorIdleHide() {
      clearCursorIdleTimer();
      _cursorIdleHideTimer = setTimeout(() => {
        _cursorIdleHideTimer = null;
        if (!isAppFullscreen()) {
          showCursor();
          return;
        }
        hideCursor();
      }, CURSOR_IDLE_HIDE_DELAY_MS);
    }

    function onFullscreenPointerActivity() {
      if (!isAppFullscreen()) return;
      // Always show immediately on movement.
      showCursor();
      scheduleCursorIdleHide();
    }

    function startFullscreenCursorAutoHide() {
      if (_cursorIdleListenersAttached) return;
      _cursorIdleListenersAttached = true;

      showCursor();
      scheduleCursorIdleHide();

      // Use capture so we still see movement early in the event chain.
      window.addEventListener('pointermove', onFullscreenPointerActivity, { passive: true, capture: true });
      window.addEventListener('mousemove', onFullscreenPointerActivity, { passive: true, capture: true });
      // If the cursor is hidden while over a cross-origin iframe, we won't receive
      // pointer events from inside it. The overlay (enabled only when hidden)
      // ensures movement wakes the cursor reliably.
      const overlay = ensureCursorWakeOverlay();
      if (!_cursorWakeOverlayListenersAttached) {
        _cursorWakeOverlayListenersAttached = true;
        overlay.addEventListener('pointermove', onFullscreenPointerActivity, { passive: true });
        overlay.addEventListener('mousemove', onFullscreenPointerActivity, { passive: true });
      }
    }

    function stopFullscreenCursorAutoHide() {
      if (!_cursorIdleListenersAttached) {
        showCursor();
        clearCursorIdleTimer();
        return;
      }
      _cursorIdleListenersAttached = false;
      clearCursorIdleTimer();
      showCursor();
      window.removeEventListener('pointermove', onFullscreenPointerActivity, true);
      window.removeEventListener('mousemove', onFullscreenPointerActivity, true);
      if (_cursorWakeOverlay) {
        _cursorWakeOverlay.style.display = 'none';
      }
    }


    function handleFullscreenChange() {
      updateFullscreenButtonState();
      const fs = isAppFullscreen();
      document.body.classList.toggle('is-fullscreen', fs);

      // Only auto-hide in fullscreen. When leaving fullscreen, restore the sidebar
      // to the state it had before entering fullscreen.
      if (fs && !_lastAppFullscreen) {
        _sidebarHiddenBeforeFullscreen = sidebar ? sidebar.isHidden() : false;
        // If visible, start (or resume) the inactivity timer now that fullscreen is enabled.
        if (sidebar && !sidebar.isHidden()) sidebar.noteActivity();
      } else if (!fs && _lastAppFullscreen) {
        if (sidebar) sidebar.setHidden(!!_sidebarHiddenBeforeFullscreen);
      }
      _lastAppFullscreen = fs;

      // Cursor hide/show in fullscreen is driven by the center overlay idle timer.
      if (!fs) {
        stopFullscreenCursorAutoHide();
      } else {
        // Ensure visible on entry; idle hide happens via overlay.
        showCursor();
        clearCursorIdleTimer();
      }
    }



    function toggleShuffleMode() {
      shuffleQueue.toggle();
      saveSettings({ shuffleEnabled: shuffleQueue.isEnabled() });
      updateShuffleButtonState();
    }

    function normalizeArtistName(name) {
      return TextUtils.normalizeArtistName(name);
    }

    function normalizeArtistKey(name) {
      return TextUtils.normalizeArtistKey(name);
    }

    function normalizeArtistFilterList(value) {
      if (!Array.isArray(value)) return [];
      const out = [];
      const seen = new Set();
      value.forEach((entry) => {
        const cleaned = normalizeArtistName(entry);
        if (!cleaned) return;
        const key = normalizeArtistKey(cleaned);
        if (!key) return;
        if (seen.has(key)) return;
        seen.add(key);
        out.push(cleaned);
      });
      return out;
    }

    function toggleArtistFilterName(name) {
      artistFilterOverlayController.toggleName(name, { preserveScroll: true, skipActiveScroll: true });
    }

    function normalizeCountryFilterList(value) {
      if (!Array.isArray(value)) return [];
      const out = [];
      const seen = new Set();
      value.forEach((entry) => {
        const code = normalizeIso3(entry);
        if (!code) return;
        if (seen.has(code)) return;
        seen.add(code);
        out.push(code);
      });
      return out;
    }

    function normalizeIso3(code) {
      return filterStateStore
        ? filterStateStore.normalizeIso3(code)
        : (code || '').trim().toUpperCase();
    }

    function splitCountryCodes(value) {
      if (typeof value !== 'string') return [];
      return value
        .split(';')
        .map((part) => normalizeIso3(part))
        .filter(Boolean);
    }

    function getCountryFlagEmoji(iso3) {
      if (iso3 === '?') return '🏳️';
      return getFlagEmojiForIso3(iso3);
    }

    function toggleCountryFilterCode(code) {
      countryFilterOverlayController.toggleCode(code);
    }

    // TrackDetailsOverlay logic extracted to TrackDetailsOverlay.mjs

    function getPlayerInfo() {
      return playerHost ? playerHost.getInfo() : {
        state: 'idle',
        muted: false,
        volume: 1,
        rate: 1,
        time: { positionMs: 0, durationMs: undefined, bufferedMs: undefined },
        activeTrackId: undefined,
      };
    }

    function getPlayerDurationSeconds() {
      const ms = getPlayerInfo().time.durationMs;
      return typeof ms === 'number' && isFinite(ms) && ms > 0 ? ms / 1000 : 0;
    }

    function getPlayerCurrentTimeSeconds() {
      const ms = getPlayerInfo().time.positionMs;
      return typeof ms === 'number' && isFinite(ms) && ms > 0 ? ms / 1000 : 0;
    }

    function getActiveTrackId() {
      return getPlayerInfo().activeTrackId || '';
    }

    // End-of-track auto-advance can be reported via both a state transition and a separate
    // `ended` event (e.g. YouTube). Debounce so we never advance twice for the same track.
    let _lastEndedAdvanceKey = '';
    let _lastEndedAdvanceAt = 0;
    let _suppressEndedAutoAdvanceUntilMs = 0;

    function _autoAdvanceFromEnded({ shouldAutoScroll = false } = {}) {
      const now = Date.now();
      // After we advance, some players can still emit a late duplicate "ended" signal.
      // If the index has already changed, the per-track debounce key may differ, causing a
      // second advance (skipping the next track). A short global suppression window prevents that.
      if (now < _suppressEndedAutoAdvanceUntilMs) {
        return;
      }
      const trackId = getActiveTrackId();
      const key = `${currentIndex}:${trackId || ''}`;
      if (key && key === _lastEndedAdvanceKey && now - _lastEndedAdvanceAt < 1500) {
        return;
      }
      _lastEndedAdvanceKey = key;
      _lastEndedAdvanceAt = now;

      // Keep the UI in "playing" while the next track is loading to avoid flicker.
      holdPlayingUiUntilMs = now + 2500;

      const advanced = playNext({ keepPlayingUi: true });
      _suppressEndedAutoAdvanceUntilMs = now + 2000;
      if (!advanced) {
        isPlaying = false;
        updatePlayPauseButton();
      } else {
        isPlaying = true;
        updatePlayPauseButton();
      }

      // Keep the active row visible, but don't steal focus from controls.
      if (shouldAutoScroll) {
        scrollActiveIntoView({ guardUserScroll: true });
        lastAutoScrollIndex = currentIndex;
      }

      spectrum.stop();
    }

    function seekToSeconds(seconds) {
      if (!playerHost) return;
      const s = Number(seconds);
      if (!isFinite(s)) return;
      void playerHost.seekToMs(Math.max(0, Math.floor(s * 1000)));
    }

    function supportsMediaSession() {
      try {
        return typeof navigator !== 'undefined'
          && !!navigator.mediaSession
          && typeof window !== 'undefined'
          && typeof window.MediaMetadata === 'function';
      } catch {
        return false;
      }
    }

    function buildAbsoluteUrl(url) {
      const u = String(url || '').trim();
      if (!u) return '';
      try { return new URL(u, window.location.href).toString(); } catch { return u; }
    }

    function getCurrentTrackForMediaSession() {
      if (currentIndex < 0 || currentIndex >= playlistItems.length) return null;
      const item = playlistItems[currentIndex];
      if (!item) return null;
      return buildTrackFromPlaylistItem(item);
    }

    function updateMediaSessionMetadata() {
      if (!supportsMediaSession()) return;
      const track = getCurrentTrackForMediaSession();
      if (!track) return;

      const isFileProtocol = (window.location && window.location.protocol === 'file:');

      // Prefer PlayerHost-derived thumbnail so Spotify can use cached/learned art.
      let artUrl = '';
      try {
        artUrl = String(playerHost?.getThumbnailUrl?.(track) || track.artworkUrl || '').trim();
      } catch {
        artUrl = String(track.artworkUrl || '').trim();
      }

      // For Spotify, always show at least the placeholder.
      if (!artUrl && getPlayerMode() === 'spotify') {
        artUrl = './img/spotify-icon.png';
      }

      const title = String(track.title || '').trim();
      const item = playlistItems[currentIndex] || {};
      const artist = String(item.artist || item.channel || item.uploader || '').trim();

      const artwork = (!isFileProtocol && artUrl)
        ? [
            { src: buildAbsoluteUrl(artUrl), sizes: '96x96', type: 'image/png' },
            { src: buildAbsoluteUrl(artUrl), sizes: '192x192', type: 'image/png' },
            { src: buildAbsoluteUrl(artUrl), sizes: '512x512', type: 'image/png' },
          ]
        : [];

      try {
        navigator.mediaSession.metadata = new window.MediaMetadata({
          title: title || ' ',
          artist,
          album: '',
          artwork,
        });
      } catch {
        // ignore
      }
    }

    function updateMediaSessionPositionState(force = false) {
      if (!supportsMediaSession()) return;
      const now = Date.now();
      if (!force && now - lastMediaPositionUpdateAt < 1000) return;
      lastMediaPositionUpdateAt = now;

      const info = getPlayerInfo();
      const pos = Number(info?.time?.positionMs) || 0;
      const dur = Number(info?.time?.durationMs) || 0;
      const rate = Number(info?.rate) || 1;

      if (!(dur > 0)) return;
      try {
        navigator.mediaSession.setPositionState({
          duration: dur / 1000,
          position: Math.max(0, Math.min(dur, pos)) / 1000,
          playbackRate: rate,
        });
      } catch {
        // ignore
      }
    }

    function setupMediaSessionHandlers() {
      if (!supportsMediaSession()) return;
      if (mediaSessionInitialized) return;
      mediaSessionInitialized = true;

      const ms = navigator.mediaSession;
      const safe = (action, handler) => {
        try { ms.setActionHandler(action, handler); } catch { /* ignore */ }
      };

      safe('play', () => {
        sidebar.suppressHide(1500);
        void playerHost?.play?.().catch(() => {});
        isPlaying = true;
        updatePlayPauseButton();
      });
      safe('pause', () => {
        sidebar.suppressHide(1500);
        void playerHost?.pause?.().catch(() => {});
        isPlaying = false;
        updatePlayPauseButton();
      });
      safe('nexttrack', () => playNext({ keepPlayingUi: true }));
      safe('previoustrack', () => playPrev());

      // Prefer prev/next over 10s skip controls on iOS.
      safe('seekbackward', null);
      safe('seekforward', null);

      // Allow scrub bar seeks.
      safe('seekto', (details) => {
        const t = details && typeof details.seekTime === 'number' ? details.seekTime : NaN;
        if (!isFinite(t)) return;
        seekToSeconds(t);
      });
    }

    function buildTrackFromPlaylistItem(item) {
      const videoId = item && item.videoId ? String(item.videoId).trim() : '';
      const mode = getPlayerMode();
      const spotifyId = item && item.spotifyId ? String(item.spotifyId).trim() : '';

      const itemArtwork = (item && typeof item.artwork === 'string') ? String(item.artwork).trim() : '';
      return {
        id: videoId,
        title: item?.userTitle || item?.title || '',
        source: (mode === 'local')
          ? { kind: 'file', url: buildLocalVideoUrlForItem(item) }
          : (mode === 'spotify')
            ? { kind: 'spotify', trackId: spotifyId || 'unmatched' }
            : { kind: 'youtube', videoId },
        ...((mode === 'spotify' && itemArtwork) ? { artworkUrl: itemArtwork } : {}),
      };
    }

    function handlePlayerModeChanged(_prevMode, _nextMode) {
      if (!playerHost) return;
      if (currentIndex < 0 || !playlistItems[currentIndex]) return;

      try { centerControlsOverlayController?.updateForMode?.(_nextMode); } catch { /* ignore */ }

      const doSwitchLoad = () => {
        const autoplay = !!isPlaying;
        isPlaying = false;
        updatePlayPauseButton();
        void playerHost.stop().catch(() => {});
        void playerHost.load(buildTrackFromPlaylistItem(playlistItems[currentIndex]), { autoplay })
          .catch((err) => console.error('Player load error:', err));

        // Ensure UI reflects the new mode (e.g., hide thumbnails in local mode).
        renderTrackList();
      };

      if (_nextMode === 'spotify') {
        void ensureSpotifySession({ promptIfMissing: true, promptLogin: true })
          .then((ok) => { if (ok) doSwitchLoad(); })
          .catch((err) => console.warn('Spotify readiness failed:', err));
        return;
      }

      doSwitchLoad();

    }

    function initPlayerHost() {
      if (playerHost) return;
      playerReady = false;

      const spotifySdkName = buildSpotifySdkName();
      console.log('[Spotify] SDK player name:', spotifySdkName, {
        hostname: window.location.hostname,
        hostnameSuppressed: ['localhost', '127.0.0.1', '::1', ''].includes(String(window.location.hostname || '').trim()),
        os: _detectOsTag(),
        browser: _detectBrowserTag(),
      });
      spotifyAdapter = new SpotifyAdapter({ auth: spotifyAuth, name: spotifySdkName });

      // When Spotify artwork becomes available (learned from SDK state), update the current row thumbnail ASAP.
      // We also invalidate the playlist->thumb cache so the next render uses the newly cached art.
      try {
        if (spotifyAdapter && typeof spotifyAdapter.on === 'function') {
          spotifyAdapter.on('artwork', (payload) => {
            if (getPlayerMode() !== 'spotify') return;
            const trackId = payload && typeof payload.trackId === 'string' ? payload.trackId : '';
            const url = payload && typeof payload.url === 'string' ? payload.url : '';
            const tid = String(trackId || '').trim();
            const u = String(url || '').trim();
            if (!tid || !u) return;

            // Force thumbnail recompute on subsequent renders.
            try { trackListItemsCache.version = -1; } catch { /* ignore */ }

            const idx = currentIndex;
            const items = Array.isArray(playlistItems) ? playlistItems : [];
            const item = (idx >= 0 && idx < items.length) ? items[idx] : null;
            const itemTid = item && item.spotifyId ? String(item.spotifyId).trim() : '';
            if (!itemTid || itemTid !== tid) return;

            // Update the existing row without a full rerender.
            try { queueSpotifyThumbUpdate(idx, u); } catch { /* ignore */ }

            // Keep lock-screen artwork in sync when the current track learns art.
            try { updateMediaSessionMetadata(); } catch { /* ignore */ }
          });
        }
      } catch {
        // ignore
      }

      ytAdapter = new YouTubeAdapter({ elementId: null, controls: 0, autoplay: false });
      playerHost = new PlayerHost([
        // Let the adapter create its own mount element inside #player.
        // This avoids the YouTube API replacing the #player node itself.
        ytAdapter,
        new HtmlVideoAdapter(),
        spotifyAdapter
      ]);

      // Mount into the existing video pane element.
      const container = document.getElementById('player');
      if (container instanceof HTMLElement) {
        playerHost.mount(container);
      }

      // Spectrum expects a controller-like API with getCurrentTime() in seconds.
      spectrum.setController({
        getCurrentTime: () => getPlayerCurrentTimeSeconds(),
      });

      let firedReady = false;
      playerHost.on('state', (state) => {
        onPlayerStateChange(state);
        if (!firedReady && state === 'ready') {
          firedReady = true;
          void onPlayerReady();
          applyConfiguredVolumeToHost();
        }
      });
      playerHost.on('track', () => {
        setupMediaSessionHandlers();
        updateMediaSessionMetadata();
        updateMediaSessionPositionState(true);

        // Ensure "No audio" remains enforced across adapter switches.
        void _enforceNoAudioIfEnabled();

        // Track changes can switch adapters; refresh cover optimization.
        try { applyCoveredYouTubeOptimization(); } catch { /* ignore */ }
      });
      playerHost.on('time', () => updateMediaSessionPositionState(false));
      playerHost.on('ended', () => {
        const shouldAutoScroll = currentIndex !== lastAutoScrollIndex;
        _autoAdvanceFromEnded({ shouldAutoScroll });
      });
      playerHost.on('error', (err) => {
        console.error('Player error:', err);

        if (!err || typeof err !== 'object') return;
        if (err.code !== 'YT_IFRAME_ERROR') return;
        if (err.ytCode !== 150) return;

        const dbg = (err && typeof err === 'object' && err.debug && typeof err.debug === 'object') ? err.debug : null;
        if (dbg) {
          const po = dbg.pageOrigin || '';
          const ro = dbg.runtimeOrigin || '';
          const io = dbg.iframeOriginParam || '';
          const iso = dbg.iframeSrcOrigin || '';
          console.warn(`YT 150 debug: pageOrigin=${po} runtimeOrigin=${ro} iframeOriginParam=${io} iframeSrcOrigin=${iso}`);
        }

        // ytCode 150: video cannot be played in an embedded player.
        // Auto-skip after 3s, but avoid scheduling multiple skips for the same failure.
        const idxAtError = currentIndex;
        const requestedVideoId = (err.request && typeof err.request.videoId === 'string') ? err.request.videoId : '';
        const currentVideoId = (playlistItems[idxAtError] && typeof playlistItems[idxAtError].videoId === 'string')
          ? playlistItems[idxAtError].videoId
          : '';
        const videoId = (requestedVideoId || currentVideoId || '').trim();
        const key = `${idxAtError}:${videoId || 'unknown'}`;

        if (ytEmbedError150SkipTimer !== null && ytEmbedError150SkipKey === key) return;

        clearPendingYtEmbedError150Skip();
        ytEmbedError150SkipKey = key;
        ytEmbedError150SkipTimer = setTimeout(() => {
          ytEmbedError150SkipTimer = null;
          ytEmbedError150SkipKey = '';

          if (currentIndex !== idxAtError) return;
          if (videoId) {
            const stillVideoId = (playlistItems[currentIndex] && typeof playlistItems[currentIndex].videoId === 'string')
              ? String(playlistItems[currentIndex].videoId).trim()
              : '';
            if (stillVideoId && stillVideoId !== videoId) return;
          }

          try {
            const item = playlistItems[idxAtError];
            const title = item?.userTitle || item?.title || '';
            addYtEmbedError150({ videoId, userTitle: title });
          } catch { /* ignore */ }

          playNext();
        }, 3000);
      });
    }

    initPlayerHost();

    async function onPlayerReady() {
      playerReady = true;
      startProgressTimer();

      applyConfiguredVolumeToHost();

      try {
        await dataSourceReadyPromise;
      } catch (readyError) {
        console.warn('Data source readiness failed:', readyError);
      }

      const startupPlaylistId = initialPlaylistId || settings.playlistId;

      if (useLocalMode) {
        if (!playlistItems.length) {
          await loadPlaylistFromLocal(startupPlaylistId || '');
        }
        if (currentIndex >= 0 && playlistItems[currentIndex] && playerHost) {
          playIndex(currentIndex);
        } else {
          computeFilteredIndices();
          renderTrackList();
          updateNowPlaying();
          updatePlayPauseButton();
        }
        if (pendingPlayIndex !== null) {
          const queuedIndex = pendingPlayIndex;
          pendingPlayIndex = null;
          playIndex(queuedIndex);
        }
        return;
      }

      if (startupPlaylistId) {
        await loadPlaylistFromServer(false, startupPlaylistId);
      } else {
        computeFilteredIndices();
        renderTrackList();
        updateNowPlaying();
        updatePlayPauseButton();
      }
      if (pendingPlayIndex !== null) {
        const queuedIndex = pendingPlayIndex;
        pendingPlayIndex = null;
        playIndex(queuedIndex);
      }
    }

    function onPlayerStateChange(state) {
      const shouldAutoScroll = currentIndex !== lastAutoScrollIndex;
      if (state === 'ended') {
        _autoAdvanceFromEnded({ shouldAutoScroll });
      } else if (state === 'playing' || state === 'buffering') {
        holdPlayingUiUntilMs = 0;
        isPlaying = true;
        updatePlayPauseButton();

        // If we were re-checking a previously blocked embed, a successful play means it's recovered.
        if (ytEmbedError150CheckingVideoId) {
          const currentVideoId = (playlistItems[currentIndex] && typeof playlistItems[currentIndex].videoId === 'string')
            ? String(playlistItems[currentIndex].videoId).trim()
            : '';
          if (currentVideoId && currentVideoId === ytEmbedError150CheckingVideoId) {
            ytEmbedError150CheckingVideoId = '';
            hideVideoCheckOverlay();
            try { removeYtEmbedError150(currentVideoId); } catch { /* ignore */ }
          }
        }

        if (shouldAutoScroll) {
          scrollActiveIntoView({ guardUserScroll: true });
          lastAutoScrollIndex = currentIndex;
        }
        spectrum.start();
      } else if (state === 'paused' || state === 'ready' || state === 'idle') {
        // During auto-advance, Spotify can transiently report ready/paused.
        // Keep the pause icon until we either start playing or the hold expires.
        if (holdPlayingUiUntilMs && Date.now() < holdPlayingUiUntilMs) {
          if (isPlaying) {
            updatePlayPauseButton();
            if (shouldAutoScroll) {
              scrollActiveIntoView({ guardUserScroll: true });
              lastAutoScrollIndex = currentIndex;
            }
            sidebar.maybeHideFromPlayerStateChange(state);
            return;
          }
        }

        holdPlayingUiUntilMs = 0;
        isPlaying = false;
        updatePlayPauseButton();
        if (shouldAutoScroll) {
          scrollActiveIntoView({ guardUserScroll: true });
          lastAutoScrollIndex = currentIndex;
        }
        spectrum.stop();
      }

      // Clicking inside the YouTube iframe does not bubble to the document, but it does
      // trigger state changes. Use those to hide the sidebar after an iframe interaction.
      sidebar.maybeHideFromPlayerStateChange(state);
    }

    function updatePlayPauseButton() {
      if (!playPauseIcon) return;
      if (isPlaying) {
        playPauseIcon.className = 'icon pause';
        playPauseIcon.textContent = 'pause';

        if (centerPlayPauseIcon) {
          centerPlayPauseIcon.className = 'icon pause';
          centerPlayPauseIcon.textContent = 'pause';
        }
      } else {
        playPauseIcon.className = 'icon play';
        playPauseIcon.textContent = 'play_arrow';

        if (centerPlayPauseIcon) {
          centerPlayPauseIcon.className = 'icon play';
          centerPlayPauseIcon.textContent = 'play_arrow';
        }
      }
    }

    function computeFilteredIndices() {
      filteredIndices = computeFilteredIndicesPure({
        playlistItems,
        filterText,
        artistFilters,
        countryFilters,
        normalizeArtistKey,
        normalizeArtistName,
        normalizeCountryFilterList,
        splitCountryCodes,
      });

      if (onlyMarked) {
        const activePlaylistId = getActivePlaylistId();
        filteredIndices = (filteredIndices || []).filter((idx) => {
          const item = playlistItems && playlistItems[idx];
          const videoId = item && item.videoId;
          return !!(videoId && isTrackChecked(activePlaylistId, videoId));
        });
      }

      combinedFilterOverlayController?.updateButtonState?.();
    }

    function getSortKeyForIndex(idx) {
      const item = playlistItems[idx];
      if (!item) return '';
      const rawTitle = typeof item.userTitle === 'string' && item.userTitle.trim().length
        ? item.userTitle
        : item.title || '';
      return getSortKeyForTitle(rawTitle, makeSortKey);
    }

    function getSortedIndices(indices) {
      return indices.slice().sort((a, b) => {
        const keyA = getSortKeyForIndex(a);
        const keyB = getSortKeyForIndex(b);
        if (keyA < keyB) return -1;
        if (keyA > keyB) return 1;
        return a - b;
      });
    }

    function renderTrackList(options = {}) {
      trackListView.render(options);
    }

    function updateActiveTrackRow(previousIdx, nextIdx) {
      trackListView.updateActiveTrackRow(previousIdx, nextIdx);
    }

    function scrollActiveIntoView(options = {}) {
      trackListView.scrollActiveIntoView(options);
    }

    function focusActiveTrack(options = {}) {
      trackListView.focusActiveTrack(options);
    }

    function updateNowPlaying() {
      try { syncCenterMarkTrackButton(); } catch { /* ignore */ }
      try { syncCenterTrackInfo(); } catch { /* ignore */ }
      const titleEl = document.getElementById('nowPlaying');
      const barEl = document.getElementById('nowPlayingBar');
      const artEl = document.getElementById('nowPlayingArtwork');

      const item = (currentIndex >= 0 && playlistItems[currentIndex]) ? playlistItems[currentIndex] : null;
      if (!item) {
        if (titleEl) titleEl.textContent = '–';
        if (artEl) {
          artEl.removeAttribute('src');
          artEl.removeAttribute('srcset');
        }
        if (barEl) barEl.classList.add('no-art');

        try { spotifyAdapter?.setArtworkUrl?.(''); } catch { /* ignore */ }
        return;
      }

      if (titleEl) titleEl.textContent = item.title;

      const mode = getPlayerMode();
      if (mode !== 'spotify' || !artEl) {
        if (artEl) {
          artEl.removeAttribute('src');
          artEl.removeAttribute('srcset');
        }
        if (barEl) barEl.classList.add('no-art');

        // Also clear the main Spotify artwork pane when leaving Spotify mode.
        try { spotifyAdapter?.setArtworkUrl?.(''); } catch { /* ignore */ }
        return;
      }

      const track = buildTrackFromPlaylistItem(item);

      // If the playlist provides artwork, use it directly and do NOT touch the cache.
      const artwork = (item && typeof item.artwork === 'string') ? String(item.artwork).trim() : '';
      const cached = artwork
        ? undefined
        : ((playerHost && typeof playerHost.getThumbnailUrl === 'function')
          ? playerHost.getThumbnailUrl(track)
          : undefined);

      const url = artwork || cached || './img/spotify-icon.png';
      if (artEl.getAttribute('src') !== url) artEl.setAttribute('src', url);
      if (barEl) barEl.classList.remove('no-art');
      return;
    }

    function playIndex(idx, options = {}) {
      if (!playerHost || !playlistItems[idx]) return;

      clearPendingYtEmbedError150Skip();
      ytEmbedError150CheckingVideoId = '';
      hideVideoCheckOverlay();

      const suppressShuffleHistoryRecord = !!options.suppressShuffleHistoryRecord;
      const keepPlayingUi = !!options.keepPlayingUi;
      const playerState = getPlayerInfo().state;
      const sameIndex = currentIndex === idx;
      const targetVideoId = playlistItems[idx].videoId;
      const currentTrackId = getActiveTrackId();
      const isSameVideo = sameIndex && targetVideoId && currentTrackId === targetVideoId;
      const isActivelyPlaying = playerState === 'playing' || playerState === 'buffering';
      const previousIndex = currentIndex;

      if (isSameVideo) {
        focusActiveTrack();
        if (isActivelyPlaying) {
          return;
        }
        if (playerState === 'paused') {
          if (playerReady && playerHost) {
            sidebar.suppressHide(1500);
            void playerHost.play();
            isPlaying = true;
            updatePlayPauseButton();
            focusActiveTrack({ scroll: false });
          } else {
            console.warn('YouTube player API is not ready to resume playback; skipping play request.');
            pendingPlayIndex = idx;
          }
          return;
        }
      }

      currentIndex = idx;
      shuffleQueue.notePlayed(idx);
      shuffleQueue.recordHistory(idx, { suppress: suppressShuffleHistoryRecord });
      const videoId = targetVideoId;
      isPlaying = false;
      updateNowPlaying();

      if (!spectrum.isEnabled()) {
        spectrum.stop();
        document.body.classList.add('spectrum-missing');
        spectrum.clearCanvas();
      } else {
        // Load offline spectrum cache for this video (non-blocking).
        spectrum.loadForVideoId(videoId).then((ok) => {
          if (!ok) {
            spectrum.stop();
            spectrum.clearCanvas();
          } else if (isPlaying) {
            spectrum.start();
          }
        });
      }

      if (!trackListView.hasRow(currentIndex)) {
        renderTrackList();
      } else {
        updateActiveTrackRow(previousIndex, currentIndex);
      }
      updatePlayPauseButton();
      // With the generic player host, the adapter may create the underlying player on first load.
      // Allow loads even before the "ready" state is observed; otherwise nothing can ever start.
      sidebar.suppressHide(5000);

      const mode = getPlayerMode();
      if (mode === 'youtube') {
        const id = String(videoId || '').trim();
        if (id && hasYtEmbedError150(id)) {
          ytEmbedError150CheckingVideoId = id;
          showVideoCheckOverlay();
        }
      }
      if (mode === 'spotify') {
        void ensureSpotifySession({ promptIfMissing: true, promptLogin: true })
          .then((ok) => {
            if (!ok) return;
            // Apply output volume before starting playback.
            // Setting Spotify Connect volume shortly after autoplay can cause an audible hiccup
            // (observed on iOS). Load without autoplay, set volume, then play.
            return playerHost
              .load(buildTrackFromPlaylistItem(playlistItems[idx]), { autoplay: false })
              .then(() => applyConfiguredVolumeToHost())
              .then(() => playerHost.play());
          })
          .catch((err) => console.error('Player load error:', err));
      } else {
        void playerHost.load(buildTrackFromPlaylistItem(playlistItems[idx]), { autoplay: true })
          .then(() => applyConfiguredVolumeToHost())
          .catch((err) => console.error('Player load error:', err));
      }
      pendingPlayIndex = null;
      const playlistId = settings.playlistId || '';
      updateCurrentVideo(playlistId, videoId);
      focusActiveTrack();
    }

    // Default volume: applied when players become ready / tracks load.

    function getRelativeVisibleIndex(offset) {
      const indices = visibleIndices.length ? visibleIndices : playlistItems.map((_, idx) => idx);
      if (!indices.length) return -1;
      const currentPos = indices.indexOf(currentIndex);
      if (currentPos === -1) {
        if (offset > 0) {
          return indices[0];
        }
        if (offset < 0) {
          return indices[indices.length - 1];
        }
        return -1;
      }
      const targetPos = currentPos + offset;
      if (targetPos < 0 || targetPos >= indices.length) {
        return -1;
      }
      return indices[targetPos];
    }

    function playNext(options = {}) {
      let nextIdx = -1;
      let fromHistory = false;
      if (shuffleQueue.isEnabled()) {
        const choice = shuffleQueue.next();
        nextIdx = choice.index;
        fromHistory = choice.fromHistory;
      } else {
        nextIdx = getRelativeVisibleIndex(1);
      }
      if (nextIdx >= 0) {
        playIndex(nextIdx, {
          suppressShuffleHistoryRecord: shuffleQueue.isEnabled() && fromHistory,
          keepPlayingUi: !!options.keepPlayingUi,
        });
        return true;
      }
      return false;
    }

    function playPrev() {
      let prevIdx = -1;
      if (shuffleQueue.isEnabled()) {
        prevIdx = shuffleQueue.prev();
      } else {
        prevIdx = getRelativeVisibleIndex(-1);
      }
      if (prevIdx >= 0) {
        playIndex(prevIdx, { suppressShuffleHistoryRecord: shuffleQueue.isEnabled() });
      }
    }

    function togglePlayback() {
      if (!playerHost) return;
      if (!getActiveTrackId()) {
        const idx = currentIndex >= 0
          ? currentIndex
          : (Array.isArray(visibleIndices) && visibleIndices.length ? visibleIndices[0] : (playlistItems.length ? 0 : -1));
        if (idx >= 0) {
          playIndex(idx);
          return;
        }
      }
      const state = getPlayerInfo().state;
      let activelyPlaying = state === 'playing' || state === 'buffering';

      // Local mode fallback: if time has advanced recently, treat as playing.
      if (!activelyPlaying && state !== 'paused' && getPlayerMode() === 'local') {
        const now = Date.now();
        if (lastLocalTimeAdvanceAt && (now - lastLocalTimeAdvanceAt) < 1100) {
          activelyPlaying = true;
        }
      }

      // Optimistically toggle the UI immediately; then reconcile with actual
      // player state (some adapters can lag state events briefly).
      const nextPlaying = !activelyPlaying;
      isPlaying = nextPlaying;
      updatePlayPauseButton();

      sidebar.suppressHide(1500);
      if (nextPlaying) {
        void playerHost.play().catch(() => {});
      } else {
        void playerHost.pause().catch(() => {});
      }

      setTimeout(() => {
        try {
          const s = getPlayerInfo().state;
          let playing = s === 'playing' || s === 'buffering';
          if (!playing && s !== 'paused' && getPlayerMode() === 'local') {
            const now = Date.now();
            if (lastLocalTimeAdvanceAt && (now - lastLocalTimeAdvanceAt) < 1100) {
              playing = true;
            }
          }
          if (isPlaying !== playing) {
            isPlaying = playing;
            updatePlayPauseButton();
          }
        } catch { /* ignore */ }
      }, 350);
      focusActiveTrack();
    }

    document.getElementById('playPauseBtn').addEventListener('click', () => {
      togglePlayback();
    });
    document.getElementById('nextBtn').addEventListener('click', playNext);
    document.getElementById('prevBtn').addEventListener('click', playPrev);

    // Center overlay controls: show on interaction and auto-hide.
    if (centerControlsHitEl && centerControlsPanelEl && playerContainerEl && !centerControlsOverlayController) {
      centerControlsOverlayController = new CenterControlsOverlay({
        hitEl: centerControlsHitEl,
        panelEl: centerControlsPanelEl,
        playerContainerEl,
        sidebarDrawerEl: sidebarDrawer,
        hideAfterMs: 5000,
        onActivity: () => {
          // Unify fullscreen cursor behavior with overlay visibility.
          if (!isAppFullscreen()) return;
          try { showCursor(); } catch { /* ignore */ }
          try { clearCursorIdleTimer(); } catch { /* ignore */ }
        },
        onIdleHide: () => {
          // When overlay idles out, also hide cursor + sidebar in fullscreen.
          if (!isAppFullscreen()) return;
          try { hideCursor(); } catch { /* ignore */ }
          try {
            if (sidebar && !sidebar.isHidden()) sidebar.setHidden(true, { force: true, source: 'fullscreen-idle' });
          } catch { /* ignore */ }
        },
        onPrev: () => playPrev(),
        onNext: () => playNext(),
        onTogglePlayback: () => togglePlayback(),
        onToggleMarkTrack: () => {
          const activePlaylistId = getActivePlaylistId();
          const activeItem = (currentIndex >= 0 && playlistItems[currentIndex]) ? playlistItems[currentIndex] : null;
          if (!activePlaylistId || !activeItem || !activeItem.videoId) return;
          toggleTrackStateForPlaylist(activePlaylistId, activeItem.videoId);
          renderTrackList({ preserveScroll: true });
          syncCenterMarkTrackButton();
        },
        getPlayerMode: () => getPlayerMode(),
        isSidebarHidden: () => (sidebar ? sidebar.isHidden() : document.body.classList.contains('sidebar-hidden')),
        setSidebarHidden: (hidden, options) => {
          if (sidebar) return sidebar.setHidden(hidden, options);
          document.body.classList.toggle('sidebar-hidden', !!hidden);
        },
        buttons: {
          prevBtn: centerPrevBtn,
          playPauseBtn: centerPlayPauseBtn,
          nextBtn: centerNextBtn,
          markBtn: centerMarkBtn,
          edgePrevBtn: centerEdgePrevBtn,
          edgeNextBtn: centerEdgeNextBtn,
          sidebarToggleInput: centerSidebarToggleInput,
        },
      });
      try { centerControlsOverlayController.setup(); } catch { /* ignore */ }
    }

    try { syncCenterMarkTrackButton(); } catch { /* ignore */ }

    // Initialize Media Session handlers once the UI is wired.
    try { setupMediaSessionHandlers(); } catch { /* ignore */ }

    if (timeLabel) {
      timeLabel.addEventListener('click', (event) => {
        event.preventDefault();
        focusActiveTrack({ scroll: true });
      });
    }

    if (centerTimeLabel) {
      centerTimeLabel.addEventListener('click', (event) => {
        event.preventDefault();
        focusActiveTrack({ scroll: true });
      });
    }

    if (fullscreenBtn) {
      fullscreenBtn.addEventListener('click', async () => {
        const isFs = isAppFullscreen();
        if (isFs) {
          // Prefer exiting native fullscreen, but also clear pseudo fullscreen.
          if (getFullscreenElement()) {
            exitFullscreen();
          }
          if (isPseudoFullscreen()) {
            setPseudoFullscreen(false);
          }
          return;
        }

        // Try native fullscreen first.
        let enteredNative = false;
        const ret = requestFullscreenFor(document.documentElement);
        if (ret && typeof ret.then === 'function') {
          try {
            await ret;
          } catch {
            // ignore; we'll fall back to pseudo fullscreen
          }
        }
        // Some browsers don't throw/reject but still don't enter.
        enteredNative = !!getFullscreenElement();
        if (!enteredNative) {
          setPseudoFullscreen(true);
        }
      });

      document.addEventListener('fullscreenchange', handleFullscreenChange);
      document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
      document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if (!isAppFullscreen()) return;
        if (getFullscreenElement()) {
          // Some browsers already exit fullscreen on ESC, but keep this as a guarantee.
          exitFullscreen();
        }
        if (isPseudoFullscreen()) {
          setPseudoFullscreen(false);
        }
      });

      handleFullscreenChange();
    }

    sidebar.setup();

    // When the sidebar fully covers the player (mobile portrait full-width sidebar),
    // request a lower YouTube video quality to reduce decode/render pressure.
    const fullWidthSidebarMq = window.matchMedia('(max-width: 800px) and (max-aspect-ratio: 2/3)');
    function applyCoveredYouTubeOptimization() {
      const isFullWidthSidebarProfile = !!(fullWidthSidebarMq && fullWidthSidebarMq.matches);
      const sidebarHidden = document.body.classList.contains('sidebar-hidden');
      const isCovered = isFullWidthSidebarProfile && !sidebarHidden;

      if (!ytAdapter || typeof ytAdapter.setCoverOptimization !== 'function') return;

      // Only apply if YouTube is currently active.
      const activeKind = playerHost?.getMediaPane?.()?.kind;
      const isYouTubeActive = (playerHost && playerHost.active && playerHost.active === ytAdapter)
        || (activeKind === 'iframe');
      if (!isYouTubeActive) {
        ytAdapter.setCoverOptimization(false);
        return;
      }

      ytAdapter.setCoverOptimization(isCovered);
    }
    if (fullWidthSidebarMq && typeof fullWidthSidebarMq.addEventListener === 'function') {
      fullWidthSidebarMq.addEventListener('change', () => {
        try { applyCoveredYouTubeOptimization(); } catch { /* ignore */ }
      });
    } else if (fullWidthSidebarMq && typeof fullWidthSidebarMq.addListener === 'function') {
      fullWidthSidebarMq.addListener(() => {
        try { applyCoveredYouTubeOptimization(); } catch { /* ignore */ }
      });
    }

    // When the sidebar is shown/hidden (via tap layer, Enter binding, auto-hide, etc)
    // move focus to a sensible target so keyboard shortcuts keep working.
    let _lastSidebarHidden = document.body.classList.contains('sidebar-hidden');
    const sidebarClassObserver = new MutationObserver(() => {
      const nextHidden = document.body.classList.contains('sidebar-hidden');
      if (nextHidden === _lastSidebarHidden) return;
      _lastSidebarHidden = nextHidden;

      if (isTextInputFocused()) return;

      if (nextHidden) {
        focusActivePlayerPane();
      } else {
        focusTrackControls();

        // When the user reveals the sidebar, ensure the currently playing track
        // is visible and centered in the list.
        try {
          requestAnimationFrame(() => {
            try { scrollActiveIntoView({ guardUserScroll: false }); } catch { /* ignore */ }
          });
        } catch { /* ignore */ }
      }

      try { applyCoveredYouTubeOptimization(); } catch { /* ignore */ }
    });
    sidebarClassObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    try { applyCoveredYouTubeOptimization(); } catch { /* ignore */ }

    if (shuffleBtn) {
      shuffleBtn.addEventListener('click', () => {
        toggleShuffleMode();
      });
      updateShuffleButtonState();
    }

    const playlistDataSource = new PlaylistDataSource({
      statusEndpoint: STATUS_ENDPOINT,
      playlistEndpoint: PLAYLIST_ENDPOINT,

      syncDefaultPlaylists: async (defaults) => {
        playlistLibrary = playlistLibraryStore.syncDefaults(defaults);
        return playlistLibrary;
      },

      spectrum,

      initPlaylistIO,
      playlistIOBtn,

      getSettings: () => settings,
      saveSettings: (patch) => saveSettings(patch),
      getActivePlaylistId: () => getActivePlaylistId(),
      getCurrentVideoMap: () => getCurrentVideoMap(),

      getUseLocalMode: () => useLocalMode,
      setUseLocalMode: (next) => {
        useLocalMode = !!next;
        return useLocalMode;
      },

      getLocalPlaylistLibrary: () => localPlaylistLibrary,
      setLocalPlaylistLibrary: (next) => {
        localPlaylistLibrary = next;
        return localPlaylistLibrary;
      },

      getLocalFallbackNotified: () => localFallbackNotified,
      setLocalFallbackNotified: (next) => {
        localFallbackNotified = !!next;
        return localFallbackNotified;
      },

      getPlaylistIOInstance: () => playlistIOInstance,
      setPlaylistIOInstance: (next) => {
        playlistIOInstance = next;
        return playlistIOInstance;
      },

      getPlaylistHistory: () => playlistLibrary,
      removePlaylistFromHistory: (id) => removePlaylistFromHistory(id),
      resetUserSettings: () => resetStoredSettings(),
      showAlert,

      downloadCurrentPlaylist: () => downloadCurrentPlaylist(),

      updatePlaylistHistorySelect: (selectedId) => updatePlaylistHistorySelect(selectedId),
      updateUrlPlaylistParam: (playlistId) => updateUrlPlaylistParam(playlistId),

      getFilterInputValue: () => (filterInputEl ? (filterInputEl.value || '') : ''),
      setFilterTextFromValue: (value) => {
        filterText = value || '';
        return filterText;
      },

      setPlaylistItems: (items) => {
        playlistItems = items;
        return playlistItems;
      },
      getPlaylistItems: () => playlistItems,
      bumpPlaylistVersion: () => {
        playlistVersion += 1;
        return playlistVersion;
      },

      shuffleQueue,
      resetVisibleIndices: () => {
        visibleIndicesHash = 0;
        visibleIndicesVersion += 1;
      },

      refreshFilterOverlays: () => {
        countryFilterOverlayController.updateOptions();
        artistFilterOverlayController.updateOptions();
        combinedFilterOverlayController?.updateButtonState?.();
      },

      computeFilteredIndices: () => computeFilteredIndices(),
      renderTrackList: (opts) => renderTrackList(opts),
      updateNowPlaying: () => updateNowPlaying(),
      updatePlayPauseButton: () => updatePlayPauseButton(),
      playIndex: (idx) => playIndex(idx),

      addPlaylistToHistory: (id, title) => addPlaylistToHistory(id, title),

      setNotifySettingsUpdated: (fn) => {
        notifySettingsUpdated = typeof fn === 'function' ? fn : () => {};
      },

      getController: () => playerHost,
      getCurrentIndex: () => currentIndex,
      setCurrentIndex: (next) => {
        currentIndex = next;
        return currentIndex;
      },

      listSpotifyDevices: async () => {
        if (!spotifyAdapter || typeof spotifyAdapter.listDevices !== 'function') return [];
        return spotifyAdapter.listDevices();
      },
      transferSpotifyPlayback: async (deviceId) => {
        if (!spotifyAdapter || typeof spotifyAdapter.transferPlayback !== 'function') {
          throw new Error('Spotify player is not initialized.');
        }
        await spotifyAdapter.transferPlayback(deviceId, { play: !!isPlaying });
      },
      getSpotifyLocalDeviceId: () => {
        try { return spotifyAdapter?.getLocalDeviceId?.() || ''; } catch { return ''; }
      },

      getOutputVolume01: () => {
        return 1;
      },
      setOutputVolume01: (v01) => {
        void v01;
        saveSettings({ volume01: 1 });
        try { applyConfiguredVolumeToHost(); } catch { /* ignore */ }
      },
    });

    // Allow the Settings overlay to request clearing the Spotify artwork cache.
    // This is global so the overlay code doesn't need direct access to player/adapter instances.
    window.addEventListener('polaris:flushSpotifyArtworkCache', () => {
      try { localStorage.removeItem('polaris.spotify.artwork.v1'); } catch { /* ignore */ }
      try { spotifyAdapter?.flushArtworkCache?.(); } catch { /* ignore */ }
      try { trackListItemsCache.version = -1; } catch { /* ignore */ }
      try { renderTrackList({ preserveScroll: true }); } catch { try { renderTrackList(); } catch { /* ignore */ } }
      try { updateNowPlaying(); } catch { /* ignore */ }
    });

    async function loadPlaylistFromServer(forceRefresh = false, playlistIdOverride = '') {
      return playlistDataSource.loadPlaylistFromServer(Boolean(forceRefresh), playlistIdOverride);
    }

    function downloadCurrentPlaylist() {
      if (!playlistItems || playlistItems.length === 0) {
        showAlert('No playlist loaded yet.');
        return false;
      }

      let spotifyArtworkCache = null;
      try {
        const raw = localStorage.getItem('polaris.spotify.artwork.v1');
        const obj = raw ? JSON.parse(raw) : null;
        spotifyArtworkCache = (obj && typeof obj === 'object') ? obj : null;
      } catch {
        spotifyArtworkCache = null;
      }

      const activePlaylistId = getActivePlaylistId();
      const indices = (Array.isArray(visibleIndices) && visibleIndices.length)
        ? visibleIndices
        : (() => {
          const hasFilter = (filterText || '').trim().length > 0
            || (Array.isArray(artistFilters) && artistFilters.length > 0)
            || (Array.isArray(countryFilters) && countryFilters.length > 0);
          let out = hasFilter ? filteredIndices.slice() : playlistItems.map((_, i) => i);
          if (sortAlphabetically) {
            out = getSortedIndices(out);
          }
          return out;
        })();

      const payload = {
        playlistId: activePlaylistId,
        fetchedAt: new Date().toISOString(),
        itemCount: indices.length,
        items: indices.map((idx) => {
          const item = playlistItems[idx];

          const itemArtwork = (item && typeof item.artwork === 'string') ? String(item.artwork).trim() : '';

          const spotifyId = item && item.spotifyId ? String(item.spotifyId).trim() : '';
          const artwork = itemArtwork
            ? ''
            : ((spotifyArtworkCache && spotifyId && spotifyArtworkCache[spotifyId] && typeof spotifyArtworkCache[spotifyId].url === 'string')
              ? String(spotifyArtworkCache[spotifyId].url).trim()
              : '');

          // Preserve a stable key order and insert `artwork` immediately after `thumbnail`.
          const entry = {};
          if (item && typeof item === 'object') {
            for (const [k, v] of Object.entries(item)) {
              entry[k] = v;
              if (k === 'thumbnail' && artwork) {
                entry.artwork = artwork;
              }
            }
          }

          // If there is no `thumbnail` field, still include artwork at the end.
          if (artwork && !Object.prototype.hasOwnProperty.call(entry, 'artwork')) {
            entry.artwork = artwork;
          }

          entry.userTitle = item.userTitle ?? item.title;
          if (isTrackChecked(activePlaylistId, item.videoId)) {
            entry.checked = true;
          }
          return entry;
        })
      };

      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: 'application/json'
      });
      const url = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = 'yt-playlist.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      return true;
    }

    async function loadPlaylistFromLocal(playlistIdOverride = '') {
      return playlistDataSource.loadPlaylistFromLocal(playlistIdOverride);
    }

    const dataSourceReadyPromise = playlistDataSource.initialize({
      startupPlaylistId: initialPlaylistId || settings.playlistId || ''
    });

    if (shouldResetSettingsFromQuery) {
      resetStoredSettings();
    }

    document.getElementById('playlistForm').addEventListener('submit', (e) => {
      e.preventDefault();
    });

    // TrackDetailsOverlay event wiring is handled by TrackDetailsOverlay.setup().

    // Sorting is controlled via the Details overlay.

    function syncFilterHeaderCheckboxes() {
      if (markedOnlyCheckbox) markedOnlyCheckbox.checked = !!onlyMarked;
    }

    function clearArtistFiltersFromHeader() {
      artistFilters = filterStateStore.clearArtistFilters();
      artistFilterOverlayController?.updateOptions?.();
      computeFilteredIndices();
      renderTrackList({ preserveScroll: true });
    }

    function clearCountryFiltersFromHeader() {
      countryFilters = filterStateStore.clearCountryFilters();
      countryFilterOverlayController?.updateOptions?.();
      computeFilteredIndices();
      renderTrackList({ preserveScroll: true });
    }

    function toggleOnlyMarkedFromHeader() {
      onlyMarked = filterStateStore.setOnlyMarked(!onlyMarked);
      computeFilteredIndices();
      renderTrackList({ preserveScroll: true });
      syncFilterHeaderCheckboxes();
    }

    if (filtersResetBtn) {
      filtersResetBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();

        filterInputEl.value = '';
        filterText = filterStateStore.clearFilterText();
        updateFilterWrapperClass();

        onlyMarked = filterStateStore.clearOnlyMarked();
        if (markedOnlyCheckbox) markedOnlyCheckbox.checked = false;

        artistFilters = filterStateStore.clearArtistFilters();
        countryFilters = filterStateStore.clearCountryFilters();

        artistFilterOverlayController?.updateOptions?.();
        countryFilterOverlayController?.updateOptions?.();

        computeFilteredIndices();
        renderTrackList({ preserveScroll: true });
        syncFilterHeaderCheckboxes();
      });
    }

    if (markedOnlyCheckbox) {
      syncFilterHeaderCheckboxes();
      markedOnlyCheckbox.addEventListener('change', () => {
        onlyMarked = filterStateStore.setOnlyMarked(!!markedOnlyCheckbox.checked);
        computeFilteredIndices();
        renderTrackList({ preserveScroll: true });
        syncFilterHeaderCheckboxes();
      });
    }

    if (artistResetBtn) {
      artistResetBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        clearArtistFiltersFromHeader();
      });
    }

    if (countryResetBtn) {
      countryResetBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        clearCountryFiltersFromHeader();
      });
    }

    if (artistFilterHeading) {
      artistFilterHeading.addEventListener('click', (event) => {
        const targetEl = event.target instanceof Element ? event.target : null;
        if (targetEl && targetEl.closest('button')) return;
        if (Array.isArray(artistFilters) && artistFilters.length > 0) {
          clearArtistFiltersFromHeader();
        }
      });
    }

    if (countryFilterHeading) {
      countryFilterHeading.addEventListener('click', (event) => {
        const targetEl = event.target instanceof Element ? event.target : null;
        if (targetEl && targetEl.closest('button')) return;
        if (Array.isArray(countryFilters) && countryFilters.length > 0) {
          clearCountryFiltersFromHeader();
        }
      });
    }

    if (markedFilterHeading) {
      markedFilterHeading.addEventListener('click', (event) => {
        const targetEl = event.target instanceof Element ? event.target : null;
        if (targetEl && targetEl.closest('input[type="checkbox"]')) return;
        toggleOnlyMarkedFromHeader();
      });
    }

    // filter
    filterInputEl.addEventListener('input', () => {
      filterText = filterStateStore.setFilterText(filterInputEl.value || '');
      updateFilterWrapperClass();
      computeFilteredIndices();
      renderTrackList();
    });

    function updateFilterWrapperClass() {
      if ((filterInputEl.value || '').length > 0) {
        filterWrapper.classList.add('has-value');
      } else {
        filterWrapper.classList.remove('has-value');
      }
    }

    clearFilterBtn.addEventListener('click', () => {
      filterInputEl.value = '';
      filterText = filterStateStore.clearFilterText();
      updateFilterWrapperClass();
      computeFilteredIndices();
      renderTrackList();
    });

    if (trackListContainerEl) {
      trackListContainerEl.addEventListener('mousedown', (event) => {
        if (event.target === trackListContainerEl && document.activeElement !== trackListContainerEl && typeof trackListContainerEl.focus === 'function') {
          trackListContainerEl.focus({ preventScroll: true });
        }
      });
      trackListContainerEl.addEventListener('keydown', (event) => {
        if (event.defaultPrevented) return;
        if (event.key === 'Enter' || event.key === 'Return' || event.code === 'NumpadEnter') {
          const activePlaylistId = getActivePlaylistId();
          const activeItem = currentIndex >= 0 ? playlistItems[currentIndex] : null;
          if (activePlaylistId && activeItem && activeItem.videoId) {
            event.preventDefault();
            toggleTrackStateForPlaylist(activePlaylistId, activeItem.videoId);
            renderTrackList();
            focusActiveTrack({ scroll: false });
          }
          return;
        }
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          if (event.key === 'ArrowUp') {
            playPrev();
          } else {
            playNext();
          }
        }
      });
    }

    if (trackControlsEl) {
      if (!trackControlsEl.hasAttribute('tabindex')) {
        trackControlsEl.setAttribute('tabindex', '0');
      }
      trackControlsEl.addEventListener('keydown', (event) => {
        if (event.defaultPrevented) return;
        // If the container itself is focused (not a child button), Enter hides the sidebar.
        if ((event.key === 'Enter' || event.key === 'Return' || event.code === 'NumpadEnter')
          && event.target === trackControlsEl
          && !event.ctrlKey && !event.altKey && !event.metaKey) {
          event.preventDefault();
          sidebar.setHidden(true);
          return;
        }
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          if (event.key === 'ArrowUp') {
            playPrev();
          } else {
            playNext();
          }
        }
      });
    }

    // keyboard handling
    function isTextInputFocused() {
      const ae = document.activeElement;
      if (!ae) return false;
      if (ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT') return true;
      if (ae.tagName === 'INPUT') {
        const type = String(ae.getAttribute('type') || '').toLowerCase();
        return type === '' || type === 'text' || type === 'search' || type === 'email' || type === 'number'
          || type === 'password' || type === 'url' || type === 'tel';
      }
      if (ae.isContentEditable) return true;
      return false;
    }

    function isEnterKey(e) {
      return e && (e.key === 'Enter' || e.key === 'Return' || e.code === 'NumpadEnter');
    }

    document.addEventListener('keydown', (e) => {
      // X hides the center controls immediately (even if focus is in the sidebar
      // or on invisible edge buttons). Mimics middle-click behavior.
      if (!e.defaultPrevented && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'x' || e.key === 'X')) {
        try { centerControlsOverlayController?.setVisible?.(false); } catch { /* ignore */ }
        try {
          if (centerControlsHitEl) centerControlsHitEl.dataset.visible = 'false';
          if (centerControlsPanelEl) {
            centerControlsPanelEl.dataset.visible = 'false';
            centerControlsPanelEl.setAttribute('aria-hidden', 'true');
          }
          if (centerEdgePrevBtn) centerEdgePrevBtn.dataset.visible = 'false';
          if (centerEdgeNextBtn) centerEdgeNextBtn.dataset.visible = 'false';
        } catch { /* ignore */ }

        if (isAppFullscreen()) {
          try { hideCursor(); } catch { /* ignore */ }
          try { clearCursorIdleTimer(); } catch { /* ignore */ }
          try {
            if (sidebar && !sidebar.isHidden()) sidebar.setHidden(true, { force: true, source: 'x-hide' });
          } catch { /* ignore */ }
        }

        try {
          e.preventDefault();
          e.stopPropagation();
          if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        } catch { /* ignore */ }
        return;
      }

      if (isTextInputFocused()) return;

      // PageUp/PageDown should scroll the playlist by pages from anywhere in the sidebar,
      // unless a focused control (e.g., select/input) handles it.
      if ((e.key === 'PageDown' || e.key === 'PageUp') && !e.defaultPrevented) {
        const sidebarHidden = !!(document.body && document.body.classList && document.body.classList.contains('sidebar-hidden'));
        if (!sidebarHidden && trackListContainerEl) {
          const page = Math.max(60, Math.floor(trackListContainerEl.clientHeight * 0.9));
          const delta = e.key === 'PageUp' ? -page : page;
          try {
            trackListContainerEl.scrollBy({ top: delta, left: 0, behavior: 'auto' });
          } catch {
            trackListContainerEl.scrollTop += delta;
          }
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }

      // Enter toggles the sidebar in/out, but don't steal Enter from controls
      // inside the sidebar (track list uses Enter to toggle completion).
      if (isEnterKey(e) && !e.defaultPrevented && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const hidden = !!(document.body && document.body.classList && document.body.classList.contains('sidebar-hidden'));
        const activeEl = document.activeElement;
        const inSidebarDrawer = !!(sidebarDrawer && activeEl instanceof Node && sidebarDrawer.contains(activeEl));
        const inTrackList = !!(trackListContainerEl && activeEl instanceof Node && trackListContainerEl.contains(activeEl));

        // Always allow showing the sidebar when hidden.
        if (hidden) {
          e.preventDefault();
          e.stopPropagation();
          sidebar.setHidden(false);
          return;
        }

        // When visible, only hide if focus isn't in the sidebar UI.
        if (!inSidebarDrawer && !inTrackList) {
          e.preventDefault();
          e.stopPropagation();
          sidebar.setHidden(true);
          return;
        }
      }

      // When the sidebar is hidden, focus may be on the video/gesture layers.
      // Handle prev/next globally so arrow keys remain reliable.
      const sidebarHidden = !!(document.body && document.body.classList && document.body.classList.contains('sidebar-hidden'));
      if (sidebarHidden && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        if (!e.defaultPrevented) {
          e.preventDefault();
          e.stopPropagation();
          if (e.key === 'ArrowUp') playPrev();
          else playNext();
        }
        return;
      }

      if (e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar') {
        const activeEl = document.activeElement;
        if (activeEl) {
          const tagName = activeEl.tagName;
          if (tagName === 'BUTTON' || tagName === 'A') {
            return;
          }
          if (activeEl.isContentEditable) {
            return;
          }
        }
        togglePlayback();
        e.preventDefault();
        return;
      }

      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (!playerHost) {
          return;
        }
        const duration = getPlayerDurationSeconds();
        const delta = e.key === 'ArrowLeft' ? -10 : 10;
        const currentTime = getPlayerCurrentTimeSeconds();
        const newTime = Math.max(0, currentTime + delta);
        sidebar.suppressHide(8000);
        seekToSeconds(newTime);
        if (duration && isFinite(duration) && duration > 0) {
          updateSeekFeedbackFromFraction(newTime / duration);
          // Let the browser paint it visible, then fade it out.
          scheduleSeekFeedbackFadeOut(50);
        }
        e.preventDefault();
        return;
      }

      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && (e.ctrlKey || e.altKey)) {
        if (e.key === 'ArrowUp') {
          playPrev();
        } else {
          playNext();
        }
        e.preventDefault();
        return;
      }
    }, { capture: true });

    // progress slider
    let progressInterval = null;

    function startProgressTimer() {
      if (progressInterval) return;
      progressInterval = setInterval(updateProgressBar, 200);
    }

    function formatTime(seconds) {
      if (!isFinite(seconds) || seconds < 0) return '00:00';
      const s = Math.floor(seconds);
      const m = Math.floor(s / 60);
      const r = s % 60;
      const mm = m.toString().padStart(2, '0');
      const ss = r.toString().padStart(2, '0');
      return `${mm}:${ss}`;
    }

    function updateProgressBar() {
      if (!playerHost) {
        if (progressRange) progressRange.value = 0;
        if (centerProgressRange) centerProgressRange.value = 0;
        if (centerProgressRange) {
          try { centerProgressRange.style.setProperty('--cco-progress-pct', '0%'); } catch { /* ignore */ }
        }
        if (timeLabel) timeLabel.textContent = '00:00 / 00:00';
        if (centerTimeLabel) centerTimeLabel.textContent = '00:00 / 00:00';
        return;
      }

      // Keep play/pause UI synced in local mode even if adapter state is stale.
      if (getPlayerMode() === 'local' && !isProgressScrubbing && !holdPlayingUiUntilMs) {
        try {
          const info = getPlayerInfo();
          const now = Date.now();
          const posMs = Number(info?.time?.positionMs) || 0;

          // Detect forward progress.
          if (posMs > lastLocalPositionMs + 150) {
            lastLocalTimeAdvanceAt = now;
            lastLocalPositionMs = posMs;
          } else if (posMs < lastLocalPositionMs - 500) {
            // Seek/backwards jump: update baseline without marking as "playing".
            lastLocalPositionMs = posMs;
          }

          let playing = info?.state === 'playing' || info?.state === 'buffering';
          if (!playing && info?.state !== 'paused' && lastLocalTimeAdvanceAt && (now - lastLocalTimeAdvanceAt) < 1100) {
            playing = true;
          }

          if (isPlaying !== playing) {
            isPlaying = playing;
            updatePlayPauseButton();
          }
        } catch { /* ignore */ }
      }

      const duration = getPlayerDurationSeconds();
      const current = getPlayerCurrentTimeSeconds();

      if (!duration || !isFinite(duration) || duration <= 0) {
        if (progressRange && !isProgressScrubbing) progressRange.value = 0;
        if (centerProgressRange && !isProgressScrubbing) centerProgressRange.value = 0;
        if (centerProgressRange) {
          try { centerProgressRange.style.setProperty('--cco-progress-pct', '0%'); } catch { /* ignore */ }
        }
        const text = `${formatTime(current)} / --:--`;
        if (timeLabel) timeLabel.textContent = text;
        if (centerTimeLabel) centerTimeLabel.textContent = text;
        return;
      }

      const frac = Math.max(0, Math.min(1, current / duration));
      if (!isProgressScrubbing) {
        if (progressRange) progressRange.value = Math.round(frac * 1000);
        if (centerProgressRange) centerProgressRange.value = Math.round(frac * 1000);
      }

      if (centerProgressRange) {
        try { centerProgressRange.style.setProperty('--cco-progress-pct', `${(frac * 100).toFixed(2)}%`); } catch { /* ignore */ }
      }
      const text = `${formatTime(current)} / ${formatTime(duration)}`;
      if (timeLabel) timeLabel.textContent = text;
      if (centerTimeLabel) centerTimeLabel.textContent = text;
    }

    function setProgressScrubbing(active, valueRaw = null) {
      isProgressScrubbing = !!active;
      if (isProgressScrubbing) {
        sidebar.suppressHide(8000);
        const v = (valueRaw == null) ? Number(progressRange?.value || 0) : Number(valueRaw);
        updateSeekFeedbackFromFraction(v / 1000);
      }
      if (!isProgressScrubbing) {
        // Fade out once the user stops dragging.
        setSeekFeedbackVisible(false);
      }
    }

    const clearProgressScrubbing = () => setProgressScrubbing(false);

    // On touch devices, dragging the range thumb can trigger YouTube state changes
    // (buffering/playing) and we must not treat those as outside taps.
    function _onProgressInput(valueRaw) {
      if (!playerHost) {
        return;
      }
      const duration = getPlayerDurationSeconds();
      if (!duration || !isFinite(duration) || duration <= 0) return;
      const frac = Number(valueRaw) / 1000;
      const newTime = frac * duration;

      if (centerProgressRange) {
        try { centerProgressRange.style.setProperty('--cco-progress-pct', `${(frac * 100).toFixed(2)}%`); } catch { /* ignore */ }
      }

      if (isProgressScrubbing) {
        sidebar.suppressHide(8000);
      }
      updateSeekFeedbackFromFraction(frac);
      seekToSeconds(newTime);
    }

    function _setRangeValueFromClientPoint(rangeEl, clientX, clientY) {
      if (!(rangeEl instanceof HTMLInputElement)) return;
      if (rangeEl.type !== 'range') return;
      let rect;
      try { rect = rangeEl.getBoundingClientRect(); } catch { return; }
      if (!rect || !isFinite(rect.width) || !isFinite(rect.height) || rect.width <= 0 || rect.height <= 0) return;

      const min = Number(rangeEl.min || 0);
      const max = Number(rangeEl.max || 1000);
      const span = (isFinite(max - min) && (max - min) > 0) ? (max - min) : 1000;

      // Heuristic: treat tall sliders as vertical (useful when the whole UI is rotated).
      const isVertical = rect.height > (rect.width * 1.2);
      let frac;
      if (isVertical) {
        frac = (rect.bottom - clientY) / rect.height;
      } else {
        frac = (clientX - rect.left) / rect.width;
      }
      frac = Math.max(0, Math.min(1, frac));
      const next = Math.round(min + (frac * span));

      try {
        rangeEl.value = String(next);
        // Trigger existing input handler path.
        rangeEl.dispatchEvent(new Event('input', { bubbles: true }));
      } catch { /* ignore */ }
    }

    function _installMobileRangeDragFix(rangeEl) {
      if (!(rangeEl instanceof HTMLInputElement)) return;
      if (rangeEl.type !== 'range') return;

      let dragging = false;

      const onTouchStart = (event) => {
        if (!event) return;
        const touch = event.touches && event.touches[0];
        if (!touch) return;
        dragging = true;
        _setRangeValueFromClientPoint(rangeEl, touch.clientX, touch.clientY);
        // Prevent page scroll from stealing the gesture.
        try { if (event.cancelable) event.preventDefault(); } catch { /* ignore */ }
      };

      const onTouchMove = (event) => {
        if (!dragging) return;
        const touch = event.touches && event.touches[0];
        if (!touch) return;
        _setRangeValueFromClientPoint(rangeEl, touch.clientX, touch.clientY);
        try { if (event.cancelable) event.preventDefault(); } catch { /* ignore */ }
      };

      const onTouchEnd = () => {
        dragging = false;
      };

      // Use non-passive so we can preventDefault and keep the gesture.
      rangeEl.addEventListener('touchstart', onTouchStart, { passive: false });
      rangeEl.addEventListener('touchmove', onTouchMove, { passive: false });
      rangeEl.addEventListener('touchend', onTouchEnd, { passive: true });
      rangeEl.addEventListener('touchcancel', onTouchEnd, { passive: true });
    }

    if (progressRange) {
      progressRange.addEventListener('pointerdown', () => setProgressScrubbing(true, progressRange.value), { passive: true });
      progressRange.addEventListener('pointerup', clearProgressScrubbing, { passive: true });
      progressRange.addEventListener('pointercancel', clearProgressScrubbing, { passive: true });
      progressRange.addEventListener('touchstart', () => setProgressScrubbing(true, progressRange.value), { passive: true });
      progressRange.addEventListener('touchend', clearProgressScrubbing, { passive: true });
      progressRange.addEventListener('touchcancel', clearProgressScrubbing, { passive: true });
      progressRange.addEventListener('input', () => _onProgressInput(progressRange.value));
      _installMobileRangeDragFix(progressRange);
    }

    if (centerProgressRange) {
      centerProgressRange.addEventListener('pointerdown', () => setProgressScrubbing(true, centerProgressRange.value), { passive: true });
      centerProgressRange.addEventListener('pointerup', clearProgressScrubbing, { passive: true });
      centerProgressRange.addEventListener('pointercancel', clearProgressScrubbing, { passive: true });
      centerProgressRange.addEventListener('touchstart', () => setProgressScrubbing(true, centerProgressRange.value), { passive: true });
      centerProgressRange.addEventListener('touchend', clearProgressScrubbing, { passive: true });
      centerProgressRange.addEventListener('touchcancel', clearProgressScrubbing, { passive: true });
      centerProgressRange.addEventListener('input', () => _onProgressInput(centerProgressRange.value));
      _installMobileRangeDragFix(centerProgressRange);
      centerProgressRange.addEventListener('keydown', (event) => {
        if (!event || event.defaultPrevented) return;
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          event.stopPropagation();
          if (event.key === 'ArrowUp') playPrev();
          else playNext();
        }
      });
    }

    // TEMP: swipe gesture overlays/controllers removed during refactor.
