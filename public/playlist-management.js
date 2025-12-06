(function () {
  function initPlaylistIO(options = {}) {
    const {
      triggerElement,
      getPlaylistId = () => '',
      onLoad = async () => undefined,
      onDownload = () => undefined,
      showAlert = (message) => window.alert(message),
      getPlaylistHistory = () => [],
      removePlaylist = () => {}
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
      bodyOverflow: '',
      historyList: null,
      overlayHost: document.body,
      panelBoundsHandler: null
    };

    function applyPanelBounds(panelArg, overlayArg) {
      const panel = panelArg || state.panel;
      const overlay = overlayArg || state.overlay;
      if (!panel || !overlay) return;

      const sidebar = document.getElementById('sidebar');
      const trackList = document.getElementById('trackListContainer');
      const sidebarRect = sidebar instanceof HTMLElement ? sidebar.getBoundingClientRect() : null;
      const trackRect = trackList instanceof HTMLElement ? trackList.getBoundingClientRect() : null;

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
        panel.style.bottom = 'auto';
        if (typeof targetWidth === 'number') {
          panel.style.width = `${targetWidth}px`;
          panel.style.maxWidth = `${targetWidth}px`;
          panel.style.minWidth = `${targetWidth}px`;
        }
        panel.style.transform = 'none';
        panel.style.margin = '0';
        panel.style.alignSelf = 'flex-start';
      } else {
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.style.padding = '1rem';
        panel.style.position = 'relative';
        panel.style.top = 'auto';
        panel.style.left = 'auto';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.width = 'min(560px, 92vw)';
        panel.style.maxWidth = 'min(560px, 92vw)';
        panel.style.minWidth = '0';
        panel.style.transform = 'none';
        panel.style.margin = '0 auto';
        panel.style.alignSelf = 'center';
      }
    }

    function ensureOverlay() {
      if (state.overlay) return state.overlay;

      state.overlayHost = document.body;

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
      panel.style.padding = '1.25rem';
      panel.style.border = '1px solid #2b2f3a';
      panel.style.borderRadius = '8px';
      panel.style.boxShadow = '0 18px 48px rgba(0, 0, 0, 0.45)';
      panel.style.maxWidth = '100%';
      panel.style.maxHeight = '80vh';
      panel.style.display = 'flex';
      panel.style.flexDirection = 'column';
      panel.style.gap = '1rem';
      panel.style.boxSizing = 'border-box';
      panel.style.overflowY = 'auto';
      panel.style.alignSelf = 'flex-start';

      const header = document.createElement('div');
      header.style.display = 'flex';
      header.style.alignItems = 'center';
      header.style.justifyContent = 'space-between';
      header.style.gap = '0.75rem';

      const title = document.createElement('h2');
      title.id = 'playlistIOOverlayTitle';
      title.textContent = 'Playlist Management';
      title.style.margin = '0';
      title.style.fontSize = '1rem';

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.setAttribute('aria-label', 'Close overlay');
      closeBtn.style.background = '#28344d';
      closeBtn.style.color = '#f5f7fa';
      closeBtn.style.border = '1px solid #394150';
      closeBtn.style.borderRadius = '4px';
      closeBtn.style.padding = '0.35rem';
      closeBtn.style.cursor = 'pointer';
      closeBtn.style.fontSize = '0';
      closeBtn.addEventListener('click', closeOverlay);

      const closeIcon = document.createElement('span');
      closeIcon.className = 'icon close';
      closeIcon.setAttribute('aria-hidden', 'true');
      closeBtn.appendChild(closeIcon);

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
      form.style.gap = '0.75rem';
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
      buttonRow.style.flexWrap = 'wrap';
      buttonRow.style.gap = '0.5rem';

      const loadBtn = document.createElement('button');
      loadBtn.type = 'submit';
      loadBtn.style.flex = '1 1 150px';
      stylePrimaryButton(loadBtn);
      loadBtn.textContent = '';
      loadBtn.setAttribute('aria-label', 'Upload playlist');
      const loadIcon = document.createElement('span');
      loadIcon.className = 'icon upload';
      loadIcon.setAttribute('aria-hidden', 'true');
      loadBtn.appendChild(loadIcon);
      const loadSr = document.createElement('span');
      loadSr.className = 'sr-only';
      loadSr.textContent = 'Upload';
      loadBtn.appendChild(loadSr);

      const refreshBtn = document.createElement('button');
      refreshBtn.type = 'button';
      refreshBtn.style.flex = '1 1 150px';
      styleSecondaryButton(refreshBtn);
      refreshBtn.textContent = '';
      refreshBtn.setAttribute('aria-label', 'Upload and refresh playlist');
      const refreshUploadIcon = document.createElement('span');
      refreshUploadIcon.className = 'icon upload';
      refreshUploadIcon.setAttribute('aria-hidden', 'true');
      refreshBtn.appendChild(refreshUploadIcon);
      const refreshSyncIcon = document.createElement('span');
      refreshSyncIcon.className = 'icon refresh';
      refreshSyncIcon.setAttribute('aria-hidden', 'true');
      refreshBtn.appendChild(refreshSyncIcon);
      const refreshSr = document.createElement('span');
      refreshSr.className = 'sr-only';
      refreshSr.textContent = 'Upload and refresh';
      refreshBtn.appendChild(refreshSr);
      refreshBtn.addEventListener('click', () => triggerLoad(true));

      const downloadBtn = document.createElement('button');
      downloadBtn.type = 'button';
      downloadBtn.style.flex = '1 1 150px';
      styleTertiaryButton(downloadBtn);
      downloadBtn.textContent = '';
      downloadBtn.setAttribute('aria-label', 'Download playlist JSON');
      const downloadIcon = document.createElement('span');
      downloadIcon.className = 'icon download';
      downloadIcon.setAttribute('aria-hidden', 'true');
      downloadBtn.appendChild(downloadIcon);
      const downloadLabel = document.createElement('span');
      downloadLabel.textContent = 'JSON';
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
      historyWrapper.style.padding = '0.45rem 0.35rem 0.6rem';
      historyWrapper.style.overflow = 'hidden';
      historyWrapper.style.display = 'flex';
      historyWrapper.style.flexDirection = 'column';
      historyWrapper.style.gap = '0.45rem';

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
      historyList.style.minHeight = 'calc(5 * 2.2rem)';
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
      state.refreshBtn = refreshBtn;
      state.downloadBtn = downloadBtn;
      state.statusEl = statusEl;
      state.historyList = historyList;

      refreshHistoryList();

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
      applyPanelBounds();
      overlay.setAttribute('aria-hidden', 'false');
      if (state.overlayHost === document.body) {
        state.bodyOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
      }
      updateStatus('');
      refreshHistoryList();
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
      if (state.overlayHost === document.body) {
        document.body.style.overflow = state.bodyOverflow || '';
      }
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
        state.input.select();
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
      updateStatus
    };
  }

  window.initPlaylistIO = initPlaylistIO;
})();