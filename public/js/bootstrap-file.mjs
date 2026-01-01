import { initIconFontReadyClass } from './FontLoad.mjs';

// Provide temporary globals for any legacy code paths.
import './OverlayShared.mjs';
import './CountryFlags.mjs';
import './PlaylistManagement.mjs';

// Embed default playlist index for file:// builds.
import defaultPlaylistIndex from '../video/default-playlists.json';
try {
  // eslint-disable-next-line no-undef
  globalThis.__POLARIS_DEFAULT_PLAYLIST_INDEX__ = defaultPlaylistIndex;
} catch {
  // ignore
}

// Embed default playlist library (per-playlist files) for file:// builds.
import defaultPlaylistLibrary from '../video/default-playlist-library.json';
try {
  // eslint-disable-next-line no-undef
  globalThis.__POLARIS_DEFAULT_PLAYLIST_LIBRARY__ = defaultPlaylistLibrary;
} catch {
  // ignore
}

initIconFontReadyClass();

// Start the app.
import './polaris2-player.mjs';
