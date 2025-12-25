  function initPlaylistIO(options = {}) {
    const {
      triggerElement,
      getPlaylistId = () => '',
      onLoad = async () => undefined,
      onDownload = () => undefined,
      showAlert = (message) => window.alert(message),
      getPlaylistHistory = () => [],
      removePlaylist = () => {},
      getUserSettings = () => ({}),
      resetUserSettings = () => {},
      getPlayerMode = () => 'youtube',
      setPlayerMode = () => {},
      getSpotifyClientId = () => '',
      setSpotifyClientId = () => {}
    } = options;

    const LAST_OPEN_SECTION_KEY = 'polaris.playlistio.lastOpenSectionId.v1';
    const SPOTIFY_ARTWORK_CACHE_KEY = 'polaris.spotify.artwork.v1';
    const SPOTIFY_ARTWORK_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // keep in sync with SpotifyAdapter

    const state = {
      overlay: null,
      panel: null,
      input: null,
      loadBtn: null,
      refreshBtn: null,
      downloadBtn: null,
      statusEl: null,
      loading: false,
      lastFocused: null,
      bodyOverflow: '',
      historyList: null,
      overlayHost: document.body,
      panelBoundsHandler: null,
      sections: new Map(),
      openSectionId: null,
      lastOpenedSectionId: null,
      settingsStatus: null,
      settingsPre: null,
      settingsResetBtn: null,
      settingsConfirmBox: null,
      settingsConfirmConfirmBtn: null,
      settingsConfirmCancelBtn: null,
      cacheStatus: null,
      cachePre: null,
      resettingSettings: false,
      serverAvailable: true,
      staticNotice: null,
      loadBtnIcon: null,
      loadBtnSr: null,
      refreshUploadIcon: null,
      refreshSyncIcon: null,
      refreshSr: null,
      sidebarHiddenBeforeOpen: null
    };

    function readLastOpenedSectionId() {
      try {
        const v = localStorage.getItem(LAST_OPEN_SECTION_KEY);
        return typeof v === 'string' && v.trim().length ? v.trim() : '';
      } catch {
        return '';
      }
    }

    function writeLastOpenedSectionId(sectionId) {
      const v = String(sectionId || '').trim();
      if (!v) return;
      try { localStorage.setItem(LAST_OPEN_SECTION_KEY, v); } catch { /* ignore */ }
    }

    // Initialize last-opened state.
    state.lastOpenedSectionId = readLastOpenedSectionId() || 'playlist';

    function applyPanelBounds(panelArg, overlayArg) {
      const panel = panelArg || state.panel;
      const overlay = overlayArg || state.overlay;
      if (!panel || !overlay) return;

      const sidebar = document.getElementById('sidebar');
      const trackList = document.getElementById('trackListContainer');
      const sidebarRect = sidebar instanceof HTMLElement ? sidebar.getBoundingClientRect() : null;
      const trackRect = trackList instanceof HTMLElement ? trackList.getBoundingClientRect() : null;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || document.body.clientHeight || 0;

      if (sidebarRect || trackRect) {
        const topOffset = Math.max(sidebarRect ? sidebarRect.top : trackRect.top, 0);
        const targetLeft = trackRect ? trackRect.left : (sidebarRect ? sidebarRect.left : 0);
        const targetWidth = trackRect ? trackRect.width : (sidebarRect ? sidebarRect.width : undefined);
        overlay.style.alignItems = 'flex-start';
        overlay.style.justifyContent = 'flex-start';
        overlay.style.padding = '0';

        panel.style.position = 'fixed';
        panel.style.top = `${topOffset}px`;
        panel.style.left = `${targetLeft}px`;
        panel.style.right = 'auto';
        panel.style.bottom = '0';
        if (typeof targetWidth === 'number') {
          panel.style.width = `${targetWidth}px`;
          panel.style.maxWidth = `${targetWidth}px`;
          panel.style.minWidth = `${targetWidth}px`;
        }
        panel.style.transform = 'none';
        panel.style.margin = '0';
        panel.style.alignSelf = 'stretch';
        const availableHeight = Math.max(viewportHeight - topOffset, 0);
        panel.style.height = `${availableHeight}px`;
        panel.style.maxHeight = `${availableHeight}px`;
      } else {
        overlay.style.alignItems = 'flex-start';
        overlay.style.justifyContent = 'center';
        overlay.style.padding = '0';
        panel.style.position = 'relative';
        panel.style.top = 'auto';
        panel.style.left = 'auto';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.width = 'min(560px, 92vw)';
        panel.style.maxWidth = 'min(560px, 92vw)';
        panel.style.minWidth = '0';
        panel.style.transform = 'none';
        panel.style.margin = '1rem auto';
        panel.style.alignSelf = 'stretch';
        let fallbackHeight = Math.max(viewportHeight - 32, 0);
        if (fallbackHeight <= 0) {
          fallbackHeight = Math.max(viewportHeight, 0);
        }
        panel.style.height = `${fallbackHeight}px`;
        panel.style.maxHeight = `${fallbackHeight}px`;
      }
    }

    async function refreshSettingsView() {
      if (!state.settingsStatus) return;
      const statusEl = state.settingsStatus;
      const preEl = state.settingsPre;

      statusEl.textContent = 'Loading stored settings…';
      statusEl.style.color = '#a8b3c7';
      updateSettingsResetButtonState(true);
      if (preEl) {
        preEl.textContent = '';
        preEl.style.display = 'none';
      }

      try {
        const raw = await Promise.resolve().then(() => getUserSettings());
        const data = raw === null || raw === undefined ? {} : raw;
        const isObject = typeof data === 'object' && !Array.isArray(data);
        const hasEntries = isObject ? Object.keys(data).length > 0 : Boolean(data);

        if (!hasEntries) {
          statusEl.textContent = 'No stored settings found.';
          statusEl.style.color = '#6c7488';
          hideSettingsResetPrompt();
          return;
        }

        if (preEl) {
          const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
          preEl.textContent = text;
          preEl.style.display = 'block';
        }
        statusEl.textContent = 'Saved in localStorage as ytAudioPlayer.settings.';
        statusEl.style.color = '#a8b3c7';
        updateSettingsResetButtonState(false);
      } catch (error) {
        const message = error && error.message ? error.message : 'Failed to load settings.';
        statusEl.textContent = message;
        statusEl.style.color = '#ff8080';
        if (preEl) {
          preEl.textContent = '';
          preEl.style.display = 'none';
        }
        updateSettingsResetButtonState(false);
        hideSettingsResetPrompt();
      }
    }

    function readSpotifyArtworkCacheRaw() {
      try {
        const raw = localStorage.getItem(SPOTIFY_ARTWORK_CACHE_KEY);
        return typeof raw === 'string' ? raw : '';
      } catch {
        return '';
      }
    }

    function parseSpotifyArtworkCache(raw) {
      if (!raw) return {};
      try {
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
        return obj;
      } catch {
        return {};
      }
    }

    function refreshCacheStatsView() {
      if (!state.cacheStatus) return;
      const statusEl = state.cacheStatus;
      const preEl = state.cachePre;

      const raw = readSpotifyArtworkCacheRaw();
      const cache = parseSpotifyArtworkCache(raw);

      const keys = Object.keys(cache);
      let fresh = 0;
      let expired = 0;
      const now = Date.now();

      for (const k of keys) {
        const entry = cache[k];
        if (!entry || typeof entry !== 'object') continue;
        const ts = Number(entry.ts) || 0;
        const url = typeof entry.url === 'string' ? entry.url : '';
        if (!url) continue;
        if (ts && (now - ts) > SPOTIFY_ARTWORK_CACHE_TTL_MS) expired += 1;
        else fresh += 1;
      }

      const approxBytes = raw ? raw.length : 0;
      const approxKb = Math.round((approxBytes / 1024) * 10) / 10;

      statusEl.textContent = `Spotify artwork cache: ${keys.length} entries (${fresh} fresh, ${expired} expired), ~${approxKb} KB in localStorage.`;
      statusEl.style.color = '#a8b3c7';

      if (preEl) {
        if (!keys.length) {
          preEl.textContent = '';
          preEl.style.display = 'none';
        } else {
          preEl.textContent = raw;
          preEl.style.display = 'block';
        }
      }
    }

    function setSectionOpen(sectionId, options = {}) {
      const force = Boolean(options.force);
      if (!state.sections || state.sections.size === 0) return;
      if (sectionId && state.openSectionId === sectionId) {
        if (force) return;
        state.sections.forEach((section) => {
          section.header.setAttribute('aria-expanded', 'false');
          section.icon.className = 'icon unfold-more';
          section.icon.textContent = 'folder';
          section.wrapper.style.flex = '0 0 auto';
          section.wrapper.style.minHeight = 'auto';
          section.content.style.display = 'none';
          section.content.style.flex = '0 0 auto';
          section.content.style.overflowY = 'hidden';
          section.content.style.minHeight = 'auto';
        });
        state.openSectionId = null;
        return;
      }

      if (!sectionId || !state.sections.has(sectionId)) {
        const first = state.sections.keys().next();
        if (first.done) return;
        sectionId = first.value;
      }

      state.sections.forEach((section, id) => {
        const isOpen = id === sectionId;
        section.header.setAttribute('aria-expanded', String(isOpen));
        section.icon.className = `icon ${isOpen ? 'folder_open' : 'folder'}`;
        section.icon.textContent = isOpen ? 'folder_open' : 'folder';
        section.wrapper.style.flex = isOpen ? '1 1 auto' : '0 0 auto';
        section.wrapper.style.minHeight = isOpen ? '0' : 'auto';
        section.content.style.display = isOpen ? 'flex' : 'none';
        section.content.style.flex = isOpen ? '1 1 auto' : '0 0 auto';
        section.content.style.overflowY = isOpen ? 'auto' : 'hidden';
        section.content.style.minHeight = isOpen ? '0' : 'auto';
      });

      state.openSectionId = sectionId;
      state.lastOpenedSectionId = sectionId;
      writeLastOpenedSectionId(sectionId);

      if (sectionId === 'playlist' && state.input && state.overlay && state.overlay.style.display !== 'none') {
        state.input.focus({ preventScroll: true });
      }
      if (sectionId === 'settings') {
        refreshSettingsView();
      }
      if (sectionId === 'cache') {
        refreshCacheStatsView();
      }
      if (sectionId === 'videoPlayer') {
        const section = state.sections.get('videoPlayer');
        if (section && section.playerModeSelect) {
          try {
            const mode = String(getPlayerMode() || 'youtube');
            section.playerModeSelect.value = (mode === 'local' || mode === 'spotify') ? mode : 'youtube';
          } catch { /* ignore */ }
        }

        if (section && section.spotifyClientIdInput) {
          try {
            const v = String(getSpotifyClientId() || '');
            section.spotifyClientIdInput.value = v;
          } catch { /* ignore */ }
        }

        if (section && typeof section.updateSpotifyVisibility === 'function') {
          try { section.updateSpotifyVisibility(); } catch { /* ignore */ }
        }
      }
    }

    function createAccordionSection({ id, title }) {
      const wrapper = document.createElement('section');
      wrapper.dataset.sectionId = id;
      wrapper.style.border = 'none';
      wrapper.style.borderRadius = '6px';
      wrapper.style.background = '#11141c';
      wrapper.style.overflow = 'hidden';
      wrapper.style.display = 'flex';
      wrapper.style.flexDirection = 'column';
      wrapper.style.minHeight = '0';
      wrapper.style.margin = '0';

      const headerBtn = document.createElement('button');
      headerBtn.type = 'button';
      headerBtn.style.display = 'flex';
      headerBtn.style.alignItems = 'center';
      headerBtn.style.justifyContent = 'flex-start';
      headerBtn.style.padding = '0.55rem 0';
      headerBtn.style.background = 'transparent';
      headerBtn.style.border = 'none';
      headerBtn.style.color = '#f5f7fa';
      headerBtn.style.fontSize = '0.82rem';
      headerBtn.style.fontWeight = '600';
      headerBtn.style.letterSpacing = '0.06em';
      headerBtn.style.textTransform = 'uppercase';
      headerBtn.style.cursor = 'pointer';
      headerBtn.style.width = '100%';
      headerBtn.style.gap = '0.6rem';

      const iconSpan = document.createElement('span');
      iconSpan.className = 'icon unfold-more';
      iconSpan.textContent = 'unfold_more';
      iconSpan.setAttribute('aria-hidden', 'true');
      iconSpan.style.fontSize = '1rem';

      const labelSpan = document.createElement('span');
      labelSpan.textContent = title;
      labelSpan.style.pointerEvents = 'none';
      labelSpan.style.flex = '1 1 auto';
      labelSpan.style.textAlign = 'left';

      headerBtn.appendChild(iconSpan);
      headerBtn.appendChild(labelSpan);

      const content = document.createElement('div');
      content.classList.add('playlist-overlay-content');
      content.style.display = 'none';
      content.style.flexDirection = 'column';
      //content.style.gap = '0.75rem';
      content.style.padding = '0';
      content.style.background = '#141926';
      content.style.flex = '1 1 auto';
      content.style.minHeight = '0';
      content.style.overflowY = 'hidden';
      content.id = `playlistIOSection-${id}`;

      headerBtn.setAttribute('aria-controls', content.id);
      headerBtn.setAttribute('aria-expanded', 'false');

      headerBtn.addEventListener('click', () => {
        setSectionOpen(id);
      });

      wrapper.appendChild(headerBtn);
      wrapper.appendChild(content);

      state.sections.set(id, {
        id,
        wrapper,
        header: headerBtn,
        icon: iconSpan,
        content
      });

      return {
        wrapper,
        header: headerBtn,
        icon: iconSpan,
        content
      };
    }

    function ensureOverlay() {
      if (state.overlay) return state.overlay;

      state.overlayHost = document.body;

      function buildCloseButton(handler) {
        if (window.OverlayShared && typeof window.OverlayShared.createOverlayCloseButton === 'function') {
          return window.OverlayShared.createOverlayCloseButton({ onClick: handler });
        }
        const fallback = document.createElement('button');
        fallback.type = 'button';
        fallback.setAttribute('aria-label', 'Close overlay');
        fallback.style.background = '#28344d';
        fallback.style.color = '#f5f7fa';
        fallback.style.border = '1px solid #394150';
        fallback.style.borderRadius = '4px';
        fallback.style.padding = '0.35rem';
        fallback.style.cursor = 'pointer';
        fallback.style.fontSize = '0';
        const icon = document.createElement('span');
        icon.className = 'icon close';
        icon.textContent = 'close';
        icon.setAttribute('aria-hidden', 'true');
        fallback.appendChild(icon);
        fallback.addEventListener('click', handler);
        return fallback;
      }

      const overlay = document.createElement('div');
      overlay.id = 'playlistIOOverlay';
      overlay.style.position = 'fixed';
      overlay.style.inset = '0';
      overlay.style.display = 'none';
      overlay.style.alignItems = 'flex-start';
      overlay.style.justifyContent = 'flex-start';
      overlay.style.background = 'rgba(10, 12, 18, 0.72)';
      overlay.style.zIndex = '1000';
      overlay.style.padding = '0';
      overlay.style.boxSizing = 'border-box';
      overlay.style.pointerEvents = 'auto';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-labelledby', 'playlistIOOverlayTitle');
      overlay.setAttribute('aria-hidden', 'true');

      const panel = document.createElement('div');
      panel.style.background = '#161921';
      panel.style.color = '#f5f7fa';
      panel.style.padding = '0';
      panel.style.border = '1px solid #2b2f3a';
      panel.style.borderRadius = '8px';
      panel.style.boxShadow = '0 18px 48px rgba(0, 0, 0, 0.45)';
      panel.style.maxWidth = '100%';
      panel.style.height = '100vh';
      panel.style.maxHeight = '100vh';
      panel.style.display = 'flex';
      panel.style.flexDirection = 'column';
      panel.style.gap = 0;
      panel.style.boxSizing = 'border-box';
      panel.style.overflow = 'hidden';
      panel.style.alignSelf = 'stretch';
      panel.style.minHeight = '0';

      const header = document.createElement('div');
      header.style.display = 'flex';
      header.style.alignItems = 'center';
      header.style.justifyContent = 'space-between';
      header.style.gap = '0.25rem';
      header.style.padding = '0.4rem 0.4rem 0';
      header.style.minHeight = 'var(--playlist-manager-button-size, 34px)';

      const title = document.createElement('h2');
      title.id = 'playlistIOOverlayTitle';
      title.textContent = 'Settings';
      title.style.margin = '0';
      title.style.fontSize = '1rem';
      title.style.flex = '1 1 auto';

      const closeBtn = buildCloseButton(closeOverlay);
      const applyCloseBtnRestState = () => {
        closeBtn.style.background = '#1f2532';
        closeBtn.style.borderColor = 'var(--color-border, #2b2f3a)';
        closeBtn.style.color = 'var(--color-text, #f5f7fa)';
      };
      closeBtn.style.width = 'var(--playlist-manager-button-size, 34px)';
      closeBtn.style.height = 'var(--playlist-manager-button-size, 34px)';
      closeBtn.style.minWidth = 'var(--playlist-manager-button-size, 34px)';
      closeBtn.style.minHeight = 'var(--playlist-manager-button-size, 34px)';
      closeBtn.style.borderRadius = '4px';
      closeBtn.style.border = '1px solid var(--color-border, #2b2f3a)';
      closeBtn.style.background = '#1f2532';
      closeBtn.style.color = 'var(--color-text, #f5f7fa)';
      closeBtn.style.padding = '0';
      closeBtn.style.display = 'inline-flex';
      closeBtn.style.alignItems = 'center';
      closeBtn.style.justifyContent = 'center';
      closeBtn.style.transition = 'background 0.15s ease, border-color 0.15s ease';
      closeBtn.style.fontSize = '0';
      closeBtn.style.cursor = 'pointer';
      const closeBtnIcon = closeBtn.querySelector('.icon');
      if (closeBtnIcon) {
        closeBtnIcon.style.fontSize = '20px';
        closeBtnIcon.style.width = '20px';
        closeBtnIcon.style.height = '20px';
        closeBtnIcon.style.lineHeight = '1';
      }
      closeBtn.addEventListener('mouseenter', () => {
        closeBtn.style.background = '#273043';
        closeBtn.style.borderColor = 'var(--color-border-strong, #394150)';
      });
      closeBtn.addEventListener('mouseleave', () => {
        applyCloseBtnRestState();
      });
      closeBtn.addEventListener('focus', () => {
        closeBtn.style.background = '#273043';
        closeBtn.style.borderColor = 'var(--color-border-strong, #394150)';
      });
      closeBtn.addEventListener('blur', () => {
        applyCloseBtnRestState();
      });
      closeBtn.addEventListener('click', () => {
        applyCloseBtnRestState();
      });
      applyCloseBtnRestState();

      header.appendChild(title);
      header.appendChild(closeBtn);

      const description = document.createElement('p');
      description.textContent = 'Enter a YouTube playlist URL or ID to load, refresh server data, or download the current snapshot.';
      description.style.margin = '0';
      description.style.fontSize = '0.8rem';
      description.style.color = '#a8b3c7';
      description.style.lineHeight = '1.5';

      const form = document.createElement('form');
      form.style.display = 'flex';
      form.style.flexDirection = 'column';
      form.style.gap = '0.75rem';
      form.style.flex = '1 1 auto';
      form.style.minHeight = '0';
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        triggerLoad(false);
      });

      const inputLabel = document.createElement('label');
      inputLabel.textContent = 'Playlist URL or ID';
      inputLabel.style.fontSize = '0.75rem';
      inputLabel.style.letterSpacing = '0.05em';
      inputLabel.style.fontWeight = '600';
      inputLabel.style.textTransform = 'uppercase';
      inputLabel.style.color = '#a8b3c7';

      const input = document.createElement('input');
      input.type = 'text';
      input.id = 'playlistIOInput';
      input.placeholder = 'https://www.youtube.com/playlist?list=...';
      input.style.width = '100%';
      input.style.boxSizing = 'border-box';
      input.style.padding = '0.45rem 0.6rem';
      input.style.fontSize = '0.85rem';
      input.style.borderRadius = '4px';
      input.style.border = '1px solid #394150';
      input.style.background = '#202633';
      input.style.color = '#f5f7fa';
      input.style.outline = 'none';
      input.autocomplete = 'off';

      const buttonRow = document.createElement('div');
      buttonRow.style.display = 'flex';
      buttonRow.style.flexWrap = 'nowrap';
      buttonRow.style.gap = '0.5rem';
      buttonRow.style.alignItems = 'stretch';
      buttonRow.style.minWidth = '0';

      const loadBtn = document.createElement('button');
      loadBtn.type = 'submit';
      loadBtn.style.flex = '1 1 0';
      loadBtn.style.minWidth = '0';
      stylePrimaryButton(loadBtn);
      loadBtn.textContent = '';
      loadBtn.setAttribute('aria-label', 'Upload playlist');
      const loadIcon = document.createElement('span');
      loadIcon.className = 'icon upload';
      loadIcon.textContent = 'upload';
      loadIcon.setAttribute('aria-hidden', 'true');
      loadBtn.appendChild(loadIcon);
      const loadSr = document.createElement('span');
      loadSr.className = 'sr-only';
      loadSr.textContent = 'Upload';
      loadBtn.appendChild(loadSr);

      const refreshBtn = document.createElement('button');
      refreshBtn.type = 'button';
      refreshBtn.style.flex = '1 1 0';
      refreshBtn.style.minWidth = '0';
      stylePrimaryButton(refreshBtn);
      refreshBtn.textContent = '';
      refreshBtn.setAttribute('aria-label', 'Upload and refresh playlist');
      const refreshUploadIcon = document.createElement('span');
      refreshUploadIcon.className = 'icon upload';
      refreshUploadIcon.textContent = 'upload';
      refreshUploadIcon.setAttribute('aria-hidden', 'true');
      refreshBtn.appendChild(refreshUploadIcon);
      const refreshSyncIcon = document.createElement('span');
      refreshSyncIcon.className = 'icon refresh';
      refreshSyncIcon.textContent = 'refresh';
      refreshSyncIcon.setAttribute('aria-hidden', 'true');
      refreshBtn.appendChild(refreshSyncIcon);
      const refreshSr = document.createElement('span');
      refreshSr.className = 'sr-only';
      refreshSr.textContent = 'Upload and refresh';
      refreshBtn.appendChild(refreshSr);
      refreshBtn.addEventListener('click', () => triggerLoad(true));

      const downloadBtn = document.createElement('button');
      downloadBtn.type = 'button';
      downloadBtn.style.flex = '1 1 0';
      downloadBtn.style.minWidth = '0';
      stylePrimaryButton(downloadBtn);
      downloadBtn.textContent = '';
      downloadBtn.setAttribute('aria-label', 'Download playlist JSON');
      const downloadIcon = document.createElement('span');
      downloadIcon.className = 'icon download';
      downloadIcon.textContent = 'download';
      downloadIcon.setAttribute('aria-hidden', 'true');
      downloadBtn.appendChild(downloadIcon);
      const downloadLabel = document.createElement('span');
      downloadLabel.textContent = 'JSON';
      downloadLabel.style.fontWeight = '600';
      downloadLabel.style.color = '#f5f7fa';
      downloadBtn.appendChild(downloadLabel);
      downloadBtn.addEventListener('click', handleDownload);

      buttonRow.appendChild(loadBtn);
      buttonRow.appendChild(refreshBtn);
      buttonRow.appendChild(downloadBtn);

      const historyWrapper = document.createElement('div');
      historyWrapper.id = 'playlistIOHistory';
      historyWrapper.style.border = '1px solid #2b2f3a';
      historyWrapper.style.borderRadius = '6px';
      historyWrapper.style.background = '#11141c';
      historyWrapper.style.padding = '0.45rem 0.35rem 0';
      historyWrapper.style.overflow = 'hidden';
      historyWrapper.style.display = 'flex';
      historyWrapper.style.flexDirection = 'column';
      historyWrapper.style.gap = '0.45rem';
      historyWrapper.style.flex = '1 1 auto';
      historyWrapper.style.minHeight = '0';

      const historyLabel = document.createElement('div');
      historyLabel.textContent = 'Saved Playlists';
      historyLabel.style.fontSize = '0.75rem';
      historyLabel.style.letterSpacing = '0.05em';
      historyLabel.style.textTransform = 'uppercase';
      historyLabel.style.color = '#a8b3c7';
      historyLabel.style.fontWeight = '600';
      historyLabel.style.margin = '0';
      historyLabel.style.padding = '0 0.15rem';

      const historyList = document.createElement('div');
      historyList.id = 'playlistIOHistoryList';
      historyList.style.display = 'flex';
      historyList.style.flexDirection = 'column';
      historyList.style.gap = '0.25rem';
      historyList.style.maxHeight = 'calc(5 * 2.2rem)';
      historyList.style.minHeight = '0';
      historyList.style.overflowY = 'auto';
      historyList.style.overflowX = 'hidden';
      historyList.style.paddingRight = '0.1rem';
      historyList.style.margin = '0';

      historyWrapper.appendChild(historyLabel);
      historyWrapper.appendChild(historyList);

      const statusEl = document.createElement('div');
      statusEl.id = 'playlistIOStatus';
      statusEl.style.minHeight = '1em';
      statusEl.style.fontSize = '0.75rem';
      statusEl.style.color = '#a8b3c7';

      form.appendChild(inputLabel);
      form.appendChild(input);
      form.appendChild(buttonRow);
      form.appendChild(historyWrapper);
      form.appendChild(statusEl);

      state.sections = new Map();

      const accordion = document.createElement('div');
      accordion.style.display = 'flex';
      accordion.style.flexDirection = 'column';
      accordion.style.gap = '0.2rem';
      accordion.style.flex = '1 1 auto';
      accordion.style.minHeight = '0';
      accordion.style.padding = '0.75rem 0.4rem 1rem';
      const playlistSection = createAccordionSection({ id: 'playlist', title: 'Playlist Management' });
      const staticNotice = document.createElement('div');
      staticNotice.style.display = 'none';
      staticNotice.style.padding = '0.55rem 0.65rem';
      staticNotice.style.margin = '0 0 0.5rem';
      staticNotice.style.borderRadius = '6px';
      staticNotice.style.border = '1px solid #3a4254';
      staticNotice.style.background = '#1f2532';
      staticNotice.style.color = '#f2d88c';
      staticNotice.style.fontSize = '0.78rem';
      staticNotice.style.lineHeight = '1.45';
      staticNotice.textContent = 'Server unavailable. Uploading new playlists is disabled, but you can still load cached playlists and manage saved settings.';
      playlistSection.content.appendChild(description);
      playlistSection.content.appendChild(staticNotice);
      playlistSection.content.appendChild(form);

      const videoPlayerSection = createAccordionSection({ id: 'videoPlayer', title: 'Video Player' });
      videoPlayerSection.content.style.padding = '0.75rem 0.8rem 0.9rem';
      videoPlayerSection.content.style.gap = '0.6rem';

      const playerIntro = document.createElement('p');
      playerIntro.textContent = 'Select the active player implementation.';
      playerIntro.style.margin = '0';
      playerIntro.style.fontSize = '0.8rem';
      playerIntro.style.color = '#a8b3c7';
      playerIntro.style.lineHeight = '1.5';

      const playerRow = document.createElement('div');
      playerRow.style.display = 'flex';
      playerRow.style.flexDirection = 'column';
      playerRow.style.gap = '0.35rem';

      const playerLabel = document.createElement('label');
      playerLabel.textContent = 'Player';
      playerLabel.style.fontSize = '0.75rem';
      playerLabel.style.fontWeight = '600';
      playerLabel.style.letterSpacing = '0.05em';
      playerLabel.style.textTransform = 'uppercase';
      playerLabel.style.color = '#a8b3c7';

      const playerSelect = document.createElement('select');
      playerSelect.style.padding = '0.55rem 0.6rem';
      playerSelect.style.borderRadius = '6px';
      playerSelect.style.border = '1px solid #2b2f3a';
      playerSelect.style.background = '#11141c';
      playerSelect.style.color = '#f5f7fa';
      playerSelect.style.fontSize = '0.9rem';
      playerSelect.style.outline = 'none';
      const optYoutube = document.createElement('option');
      optYoutube.value = 'youtube';
      optYoutube.textContent = 'YouTube player (default)';
      const optLocal = document.createElement('option');
      optLocal.value = 'local';
      optLocal.textContent = 'Local video player';
      const optSpotify = document.createElement('option');
      optSpotify.value = 'spotify';
      optSpotify.textContent = 'Spotify player (Premium)';
      playerSelect.appendChild(optYoutube);
      playerSelect.appendChild(optLocal);
      playerSelect.appendChild(optSpotify);

      try {
        const mode = String(getPlayerMode() || 'youtube');
        playerSelect.value = (mode === 'local' || mode === 'spotify') ? mode : 'youtube';
      } catch { /* ignore */ }

      playerSelect.addEventListener('change', () => {
        const next = (playerSelect.value === 'local' || playerSelect.value === 'spotify') ? playerSelect.value : 'youtube';
        try { setPlayerMode(next); } catch { /* ignore */ }
        try {
          const section = state.sections.get('videoPlayer');
          if (section && typeof section.updateSpotifyVisibility === 'function') {
            section.updateSpotifyVisibility();
          }
        } catch { /* ignore */ }
      });

      const spotifyRow = document.createElement('div');
      spotifyRow.style.display = 'flex';
      spotifyRow.style.flexDirection = 'column';
      spotifyRow.style.gap = '0.35rem';

      const spotifyLabel = document.createElement('label');
      spotifyLabel.textContent = 'Spotify Client ID';
      spotifyLabel.style.fontSize = '0.75rem';
      spotifyLabel.style.fontWeight = '600';
      spotifyLabel.style.letterSpacing = '0.05em';
      spotifyLabel.style.textTransform = 'uppercase';
      spotifyLabel.style.color = '#a8b3c7';

      const spotifyClientIdInput = document.createElement('input');
      spotifyClientIdInput.type = 'text';
      spotifyClientIdInput.autocomplete = 'off';
      spotifyClientIdInput.spellcheck = false;
      spotifyClientIdInput.placeholder = 'Paste Spotify App Client ID…';
      spotifyClientIdInput.style.padding = '0.55rem 0.6rem';
      spotifyClientIdInput.style.borderRadius = '6px';
      spotifyClientIdInput.style.border = '1px solid #2b2f3a';
      spotifyClientIdInput.style.background = '#11141c';
      spotifyClientIdInput.style.color = '#f5f7fa';
      spotifyClientIdInput.style.fontSize = '0.9rem';
      spotifyClientIdInput.style.outline = 'none';

      const spotifyHint = document.createElement('p');
      spotifyHint.textContent = 'Used for Spotify login (stored locally in ytAudioPlayer.settings).';
      spotifyHint.style.margin = '0';
      spotifyHint.style.fontSize = '0.75rem';
      spotifyHint.style.color = '#6c7488';
      spotifyHint.style.lineHeight = '1.4';

      try {
        spotifyClientIdInput.value = String(getSpotifyClientId() || '');
      } catch { /* ignore */ }

      let spotifyWriteTimer = null;
      function commitSpotifyClientId() {
        const v = String(spotifyClientIdInput.value || '').trim();
        try { setSpotifyClientId(v); } catch { /* ignore */ }
      }

      spotifyClientIdInput.addEventListener('input', () => {
        if (spotifyWriteTimer) {
          clearTimeout(spotifyWriteTimer);
          spotifyWriteTimer = null;
        }
        spotifyWriteTimer = setTimeout(() => {
          spotifyWriteTimer = null;
          commitSpotifyClientId();
        }, 300);
      });
      spotifyClientIdInput.addEventListener('blur', () => commitSpotifyClientId());
      spotifyClientIdInput.addEventListener('keydown', (e) => {
        if (e && e.key === 'Enter') {
          e.preventDefault();
          commitSpotifyClientId();
        }
      });

      spotifyRow.appendChild(spotifyLabel);
      spotifyRow.appendChild(spotifyClientIdInput);
      spotifyRow.appendChild(spotifyHint);

      function updateSpotifyVisibility() {
        const isSpotify = playerSelect.value === 'spotify';
        spotifyRow.style.display = isSpotify ? 'flex' : 'none';
      }
      updateSpotifyVisibility();

      try {
        const section = state.sections.get('videoPlayer');
        if (section) {
          section.playerModeSelect = playerSelect;
          section.spotifyClientIdInput = spotifyClientIdInput;
          section.updateSpotifyVisibility = updateSpotifyVisibility;
        }
      } catch { /* ignore */ }

      playerRow.appendChild(playerLabel);
      playerRow.appendChild(playerSelect);

      const localHint = document.createElement('p');
      localHint.textContent = 'Local mode loads: /video/<userTitle>.mp4';
      localHint.style.margin = '0';
      localHint.style.fontSize = '0.75rem';
      localHint.style.color = '#6c7488';
      localHint.style.lineHeight = '1.4';

      videoPlayerSection.content.appendChild(playerIntro);
      videoPlayerSection.content.appendChild(playerRow);
      videoPlayerSection.content.appendChild(spotifyRow);
      videoPlayerSection.content.appendChild(localHint);

      const settingsSection = createAccordionSection({ id: 'settings', title: 'Stored Settings' });
      //settingsSection.content.style.gap = '0.6rem';
      settingsSection.content.style.flex = '1 1 auto';
      settingsSection.content.style.minHeight = '0';

      const settingsIntro = document.createElement('p');
      settingsIntro.textContent = 'Inspect the current ytAudioPlayer.settings.';
      settingsIntro.style.margin = '0';
      settingsIntro.style.fontSize = '0.8rem';
      settingsIntro.style.color = '#a8b3c7';
      settingsIntro.style.lineHeight = '1.5';

      const settingsStatus = document.createElement('p');
      settingsStatus.style.margin = '0';
      settingsStatus.style.fontSize = '0.75rem';
      settingsStatus.style.color = '#a8b3c7';
      settingsStatus.style.lineHeight = '1.5';
      settingsStatus.textContent = 'Loading stored settings…';

      const settingsCopy = document.createElement('div');
      settingsCopy.style.flex = '1 1 auto';
      settingsCopy.style.minWidth = '0';
      settingsCopy.style.display = 'flex';
      settingsCopy.style.flexDirection = 'column';
      settingsCopy.style.gap = '0.4rem';
      settingsCopy.appendChild(settingsIntro);
      settingsCopy.appendChild(settingsStatus);

      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.style.flex = '0 0 auto';
      resetBtn.style.display = 'inline-flex';
      resetBtn.style.alignItems = 'center';
      resetBtn.style.justifyContent = 'center';
      resetBtn.style.width = '32px';
      resetBtn.style.height = '32px';
      resetBtn.style.borderRadius = '4px';
      resetBtn.style.border = '1px solid #2b2f3a';
      resetBtn.style.background = '#1b2231';
      resetBtn.style.color = '#a8b3c7';
      resetBtn.style.cursor = 'pointer';
      resetBtn.style.transition = 'background-color 120ms ease, border-color 120ms ease, color 120ms ease';
      resetBtn.setAttribute('aria-label', 'Reset stored settings');
      resetBtn.title = 'Reset stored settings';
      const resetIcon = document.createElement('span');
      resetIcon.className = 'icon delete';
      resetIcon.textContent = 'delete';
      resetIcon.setAttribute('aria-hidden', 'true');
      resetIcon.style.fontSize = '1rem';
      resetBtn.appendChild(resetIcon);
      resetBtn.addEventListener('mouseover', () => {
        if (resetBtn.disabled) return;
        resetBtn.style.background = '#232c3d';
        resetBtn.style.borderColor = '#394150';
        resetBtn.style.color = '#f5f7fa';
      });
      resetBtn.addEventListener('mouseout', () => {
        resetBtn.style.background = '#1b2231';
        resetBtn.style.borderColor = '#2b2f3a';
        resetBtn.style.color = '#a8b3c7';
      });
      resetBtn.addEventListener('click', handleSettingsReset);

      const settingsHeaderRow = document.createElement('div');
      settingsHeaderRow.style.display = 'flex';
      settingsHeaderRow.style.alignItems = 'flex-start';
      settingsHeaderRow.style.gap = '0.6rem';
      settingsHeaderRow.style.marginBottom = '0.75rem';
      settingsHeaderRow.appendChild(settingsCopy);
      settingsHeaderRow.appendChild(resetBtn);

      const settingsConfirmBox = document.createElement('div');
      settingsConfirmBox.style.display = 'none';
      settingsConfirmBox.style.flexDirection = 'column';
      settingsConfirmBox.style.gap = '0.75rem';
      settingsConfirmBox.style.padding = '0.75rem 0.85rem';
      settingsConfirmBox.style.margin = '0 0 0.75rem';
      settingsConfirmBox.style.background = '#1b2231';
      settingsConfirmBox.style.border = '1px solid #394150';
      settingsConfirmBox.style.borderRadius = '6px';

      const settingsConfirmMessage = document.createElement('p');
      settingsConfirmMessage.textContent = 'Reset stored settings? This clears ytAudioPlayer.settings from localStorage.';
      settingsConfirmMessage.style.margin = '0';
      settingsConfirmMessage.style.fontSize = '0.8rem';
      settingsConfirmMessage.style.color = '#f5f7fa';
      settingsConfirmMessage.style.lineHeight = '1.5';

      const settingsConfirmActions = document.createElement('div');
      settingsConfirmActions.style.display = 'flex';
      settingsConfirmActions.style.justifyContent = 'flex-end';
      settingsConfirmActions.style.alignItems = 'center';
      settingsConfirmActions.style.gap = '0.5rem';

      const settingsConfirmCancelBtn = document.createElement('button');
      settingsConfirmCancelBtn.type = 'button';
      settingsConfirmCancelBtn.textContent = 'Cancel';
      settingsConfirmCancelBtn.style.padding = '0.45rem 0.9rem';
      settingsConfirmCancelBtn.style.fontSize = '0.78rem';
      settingsConfirmCancelBtn.style.fontWeight = '600';
      settingsConfirmCancelBtn.style.letterSpacing = '0.05em';
      settingsConfirmCancelBtn.style.textTransform = 'uppercase';
      settingsConfirmCancelBtn.style.borderRadius = '4px';
      settingsConfirmCancelBtn.style.border = '1px solid #394150';
      settingsConfirmCancelBtn.style.background = 'transparent';
      settingsConfirmCancelBtn.style.color = '#a8b3c7';
      settingsConfirmCancelBtn.style.cursor = 'pointer';
      settingsConfirmCancelBtn.addEventListener('mouseover', () => {
        settingsConfirmCancelBtn.style.color = '#f5f7fa';
        settingsConfirmCancelBtn.style.borderColor = '#46526d';
        settingsConfirmCancelBtn.style.background = '#232c3d';
      });
      settingsConfirmCancelBtn.addEventListener('mouseout', () => {
        settingsConfirmCancelBtn.style.color = '#a8b3c7';
        settingsConfirmCancelBtn.style.borderColor = '#394150';
        settingsConfirmCancelBtn.style.background = 'transparent';
      });
      settingsConfirmCancelBtn.addEventListener('click', () => {
        hideSettingsResetPrompt();
        updateStatus('Reset cancelled.', 'neutral');
      });

      const settingsConfirmConfirmBtn = document.createElement('button');
      settingsConfirmConfirmBtn.type = 'button';
      settingsConfirmConfirmBtn.textContent = 'Reset';
      settingsConfirmConfirmBtn.style.padding = '0.45rem 0.9rem';
      settingsConfirmConfirmBtn.style.fontSize = '0.78rem';
      settingsConfirmConfirmBtn.style.fontWeight = '600';
      settingsConfirmConfirmBtn.style.letterSpacing = '0.05em';
      settingsConfirmConfirmBtn.style.textTransform = 'uppercase';
      settingsConfirmConfirmBtn.style.borderRadius = '4px';
      settingsConfirmConfirmBtn.style.border = '1px solid #46526d';
      settingsConfirmConfirmBtn.style.background = '#3a4a67';
      settingsConfirmConfirmBtn.style.color = '#f5f7fa';
      settingsConfirmConfirmBtn.style.cursor = 'pointer';
      settingsConfirmConfirmBtn.addEventListener('mouseover', () => {
        settingsConfirmConfirmBtn.style.background = '#425374';
        settingsConfirmConfirmBtn.style.borderColor = '#556384';
      });
      settingsConfirmConfirmBtn.addEventListener('mouseout', () => {
        settingsConfirmConfirmBtn.style.background = '#3a4a67';
        settingsConfirmConfirmBtn.style.borderColor = '#46526d';
      });
      settingsConfirmConfirmBtn.addEventListener('click', () => {
        performSettingsReset();
      });

      settingsConfirmActions.appendChild(settingsConfirmCancelBtn);
      settingsConfirmActions.appendChild(settingsConfirmConfirmBtn);

      settingsConfirmBox.appendChild(settingsConfirmMessage);
      settingsConfirmBox.appendChild(settingsConfirmActions);

      const settingsPre = document.createElement('pre');
      settingsPre.style.margin = '0';
      settingsPre.style.padding = '0.5rem 0.6rem';
      settingsPre.style.background = '#11141c';
      settingsPre.style.border = '1px solid #2b2f3a';
      settingsPre.style.borderRadius = '4px';
      settingsPre.style.fontSize = '0.8rem';
      settingsPre.style.lineHeight = '1.4';
      settingsPre.style.color = '#f5f7fa';
      settingsPre.style.whiteSpace = 'pre-wrap';
      settingsPre.style.wordBreak = 'break-word';
      settingsPre.style.display = 'none';
      settingsPre.style.flex = '1 1 auto';
      settingsPre.style.minHeight = '0';
      settingsPre.style.maxHeight = '100%';
      settingsPre.style.overflow = 'auto';

  settingsSection.content.appendChild(settingsHeaderRow);
      settingsSection.content.appendChild(settingsConfirmBox);
      settingsSection.content.appendChild(settingsPre);

      const cacheSection = createAccordionSection({ id: 'cache', title: 'Cache' });

      const cacheContent = cacheSection.content;
      cacheContent.style.padding = '0.75rem 0.8rem 0.9rem';
      cacheContent.style.gap = '0.6rem';

      const cacheIntro = document.createElement('p');
      cacheIntro.textContent = 'Local cache statistics for this browser.';
      cacheIntro.style.margin = '0';
      cacheIntro.style.fontSize = '0.8rem';
      cacheIntro.style.color = '#a8b3c7';
      cacheIntro.style.lineHeight = '1.5';

      const cacheStatus = document.createElement('div');
      cacheStatus.style.fontSize = '0.8rem';
      cacheStatus.style.color = '#a8b3c7';
      cacheStatus.style.lineHeight = '1.45';

      const cachePre = document.createElement('pre');
      cachePre.style.margin = '0';
      cachePre.style.padding = '0.5rem 0.6rem';
      cachePre.style.background = '#11141c';
      cachePre.style.border = '1px solid #2b2f3a';
      cachePre.style.borderRadius = '4px';
      cachePre.style.fontSize = '0.72rem';
      cachePre.style.lineHeight = '1.4';
      cachePre.style.color = '#f5f7fa';
      cachePre.style.whiteSpace = 'pre-wrap';
      cachePre.style.wordBreak = 'break-word';
      cachePre.style.display = 'none';
      cachePre.style.maxHeight = '40vh';
      cachePre.style.overflow = 'auto';

      const cacheActions = document.createElement('div');
      cacheActions.style.display = 'flex';
      cacheActions.style.gap = '0.5rem';
      cacheActions.style.alignItems = 'center';

      const cacheRefreshBtn = document.createElement('button');
      cacheRefreshBtn.type = 'button';
      cacheRefreshBtn.textContent = 'Refresh';
      styleSecondaryButton(cacheRefreshBtn);
      cacheRefreshBtn.addEventListener('click', () => refreshCacheStatsView());

      cacheActions.appendChild(cacheRefreshBtn);

      cacheContent.appendChild(cacheIntro);
      cacheContent.appendChild(cacheStatus);
      cacheContent.appendChild(cacheActions);
      cacheContent.appendChild(cachePre);

      accordion.appendChild(playlistSection.wrapper);
      accordion.appendChild(videoPlayerSection.wrapper);
      accordion.appendChild(settingsSection.wrapper);
      accordion.appendChild(cacheSection.wrapper);

      panel.appendChild(header);
      panel.appendChild(accordion);
      overlay.appendChild(panel);

      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
          closeOverlay();
        }
      });

      document.addEventListener('keydown', handleGlobalKeydown);

      document.body.appendChild(overlay);

      applyPanelBounds(panel, overlay);

      if (!state.panelBoundsHandler) {
        state.panelBoundsHandler = () => {
          if (state.panel && state.overlay && state.overlay.style.display !== 'none') {
            applyPanelBounds();
          }
        };
        window.addEventListener('resize', state.panelBoundsHandler, { passive: true });
        window.addEventListener('scroll', state.panelBoundsHandler, { passive: true });
      }

      state.overlay = overlay;
      state.panel = panel;
      state.input = input;
      state.loadBtn = loadBtn;
      state.loadBtnIcon = loadIcon;
      state.loadBtnSr = loadSr;
      state.refreshBtn = refreshBtn;
      state.refreshUploadIcon = refreshUploadIcon;
      state.refreshSyncIcon = refreshSyncIcon;
      state.refreshSr = refreshSr;
      state.downloadBtn = downloadBtn;
      state.statusEl = statusEl;
      state.staticNotice = staticNotice;
      state.historyList = historyList;
      state.settingsStatus = settingsStatus;
      state.settingsPre = settingsPre;
      state.settingsResetBtn = resetBtn;
      state.settingsConfirmBox = settingsConfirmBox;
      state.settingsConfirmConfirmBtn = settingsConfirmConfirmBtn;
      state.settingsConfirmCancelBtn = settingsConfirmCancelBtn;
      state.cacheStatus = cacheStatus;
      state.cachePre = cachePre;
      updateSettingsResetButtonState(true);

      setSectionOpen(state.openSectionId || state.lastOpenedSectionId || 'playlist', { force: true });
      refreshHistoryList();
      refreshSettingsView();
      refreshCacheStatsView();
      updateOverlayAvailability();

      return overlay;
    }

    function stylePrimaryButton(button) {
      button.style.display = 'inline-flex';
      button.style.alignItems = 'center';
      button.style.justifyContent = 'center';
      button.style.gap = '0.35rem';
      button.style.padding = '0.45rem 0.9rem';
      button.style.fontSize = '0.82rem';
      button.style.fontWeight = '600';
      button.style.textTransform = 'uppercase';
      button.style.letterSpacing = '0.06em';
      button.style.borderRadius = '4px';
      button.style.border = '1px solid #46526d';
      button.style.background = '#3a4a67';
      button.style.color = '#f5f7fa';
      button.style.cursor = 'pointer';
      button.addEventListener('mouseover', () => {
        button.style.background = '#425374';
        button.style.borderColor = '#556384';
      });
      button.addEventListener('mouseout', () => {
        button.style.background = '#3a4a67';
        button.style.borderColor = '#46526d';
      });
    }

    function styleSecondaryButton(button) {
      button.style.display = 'inline-flex';
      button.style.alignItems = 'center';
      button.style.justifyContent = 'center';
      button.style.gap = '0.35rem';
      button.style.padding = '0.45rem 0.9rem';
      button.style.fontSize = '0.82rem';
      button.style.fontWeight = '600';
      button.style.textTransform = 'uppercase';
      button.style.letterSpacing = '0.06em';
      button.style.borderRadius = '4px';
      button.style.border = '1px solid #394150';
      button.style.background = '#222836';
      button.style.color = '#f5f7fa';
      button.style.cursor = 'pointer';
      button.addEventListener('mouseover', () => {
        button.style.background = '#283042';
      });
      button.addEventListener('mouseout', () => {
        button.style.background = '#222836';
      });
    }

    function styleTertiaryButton(button) {
      button.style.display = 'inline-flex';
      button.style.alignItems = 'center';
      button.style.justifyContent = 'center';
      button.style.gap = '0.35rem';
      button.style.padding = '0.45rem 0.9rem';
      button.style.fontSize = '0.82rem';
      button.style.fontWeight = '600';
      button.style.textTransform = 'uppercase';
      button.style.letterSpacing = '0.06em';
      button.style.borderRadius = '4px';
      button.style.border = '1px solid #2b2f3a';
      button.style.background = 'transparent';
      button.style.color = '#a8b3c7';
      button.style.cursor = 'pointer';
      button.addEventListener('mouseover', () => {
        button.style.color = '#f5f7fa';
        button.style.borderColor = '#394150';
      });
      button.addEventListener('mouseout', () => {
        button.style.color = '#a8b3c7';
        button.style.borderColor = '#2b2f3a';
      });
    }

    function openOverlay() {
      const overlay = ensureOverlay();
      state.lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      state.sidebarHiddenBeforeOpen = document.body.classList.contains('sidebar-hidden');
      overlay.style.display = 'flex';
      applyPanelBounds();
      overlay.setAttribute('aria-hidden', 'false');
      if (state.overlayHost === document.body) {
        state.bodyOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
      }
      // Ensure the sidebar stays visible behind the overlay; otherwise closing via X can
      // reveal an auto-hidden sidebar and look like the playlist UI disappeared.
      document.body.classList.remove('sidebar-hidden');
      updateOverlayAvailability();
      updateStatus('');
      setSectionOpen(state.openSectionId || state.lastOpenedSectionId || 'playlist', { force: true });
      refreshHistoryList();
      refreshSettingsView();
      refreshCacheStatsView();
      if (state.input) {
        const currentId = typeof getPlaylistId === 'function' ? getPlaylistId() : '';
        state.input.value = currentId || '';
        if (state.openSectionId === 'playlist') {
          state.input.focus({ preventScroll: true });
        }
      }
    }

    function closeOverlay() {
      if (!state.overlay) return;
      state.overlay.style.display = 'none';
      state.overlay.setAttribute('aria-hidden', 'true');
      if (state.overlayHost === document.body) {
        document.body.style.overflow = state.bodyOverflow || '';
      }
      state.bodyOverflow = '';
      state.loading = false;
      setLoading(false);
      updateStatus('');
      if (typeof state.sidebarHiddenBeforeOpen === 'boolean') {
        document.body.classList.toggle('sidebar-hidden', state.sidebarHiddenBeforeOpen);
      }
      state.sidebarHiddenBeforeOpen = null;
      if (state.lastFocused && typeof state.lastFocused.focus === 'function') {
        state.lastFocused.focus({ preventScroll: true });
      }
      state.lastFocused = null;
    }

    function updateStatus(message, tone = 'neutral') {
      if (!state.statusEl) return;
      const text = message || '';
      if (!text && !state.serverAvailable) {
        state.statusEl.textContent = 'Static server mode: cached playlists only.';
        state.statusEl.style.color = '#d7c37a';
        return;
      }

      state.statusEl.textContent = text;
      if (!text) {
        state.statusEl.style.color = '#a8b3c7';
        return;
      }

      if (tone === 'error') {
        state.statusEl.style.color = '#ff8080';
      } else if (tone === 'success') {
        state.statusEl.style.color = '#7ddc8c';
      } else {
        state.statusEl.style.color = '#a8b3c7';
      }
    }

    function updateOverlayAvailability() {
      const isStatic = !state.serverAvailable;

      if (state.staticNotice) {
        state.staticNotice.style.display = isStatic ? 'block' : 'none';
      }

      if (state.input) {
        state.input.disabled = state.loading || isStatic;
        state.input.placeholder = isStatic
          ? 'Enter cached playlist ID (server static)'
          : 'https://www.youtube.com/playlist?list=...';
      }

      if (state.loadBtn) {
        const loadDisabled = state.loading || isStatic;
        state.loadBtn.disabled = loadDisabled;
        state.loadBtn.setAttribute('aria-disabled', String(loadDisabled));
        state.loadBtn.setAttribute(
          'aria-label',
          isStatic ? 'Upload disabled while running in static mode' : 'Upload playlist'
        );
        state.loadBtn.title = isStatic
          ? 'Server unavailable; uploading new playlists is disabled.'
          : 'Upload playlist';
        state.loadBtn.style.opacity = isStatic ? '0.5' : '1';
        state.loadBtn.style.cursor = isStatic ? 'not-allowed' : 'pointer';
        state.loadBtn.style.pointerEvents = isStatic ? 'none' : 'auto';
        if (state.loadBtnIcon) {
          state.loadBtnIcon.className = 'icon upload';
          state.loadBtnIcon.textContent = 'upload';
        }
        if (state.loadBtnSr) {
          state.loadBtnSr.textContent = 'Upload';
        }
      }

      if (state.refreshBtn) {
        state.refreshBtn.disabled = state.loading || isStatic;
        state.refreshBtn.setAttribute(
          'aria-label',
          isStatic ? 'Refresh requires server connection' : 'Upload and refresh playlist'
        );
        state.refreshBtn.title = isStatic
          ? 'Refreshing playlists requires the server; unavailable in static mode.'
          : 'Upload and refresh playlist';
        state.refreshBtn.style.opacity = isStatic ? '0.5' : '1';
        state.refreshBtn.style.cursor = isStatic ? 'not-allowed' : 'pointer';
        state.refreshBtn.style.pointerEvents = isStatic ? 'none' : 'auto';
        if (state.refreshSr) {
          state.refreshSr.textContent = isStatic ? 'Refresh (requires server)' : 'Upload and refresh';
        }
        if (state.refreshUploadIcon) {
          state.refreshUploadIcon.style.opacity = isStatic ? '0.35' : '1';
        }
        if (state.refreshSyncIcon) {
          state.refreshSyncIcon.style.opacity = isStatic ? '0.35' : '1';
        }
      }

      if (state.downloadBtn) {
        state.downloadBtn.disabled = state.loading;
      }

      if (state.statusEl && !state.loading && !state.statusEl.textContent && isStatic) {
        state.statusEl.textContent = 'Static server mode: cached playlists only.';
        state.statusEl.style.color = '#d7c37a';
      }
    }

    function updateSettingsResetButtonState(disabled) {
      if (!state.settingsResetBtn) return;
      const isDisabled = Boolean(disabled);
      state.settingsResetBtn.disabled = isDisabled;
      state.settingsResetBtn.setAttribute('aria-disabled', String(isDisabled));
      state.settingsResetBtn.style.opacity = isDisabled ? '0.55' : '1';
      state.settingsResetBtn.style.cursor = isDisabled ? 'not-allowed' : 'pointer';
      state.settingsResetBtn.style.pointerEvents = isDisabled ? 'none' : 'auto';
      state.settingsResetBtn.style.background = isDisabled ? '#1b2231' : '#1b2231';
      state.settingsResetBtn.style.borderColor = '#2b2f3a';
      state.settingsResetBtn.style.color = '#a8b3c7';
      if (isDisabled) {
        hideSettingsResetPrompt();
      }
    }

    function showSettingsResetPrompt() {
      if (!state.settingsConfirmBox) return;
      if (state.settingsConfirmBox.style.display === 'flex') return;
      state.settingsConfirmBox.style.display = 'flex';
      state.settingsConfirmBox.style.flexDirection = 'column';
      if (state.settingsConfirmConfirmBtn) {
        state.settingsConfirmConfirmBtn.focus({ preventScroll: true });
      }
    }

    function hideSettingsResetPrompt() {
      if (!state.settingsConfirmBox) return;
      state.settingsConfirmBox.style.display = 'none';
    }

    function setLoading(isLoading) {
      state.loading = isLoading;
      updateOverlayAvailability();
    }

    function setServerAvailability(available) {
      state.serverAvailable = Boolean(available);
      updateOverlayAvailability();
      if (!state.loading) {
        updateStatus('');
      }
    }

    async function triggerLoad(forceRefresh) {
      if (state.loading) return;
      const value = state.input ? state.input.value.trim() : '';
      if (!value) {
        updateStatus('Enter a playlist URL or ID first.', 'error');
        if (state.input) {
          state.input.focus({ preventScroll: true });
        }
        return;
      }

      updateStatus(forceRefresh ? 'Refreshing playlist...' : 'Loading playlist...');
      setLoading(true);

      try {
        const result = await onLoad({ playlistId: value, forceRefresh });
        if (typeof result === 'string' && result.trim()) {
          updateStatus('Playlist loaded.', 'success');
          closeOverlay();
        } else {
          updateStatus('Unable to load playlist. Check alerts for details.', 'error');
        }
      } catch (error) {
        console.error('Playlist load failed:', error);
        const message = error && error.message ? error.message : 'Failed to load playlist.';
        updateStatus(message, 'error');
        if (typeof showAlert === 'function') {
          showAlert(message);
        }
      } finally {
        setLoading(false);
        refreshHistoryList();
      }
    }

    function handleDownload() {
      try {
        const result = onDownload();
        if (result === false) {
          updateStatus('No playlist loaded yet.', 'error');
          return;
        }
        updateStatus('Download started.', 'success');
      } catch (error) {
        console.error('Playlist download failed:', error);
        const message = error && error.message ? error.message : 'Failed to download playlist.';
        updateStatus(message, 'error');
        if (typeof showAlert === 'function') {
          showAlert(message);
        }
      }

      refreshHistoryList();
    }

    function handleSettingsReset() {
      if (state.resettingSettings) return;
      if (!state.settingsResetBtn || state.settingsResetBtn.disabled) return;
      showSettingsResetPrompt();
    }

    async function performSettingsReset() {
      if (state.resettingSettings) return;
      if (typeof resetUserSettings !== 'function') return;

      state.resettingSettings = true;
      updateSettingsResetButtonState(true);
      hideSettingsResetPrompt();
      if (state.settingsStatus) {
        state.settingsStatus.textContent = 'Resetting stored settings…';
        state.settingsStatus.style.color = '#a8b3c7';
      }

      try {
        const result = await Promise.resolve().then(() => resetUserSettings());
        if (result === false) {
          updateStatus('Reset cancelled.', 'neutral');
        } else {
          updateStatus('Stored settings reset.', 'success');
        }
      } catch (error) {
        console.error('Stored settings reset failed:', error);
        updateStatus('Failed to reset stored settings.', 'error');
      } finally {
        state.resettingSettings = false;
        refreshSettingsView();
        refreshHistoryList();
      }
    }

    function refreshHistoryList() {
      if (!state.historyList) return;
      state.historyList.innerHTML = '';
      const items = typeof getPlaylistHistory === 'function' ? getPlaylistHistory() : [];
      if (!items || !items.length) {
        const empty = document.createElement('div');
        empty.textContent = 'No saved playlists.';
        empty.style.fontSize = '0.8rem';
        empty.style.color = '#6c7488';
        empty.style.padding = '0.35rem 0.5rem';
        empty.style.textAlign = 'center';
        state.historyList.appendChild(empty);
        return;
      }

      items.forEach((entry, index) => {
        const row = document.createElement('div');
        row.dataset.historyRow = 'true';
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.gap = '0.45rem';
        row.style.padding = '0 0.45rem';
        row.style.minHeight = '2.1rem';
        row.style.background = '#171c26';
        row.style.color = '#f5f7fa';
        row.style.borderRadius = '4px';
        row.style.boxSizing = 'border-box';
        row.style.width = '100%';
        row.style.transition = 'background-color 120ms ease';
        row.style.cursor = 'pointer';

        const textBtn = document.createElement('button');
        textBtn.type = 'button';
        textBtn.dataset.historyTitle = 'true';
        textBtn.textContent = entry.title || entry.id;
        textBtn.title = entry.id;
        textBtn.style.flex = '1 1 auto';
        textBtn.style.display = 'flex';
        textBtn.style.alignItems = 'center';
        textBtn.style.textAlign = 'left';
        textBtn.style.background = 'transparent';
        textBtn.style.border = 'none';
        textBtn.style.color = 'inherit';
        textBtn.style.fontSize = '0.82rem';
        textBtn.style.cursor = 'pointer';
        textBtn.style.padding = '0';
        textBtn.style.minWidth = '0';
        textBtn.style.height = '100%';
        textBtn.style.overflow = 'hidden';
        textBtn.style.textOverflow = 'ellipsis';
        textBtn.style.whiteSpace = 'nowrap';
        textBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          selectHistoryRow(index);
        });

        row.addEventListener('click', (event) => {
          const target = event.target instanceof HTMLElement ? event.target : null;
          if (target && target.closest('[data-history-action="true"]')) {
            return;
          }
          selectHistoryRow(index);
        });

        const openBtn = createIconButton('open_in_browser', 'Open in YouTube');
        openBtn.dataset.historyAction = 'true';
        openBtn.addEventListener('click', () => {
          const url = entry.id.startsWith('http')
            ? entry.id
            : `https://www.youtube.com/playlist?list=${encodeURIComponent(entry.id)}`;
          window.open(url, '_blank', 'noopener');
        });

        const deleteBtn = createIconButton('delete', 'Remove from saved');
        deleteBtn.dataset.historyAction = 'true';
        deleteBtn.addEventListener('click', () => {
          if (typeof removePlaylist === 'function') {
            removePlaylist(entry.id);
            updateStatus('Removed playlist from saved list.', 'success');
            refreshHistoryList();
          }
        });

        row.appendChild(textBtn);
        row.appendChild(openBtn);
        row.appendChild(deleteBtn);
        state.historyList.appendChild(row);
      });

      // If we have an input value matching a row, highlight it.
      if (state.input && state.input.value) {
        const matchIndex = items.findIndex((entry) => entry.id === state.input.value.trim());
        if (matchIndex >= 0) {
          highlightHistoryRow(matchIndex);
        }
      }
    }

    function selectHistoryRow(index) {
      if (!state.historyList) return;
      const items = typeof getPlaylistHistory === 'function' ? getPlaylistHistory() : [];
      if (!items[index]) return;

      if (state.input) {
        state.input.value = items[index].id;
        state.input.focus({ preventScroll: true });
        const cursor = state.input.value.length;
        if (typeof state.input.setSelectionRange === 'function') {
          state.input.setSelectionRange(cursor, cursor);
        }
      }

      highlightHistoryRow(index);
    }

    function highlightHistoryRow(index) {
      if (!state.historyList) return;
      const rows = Array.from(state.historyList.children);
      rows.forEach((node, idx) => {
        if (!(node instanceof HTMLElement)) return;
        if (idx === index) {
          node.dataset.selected = 'true';
          node.style.outline = 'none';
          node.style.background = '#242b3a';
          node.style.color = '#f5f7fa';
        } else {
          delete node.dataset.selected;
          node.style.outline = 'none';
          node.style.background = '#171c26';
          node.style.color = '#f5f7fa';
        }
        const titleBtn = node.querySelector('[data-history-title="true"]');
        if (titleBtn instanceof HTMLElement) {
          titleBtn.style.color = 'inherit';
        }
        node.querySelectorAll('[data-history-action="true"]').forEach((btn) => {
          if (btn instanceof HTMLElement) {
            applyHistoryActionButtonState(btn, btn.matches(':hover'));
          }
        });
      });
    }

    function applyHistoryActionButtonState(btn, hover) {
      const row = btn.closest('[data-history-row="true"]');
      const isSelected = Boolean(row && row.dataset.selected === 'true');
      if (isSelected) {
        if (hover) {
          btn.style.background = '#384257';
          btn.style.color = '#f5f7fa';
          btn.style.borderColor = '#445069';
        } else {
          btn.style.background = '#2d3648';
          btn.style.color = '#f5f7fa';
          btn.style.borderColor = '#2d3648';
        }
      } else {
        if (hover) {
          btn.style.background = '#273043';
          btn.style.color = '#f5f7fa';
          btn.style.borderColor = '#394150';
        } else {
          btn.style.background = '#1f2532';
          btn.style.color = '#a8b3c7';
          btn.style.borderColor = 'transparent';
        }
      }
    }

    function createIconButton(iconName, tooltip) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.style.width = '28px';
      btn.style.height = '28px';
      btn.style.flex = '0 0 28px';
      btn.style.display = 'inline-flex';
      btn.style.alignItems = 'center';
      btn.style.justifyContent = 'center';
      btn.style.borderRadius = '4px';
      btn.style.border = '1px solid transparent';
      btn.style.background = '#1f2532';
      btn.style.cursor = 'pointer';
      btn.style.color = '#a8b3c7';
      btn.style.padding = '0';
      btn.title = tooltip;
      btn.setAttribute('aria-label', tooltip);
      btn.style.fontSize = '0';

      const iconSpan = document.createElement('span');
      iconSpan.setAttribute('aria-hidden', 'true');
      iconSpan.className = 'icon';
      const iconClass = iconName.replace(/_/g, '-');
      iconSpan.classList.add(iconClass);
      iconSpan.textContent = iconName;
      btn.appendChild(iconSpan);

      applyHistoryActionButtonState(btn, false);

      btn.addEventListener('mouseover', () => {
        applyHistoryActionButtonState(btn, true);
      });
      btn.addEventListener('mouseout', () => {
        applyHistoryActionButtonState(btn, false);
      });

      return btn;
    }

    function handleGlobalKeydown(event) {
      if (event.key === 'Escape' && state.overlay && state.overlay.style.display !== 'none') {
        event.preventDefault();
        closeOverlay();
      }
    }

    if (triggerElement && typeof triggerElement.addEventListener === 'function') {
      triggerElement.addEventListener('click', () => {
        openOverlay();
      });
    }

    return {
      open: openOverlay,
      close: closeOverlay,
      updateStatus,
      refreshSettings: refreshSettingsView,
      setServerAvailability
    };
  }

if (typeof window !== 'undefined') {
  window.initPlaylistIO = initPlaylistIO;
}

export { initPlaylistIO };
