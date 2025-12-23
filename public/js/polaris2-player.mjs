  import { YTController, STATES as CONTROLLER_STATES } from './YTController.mjs';
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

    let controller;
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
    let trackDetailsOverlayVisible = false;

    let trackDetailStore = null;

    let filterStateStore = null;
    let filterText = '';
    let artistFilters = [];
    let countryFilters = [];
    let filteredIndices = [];
    let trackRowElements = new Map();
    let visibleIndices = [];
    let visibleIndicesHash = 0;
    let visibleIndicesVersion = 0;
    let useLocalMode = false;
    let localPlaylistLibrary = null;
    let localFallbackNotified = false;
    let playlistIOInstance = null;
    let playerReady = false;
    let pendingPlayIndex = null;

    const STORAGE_KEY = 'ytAudioPlayer.settings';
    let notifySettingsUpdated = () => {};
    const settingsStore = new SettingsStore(STORAGE_KEY, { onChange: () => notifySettingsUpdated() });
    let settings = settingsStore.load();

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
      settings = settingsStore.patch(patch);
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
    const alertOverlay = document.getElementById('alertOverlay');
    const alertMessageEl = document.getElementById('alertMessage');
    const alertCloseBtn = document.getElementById('alertCloseBtn');
    const spectrumCanvas = document.getElementById('spectrumCanvas');
    const alert = createAlert({ overlayEl: alertOverlay, messageEl: alertMessageEl, closeBtn: alertCloseBtn });

    const spectrum = new Spectrum({ canvas: spectrumCanvas });

    const sidebar = new Sidebar({
      sidebarMenuBtn,
      sidebarDrawer,
      playerGestureLayer,
      isInteractionBlockingHide: () => isProgressScrubbing || isSeekSwipeActive,
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

    const countryFilterOverlayController = new CountryFilterOverlay({
      buttonEl: countryFilterBtn,
      overlayEl: countryFilterOverlay,
      wrapperEl: countryFilterWrapper,
      optionsEl: countryFilterOptions,
      filterInputEl,
      onBeforeOpen: () => {
        if (trackDetailsOverlayVisible) {
          closeTrackDetailsOverlay();
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
        if (trackDetailsOverlayVisible) {
          closeTrackDetailsOverlay();
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

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        let handled = false;
        handled = alert.handleEscape(event) || handled;
        if (trackDetailsOverlayVisible) {
          closeTrackDetailsOverlay({ focusButton: !handled });
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
      applyTrackDetailPreferences();
      syncTrackDetailsControls();
      closeTrackDetailsOverlay();
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
    applyTrackDetailPreferences();
    syncTrackDetailsControls();
    updateTrackDetailsButtonState();

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


    function handleFullscreenChange() {
      updateFullscreenButtonState();
      document.body.classList.toggle('is-fullscreen', isAppFullscreen());
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

    function getArtistSourceText(item) {
      if (!item || typeof item !== 'object') return '';
      if (typeof item.userTitle === 'string' && item.userTitle.trim().length) {
        return item.userTitle;
      }
      if (typeof item.title === 'string') return item.title;
      return '';
    }

    function splitArtists(value) {
      if (typeof value !== 'string') return [];
      const raw = value.trim();
      if (!raw) return [];
      const dashIndex = raw.indexOf(' - ');
      const artistPart = dashIndex >= 0 ? raw.slice(0, dashIndex) : raw;
      return artistPart
        .split(';')
        .map((part) => normalizeArtistName(part))
        .filter(Boolean);
    }

    function getCountryFlagEmoji(iso3) {
      if (iso3 === '?') return '🏳️';
      return getFlagEmojiForIso3(iso3);
    }

    function toggleCountryFilterCode(code) {
      countryFilterOverlayController.toggleCode(code);
    }

    function applyTrackDetailPreferences(options = {}) {
      const { refreshThumbnails = false, preserveScroll = true } = options || {};
      const prefs = trackDetailSettings || DEFAULT_TRACK_DETAILS;
      document.body.classList.toggle('hide-track-number', !prefs.trackNumber);
      document.body.classList.toggle('no-thumbs', !prefs.thumbnail);
      document.body.classList.toggle('no-wrap-lines', !prefs.wrapLines);
      document.body.classList.toggle('show-track-country', !!prefs.country);
      document.body.classList.toggle('hide-track-check', !prefs.checkTrack);

      const nextSort = !!prefs.sortAZ;
      const sortChanged = sortAlphabetically !== nextSort;
      if (sortChanged) {
        sortAlphabetically = trackDetailStore.setSortAlphabetically(nextSort);
        renderTrackList({ preserveScroll, skipActiveScroll: preserveScroll });
      }

      if (refreshThumbnails) {
        renderTrackList({ preserveScroll, skipActiveScroll: preserveScroll });
      }
    }

    function syncTrackDetailsControls() {
      if (!detailCheckboxMap) return;
      Object.entries(detailCheckboxMap).forEach(([key, checkbox]) => {
        if (!checkbox) return;
        checkbox.checked = !!trackDetailSettings[key];
      });
    }

    function updateTrackDetailsButtonState() {
      if (!thumbToggleBtn || !thumbToggleIcon) return;
      thumbToggleBtn.setAttribute('aria-expanded', String(trackDetailsOverlayVisible));
      thumbToggleBtn.setAttribute('aria-pressed', String(trackDetailsOverlayVisible));
      thumbToggleBtn.setAttribute('aria-label', 'Track details');
      thumbToggleBtn.title = 'Track details';
      thumbToggleBtn.classList.toggle('active', trackDetailsOverlayVisible);
      thumbToggleIcon.className = 'icon tune';
      thumbToggleIcon.textContent = 'tune';
    }

    function persistTrackDetailSettings() {
      trackDetailSettings = trackDetailStore.setPreferences(trackDetailSettings);
    }

    function openTrackDetailsOverlay() {
      if (!trackDetailsOverlay) return;
      if (artistFilterOverlayController.isVisible()) {
        artistFilterOverlayController.close();
      }
      if (countryFilterOverlayController.isVisible()) {
        countryFilterOverlayController.close();
      }
      syncTrackDetailsControls();
      trackDetailsOverlay.classList.add('visible');
      trackDetailsOverlay.setAttribute('aria-hidden', 'false');
      trackDetailsOverlayVisible = true;
      updateTrackDetailsButtonState();
    }

    function closeTrackDetailsOverlay(options = {}) {
      if (!trackDetailsOverlay) return;
      trackDetailsOverlay.classList.remove('visible');
      trackDetailsOverlay.setAttribute('aria-hidden', 'true');
      trackDetailsOverlayVisible = false;
      updateTrackDetailsButtonState();
      if (options && options.focusButton && thumbToggleBtn && typeof thumbToggleBtn.focus === 'function') {
        thumbToggleBtn.focus({ preventScroll: true });
      }
    }

    function toggleTrackDetailsOverlay() {
      if (trackDetailsOverlayVisible) {
        closeTrackDetailsOverlay();
      } else {
        openTrackDetailsOverlay();
      }
    }

    function initController() {
      if (controller) return;
      playerReady = false;
      controller = new YTController({ elementId: 'player' });
      spectrum.setController(controller);
      controller.onReady(onPlayerReady);
      controller.onStateChange(onPlayerStateChange);
      controller.init();
    }

    initController();

    async function onPlayerReady() {
      playerReady = true;
      startProgressTimer();

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
        if (currentIndex >= 0 && playlistItems[currentIndex] && controller) {
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
      if (state === CONTROLLER_STATES.ENDED) {
        playNext();
      } else if (state === CONTROLLER_STATES.PLAYING) {
        isPlaying = true;
        updatePlayPauseButton();
        focusActiveTrack({ scroll: false });
        spectrum.start();
      } else if (state === CONTROLLER_STATES.PAUSED) {
        isPlaying = false;
        updatePlayPauseButton();
        focusActiveTrack({ scroll: false });
        spectrum.stop();
      } else if (state === CONTROLLER_STATES.CUED || state === CONTROLLER_STATES.UNSTARTED) {
        isPlaying = false;
        updatePlayPauseButton();
        focusActiveTrack({ scroll: false });
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
      filteredIndices = [];
      const f = (filterText || '').trim().toLowerCase();
      const selectedArtists = new Set(artistFilters.map(normalizeArtistKey).filter(Boolean));
      const selected = new Set(normalizeCountryFilterList(countryFilters));
      playlistItems.forEach((item, idx) => {
        const title = (item.title || '').toLowerCase();
        const customTitle = (typeof item.userTitle === 'string' ? item.userTitle : '').toLowerCase();

        if (selectedArtists.size) {
          const artists = splitArtists(getArtistSourceText(item));
          if (!artists.length) return;
          let artistMatch = false;
          for (const artist of artists) {
            if (selectedArtists.has(normalizeArtistKey(artist))) {
              artistMatch = true;
              break;
            }
          }
          if (!artistMatch) return;
        }

        if (selected.size) {
          const codes = splitCountryCodes(item && typeof item === 'object' ? item.country : '');
          if (!codes.length) {
            if (!selected.has('?')) return;
          } else {
            let match = false;
            for (const code of codes) {
              if (selected.has(code)) {
                match = true;
                break;
              }
            }
            if (!match) return;
          }
        }

        if (!f || title.includes(f) || customTitle.includes(f)) {
          filteredIndices.push(idx);
        }
      });
    }

    function getSortKeyForIndex(idx) {
      const item = playlistItems[idx];
      if (!item) return '';
      const rawTitle = typeof item.userTitle === 'string' && item.userTitle.trim().length
        ? item.userTitle
        : item.title || '';

      // If multiple artists are present (e.g. "A;B - Title"), ignore everything from
      // the first ';' onward *in the artist portion* for track A–Z sorting.
      const dashIdx = rawTitle.indexOf(' - ');
      if (dashIdx >= 0) {
        const artistPart = rawTitle.slice(0, dashIdx);
        const semiIdx = artistPart.indexOf(';');
        if (semiIdx >= 0) {
          const firstArtist = artistPart.slice(0, semiIdx).trim();
          const rest = rawTitle.slice(dashIdx);
          return makeSortKey(`${firstArtist}${rest}`);
        }
      } else {
        const semiIdx = rawTitle.indexOf(';');
        if (semiIdx >= 0) {
          return makeSortKey(rawTitle.slice(0, semiIdx));
        }
      }

      return makeSortKey(rawTitle);
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

    function splitTrackDisplayText(raw) {
      const text = typeof raw === 'string' ? raw : '';
      const idx = text.indexOf(' - ');
      if (idx < 0) {
        return { artist: '', title: text.trim() };
      }
      const artistPart = text.slice(0, idx).trim();
      const titlePart = text.slice(idx + 3).trim();

      const artistPieces = artistPart
        .split(';')
        .map((p) => (p || '').trim())
        .filter(Boolean);

      if (!artistPieces.length) {
        return { artist: '', title: titlePart || '' };
      }

      const artist = artistPieces.join(', ');
      return { artist, title: titlePart || '' };
    }

    function renderTrackList(options = {}) {
      const { preserveScroll = false, skipActiveScroll } = options || {};
      const container = document.getElementById('trackListContainer');
      const suppressActiveScroll = typeof skipActiveScroll === 'boolean' ? skipActiveScroll : preserveScroll;
      let previousScrollTop = 0;
      if (preserveScroll && container) {
        previousScrollTop = container.scrollTop;
      }
      const ul = document.getElementById('trackList');
      ul.innerHTML = '';
      trackRowElements = new Map();

      const hasFilter = (filterText || '').trim().length > 0
        || (Array.isArray(artistFilters) && artistFilters.length > 0)
        || (Array.isArray(countryFilters) && countryFilters.length > 0);
      let indices = hasFilter ? filteredIndices.slice() : playlistItems.map((_, i) => i);
      if (sortAlphabetically) {
        indices = getSortedIndices(indices);
      }
      visibleIndices = indices.slice();

      const nextHash = hashIndexList(visibleIndices);
      if (nextHash !== visibleIndicesHash) {
        visibleIndicesHash = nextHash;
        visibleIndicesVersion += 1;
        shuffleQueue.onQueueChanged();
      }
      const activePlaylistId = getActivePlaylistId();

      indices.forEach((realIdx, displayIdx) => {
        const item = playlistItems[realIdx];
        const li = document.createElement('li');
        if (realIdx === currentIndex) li.classList.add('active');

        const rawTitle = item.userTitle ? item.userTitle : item.title;
        const primaryArtist = splitArtists(rawTitle)[0] || '';

        const numSpan = document.createElement('span');
        numSpan.className = 'track-number';
        numSpan.textContent = (displayIdx + 1);

        // Click/keyboard on the track number toggles the primary artist filter.
        // (Moved from thumbnail to avoid accidental taps on small screens.)
        if (primaryArtist) {
          numSpan.setAttribute('role', 'button');
          numSpan.tabIndex = 0;
          numSpan.title = `Filter artist: ${primaryArtist}`;

          numSpan.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            toggleArtistFilterName(primaryArtist);
          });

          numSpan.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
            event.preventDefault();
            event.stopPropagation();
            toggleArtistFilterName(primaryArtist);
          });
        }
        li.appendChild(numSpan);

        if (trackDetailSettings.thumbnail && item.thumbnail) {
          const img = document.createElement('img');
          img.src = item.thumbnail;

          li.appendChild(img);
        }
        const parts = splitTrackDisplayText(rawTitle);

        const textWrap = document.createElement('span');
        textWrap.className = 'title';

        const titleSpan = document.createElement('span');
        titleSpan.className = 'track-title';
        titleSpan.textContent = parts.title || rawTitle || '';

        const artistLine = document.createElement('span');
        artistLine.className = 'track-artist-line';

        const artistSpan = document.createElement('span');
        artistSpan.className = 'track-artist';
        artistSpan.textContent = parts.artist || '';
        artistLine.appendChild(artistSpan);

        const sepSpan = document.createElement('span');
        sepSpan.className = 'track-sep';
        sepSpan.textContent = ' - ';

        const codes = splitCountryCodes(item && typeof item === 'object' ? item.country : '');
        const flagEntries = codes
          .map((iso3) => ({
            iso3,
            flag: iso3 ? getCountryFlagEmoji(iso3) : ''
          }))
          .filter((entry) => !!entry.flag);

        if (flagEntries.length) {
          const flagsWrap = document.createElement('span');
          flagsWrap.className = 'track-country-flags';

          flagEntries.forEach(({ iso3, flag }) => {
            const flagSpan = document.createElement('span');
            flagSpan.className = 'track-country-flag';
            flagSpan.textContent = flag;
            if (iso3) {
              flagSpan.setAttribute('role', 'button');
              flagSpan.tabIndex = 0;
              flagSpan.title = `Filter: ${iso3}`;
              flagSpan.dataset.iso3 = iso3;

              flagSpan.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                toggleCountryFilterCode(iso3);
              });

              flagSpan.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
                event.preventDefault();
                event.stopPropagation();
                toggleCountryFilterCode(iso3);
              });
            }

            flagsWrap.appendChild(flagSpan);
          });

          // Reserve enough space so the flags don't overlay the artist text.
          // 18px font-size + ~2px gap per extra flag + a little breathing room.
          const spacePx = flagEntries.length * 18 + Math.max(0, flagEntries.length - 1) * 2 + 6;
          artistLine.style.setProperty('--track-country-flags-space', `${spacePx}px`);

          artistLine.classList.add('has-flags');
          artistLine.appendChild(flagsWrap);
        }

        if (parts.artist) {
          textWrap.appendChild(artistLine);
          textWrap.appendChild(sepSpan);
        }
        textWrap.appendChild(titleSpan);

        li.appendChild(textWrap);

        const stateBtn = createTrackStateButton(item.videoId, activePlaylistId);
        li.appendChild(stateBtn);

        trackRowElements.set(realIdx, li);

        li.addEventListener('click', () => {
          playIndex(realIdx);
        });

        li.addEventListener('auxclick', (event) => {
          if (event.button !== 1) return;
          const targetEl = event.target instanceof Element ? event.target : null;
          if (targetEl && targetEl.closest('.track-state-btn')) return;
          event.preventDefault();

          const playlistId = getActivePlaylistId();
          const baseUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId)}`;
          const url = playlistId
            ? `${baseUrl}&list=${encodeURIComponent(playlistId)}`
            : baseUrl;
          window.open(url, '_blank', 'noopener');
        });

        ul.appendChild(li);
      });

      if (preserveScroll && container) {
        container.scrollTop = previousScrollTop;
      }

      if (!suppressActiveScroll) {
        scrollActiveIntoView();
      }
    }

    function updateActiveTrackRow(previousIdx, nextIdx) {
      if (previousIdx === nextIdx) {
        const currentEl = trackRowElements.get(nextIdx);
        if (currentEl) {
          currentEl.classList.add('active');
        }
        return;
      }

      if (typeof previousIdx === 'number') {
        const prevEl = trackRowElements.get(previousIdx);
        if (prevEl) {
          prevEl.classList.remove('active');
        }
      }

      const nextEl = trackRowElements.get(nextIdx);
      if (nextEl) {
        nextEl.classList.add('active');
      }
    }

    function createTrackStateButton(videoId, playlistId) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'track-state-btn';
      btn.dataset.videoId = videoId;

      const icon = document.createElement('span');
      icon.setAttribute('aria-hidden', 'true');
      btn.appendChild(icon);

      function apply(state) {
        btn.dataset.state = state;
        if (state === TRACK_STATE_CHECKED) {
          btn.classList.add('is-checked');
          btn.setAttribute('aria-label', 'Mark video as incomplete');
          btn.title = 'Mark video as incomplete';
          btn.setAttribute('aria-pressed', 'true');
          icon.className = 'icon check-circle';
          icon.textContent = 'check_circle';
        } else {
          btn.classList.remove('is-checked');
          btn.setAttribute('aria-label', 'Mark video as completed');
          btn.title = 'Mark video as completed';
          btn.setAttribute('aria-pressed', 'false');
          icon.className = 'icon circle';
          icon.textContent = 'circle';
        }
      }

      apply(getTrackStateForPlaylist(playlistId, videoId));

      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        const next = toggleTrackStateForPlaylist(playlistId, videoId);
        apply(next);
      });

      return btn;
    }

    function scrollActiveIntoView() {
      const ul = document.getElementById('trackList');
      const active = ul.querySelector('li.active');
      if (active) {
        active.scrollIntoView({ block: 'center', behavior: 'auto' });
      }
    }

    function focusActiveTrack(options = {}) {
      const { scroll = true } = options || {};
      if (scroll) {
        scrollActiveIntoView();
      }
      if (trackListContainerEl && typeof trackListContainerEl.focus === 'function') {
        trackListContainerEl.focus({ preventScroll: true });
      }
    }

    function updateNowPlaying() {
      const el = document.getElementById('nowPlaying');
      if (!el) return;
      if (currentIndex < 0 || !playlistItems[currentIndex]) {
        el.textContent = '–';
      } else {
        el.textContent = playlistItems[currentIndex].title;
      }
    }

    function playIndex(idx, options = {}) {
      if (!controller || !playlistItems[idx]) return;
      const suppressShuffleHistoryRecord = !!options.suppressShuffleHistoryRecord;
      const playerState = controller.getState();
      const playerStates = CONTROLLER_STATES;
      const sameIndex = currentIndex === idx;
      const targetVideoId = playlistItems[idx].videoId;
      const currentVideoId = controller.getVideoId();
      const isSameVideo = sameIndex && targetVideoId && currentVideoId === targetVideoId;
      const isActivelyPlaying = playerState === playerStates.PLAYING || playerState === playerStates.BUFFERING;
      const previousIndex = currentIndex;

      if (isSameVideo) {
        focusActiveTrack();
        if (isActivelyPlaying) {
          return;
        }
        if (playerState === playerStates.PAUSED) {
          if (playerReady && controller) {
            sidebar.suppressHide(1500);
            controller.play();
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

      if (!trackRowElements.size || !trackRowElements.has(currentIndex)) {
        renderTrackList();
      } else {
        updateActiveTrackRow(previousIndex, currentIndex);
      }
      updatePlayPauseButton();
      if (!playerReady) {
        pendingPlayIndex = idx;
        return;
      }
      sidebar.suppressHide(5000);
      controller.load(videoId, { autoplay: true });
      pendingPlayIndex = null;
      const playlistId = settings.playlistId || '';
      updateCurrentVideo(playlistId, videoId);
      focusActiveTrack();
    }

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

    function playNext() {
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
        playIndex(nextIdx, { suppressShuffleHistoryRecord: shuffleQueue.isEnabled() && fromHistory });
      }
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
      if (!controller) return;
      const playerStates = CONTROLLER_STATES;
      const state = controller.getState();
      const activelyPlaying = state === playerStates.PLAYING || state === playerStates.BUFFERING;

      if (isPlaying !== activelyPlaying) {
        isPlaying = activelyPlaying;
        updatePlayPauseButton();
      }

      if (activelyPlaying) {
        sidebar.suppressHide(1500);
        controller.pause();
      } else {
        sidebar.suppressHide(1500);
        controller.play();
      }
      focusActiveTrack();
    }

    document.getElementById('playPauseBtn').addEventListener('click', () => {
      togglePlayback();
    });
    document.getElementById('nextBtn').addEventListener('click', playNext);
    document.getElementById('prevBtn').addEventListener('click', playPrev);

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

    if (shuffleBtn) {
      shuffleBtn.addEventListener('click', () => {
        toggleShuffleMode();
      });
      updateShuffleButtonState();
    }

    async function loadPlaylistFromServer(forceRefresh = false, playlistIdOverride = '') {
      if (useLocalMode) {
        return loadPlaylistFromLocal(playlistIdOverride);
      }

      const override = typeof playlistIdOverride === 'string' ? playlistIdOverride.trim() : '';
      const fallback = typeof settings.playlistId === 'string' ? settings.playlistId.trim() : '';
      const targetId = override || fallback;
      if (!targetId) {
        return undefined;
      }

      const url = `${PLAYLIST_ENDPOINT}?playlistId=${encodeURIComponent(targetId)}${forceRefresh ? '&forceRefresh=1' : ''}`;

      let resp;
      try {
        resp = await fetch(url);
      } catch (networkError) {
        console.error('Playlist request failed:', networkError);
        return enterLocalFallback(playlistIdOverride);
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
        return enterLocalFallback(playlistIdOverride);
      }
      const data = await resp.json();
      playlistItems = data.items || [];
      playlistVersion += 1;
      shuffleQueue.resetAll();
      visibleIndicesHash = 0;
      visibleIndicesVersion += 1;

      countryFilterOverlayController.updateOptions();
      artistFilterOverlayController.updateOptions();
      const resolvedPlaylistId =
        (typeof data.playlistId === 'string' && data.playlistId.trim().length
          ? data.playlistId.trim()
          : targetId) || targetId;
      const playlistTitle =
        (typeof data.title === 'string' && data.title.trim().length ? data.title.trim() : '') ||
        (typeof data.playlistTitle === 'string' && data.playlistTitle.trim().length ? data.playlistTitle.trim() : '') ||
        resolvedPlaylistId;

      saveSettings({ playlistId: resolvedPlaylistId });

      const savedMap = getCurrentVideoMap();
      const storedVideoId = savedMap[resolvedPlaylistId];
      let idxFromStorage = -1;
      if (storedVideoId) {
        idxFromStorage = playlistItems.findIndex((it) => it.videoId === storedVideoId);
      }
      if (idxFromStorage >= 0) {
        currentIndex = idxFromStorage;
      } else {
        currentIndex = playlistItems.length ? 0 : -1;
      }

      filterText = filterInputEl.value || '';
      computeFilteredIndices();
      renderTrackList();
      updateNowPlaying();
      updatePlayPauseButton();
      if (currentIndex >= 0 && controller) {
        playIndex(currentIndex);
      }

      addPlaylistToHistory(resolvedPlaylistId, playlistTitle);
      updateUrlPlaylistParam(resolvedPlaylistId);

      return resolvedPlaylistId;
    }

    function downloadCurrentPlaylist() {
      if (!playlistItems || playlistItems.length === 0) {
        showAlert('No playlist loaded yet.');
        return false;
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
          const entry = {
            ...item,
            userTitle: item.userTitle ?? item.title
          };
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

    function setupPlaylistOverlay() {
      if (playlistIOInstance || typeof initPlaylistIO !== 'function') {
        return;
      }

      if (playlistIOBtn) {
        playlistIOBtn.style.display = '';
        playlistIOBtn.removeAttribute('aria-hidden');
      }

      playlistIOInstance = initPlaylistIO({
        triggerElement: playlistIOBtn,
        getPlaylistId: () => (typeof settings.playlistId === 'string' ? settings.playlistId : ''),
        getPlaylistHistory: () => playlistHistory.slice(),
        removePlaylist: (id) => removePlaylistFromHistory(id),
        getUserSettings: () => {
          try {
            return JSON.parse(JSON.stringify(settings));
          } catch (error) {
            return settings;
          }
        },
        resetUserSettings: () => resetStoredSettings(),
        onLoad: async ({ playlistId, forceRefresh }) => {
          await loadPlaylistFromServer(Boolean(forceRefresh), playlistId);
        },
        onDownload: () => downloadCurrentPlaylist(),
        showAlert
      });

      if (playlistIOInstance && typeof playlistIOInstance.refreshSettings === 'function') {
        notifySettingsUpdated = () => {
          try {
            playlistIOInstance.refreshSettings();
          } catch (error) {
            console.warn('Failed to refresh playlist overlay settings view:', error);
          }
        };
      } else {
        notifySettingsUpdated = () => {};
      }

      if (playlistIOInstance && typeof playlistIOInstance.setServerAvailability === 'function') {
        playlistIOInstance.setServerAvailability(!useLocalMode);
      }
    }

    function enableLocalModeUi() {
      useLocalMode = true;
      setupPlaylistOverlay();
      if (playlistIOInstance && typeof playlistIOInstance.setServerAvailability === 'function') {
        playlistIOInstance.setServerAvailability(false);
      }

      // Once local data is available, populate the selector with all local playlists.
      ensureLocalPlaylistData()
        .then(() => updatePlaylistHistorySelect(settings.playlistId || ''))
        .catch(() => {});
    }

    async function checkServerAvailability() {
      try {
        const resp = await fetch(STATUS_ENDPOINT, { cache: 'no-store' });
        if (!resp || !resp.ok) {
          spectrum.disable();
          return false;
        }
        try {
          const body = await resp.json();
          if (body && typeof body === 'object' && !Array.isArray(body)) {
            if (Object.prototype.hasOwnProperty.call(body, 'spectrum-cache')) {
              if (body['spectrum-cache'] === false) {
                spectrum.disable();
              } else if (body['spectrum-cache'] === true) {
                spectrum.setEnabled(true);
              }
            }
          }
          if (body && body.ok === false) {
            spectrum.disable();
            return false;
          }
        } catch (error) {
          // ignore JSON parse errors, treat as available
        }
        return true;
      } catch (error) {
        console.warn('Server status check failed:', error);
        spectrum.disable();
        return false;
      }
    }

    async function ensureLocalPlaylistData() {
      if (localPlaylistLibrary) {
        return localPlaylistLibrary;
      }
      try {
        const resp = await fetch(LOCAL_PLAYLIST_PATH, { cache: 'no-store' });
        if (!resp.ok) {
          console.error('Failed to load local playlist file:', resp.status);
          return null;
        }
        localPlaylistLibrary = await resp.json();

        // If we're in local mode, refresh the select to show all available playlists.
        if (useLocalMode) {
          updatePlaylistHistorySelect(settings.playlistId || '');
        }

        return localPlaylistLibrary;
      } catch (error) {
        console.error('Failed to load local playlist file:', error);
        return null;
      }
    }

    async function loadPlaylistFromLocal(playlistIdOverride = '') {
      const library = await ensureLocalPlaylistData();
      if (!library || typeof library !== 'object') {
        showAlert('Local playlist data is unavailable.');
        return undefined;
      }

      const availableIds = Object.keys(library);
      if (!availableIds.length) {
        showAlert('Local playlist file does not contain any playlists.');
        return undefined;
      }

      const override = typeof playlistIdOverride === 'string' ? playlistIdOverride.trim() : '';
      const fallback = typeof settings.playlistId === 'string' ? settings.playlistId.trim() : '';
      let targetId = override || fallback;
      if (!targetId || !library[targetId]) {
        targetId = availableIds[0];
      }

      const entry = library[targetId];
      if (!entry || typeof entry !== 'object') {
        showAlert('Selected playlist is not available in local data.');
        return undefined;
      }

      const playlistTitle = (typeof entry.title === 'string' && entry.title.trim().length)
        ? entry.title.trim()
        : targetId;

      playlistItems = Array.isArray(entry.items) ? entry.items.slice() : [];
      playlistVersion += 1;
      shuffleQueue.resetAll();
      visibleIndicesHash = 0;
      visibleIndicesVersion += 1;

      countryFilterOverlayController.updateOptions();
      artistFilterOverlayController.updateOptions();
      saveSettings({ playlistId: targetId });

      const savedMap = getCurrentVideoMap();
      const storedVideoId = savedMap[targetId];
      let idxFromStorage = -1;
      if (storedVideoId) {
        idxFromStorage = playlistItems.findIndex((it) => it.videoId === storedVideoId);
      }
      currentIndex = idxFromStorage >= 0 ? idxFromStorage : (playlistItems.length ? 0 : -1);

      filterText = filterInputEl.value || '';
      computeFilteredIndices();
      renderTrackList();
      updateNowPlaying();
      updatePlayPauseButton();
      addPlaylistToHistory(targetId, playlistTitle);
      updateUrlPlaylistParam(targetId);

      if (currentIndex >= 0 && controller) {
        playIndex(currentIndex);
      }

      return targetId;
    }

    async function enterLocalFallback(playlistIdOverride = '') {
      if (!useLocalMode) {
        enableLocalModeUi();
        if (!localFallbackNotified) {
          console.warn('Server unavailable. Falling back to local playlist data.');
          localFallbackNotified = true;
        }
      }
      return loadPlaylistFromLocal(playlistIdOverride);
    }

    async function initializeDataSource() {
      const available = await checkServerAvailability();
      setupPlaylistOverlay();
      if (available) {
        useLocalMode = false;
        if (playlistIOInstance && typeof playlistIOInstance.setServerAvailability === 'function') {
          playlistIOInstance.setServerAvailability(true);
        }
        return true;
      }

      enableLocalModeUi();
      try {
        const startupPlaylistId = initialPlaylistId || settings.playlistId || '';
        await loadPlaylistFromLocal(startupPlaylistId);
      } catch (error) {
        console.warn('Failed to initialize local playlist fallback:', error);
      }
      return false;
    }

    const dataSourceReadyPromise = initializeDataSource();

    if (shouldResetSettingsFromQuery) {
      resetStoredSettings();
    }

    document.getElementById('playlistForm').addEventListener('submit', (e) => {
      e.preventDefault();
    });

    // track detail overlay toggle
    if (thumbToggleBtn) {
      thumbToggleBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleTrackDetailsOverlay();
      });
    }

    if (trackDetailsOverlay) {
      trackDetailsOverlay.addEventListener('click', (event) => {
        event.stopPropagation();
      });
    }

    document.addEventListener('click', (event) => {
      if (!trackDetailsOverlayVisible) return;
      if (trackDetailsWrapper && trackDetailsWrapper.contains(event.target)) return;
      closeTrackDetailsOverlay();
    });

    Object.entries(detailCheckboxMap).forEach(([key, checkbox]) => {
      if (!checkbox) return;
      checkbox.addEventListener('change', () => {
        trackDetailSettings = { ...trackDetailSettings, [key]: checkbox.checked };
        const shouldRefreshThumbnails = key === 'thumbnail';
        applyTrackDetailPreferences({ refreshThumbnails: shouldRefreshThumbnails, preserveScroll: true });
        persistTrackDetailSettings();
      });
    });

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
      if (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') return true;
      if (ae.isContentEditable) return true;
      return false;
    }

    document.addEventListener('keydown', (e) => {
      if (isTextInputFocused()) return;

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
        if (!controller) {
          return;
        }
        const duration = controller.getDuration();
        const delta = e.key === 'ArrowLeft' ? -10 : 10;
        const currentTime = controller.getCurrentTime();
        const newTime = Math.max(0, currentTime + delta);
        sidebar.suppressHide(8000);
        controller.seekTo(newTime, true);
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
    });

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
      if (!controller) {
        progressRange.value = 0;
        timeLabel.textContent = '00:00 / 00:00';
        return;
      }

      const duration = controller.getDuration();
      const current = controller.getCurrentTime();

      if (!duration || !isFinite(duration) || duration <= 0) {
        progressRange.value = 0;
        timeLabel.textContent = '00:00 / 00:00';
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
      if (!controller) {
        return;
      }
      const duration = controller.getDuration();
      if (!duration || !isFinite(duration) || duration <= 0) return;
      const frac = Number(progressRange.value) / 1000;
      const newTime = frac * duration;
      if (isProgressScrubbing) {
        sidebar.suppressHide(8000);
      }
      updateSeekFeedbackFromFraction(frac);
      controller.seekTo(newTime, true);
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
        getDuration: () => controller ? controller.getDuration() : 0,
        getCurrentTime: () => controller ? controller.getCurrentTime() : 0,
        seekTo: (seconds, allowSeekAhead) => {
          if (!controller) return;
          controller.seekTo(seconds, allowSeekAhead);
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
