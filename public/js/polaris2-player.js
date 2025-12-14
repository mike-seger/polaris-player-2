    let player;
    let playlistItems = [];
    let currentIndex = -1;
    let isPlaying = false;
    let sortAlphabetically = false;
    const DEFAULT_TRACK_DETAILS = Object.freeze({
      trackNumber: true,
      thumbnail: true,
      wrapLines: true,
      checkTrack: true,
      sortAZ: false
    });
    let trackDetailSettings = { ...DEFAULT_TRACK_DETAILS };
    let trackDetailsOverlayVisible = false;

    let filterText = '';
    let filteredIndices = [];
    let trackRowElements = new Map();
    let visibleIndices = [];
    let useLocalMode = false;
    let localPlaylistLibrary = null;
    let localFallbackNotified = false;
    let playlistIOInstance = null;
    let playerReady = false;
    let pendingPlayIndex = null;

    const STORAGE_KEY = 'ytAudioPlayer.settings';
    let settings = loadSettings();
    const API_BASE_PATH = window.location.hostname.endsWith('polaris.net128.com') ? '/u2b' : '.';
    const STATUS_ENDPOINT = `${API_BASE_PATH}/api/status`;
    const PLAYLIST_ENDPOINT = `${API_BASE_PATH}/api/playlist`;
    const LOCAL_PLAYLIST_PATH = './local-playlist.json';
    const PLAYLIST_HISTORY_LIMIT = 25;
    const rawPlaylistHistory = Array.isArray(settings.playlistHistory) ? settings.playlistHistory : [];
    let playlistHistory = normalizePlaylistHistory(rawPlaylistHistory);
    settings.playlistHistory = playlistHistory;
    const historyNeedsPersist = JSON.stringify(rawPlaylistHistory) !== JSON.stringify(playlistHistory);
    const TRACK_STATE_DEFAULT = 'default';
    const TRACK_STATE_CHECKED = 'checked';
    const urlParams = new URLSearchParams(window.location.search);
    const initialPlaylistId = (urlParams.get('pl') || '').trim();
    const hadInitialPlaylistParam = urlParams.has('pl');
    const shouldResetSettingsFromQuery = ((urlParams.get('reset') || '').trim().toLowerCase() === 'true');

    // settings helpers
    let notifySettingsUpdated = () => {};
    function loadSettings() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
      } catch (e) {
        console.warn('Failed to load settings:', e);
        return {};
      }
    }
    function saveSettings(patch) {
      settings = Object.assign({}, settings, patch);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      } catch (e) {
        console.warn('Failed to save settings:', e);
      }
      try {
        notifySettingsUpdated();
      } catch (notifyError) {
        console.warn('Settings overlay update failed:', notifyError);
      }
    }

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

    function normalizePlaylistHistory(raw) {
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
        if (cleaned.length >= PLAYLIST_HISTORY_LIMIT) break;
      }
      return cleaned;
    }

    // DOM refs
    const playlistIOBtn = document.getElementById('playlistIOBtn');
    const filterInputEl = document.getElementById('filterInput');
    const filterWrapper = document.getElementById('filterWrapper');
    const clearFilterBtn = document.getElementById('clearFilterBtn');
    const thumbToggleBtn = document.getElementById('thumbToggleBtn');
    const thumbToggleIcon = document.getElementById('thumbToggleIcon');
    const trackDetailsWrapper = document.getElementById('trackDetailsWrapper');
    const trackDetailsOverlay = document.getElementById('trackDetailsOverlay');
    const detailTrackNumberCheckbox = document.getElementById('detailTrackNumber');
    const detailThumbnailCheckbox = document.getElementById('detailThumbnail');
    const detailWrapLinesCheckbox = document.getElementById('detailWrapLines');
    const detailCheckTrackCheckbox = document.getElementById('detailCheckTrack');
    const detailSortAZCheckbox = document.getElementById('detailSortAZ');
    const detailCheckboxMap = {
      trackNumber: detailTrackNumberCheckbox,
      thumbnail: detailThumbnailCheckbox,
      wrapLines: detailWrapLinesCheckbox,
      checkTrack: detailCheckTrackCheckbox,
      sortAZ: detailSortAZCheckbox
    };
    const progressRange = document.getElementById('progressRange');
    const timeLabel = document.getElementById('timeLabel');
    const playPauseIcon = document.getElementById('playPauseIcon');
    const trackControlsEl = document.getElementById('trackControls');
    const playlistHistorySelect = document.getElementById('playlistHistorySelect');
    const trackListContainerEl = document.getElementById('trackListContainer');
    const alertOverlay = document.getElementById('alertOverlay');
    const alertMessageEl = document.getElementById('alertMessage');
    const alertCloseBtn = document.getElementById('alertCloseBtn');
    const spectrumCanvas = document.getElementById('spectrumCanvas');
    let lastFocusedElement = null;

    // ---- Offline spectrum cache + renderer ----
    // Cache format: `public/spectrum-cache/<videoId>.spc32`
    // Header (32 bytes):
    // 0..3   magic 'SPC1'
    // 4      version u8
    // 5      bins u8
    // 6      fps u8
    // 7      reserved
    // 8..11  sampleRate u32le
    // 12..15 durationMs u32le
    // 16..19 frameCount u32le
    // 20..27 videoIdHash (sha256 first 8 bytes)
    // 28..31 reserved
    // Payload: frameCount * bins u8

    const SPECTRUM_CACHE_DIR = './spectrum-cache';
    const spectrumState = {
      bins: 16,
      fps: 20,
      frameCount: 0,
      durationMs: 0,
      frames: null,
      peaks: null,
      rafId: null,
      lastVideoId: '',
      dpr: 1,
    };

    function ensureSpectrumPeaks(binCount) {
      if (spectrumState.peaks && spectrumState.peaks.length === binCount) return;
      spectrumState.peaks = new Float32Array(binCount);
      spectrumState.peaks.fill(0);
    }

    function u8ToHex(u8) {
      return Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
    }

    async function sha256First8Bytes(str) {
      if (!window.crypto?.subtle) return null;
      const data = new TextEncoder().encode(str);
      const digest = await window.crypto.subtle.digest('SHA-256', data);
      return new Uint8Array(digest).slice(0, 8);
    }

    function drawSpectrumFrame(frameU8) {
      if (!spectrumCanvas || !frameU8) return;
      const ctx = spectrumCanvas.getContext('2d');
      if (!ctx) return;

      const cssW = spectrumCanvas.clientWidth || 1;
      const cssH = spectrumCanvas.clientHeight || 1;
      const dpr = window.devicePixelRatio || 1;
      if (spectrumState.dpr !== dpr || spectrumCanvas.width !== Math.round(cssW * dpr) || spectrumCanvas.height !== Math.round(cssH * dpr)) {
        spectrumState.dpr = dpr;
        spectrumCanvas.width = Math.round(cssW * dpr);
        spectrumCanvas.height = Math.round(cssH * dpr);
      }

      const W = spectrumCanvas.width;
      const H = spectrumCanvas.height;
      ctx.clearRect(0, 0, W, H);

      // Background grid-like dots (subtle Winamp vibe)
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      const grid = Math.max(4, Math.floor(8 * spectrumState.dpr));
      for (let y = grid; y < H; y += grid) {
        for (let x = grid; x < W; x += grid) {
          ctx.fillRect(x, y, 1, 1);
        }
      }

      const binCount = Math.min(frameU8.length, spectrumState.bins);
      ensureSpectrumPeaks(binCount);
      // More Winamp-like proportion: fewer, chunkier bars.
      // Reduce gaps ~50% and spend the space on wider bars.
      const gap = Math.max(1, Math.round(1.5 * spectrumState.dpr));
      const barW = Math.max(2, Math.floor((W - gap * (binCount + 1)) / binCount));
      const maxBarH = H - Math.round(6 * spectrumState.dpr);
      const baseY = H - Math.round(3 * spectrumState.dpr);

      // Peak hold: keep a decaying peak per bin.
      // Tuned for ~60fps render loop while cache is 20fps.
      const peakFallPerFrame = 0.018; // fraction per animation frame
      // Peak marker should be a single device pixel.
      const peakCapH = Math.max(1, Math.round(1 * spectrumState.dpr));

      for (let i = 0; i < binCount; i++) {
        const v = frameU8[i] / 255;
        const h = Math.max(1, Math.round(v * maxBarH));
        const x = gap + i * (barW + gap);
        const y = baseY - h;

        // Height-based ramp: green -> yellow -> orange -> red.
        // Red should occupy a noticeable top band, not just 1px.
        const grad = ctx.createLinearGradient(0, y, 0, baseY);
        // More vivid ramp.
        grad.addColorStop(0.00, '#ff0033'); // vivid red (top)
        grad.addColorStop(0.18, '#ff6a00'); // vivid orange
        grad.addColorStop(0.40, '#ffe600'); // vivid yellow
        grad.addColorStop(1.00, '#00ff57'); // vivid green (bottom)
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, barW, h);

        // Peak hold update + draw (thicker cap)
        const peaks = spectrumState.peaks;
        const nextPeak = Math.max(v, (peaks[i] || 0) - peakFallPerFrame);
        peaks[i] = nextPeak;

        const peakH = Math.max(1, Math.round(nextPeak * maxBarH));
        const peakY = Math.max(0, baseY - peakH);
        const capY = Math.max(0, peakY);
        const capH = Math.min(peakCapH, baseY - capY);

        // Pick cap color by level (green/yellow/orange/red)
        let capColor = '#00ff57';
        if (nextPeak >= 0.88) capColor = '#ff0033';
        else if (nextPeak >= 0.76) capColor = '#ff6a00';
        else if (nextPeak >= 0.60) capColor = '#ffe600';
        ctx.fillStyle = capColor;
        ctx.fillRect(x, capY, barW, capH);
      }
    }

    function stopSpectrumAnimation() {
      if (spectrumState.rafId) {
        cancelAnimationFrame(spectrumState.rafId);
        spectrumState.rafId = null;
      }
    }

    function startSpectrumAnimation() {
      stopSpectrumAnimation();
      if (!spectrumCanvas || !spectrumState.frames || !player || typeof player.getCurrentTime !== 'function') return;

      const tick = () => {
        if (!spectrumState.frames || !player || typeof player.getCurrentTime !== 'function') {
          spectrumState.rafId = null;
          return;
        }
        const t = player.getCurrentTime();
        const frameIndex = Math.max(0, Math.min(spectrumState.frameCount - 1, Math.floor(t * spectrumState.fps)));
        const offset = frameIndex * spectrumState.bins;
        const frame = spectrumState.frames.subarray(offset, offset + spectrumState.bins);
        drawSpectrumFrame(frame);
        spectrumState.rafId = requestAnimationFrame(tick);
      };

      spectrumState.rafId = requestAnimationFrame(tick);
    }

    async function loadSpectrumForVideoId(videoId) {
      if (!videoId) return false;
      if (videoId === spectrumState.lastVideoId && spectrumState.frames) return true;

      stopSpectrumAnimation();
      spectrumState.lastVideoId = videoId;
      spectrumState.frames = null;
      spectrumState.frameCount = 0;
      spectrumState.durationMs = 0;
      document.body.classList.add('spectrum-missing');

      const url = `${SPECTRUM_CACHE_DIR}/${encodeURIComponent(videoId)}.spc32`;
      let buf;
      try {
        const resp = await fetch(url, { cache: 'no-store' });
        if (!resp.ok) return false;
        buf = await resp.arrayBuffer();
      } catch {
        return false;
      }

      if (buf.byteLength < 32) return false;
      const view = new DataView(buf);
      const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
      if (magic !== 'SPC1') return false;
      const version = view.getUint8(4);
      if (version !== 1) return false;
      const bins = view.getUint8(5);
      const fps = view.getUint8(6);
      const durationMs = view.getUint32(12, true);
      const frameCount = view.getUint32(16, true);
      const hashBytes = new Uint8Array(buf.slice(20, 28));

      // Optional integrity check (best-effort).
      try {
        const expect = await sha256First8Bytes(videoId);
        if (expect) {
          for (let i = 0; i < 8; i++) {
            if (expect[i] !== hashBytes[i]) {
              console.warn('Spectrum cache hash mismatch for', videoId, 'got', u8ToHex(hashBytes), 'expected', u8ToHex(expect));
              break;
            }
          }
        }
      } catch {
        // ignore
      }

      const payloadOffset = 32;
      const expectedBytes = payloadOffset + frameCount * bins;
      if (buf.byteLength < expectedBytes) return false;

      spectrumState.bins = bins;
      spectrumState.fps = fps;
      spectrumState.durationMs = durationMs;
      spectrumState.frameCount = frameCount;
      spectrumState.frames = new Uint8Array(buf, payloadOffset, frameCount * bins);
      spectrumState.peaks = null;

      document.body.classList.remove('spectrum-missing');
      return true;
    }

    function hideAlert() {
      if (!alertOverlay) return;
      alertOverlay.classList.remove('visible');
      alertOverlay.style.display = '';
      alertOverlay.setAttribute('aria-hidden', 'true');
      if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
        lastFocusedElement.focus({ preventScroll: true });
      }
      lastFocusedElement = null;
    }

    function showAlert(message) {
      if (!alertOverlay || !alertMessageEl || !alertCloseBtn) {
        window.alert(typeof message === 'string' ? message : JSON.stringify(message, null, 2));
        return;
      }
      const formatted = typeof message === 'string' ? message : JSON.stringify(message, null, 2);
      alertMessageEl.textContent = formatted;
      alertMessageEl.scrollTop = 0;
      lastFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      alertOverlay.style.display = 'flex';
      alertOverlay.classList.add('visible');
      alertOverlay.setAttribute('aria-hidden', 'false');
      alertCloseBtn.focus({ preventScroll: true });
    }

    if (alertCloseBtn) {
      alertCloseBtn.addEventListener('click', hideAlert);
    }

    if (alertOverlay) {
      alertOverlay.addEventListener('click', (event) => {
        if (event.target === alertOverlay) {
          hideAlert();
        }
      });
    }

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        let handled = false;
        if (alertOverlay?.classList.contains('visible')) {
          hideAlert();
          handled = true;
        }
        if (trackDetailsOverlayVisible) {
          closeTrackDetailsOverlay({ focusButton: !handled });
          handled = true;
        }
        if (handled) {
          event.preventDefault();
        }
      }
    });

    function persistPlaylistHistory() {
      settings.playlistHistory = playlistHistory;
      saveSettings({ playlistHistory });
    }

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
      const cleanedTitle = title && title.trim().length ? title.trim() : id;

      const existing = playlistHistory.filter((entry) => entry.id !== id);
      playlistHistory = [{ id, title: cleanedTitle }, ...existing];
      if (playlistHistory.length > PLAYLIST_HISTORY_LIMIT) {
        playlistHistory = playlistHistory.slice(0, PLAYLIST_HISTORY_LIMIT);
      }
      persistPlaylistHistory();
      updatePlaylistHistorySelect(id);
    }

    function removePlaylistFromHistory(id) {
      if (!id) return;
      playlistHistory = playlistHistory.filter((entry) => entry.id !== id);
      persistPlaylistHistory();
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
        localStorage.removeItem(STORAGE_KEY);
      } catch (error) {
        console.warn('Failed to clear stored settings:', error);
        throw error;
      }

      settings = {};
      playlistHistory = [];
      updatePlaylistHistorySelect('');

      filterText = '';
      if (filterInputEl) {
        filterInputEl.value = '';
      }

      trackDetailSettings = { ...DEFAULT_TRACK_DETAILS };
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

    if (historyNeedsPersist) {
      persistPlaylistHistory();
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

    // init from settings
    if (settings.trackDetailPreferences && typeof settings.trackDetailPreferences === 'object' && !Array.isArray(settings.trackDetailPreferences)) {
      trackDetailSettings = { ...DEFAULT_TRACK_DETAILS, ...settings.trackDetailPreferences };
    } else {
      trackDetailSettings = { ...DEFAULT_TRACK_DETAILS };
      if (typeof settings.showThumbnails === 'boolean') {
        trackDetailSettings.thumbnail = settings.showThumbnails;
      }
    }
    if (typeof settings.sortAlphabetically === 'boolean') {
      sortAlphabetically = settings.sortAlphabetically;
    }
    trackDetailSettings.sortAZ = !!sortAlphabetically;
    if (typeof settings.filterText === 'string') {
      filterText = settings.filterText;
      filterInputEl.value = filterText;
    }
    updateFilterWrapperClass();
    applyTrackDetailPreferences();
    syncTrackDetailsControls();
    updateTrackDetailsButtonState();

    function applyTrackDetailPreferences(options = {}) {
      const { refreshThumbnails = false, preserveScroll = true } = options || {};
      const prefs = trackDetailSettings || DEFAULT_TRACK_DETAILS;
      document.body.classList.toggle('hide-track-number', !prefs.trackNumber);
      document.body.classList.toggle('no-thumbs', !prefs.thumbnail);
      document.body.classList.toggle('no-wrap-lines', !prefs.wrapLines);
      document.body.classList.toggle('hide-track-check', !prefs.checkTrack);

      const nextSort = !!prefs.sortAZ;
      const sortChanged = sortAlphabetically !== nextSort;
      if (sortChanged) {
        sortAlphabetically = nextSort;
        saveSettings({ sortAlphabetically });
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
      saveSettings({ trackDetailPreferences: { ...trackDetailSettings } });
    }

    function openTrackDetailsOverlay() {
      if (!trackDetailsOverlay) return;
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

    // IFrame API ready
    function onYouTubeIframeAPIReady() {
      const playerOrigin = (window.location && window.location.origin)
        ? window.location.origin
        : `${window.location.protocol}//${window.location.host}`;
      playerReady = false;
      player = new YT.Player('player', {
        height: '200',
        width: '320',
        videoId: '',
        playerVars: {
          autoplay: 0,
          controls: 0,
          origin: playerOrigin
        },
        events: {
          onReady: onPlayerReady,
          onStateChange: onPlayerStateChange
        }
      });
    }
    window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;

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
        if (currentIndex >= 0 && playlistItems[currentIndex] && player) {
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

    function onPlayerStateChange(event) {
      if (event.data === YT.PlayerState.ENDED) {
        playNext();
      } else if (event.data === YT.PlayerState.PLAYING) {
        isPlaying = true;
        updatePlayPauseButton();
        focusActiveTrack({ scroll: false });
        startSpectrumAnimation();
      } else if (event.data === YT.PlayerState.PAUSED) {
        isPlaying = false;
        updatePlayPauseButton();
        focusActiveTrack({ scroll: false });
        stopSpectrumAnimation();
      } else if (event.data === YT.PlayerState.CUED || event.data === YT.PlayerState.UNSTARTED) {
        isPlaying = false;
        updatePlayPauseButton();
        focusActiveTrack({ scroll: false });
        stopSpectrumAnimation();
      }
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
      playlistItems.forEach((item, idx) => {
        const title = (item.title || '').toLowerCase();
        const customTitle = (typeof item.userTitle === 'string' ? item.userTitle : '').toLowerCase();
        if (!f || title.includes(f) || customTitle.includes(f)) {
          filteredIndices.push(idx);
        }
      });
    }

    function getSortKeyForIndex(idx) {
      const item = playlistItems[idx];
      if (!item) return '';
      const title = typeof item.userTitle === 'string' && item.userTitle.trim().length
        ? item.userTitle
        : item.title || '';
      return title.toLowerCase();
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

      const hasFilter = (filterText || '').trim().length > 0;
      let indices = hasFilter ? filteredIndices.slice() : playlistItems.map((_, i) => i);
      if (sortAlphabetically) {
        indices = getSortedIndices(indices);
      }
      visibleIndices = indices.slice();
      const activePlaylistId = getActivePlaylistId();

      indices.forEach((realIdx, displayIdx) => {
        const item = playlistItems[realIdx];
        const li = document.createElement('li');
        if (realIdx === currentIndex) li.classList.add('active');

        const numSpan = document.createElement('span');
        numSpan.className = 'track-number';
        numSpan.textContent = (displayIdx + 1) + '.';
        li.appendChild(numSpan);

        if (trackDetailSettings.thumbnail && item.thumbnail) {
          const img = document.createElement('img');
          img.src = item.thumbnail;
          li.appendChild(img);
        }

        const span = document.createElement('span');
        span.className = 'title';
        span.textContent = item.userTitle ? item.userTitle : item.title;
        li.appendChild(span);

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

    function playIndex(idx) {
      if (!player || !playlistItems[idx]) return;
      const getState = typeof player.getPlayerState === 'function' ? player.getPlayerState.bind(player) : null;
      const playerState = getState ? getState() : undefined;
      const playerStates = window.YT?.PlayerState ?? {};
      const sameIndex = currentIndex === idx;
      const targetVideoId = playlistItems[idx].videoId;
      const currentVideoId = typeof player.getVideoData === 'function'
        ? player.getVideoData()?.video_id
        : undefined;
      const isSameVideo = sameIndex && targetVideoId && currentVideoId === targetVideoId;
      const isActivelyPlaying = playerState === playerStates.PLAYING || playerState === playerStates.BUFFERING;
      const previousIndex = currentIndex;

      if (isSameVideo) {
        focusActiveTrack();
        if (isActivelyPlaying) {
          return;
        }
        if (playerState === playerStates.PAUSED) {
          if (playerReady && typeof player.playVideo === 'function') {
            player.playVideo();
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
      const videoId = targetVideoId;
      isPlaying = false;
      updateNowPlaying();

      // Load offline spectrum cache for this video (non-blocking).
      loadSpectrumForVideoId(videoId).then((ok) => {
        if (!ok) {
          stopSpectrumAnimation();
          if (spectrumCanvas) {
            const ctx = spectrumCanvas.getContext('2d');
            if (ctx) ctx.clearRect(0, 0, spectrumCanvas.width, spectrumCanvas.height);
          }
        } else if (isPlaying) {
          startSpectrumAnimation();
        }
      });

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
      const invokeLoadVideo =
        typeof player.loadVideoById === 'function'
          ? player.loadVideoById.bind(player)
          : typeof player.cueVideoById === 'function'
            ? player.cueVideoById.bind(player)
            : null;
      if (invokeLoadVideo) {
        invokeLoadVideo(videoId);
        pendingPlayIndex = null;
      } else {
        console.warn('YouTube player API is not ready to load videos; skipping video load.');
        pendingPlayIndex = idx;
      }
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
      const nextIdx = getRelativeVisibleIndex(1);
      if (nextIdx >= 0) {
        playIndex(nextIdx);
      }
    }

    function playPrev() {
      const prevIdx = getRelativeVisibleIndex(-1);
      if (prevIdx >= 0) {
        playIndex(prevIdx);
      }
    }

    function togglePlayback() {
      if (!player) return;
      const getState = typeof player.getPlayerState === 'function' ? player.getPlayerState.bind(player) : null;
      const playerStates = window.YT?.PlayerState ?? {};
      const state = getState ? getState() : undefined;
      const activelyPlaying = state === playerStates.PLAYING || state === playerStates.BUFFERING;

      if (isPlaying !== activelyPlaying) {
        isPlaying = activelyPlaying;
        updatePlayPauseButton();
      }

      if (activelyPlaying) {
        if (typeof player.pauseVideo === 'function') {
          player.pauseVideo();
        }
      } else if (typeof player.playVideo === 'function') {
        player.playVideo();
      }
      focusActiveTrack();
    }

    document.getElementById('playPauseBtn').addEventListener('click', () => {
      togglePlayback();
    });
    document.getElementById('nextBtn').addEventListener('click', playNext);
    document.getElementById('prevBtn').addEventListener('click', playPrev);

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
      if (currentIndex >= 0 && player) {
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
      const payload = {
        playlistId: activePlaylistId,
        fetchedAt: new Date().toISOString(),
        itemCount: playlistItems.length,
        items: playlistItems.map((item) => {
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
          return false;
        }
        try {
          const body = await resp.json();
          if (body && body.ok === false) {
            return false;
          }
        } catch (error) {
          // ignore JSON parse errors, treat as available
        }
        return true;
      } catch (error) {
        console.warn('Server status check failed:', error);
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

      if (currentIndex >= 0 && player) {
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
      filterText = filterInputEl.value || '';
      updateFilterWrapperClass();
      computeFilteredIndices();
      renderTrackList();
      saveSettings({ filterText });
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
      filterText = '';
      updateFilterWrapperClass();
      computeFilteredIndices();
      renderTrackList();
      saveSettings({ filterText: '' });
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
        if (!player || typeof player.getCurrentTime !== 'function' || typeof player.seekTo !== 'function') {
          return;
        }
        const delta = e.key === 'ArrowLeft' ? -10 : 10;
        const currentTime = player.getCurrentTime();
        const newTime = Math.max(0, currentTime + delta);
        player.seekTo(newTime, true);
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
      if (!player || typeof player.getDuration !== 'function' || typeof player.getCurrentTime !== 'function') {
        progressRange.value = 0;
        timeLabel.textContent = '00:00 / 00:00';
        return;
      }

      const duration = player.getDuration();
      const current = player.getCurrentTime();

      if (!duration || !isFinite(duration) || duration <= 0) {
        progressRange.value = 0;
        timeLabel.textContent = '00:00 / 00:00';
        return;
      }

      const frac = Math.max(0, Math.min(1, current / duration));
      progressRange.value = Math.round(frac * 1000);
      timeLabel.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
    }

    progressRange.addEventListener('input', () => {
      if (!player || typeof player.getDuration !== 'function' || typeof player.seekTo !== 'function') {
        return;
      }
      const duration = player.getDuration();
      if (!duration || !isFinite(duration) || duration <= 0) return;
      const frac = Number(progressRange.value) / 1000;
      const newTime = frac * duration;
      player.seekTo(newTime, true);
    });
