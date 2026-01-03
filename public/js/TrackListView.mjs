import { splitArtists, splitTrackDisplayText, getSortKeyForTitle } from './TrackParsing.mjs';

const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

export class TrackListView {
  constructor(options = {}) {
    const {
      ulEl,
      scrollContainerEl,
      focusContainerEl,

      getPlaylistItems,
      getCurrentIndex,

      getFilterText,
      getOnlyMarked,
      getArtistFilters,
      getCountryFilters,
      getFilteredIndices,
      getSortAlphabetically,

      getTrackDetailSettings,

      normalizeArtistName,
      makeSortKey,
      splitCountryCodes,
      getCountryFlagEmoji,

      getActivePlaylistId,
      isTrackChecked,
      getTrackStateForPlaylist,
      toggleTrackStateForPlaylist,

      trackStateCheckedValue,

      onPlayIndex,
      onToggleArtistFilterName,
      onToggleCountryFilterCode,

      onVisibleIndicesComputed,
    } = options;

    this.ulEl = ulEl;
    this.scrollContainerEl = scrollContainerEl;
    this.focusContainerEl = focusContainerEl;

    this.getPlaylistItems = getPlaylistItems;
    this.getCurrentIndex = getCurrentIndex;

    this.getFilterText = getFilterText;
    this.getOnlyMarked = typeof getOnlyMarked === 'function' ? getOnlyMarked : () => false;
    this.getArtistFilters = getArtistFilters;
    this.getCountryFilters = getCountryFilters;
    this.getFilteredIndices = getFilteredIndices;
    this.getSortAlphabetically = getSortAlphabetically;

    this.getTrackDetailSettings = getTrackDetailSettings;

    this.normalizeArtistName = normalizeArtistName;
    this.makeSortKey = makeSortKey;
    this.splitCountryCodes = splitCountryCodes;
    this.getCountryFlagEmoji = getCountryFlagEmoji;

    this.getActivePlaylistId = getActivePlaylistId;
    this.isTrackChecked = isTrackChecked;
    this.getTrackStateForPlaylist = getTrackStateForPlaylist;
    this.toggleTrackStateForPlaylist = toggleTrackStateForPlaylist;

    this.trackStateCheckedValue = trackStateCheckedValue;

    this.onPlayIndex = onPlayIndex;
    this.onToggleArtistFilterName = onToggleArtistFilterName;
    this.onToggleCountryFilterCode = onToggleCountryFilterCode;

    this.onVisibleIndicesComputed = typeof onVisibleIndicesComputed === 'function'
      ? onVisibleIndicesComputed
      : () => {};

    this.trackRowElements = new Map();

    this._lastUserScrollIntentMs = 0;
    this._lastProgrammaticScrollMs = 0;
    this._scrollActiveRaf = 0;
    this._installScrollGuards();
  }

  _applyThumbnailStyles(img, url) {
    if (!(img instanceof HTMLImageElement)) return;
    const u = String(url || '').trim();

    // Ensure thumbnails always fit the fixed 16:9 slot.
    // We use CSS vars so sizing stays in sync with `public/style.css`.
    img.style.width = 'var(--track-thumb-width)';
    img.style.height = 'var(--track-row-base-height)';
    img.style.flexShrink = '0';
    img.style.display = 'block';
    img.style.borderRadius = '6px';
    img.style.background = 'var(--color-hover)';

    const isSpotifyPlaceholder = u.includes('/img/music-icon.png') || u.endsWith('music-icon.png');
    if (isSpotifyPlaceholder) {
      img.style.objectFit = 'contain';
      img.classList.add('spotify-placeholder-thumb');
    } else {
      img.style.objectFit = '';
      img.classList.remove('spotify-placeholder-thumb');
    }
  }

  _snapScrollToRowBoundary() {
    const container = this.scrollContainerEl;
    const ul = this.ulEl;
    if (!container || !ul) return;

    const containerRect = container.getBoundingClientRect();
    const lis = ul.querySelectorAll('li');
    if (!lis || !lis.length) return;

    // Find the first row whose top is at/under the container's top.
    // If its top is > 0, it means the previous row is partially visible.
    // Nudge scrollTop down so this row starts exactly at the top.
    let firstVisibleTopDelta = null;
    for (const li of lis) {
      const r = li.getBoundingClientRect();
      const delta = r.top - containerRect.top;
      if (delta >= -0.5) {
        firstVisibleTopDelta = delta;
        break;
      }
    }

    if (typeof firstVisibleTopDelta === 'number' && firstVisibleTopDelta > 1) {
      this._lastProgrammaticScrollMs = Date.now();
      container.scrollTop += firstVisibleTopDelta;
    }
  }

  _installScrollGuards() {
    const el = this.scrollContainerEl;
    if (!el || typeof el.addEventListener !== 'function') return;

    const markUserIntent = () => {
      this._lastUserScrollIntentMs = Date.now();
    };

    // Inputs that strongly suggest the user is trying to scroll the list.
    el.addEventListener('wheel', markUserIntent, { passive: true });
    el.addEventListener('touchstart', markUserIntent, { passive: true });
    el.addEventListener('pointerdown', markUserIntent, { passive: true });

    // Scroll events can be user-driven or programmatic; ignore those we just caused.
    el.addEventListener('scroll', () => {
      if (Date.now() - this._lastProgrammaticScrollMs < 250) return;
      markUserIntent();
    }, { passive: true });
  }

  /**
   * Update (or insert) a thumbnail image for a given real playlist index.
   * This avoids full list re-renders (which can cause flicker).
   * @param {number} idx
   * @param {string} url
   */
  updateThumbnail(idx, url) {
    if (typeof idx !== 'number') return;
    const nextUrl = String(url || '').trim();
    if (!nextUrl) return;

    const li = this.trackRowElements.get(idx);
    if (!li) return;

    const existingImg = li.querySelector('img');
    if (existingImg instanceof HTMLImageElement) {
      if (existingImg.getAttribute('src') !== nextUrl) existingImg.setAttribute('src', nextUrl);
      this._applyThumbnailStyles(existingImg, nextUrl);
      return;
    }

    const img = document.createElement('img');
    img.src = nextUrl;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    this._applyThumbnailStyles(img, nextUrl);

    const numEl = li.querySelector('.track-number');
    if (numEl && numEl.parentNode === li) {
      li.insertBefore(img, numEl.nextSibling);
    } else {
      li.insertBefore(img, li.firstChild ? li.firstChild.nextSibling : null);
    }
  }

  hasRow(idx) {
    return !!(this.trackRowElements && this.trackRowElements.has(idx));
  }

  updateActiveTrackRow(previousIdx, nextIdx) {
    if (previousIdx === nextIdx) {
      const currentEl = this.trackRowElements.get(nextIdx);
      if (currentEl) {
        currentEl.classList.add('active');
      }
      return;
    }

    if (typeof previousIdx === 'number') {
      const prevEl = this.trackRowElements.get(previousIdx);
      if (prevEl) {
        prevEl.classList.remove('active');
      }
    }

    const nextEl = this.trackRowElements.get(nextIdx);
    if (nextEl) {
      nextEl.classList.add('active');
    }
  }

  scrollActiveIntoView(options = {}) {
    const { guardUserScroll = false, guardWindowMs = 1500 } = options || {};
    if (!this.ulEl) return;
    if (!this.scrollContainerEl) return;
    if (guardUserScroll && (Date.now() - this._lastUserScrollIntentMs) < guardWindowMs) return;
    const container = this.scrollContainerEl;
    const active = this.ulEl.querySelector('li.active');
    if (!active) return;

    // Deduplicate multiple calls within the same frame.
    if (this._scrollActiveRaf) return;

    // Compute a single final scrollTop (center + row-boundary snap) and apply once.
    // This avoids a visible two-step scroll (scrollIntoView, then snap adjustment).
    this._scrollActiveRaf = requestAnimationFrame(() => {
      this._scrollActiveRaf = 0;
      if (!this.ulEl || !this.scrollContainerEl) return;
      if (guardUserScroll && (Date.now() - this._lastUserScrollIntentMs) < guardWindowMs) return;

      const activeNow = this.ulEl.querySelector('li.active');
      if (!activeNow) return;

      const containerRect = container.getBoundingClientRect();
      const activeRect = activeNow.getBoundingClientRect();

      // Where is the active row within the scroll content?
      const activeTopInScroll = (activeRect.top - containerRect.top) + container.scrollTop;
      const targetCenterTop = activeTopInScroll - (container.clientHeight / 2 - activeRect.height / 2);

      // Snap so the top-most visible row is fully visible (avoid partial row at top).
      let snapped = targetCenterTop;
      try {
        const lis = this.ulEl.querySelectorAll('li');
        if (lis && lis.length >= 2) {
          const base = Number(lis[0].offsetTop) || 0;
          const step = (Number(lis[1].offsetTop) || 0) - base;
          if (step > 0) {
            const rel = snapped - base;
            snapped = base + Math.ceil(rel / step) * step;
          }
        }
      } catch {
        // ignore
      }

      const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
      const nextTop = Math.max(0, Math.min(maxScroll, Math.round(snapped)));
      if (Math.abs(container.scrollTop - nextTop) < 1) return;

      this._lastProgrammaticScrollMs = Date.now();
      container.scrollTop = nextTop;
    });
  }

  focusActiveTrack(options = {}) {
    const { scroll = true } = options || {};
    if (scroll) {
      this.scrollActiveIntoView();
    }
    if (this.focusContainerEl && typeof this.focusContainerEl.focus === 'function') {
      this.focusContainerEl.focus({ preventScroll: true });
    }
  }

  getSortKeyForIndex(idx) {
    const items = this.getPlaylistItems();
    const item = items[idx];
    if (!item) return '';
    const rawTitle = (typeof item.userTitle === 'string' && item.userTitle.trim().length)
      ? item.userTitle
      : (item.title || '');
    return getSortKeyForTitle(rawTitle, this.makeSortKey);
  }

  getSortedIndices(indices) {
    return indices.slice().sort((a, b) => {
      const keyA = this.getSortKeyForIndex(a);
      const keyB = this.getSortKeyForIndex(b);
      if (keyA < keyB) return -1;
      if (keyA > keyB) return 1;
      return a - b;
    });
  }

  createTrackStateButton(videoId, playlistId) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'track-state-btn';
    btn.dataset.videoId = videoId;

    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    btn.appendChild(icon);

    const apply = (state) => {
      btn.dataset.state = state;
      if (state === this.trackStateCheckedValue) {
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
    };

    apply(this.getTrackStateForPlaylist(playlistId, videoId));

    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const next = this.toggleTrackStateForPlaylist(playlistId, videoId);
      apply(next);
    });

    return btn;
  }

  render(options = {}) {
    const { preserveScroll = false, skipActiveScroll } = options || {};
    const suppressActiveScroll = typeof skipActiveScroll === 'boolean' ? skipActiveScroll : preserveScroll;

    const ul = this.ulEl;
    if (!ul) return;

    let previousScrollTop = 0;
    if (preserveScroll && this.scrollContainerEl) {
      previousScrollTop = this.scrollContainerEl.scrollTop;
    }

    ul.innerHTML = '';
    this.trackRowElements = new Map();

    const filterText = this.getFilterText();
    const onlyMarked = !!this.getOnlyMarked();
    const artistFilters = this.getArtistFilters();
    const countryFilters = this.getCountryFilters();

    const hasFilter = (filterText || '').trim().length > 0
      || onlyMarked
      || (Array.isArray(artistFilters) && artistFilters.length > 0)
      || (Array.isArray(countryFilters) && countryFilters.length > 0);

    const playlistItems = this.getPlaylistItems();
    const allIndices = playlistItems.map((_, i) => i);
    const rawFiltered = hasFilter ? (this.getFilteredIndices() || []).slice() : allIndices.slice();

    let playableIndices = rawFiltered;
    if (this.getSortAlphabetically()) {
      playableIndices = this.getSortedIndices(playableIndices);
    }

    const currentIndex = this.getCurrentIndex();
    const activePlaylistId = this.getActivePlaylistId();
    const trackDetailSettings = this.getTrackDetailSettings();
    const showFiltered = !!(hasFilter && trackDetailSettings && trackDetailSettings.showFiltered);

    let displayIndices = showFiltered ? allIndices.slice() : playableIndices.slice();
    if (showFiltered && this.getSortAlphabetically()) {
      displayIndices = this.getSortedIndices(displayIndices);
    }

    // Navigation/shuffle should only consider playable (filtered-in) tracks.
    this.onVisibleIndicesComputed(playableIndices.slice());

    const playableSet = showFiltered ? new Set(playableIndices) : null;

    displayIndices.forEach((realIdx, displayIdx) => {
      const item = playlistItems[realIdx];
      const li = document.createElement('li');
      if (realIdx === currentIndex) li.classList.add('active');

      const isFilteredOut = !!(showFiltered && playableSet && !playableSet.has(realIdx));
      if (isFilteredOut) {
        li.classList.add('is-filtered-out');
        li.setAttribute('aria-disabled', 'true');
      }

      const rawTitle = item.userTitle ? item.userTitle : item.title;
      const primaryArtist = splitArtists(rawTitle, this.normalizeArtistName)[0] || '';

      const numSpan = document.createElement('span');
      numSpan.className = 'track-number';
      numSpan.textContent = (displayIdx + 1);

      if (primaryArtist) {
        numSpan.setAttribute('role', 'button');
        numSpan.tabIndex = 0;
        numSpan.title = `Filter artist: ${primaryArtist}`;

        numSpan.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.onToggleArtistFilterName(primaryArtist);
        });

        numSpan.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
          event.preventDefault();
          event.stopPropagation();
          this.onToggleArtistFilterName(primaryArtist);
        });
      }
      li.appendChild(numSpan);

      if (trackDetailSettings?.thumbnail) {
        const img = document.createElement('img');
        img.src = item.thumbnail ? item.thumbnail : TRANSPARENT_PIXEL;
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        this._applyThumbnailStyles(img, img.src);

        // When a row is filtered-out (disabled), allow clicking artwork to open the video
        // without selecting/playing it in the app.
        if (isFilteredOut) {
          img.style.cursor = 'pointer';
          img.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const playlistId = this.getActivePlaylistId();
            const baseUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId)}`;
            const url = playlistId
              ? `${baseUrl}&list=${encodeURIComponent(playlistId)}`
              : baseUrl;
            window.open(url, '_blank', 'noopener');
          });
        }

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

      const codes = this.splitCountryCodes(item && typeof item === 'object' ? item.country : '');
      const flagEntries = codes
        .map((iso3) => ({
          iso3,
          flag: iso3 ? this.getCountryFlagEmoji(iso3) : ''
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
              this.onToggleCountryFilterCode(iso3);
            });

            flagSpan.addEventListener('keydown', (event) => {
              if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
              event.preventDefault();
              event.stopPropagation();
              this.onToggleCountryFilterCode(iso3);
            });
          }

          flagsWrap.appendChild(flagSpan);
        });

        const spacePx = 18 + 6;
        textWrap.style.setProperty('--track-country-flags-space', `${spacePx}px`);
        textWrap.classList.add('has-country-flags');
        textWrap.appendChild(flagsWrap);
      }

      if (parts.artist) {
        textWrap.appendChild(artistLine);
        textWrap.appendChild(sepSpan);
      }
      textWrap.appendChild(titleSpan);

      li.appendChild(textWrap);

      const stateBtn = this.createTrackStateButton(item.videoId, activePlaylistId);
      li.appendChild(stateBtn);

      this.trackRowElements.set(realIdx, li);

      li.addEventListener('click', () => {
        if (isFilteredOut) return;
        this.onPlayIndex(realIdx);
      });

      li.addEventListener('auxclick', (event) => {
        if (event.button !== 1) return;
        const targetEl = event.target instanceof Element ? event.target : null;
        if (targetEl && targetEl.closest('.track-state-btn')) return;
        event.preventDefault();

        const playlistId = this.getActivePlaylistId();
        const baseUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId)}`;
        const url = playlistId
          ? `${baseUrl}&list=${encodeURIComponent(playlistId)}`
          : baseUrl;
        window.open(url, '_blank', 'noopener');
      });

      ul.appendChild(li);
    });

    if (preserveScroll && this.scrollContainerEl) {
      this.scrollContainerEl.scrollTop = previousScrollTop;
    }

    if (!suppressActiveScroll) {
      this.scrollActiveIntoView();
    }
  }
}
