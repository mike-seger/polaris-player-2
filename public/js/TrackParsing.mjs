export function getArtistSourceText(item) {
  if (!item || typeof item !== 'object') return '';
  if (typeof item.userTitle === 'string' && item.userTitle.trim().length) {
    return item.userTitle;
  }
  if (typeof item.title === 'string') return item.title;
  return '';
}

export function splitArtists(value, normalizeArtistName) {
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

export function splitTrackDisplayText(raw) {
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

export function getSortKeyForTitle(rawTitle, makeSortKey) {
  const raw = typeof rawTitle === 'string' ? rawTitle : '';

  // If multiple artists are present (e.g. "A;B - Title"), ignore everything from
  // the first ';' onward *in the artist portion* for track A–Z sorting.
  const dashIdx = raw.indexOf(' - ');
  if (dashIdx >= 0) {
    const artistPart = raw.slice(0, dashIdx);
    const semiIdx = artistPart.indexOf(';');
    if (semiIdx >= 0) {
      const firstArtist = artistPart.slice(0, semiIdx).trim();
      const rest = raw.slice(dashIdx);
      return makeSortKey(`${firstArtist}${rest}`);
    }
  } else {
    const semiIdx = raw.indexOf(';');
    if (semiIdx >= 0) {
      return makeSortKey(raw.slice(0, semiIdx));
    }
  }

  return makeSortKey(raw);
}
