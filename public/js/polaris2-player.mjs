  import { PlayerHost } from './players/PlayerHost.mjs';
  import { YouTubeAdapter } from './players/adapters/YouTubeAdapter.mjs';
  import { HtmlVideoAdapter } from './players/adapters/HtmlVideoAdapter.mjs';
  import { SpotifyAdapter } from './players/adapters/SpotifyAdapter.mjs';
  import { SpotifyAuth } from './players/SpotifyAuth.mjs';
  import { SettingsStore } from './SettingsStore.mjs';
  import { PlaylistHistoryStore } from './PlaylistHistoryStore.mjs';
  import { FilterStateStore } from './FilterStateStore.mjs';
  import { TrackDetailSettingsStore } from './TrackDetailSettingsStore.mjs';
  import { SeekSwipeController } from './SeekSwipeController.mjs';
  import { TrackSwipeController } from './TrackSwipeController.mjs';
  import { getFlagEmojiForIso3 } from './CountryFlags.mjs';
  import { initPlaylistIO } from './PlaylistManagement.mjs';
  import { Spectrum } from './Spectrum.mjs';
  import { TextUtils } from './TextUtils.mjs';
  import { ShuffleQueue } from './ShuffleQueue.mjs';
  import { createAlert } from './Alert.mjs';
  import { Sidebar } from './Sidebar.mjs';
  import { ArtistFilterOverlay } from './ArtistFilterOverlay.mjs';
  import { CountryFilterOverlay } from './CountryFilterOverlay.mjs';
  import { computeFilteredIndices as computeFilteredIndicesPure } from './FilterEngine.mjs';
  import { getSortKeyForTitle } from './TrackParsing.mjs';
  import { TrackListView } from './TrackListView.mjs';
  import { TrackDetailsOverlay } from './TrackDetailsOverlay.mjs';
  import { PlaylistDataSource } from './PlaylistDataSource.mjs';
  import { addYtEmbedError150, hasYtEmbedError150, removeYtEmbedError150 } from './ErrorLists.mjs';

  let playerHost;
  let spotifyAdapter = null;
  let ytEmbedError150SkipTimer = null;
  let ytEmbedError150SkipKey = '';
  let ytEmbedError150CheckingVideoId = '';
  let videoCheckOverlayEl = null;

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
      wrapLines: true,
      country: true,
      checkTrack: true,
      sortAZ: false
    });
    let trackDetailSettings = { ...DEFAULT_TRACK_DETAILS };

    let trackDetailStore = null;

    let filterStateStore = null;
    let filterText = '';
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

    const STORAGE_KEY = 'ytAudioPlayer.settings';
    let notifySettingsUpdated = () => {};
    const settingsStore = new SettingsStore(STORAGE_KEY, { onChange: () => notifySettingsUpdated() });
    let settings = settingsStore.load();

    const spotifyAuth = new SpotifyAuth({
      clientId: (settings && typeof settings.spotifyClientId === 'string') ? settings.spotifyClientId : '',
      // Use SpotifyAuth's stable default redirectUri (directory root, no index.html).
      redirectUri: undefined,
    });

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
    const LOCAL_PLAYLIST_PATH = './local-playlist.json';
    const PLAYLIST_HISTORY_LIMIT = 25;
    const playlistHistoryStore = new PlaylistHistoryStore({
      limit: PLAYLIST_HISTORY_LIMIT,
      getSettings: () => settings,
      saveSettings: (patch) => saveSettings(patch)
    });
    let playlistHistory = playlistHistoryStore.get();
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

    function sanitizeLocalVideoBasename(name) {
      return String(name || '')
        .trim()
        // Normalize common quote variants to straight apostrophe (') to match
        // on-disk files that use ASCII apostrophes (encoded as %27).
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\\/]/g, '_');
    }

    function buildLocalThumbnailUrlForItem(item) {
      const rawTitle = (item && typeof item.userTitle === 'string' && item.userTitle.trim().length)
        ? item.userTitle
        : (item && typeof item.title === 'string' ? item.title : '');
      const base = sanitizeLocalVideoBasename(rawTitle);
      if (!base) return '';
      return `${window.location.origin}/video/thumbnail/${encodeURIComponent(base)}.jpg`;
    }

    function buildLocalVideoUrlForItem(item) {
      const rawTitle = (item && typeof item.userTitle === 'string' && item.userTitle.trim().length)
        ? item.userTitle
        : (item && typeof item.title === 'string' ? item.title : '');
      const base = sanitizeLocalVideoBasename(rawTitle);
      return `${window.location.origin}/video/${encodeURIComponent(base)}.mp4`;
    }

    filterStateStore = new FilterStateStore({
      getSettings: () => settings,
      saveSettings: (patch) => saveSettings(patch)
    });
    ({ filterText, artistFilters, countryFilters } = filterStateStore.snapshot());

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

    function toggleTrackStateForPlaylist(playlistId, videoId) {
      if (!playlistId || !videoId) return TRACK_STATE_DEFAULT;
      const current = getTrackStateForPlaylist(playlistId, videoId);
      const next = current === TRACK_STATE_CHECKED ? TRACK_STATE_DEFAULT : TRACK_STATE_CHECKED;
      setTrackStateForPlaylist(playlistId, videoId, next);
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
    const artistFilterWrapper = document.getElementById('artistFilterWrapper');
    const artistFilterBtn = document.getElementById('artistFilterBtn');
    const artistFilterOverlay = document.getElementById('artistFilterOverlay');
    const artistFilterOptions = document.getElementById('artistFilterOptions');
    const countryFilterWrapper = document.getElementById('countryFilterWrapper');
    const countryFilterBtn = document.getElementById('countryFilterBtn');
    const countryFilterOverlay = document.getElementById('countryFilterOverlay');
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
    const detailWrapLinesCheckbox = document.getElementById('detailWrapLines');
    const detailCountryCheckbox = document.getElementById('detailCountry');
    const detailCheckTrackCheckbox = document.getElementById('detailCheckTrack');
    const detailSortAZCheckbox = document.getElementById('detailSortAZ');
    const detailCheckboxMap = {
      trackNumber: detailTrackNumberCheckbox,
      thumbnail: detailThumbnailCheckbox,
      wrapLines: detailWrapLinesCheckbox,
      country: detailCountryCheckbox,
      checkTrack: detailCheckTrackCheckbox,
      sortAZ: detailSortAZCheckbox
    };
    const progressRange = document.getElementById('progressRange');
    const timeLabel = document.getElementById('timeLabel');
    const playPauseIcon = document.getElementById('playPauseIcon');
    const trackControlsEl = document.getElementById('trackControls');
    const playerGestureLayer = document.getElementById('playerGestureLayer');
    const sidebarDrawer = document.getElementById('sidebarDrawer');
    const trackSwipeLayer = document.getElementById('trackSwipeLayer');
    const seekSwipeLayer = document.getElementById('seekSwipeLayer');
    const seekSwipeFeedback = document.getElementById('seekSwipeFeedback');
    const playlistHistorySelect = document.getElementById('playlistHistorySelect');
    const trackListContainerEl = document.getElementById('trackListContainer');
    const trackListEl = document.getElementById('trackList');
    const alertOverlay = document.getElementById('alertOverlay');
    const alertMessageEl = document.getElementById('alertMessage');
    const alertCloseBtn = document.getElementById('alertCloseBtn');
    const spectrumCanvas = document.getElementById('spectrumCanvas');
    const alert = createAlert({ overlayEl: alertOverlay, messageEl: alertMessageEl, closeBtn: alertCloseBtn });

    function getConfiguredVolume01() {
      const v = settings && typeof settings.volume01 === 'number' ? settings.volume01 : undefined;
      const n = typeof v === 'number' && isFinite(v) ? v : 0.3;
      return Math.max(0, Math.min(1, n));
    }

    function applyConfiguredVolumeToHost() {
      if (!playerHost) return;
      const caps = playerHost.getCapabilities();
      if (!caps || !caps.canSetVolume) return;
      void playerHost.setVolume(getConfiguredVolume01()).catch(() => {});
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
        alert.show('Spotify mode requires a Spotify Client ID. Add it in Playlist → Video Player → Spotify Client ID (stored in ytAudioPlayer.settings.spotifyClientId).');
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
      getArtistFilters: () => artistFilters,
      getCountryFilters: () => countryFilters,
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
      playerGestureLayer,
      isInteractionBlockingHide: () => isProgressScrubbing || isSeekSwipeActive,
      isAutoHideEnabled: () => document.body.classList.contains('is-fullscreen'),
      allowScrollSelectors: [
        '#sidebarDrawer',
        '#trackListContainer',
        '#artistFilterOverlay',
        '#countryFilterOverlay',
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
          : buildLocalThumbnailUrlForItem(item);
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

    const countryFilterOverlayController = new CountryFilterOverlay({
      buttonEl: countryFilterBtn,
      overlayEl: countryFilterOverlay,
      wrapperEl: countryFilterWrapper,
      optionsEl: countryFilterOptions,
      filterInputEl,
      onBeforeOpen: () => {
        if (trackDetailsOverlayController && trackDetailsOverlayController.isVisible()) {
          trackDetailsOverlayController.close();
        }
        if (artistFilterOverlayController.isVisible()) {
          artistFilterOverlayController.close();
        }
      },
      getPlaylistItems: () => playlistItems,
      getFilters: () => countryFilters,
      setFilters: (next) => {
        countryFilters = filterStateStore.setCountryFilters(next);
        return countryFilters;
      },
      onFiltersChanged: () => {
        computeFilteredIndices();
        renderTrackList();
      },
      normalizeIso3: (code) => normalizeIso3(code),
      normalizeCountryFilterList: (value) => normalizeCountryFilterList(value),
      splitCountryCodes: (value) => splitCountryCodes(value),
      makeSortKey: (value) => makeSortKey(value),
      getFlagEmojiForIso3: (iso3) => getFlagEmojiForIso3(iso3),
    });

    const artistFilterOverlayController = new ArtistFilterOverlay({
      buttonEl: artistFilterBtn,
      overlayEl: artistFilterOverlay,
      wrapperEl: artistFilterWrapper,
      optionsEl: artistFilterOptions,
      filterInputEl,
      onBeforeOpen: () => {
        if (trackDetailsOverlayController && trackDetailsOverlayController.isVisible()) {
          trackDetailsOverlayController.close();
        }
        if (countryFilterOverlayController.isVisible()) {
          countryFilterOverlayController.close();
        }
      },
      getPlaylistItems: () => playlistItems,
      getFilters: () => artistFilters,
      setFilters: (next) => {
        artistFilters = filterStateStore.setArtistFilters(next);
        return artistFilters;
      },
      onFiltersChanged: (renderOptions = {}) => {
        computeFilteredIndices();
        renderTrackList(renderOptions);
      },
      normalizeArtistName: (name) => normalizeArtistName(name),
      normalizeArtistKey: (name) => normalizeArtistKey(name),
      makeSortKey: (value) => makeSortKey(value),
    });

    countryFilterOverlayController.setup();
    artistFilterOverlayController.setup();

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
      persistPreferences: () => {
        trackDetailSettings = trackDetailStore.setPreferences(trackDetailSettings);
        return trackDetailSettings;
      },

      getSortAlphabetically: () => sortAlphabetically,
      setSortAlphabetically: (next) => {
        sortAlphabetically = trackDetailStore.setSortAlphabetically(next);
        return sortAlphabetically;
      },

      renderTrackList: (options) => renderTrackList(options),

      onBeforeOpen: () => {
        if (artistFilterOverlayController.isVisible()) {
          artistFilterOverlayController.close();
        }
        if (countryFilterOverlayController.isVisible()) {
          countryFilterOverlayController.close();
        }
      },
    });
    trackDetailsOverlayController.setup();

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        let handled = false;
        handled = alert.handleEscape(event) || handled;
        if (trackDetailsOverlayController && trackDetailsOverlayController.isVisible()) {
          trackDetailsOverlayController.close({ focusButton: !handled });
          handled = true;
        }
        if (artistFilterOverlayController.isVisible()) {
          artistFilterOverlayController.close({ focusButton: !handled });
          handled = true;
        }
        if (countryFilterOverlayController.isVisible()) {
          countryFilterOverlayController.close({ focusButton: !handled });
          handled = true;
        }
        if (handled) {
          event.preventDefault();
        }
      }
    });

    function getLocalPlaylistOptions() {
      const library = localPlaylistLibrary;
      if (!library || typeof library !== 'object' || Array.isArray(library)) return [];

      const options = [];
      Object.entries(library).forEach(([id, entry]) => {
        if (!id) return;
        const title = (entry && typeof entry === 'object' && typeof entry.title === 'string' && entry.title.trim().length)
          ? entry.title.trim()
          : id;
        options.push({ id, title });
      });

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
        : playlistHistory.map((entry) => ({ id: entry.id, title: entry.title }));

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

    function addPlaylistToHistory(id, title) {
      if (!id) return;
      playlistHistoryStore.add(id, title);
      playlistHistory = playlistHistoryStore.get();
      updatePlaylistHistorySelect(id);
    }

    function removePlaylistFromHistory(id) {
      if (!id) return;
      playlistHistoryStore.remove(id);
      playlistHistory = playlistHistoryStore.get();
      const patch = {};
      const map = getCurrentVideoMap();
      if (map[id]) {
        const nextMap = { ...map };
        delete nextMap[id];
        patch.currentVideoMap = nextMap;
      }
      const itemStates = getPlaylistItemStateMap();
      if (itemStates[id]) {
        const nextStates = { ...itemStates };
        delete nextStates[id];
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
      playlistHistoryStore.replace([], { persist: false });
      playlistHistory = playlistHistoryStore.get();
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
      countryFilterOverlayController.close();

      artistFilters = [];
      artistFilterOverlayController.updateOptions();
      artistFilterOverlayController.close();

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
      const vh = (window.visualViewport ? window.visualViewport.height : window.innerHeight) * 0.01;
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
    let isSeekSwipeActive = false;
    let seekFeedbackHideTimer = null;

    function setSeekFeedbackVisible(visible) {
      if (!seekSwipeLayer || !seekSwipeFeedback) return;
      if (visible) {
        seekSwipeLayer.classList.add('is-active');
        return;
      }
      // Don't hide while an active seek gesture is still running.
      if (isSeekSwipeActive || isProgressScrubbing) return;
      seekSwipeLayer.classList.remove('is-active');
    }

    function updateSeekFeedbackFromFraction(frac) {
      if (!seekSwipeLayer || !seekSwipeFeedback) return;
      const clamped = Math.max(0, Math.min(1, Number(frac)));
      seekSwipeFeedback.textContent = `${Math.round(clamped * 100)}%`;
      setSeekFeedbackVisible(true);
    }

    function scheduleSeekFeedbackFadeOut(delayMs = 0) {
      if (!seekSwipeLayer || !seekSwipeFeedback) return;
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

      if (fs) {
        startFullscreenCursorAutoHide();
      } else {
        stopFullscreenCursorAutoHide();
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

      const artwork = artUrl
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
        ...(mode === 'spotify' && itemArtwork ? { artworkUrl: itemArtwork } : {}),
      };
    }

    function handlePlayerModeChanged(_prevMode, _nextMode) {
      if (!playerHost) return;
      if (currentIndex < 0 || !playlistItems[currentIndex]) return;

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

      spotifyAdapter = new SpotifyAdapter({ auth: spotifyAuth });

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

      playerHost = new PlayerHost([
        // Let the adapter create its own mount element inside #player.
        // This avoids the YouTube API replacing the #player node itself.
        new YouTubeAdapter({ elementId: null, controls: 0, autoplay: false }),
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
      });
      playerHost.on('time', () => updateMediaSessionPositionState(false));
      playerHost.on('ended', () => playNext());
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
        // Auto-advance: keep the UI in "playing" while the next track is loading
        // to avoid flickering play/pause icons.
        holdPlayingUiUntilMs = Date.now() + 2500;
        const advanced = playNext({ keepPlayingUi: true });
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
      } else {
        playPauseIcon.className = 'icon play';
        playPauseIcon.textContent = 'play_arrow';
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
            return playerHost.load(buildTrackFromPlaylistItem(playlistItems[idx]), { autoplay: true })
              .then(() => applyConfiguredVolumeToHost());
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
      const activelyPlaying = state === 'playing' || state === 'buffering';

      if (isPlaying !== activelyPlaying) {
        isPlaying = activelyPlaying;
        updatePlayPauseButton();
      }

      if (activelyPlaying) {
        sidebar.suppressHide(1500);
        void playerHost.pause().catch(() => {});
      } else {
        sidebar.suppressHide(1500);
        void playerHost.play().catch(() => {});
      }
      focusActiveTrack();
    }

    document.getElementById('playPauseBtn').addEventListener('click', () => {
      togglePlayback();
    });
    document.getElementById('nextBtn').addEventListener('click', playNext);
    document.getElementById('prevBtn').addEventListener('click', playPrev);

    // Initialize Media Session handlers once the UI is wired.
    try { setupMediaSessionHandlers(); } catch { /* ignore */ }

    if (timeLabel) {
      timeLabel.addEventListener('click', (event) => {
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
      }
    });
    sidebarClassObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    if (shuffleBtn) {
      shuffleBtn.addEventListener('click', () => {
        toggleShuffleMode();
      });
      updateShuffleButtonState();
    }

    const playlistDataSource = new PlaylistDataSource({
      statusEndpoint: STATUS_ENDPOINT,
      playlistEndpoint: PLAYLIST_ENDPOINT,
      localPlaylistPath: LOCAL_PLAYLIST_PATH,

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

      getPlaylistHistory: () => playlistHistory,
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
        const v = settings && typeof settings.volume01 === 'number' ? settings.volume01 : 0.3;
        const n = typeof v === 'number' && isFinite(v) ? v : 0.3;
        return Math.max(0, Math.min(1, n));
      },
      setOutputVolume01: (v01) => {
        const n = Number(v01);
        const clamped = isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.3;
        saveSettings({ volume01: clamped });
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
      if (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT') return true;
      if (ae.isContentEditable) return true;
      return false;
    }

    function isEnterKey(e) {
      return e && (e.key === 'Enter' || e.key === 'Return' || e.code === 'NumpadEnter');
    }

    document.addEventListener('keydown', (e) => {
      if (isTextInputFocused()) return;

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
      progressInterval = setInterval(updateProgressBar, 500);
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
        progressRange.value = 0;
        timeLabel.textContent = '00:00 / 00:00';
        return;
      }

      const duration = getPlayerDurationSeconds();
      const current = getPlayerCurrentTimeSeconds();

      if (!duration || !isFinite(duration) || duration <= 0) {
        progressRange.value = 0;
        timeLabel.textContent = `${formatTime(current)} / --:--`;
        return;
      }

      const frac = Math.max(0, Math.min(1, current / duration));
      progressRange.value = Math.round(frac * 1000);
      timeLabel.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
    }

    function setProgressScrubbing(active) {
      isProgressScrubbing = !!active;
      if (isProgressScrubbing) {
        sidebar.suppressHide(8000);
        updateSeekFeedbackFromFraction(Number(progressRange.value) / 1000);
      }
      if (!isProgressScrubbing) {
        // Fade out once the user stops dragging.
        setSeekFeedbackVisible(false);
      }
    }

    const clearProgressScrubbing = () => setProgressScrubbing(false);

    // On touch devices, dragging the range thumb can trigger YouTube state changes
    // (buffering/playing) and we must not treat those as outside taps.
    progressRange.addEventListener('pointerdown', () => setProgressScrubbing(true), { passive: true });
    progressRange.addEventListener('pointerup', clearProgressScrubbing, { passive: true });
    progressRange.addEventListener('pointercancel', clearProgressScrubbing, { passive: true });
    progressRange.addEventListener('touchstart', () => setProgressScrubbing(true), { passive: true });
    progressRange.addEventListener('touchend', clearProgressScrubbing, { passive: true });
    progressRange.addEventListener('touchcancel', clearProgressScrubbing, { passive: true });

    progressRange.addEventListener('input', () => {
      if (!playerHost) {
        return;
      }
      const duration = getPlayerDurationSeconds();
      if (!duration || !isFinite(duration) || duration <= 0) return;
      const frac = Number(progressRange.value) / 1000;
      const newTime = frac * duration;
      if (isProgressScrubbing) {
        sidebar.suppressHide(8000);
      }
      updateSeekFeedbackFromFraction(frac);
      seekToSeconds(newTime);
    });

    // Center vertical swipe area: up/down swipe for prev/next.
    (function setupCenterSwipeGestures() {
      if (!trackSwipeLayer) return;

      const centerSwipeController = new TrackSwipeController({
        layerEl: trackSwipeLayer,
        minDyPx: 60,
        maxDtMs: 900,
        verticalBias: 1.2,
        shouldIgnoreStart: (eventTarget) => {
          if (isProgressScrubbing) return true;
          if (sidebarDrawer && eventTarget instanceof Node && sidebarDrawer.contains(eventTarget)) return true;
          if (progressRange && eventTarget instanceof Node && progressRange.contains(eventTarget)) return true;
          return false;
        },
        onNext: () => playNext(),
        onPrev: () => playPrev()
      });

      centerSwipeController.attach();
    })();

    // Bottom seek stripe: horizontal swipe maps to absolute timeline position.
    (function setupSeekSwipeGestures() {
      if (!seekSwipeLayer) return;

      const seekSwipeController = new SeekSwipeController({
        layerEl: seekSwipeLayer,
        isBlocked: () => isProgressScrubbing,
        getDuration: () => getPlayerDurationSeconds(),
        getCurrentTime: () => getPlayerCurrentTimeSeconds(),
        seekTo: (seconds, allowSeekAhead) => {
          void allowSeekAhead;
          seekToSeconds(seconds);
        },
        setActive: (active) => {
          isSeekSwipeActive = !!active;
          seekSwipeLayer.classList.toggle('is-active', !!active);
        },
        onFeedbackFraction: (frac) => {
          updateSeekFeedbackFromFraction(frac);
        },
        suppressSidebarHide: (ms) => sidebar.suppressHide(ms)
      });

      seekSwipeController.attach();
    })();
