import { splitArtists, splitTrackDisplayText, getSortKeyForTitle } from './TrackParsing.mjs';

export class TrackListView {
  constructor(options = {}) {
    const {
      ulEl,
      scrollContainerEl,
      focusContainerEl,

      getPlaylistItems,
      getCurrentIndex,

      getFilterText,
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

  scrollActiveIntoView() {
    if (!this.ulEl) return;
    const active = this.ulEl.querySelector('li.active');
    if (active) {
      active.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
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
    const artistFilters = this.getArtistFilters();
    const countryFilters = this.getCountryFilters();

    const hasFilter = (filterText || '').trim().length > 0
      || (Array.isArray(artistFilters) && artistFilters.length > 0)
      || (Array.isArray(countryFilters) && countryFilters.length > 0);

    const playlistItems = this.getPlaylistItems();
    let indices = hasFilter ? (this.getFilteredIndices() || []).slice() : playlistItems.map((_, i) => i);
    if (this.getSortAlphabetically()) {
      indices = this.getSortedIndices(indices);
    }

    this.onVisibleIndicesComputed(indices.slice());

    const currentIndex = this.getCurrentIndex();
    const activePlaylistId = this.getActivePlaylistId();
    const trackDetailSettings = this.getTrackDetailSettings();

    indices.forEach((realIdx, displayIdx) => {
      const item = playlistItems[realIdx];
      const li = document.createElement('li');
      if (realIdx === currentIndex) li.classList.add('active');

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

      if (trackDetailSettings?.thumbnail && item.thumbnail) {
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

      const stateBtn = this.createTrackStateButton(item.videoId, activePlaylistId);
      li.appendChild(stateBtn);

      this.trackRowElements.set(realIdx, li);

      li.addEventListener('click', () => {
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
