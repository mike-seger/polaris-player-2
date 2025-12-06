(function () {
  function initPlaylistIO(options = {}) {
    const {
      triggerElement,
      getPlaylistId = () => '',
      onLoad = async () => undefined,
      onDownload = () => undefined,
      showAlert = (message) => window.alert(message)
    } = options;

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
      bodyOverflow: ''
    };

    function ensureOverlay() {
      if (state.overlay) return state.overlay;

      const overlay = document.createElement('div');
      overlay.id = 'playlistIOOverlay';
      overlay.style.position = 'fixed';
      overlay.style.inset = '0';
      overlay.style.display = 'none';
      overlay.style.alignItems = 'center';
      overlay.style.justifyContent = 'center';
      overlay.style.background = 'rgba(10, 12, 18, 0.72)';
      overlay.style.zIndex = '1000';
      overlay.style.padding = '1rem';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-labelledby', 'playlistIOOverlayTitle');
      overlay.setAttribute('aria-hidden', 'true');

      const panel = document.createElement('div');
      panel.style.background = '#161921';
      panel.style.color = '#f5f7fa';
      panel.style.padding = '1.25rem';
      panel.style.border = '1px solid #2b2f3a';
      panel.style.borderRadius = '8px';
      panel.style.boxShadow = '0 18px 48px rgba(0, 0, 0, 0.45)';
      panel.style.width = 'min(560px, 92vw)';
      panel.style.maxHeight = '80vh';
      panel.style.display = 'flex';
      panel.style.flexDirection = 'column';
      panel.style.gap = '1rem';
      panel.style.boxSizing = 'border-box';

      const header = document.createElement('div');
      header.style.display = 'flex';
      header.style.alignItems = 'center';
      header.style.justifyContent = 'space-between';
      header.style.gap = '0.75rem';

      const title = document.createElement('h2');
      title.id = 'playlistIOOverlayTitle';
      title.textContent = 'Playlist Import / Export';
      title.style.margin = '0';
      title.style.fontSize = '1rem';

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.textContent = 'Close';
      closeBtn.style.background = '#28344d';
      closeBtn.style.color = '#f5f7fa';
      closeBtn.style.border = '1px solid #394150';
      closeBtn.style.borderRadius = '4px';
      closeBtn.style.padding = '0.35rem 0.85rem';
      closeBtn.style.cursor = 'pointer';
      closeBtn.style.fontSize = '0.85rem';
      closeBtn.style.fontWeight = '600';
      closeBtn.addEventListener('click', closeOverlay);

      header.appendChild(title);
      header.appendChild(closeBtn);

      const description = document.createElement('p');
      description.textContent = 'Enter a YouTube playlist URL or ID to load it, or download the current playlist snapshot.';
      description.style.margin = '0';
      description.style.fontSize = '0.8rem';
      description.style.color = '#a8b3c7';
      description.style.lineHeight = '1.5';

      const form = document.createElement('form');
      form.style.display = 'flex';
      form.style.flexDirection = 'column';
      form.style.gap = '0.65rem';
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
      input.autocomplete = 'off';

      const buttonRow = document.createElement('div');
      buttonRow.style.display = 'flex';
      buttonRow.style.flexWrap = 'wrap';
      buttonRow.style.gap = '0.5rem';

      const loadBtn = document.createElement('button');
      loadBtn.type = 'submit';
      loadBtn.textContent = 'Load Playlist';
      loadBtn.style.flex = '1 1 150px';
      stylePrimaryButton(loadBtn);

      const refreshBtn = document.createElement('button');
      refreshBtn.type = 'button';
      refreshBtn.textContent = 'Load + Refresh';
      refreshBtn.style.flex = '1 1 150px';
      styleSecondaryButton(refreshBtn);
      refreshBtn.addEventListener('click', () => triggerLoad(true));

      const downloadBtn = document.createElement('button');
      downloadBtn.type = 'button';
      downloadBtn.textContent = 'Download JSON';
      downloadBtn.style.flex = '1 1 150px';
      styleTertiaryButton(downloadBtn);
      downloadBtn.addEventListener('click', handleDownload);

      buttonRow.appendChild(loadBtn);
      buttonRow.appendChild(refreshBtn);
      buttonRow.appendChild(downloadBtn);

      const statusEl = document.createElement('div');
      statusEl.id = 'playlistIOStatus';
      statusEl.style.minHeight = '1em';
      statusEl.style.fontSize = '0.75rem';
      statusEl.style.color = '#a8b3c7';

      form.appendChild(inputLabel);
      form.appendChild(input);
      form.appendChild(buttonRow);
      form.appendChild(statusEl);

      panel.appendChild(header);
      panel.appendChild(description);
      panel.appendChild(form);
      overlay.appendChild(panel);

      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
          closeOverlay();
        }
      });

      document.addEventListener('keydown', handleGlobalKeydown);

      document.body.appendChild(overlay);

      state.overlay = overlay;
      state.panel = panel;
      state.input = input;
      state.loadBtn = loadBtn;
      state.refreshBtn = refreshBtn;
      state.downloadBtn = downloadBtn;
      state.statusEl = statusEl;

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
      overlay.style.display = 'flex';
      overlay.setAttribute('aria-hidden', 'false');
      state.bodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      updateStatus('');
      if (state.input) {
        const currentId = typeof getPlaylistId === 'function' ? getPlaylistId() : '';
        state.input.value = currentId || '';
        state.input.focus({ preventScroll: true });
        if (state.input.value) {
          state.input.select();
        }
      }
    }

    function closeOverlay() {
      if (!state.overlay) return;
      state.overlay.style.display = 'none';
      state.overlay.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = state.bodyOverflow || '';
      state.bodyOverflow = '';
      state.loading = false;
      setLoading(false);
      updateStatus('');
      if (state.lastFocused && typeof state.lastFocused.focus === 'function') {
        state.lastFocused.focus({ preventScroll: true });
      }
      state.lastFocused = null;
    }

    function updateStatus(message, tone = 'neutral') {
      if (!state.statusEl) return;
      state.statusEl.textContent = message || '';
      if (tone === 'error') {
        state.statusEl.style.color = '#ff8080';
      } else if (tone === 'success') {
        state.statusEl.style.color = '#7ddc8c';
      } else {
        state.statusEl.style.color = '#a8b3c7';
      }
    }

    function setLoading(isLoading) {
      state.loading = isLoading;
      if (state.input) state.input.disabled = isLoading;
      if (state.loadBtn) state.loadBtn.disabled = isLoading;
      if (state.refreshBtn) state.refreshBtn.disabled = isLoading;
      if (state.downloadBtn) state.downloadBtn.disabled = isLoading;
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
      updateStatus
    };
  }

  window.initPlaylistIO = initPlaylistIO;
})();
