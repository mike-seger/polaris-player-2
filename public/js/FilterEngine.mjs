import { getArtistSourceText, splitArtists } from './TrackParsing.mjs';

export function computeFilteredIndices(options = {}) {
  const {
    playlistItems = [],
    filterText = '',
    artistFilters = [],
    countryFilters = [],

    normalizeArtistKey = (name) => (name || '').trim().toLowerCase(),
    normalizeArtistName = (name) => (name || '').trim(),
    normalizeCountryFilterList = (value) => (Array.isArray(value) ? value : []),
    splitCountryCodes = () => [],
  } = options;

  const out = [];
  const f = (filterText || '').trim().toLowerCase();
  const selectedArtists = new Set((artistFilters || []).map(normalizeArtistKey).filter(Boolean));
  const selectedCountries = new Set(normalizeCountryFilterList(countryFilters));

  (playlistItems || []).forEach((item, idx) => {
    const title = (item?.title || '').toLowerCase();
    const customTitle = (typeof item?.userTitle === 'string' ? item.userTitle : '').toLowerCase();

    if (selectedArtists.size) {
      const artists = splitArtists(getArtistSourceText(item), normalizeArtistName);
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

    if (selectedCountries.size) {
      const codes = splitCountryCodes(item && typeof item === 'object' ? item.country : '');
      if (!codes.length) {
        if (!selectedCountries.has('?')) return;
      } else {
        let match = false;
        for (const code of codes) {
          if (selectedCountries.has(code)) {
            match = true;
            break;
          }
        }
        if (!match) return;
      }
    }

    if (!f || title.includes(f) || customTitle.includes(f)) {
      out.push(idx);
    }
  });

  return out;
}
