import { initIconFontReadyClass } from './FontLoad.mjs';

// Provide temporary globals for any legacy code paths.
import './OverlayShared.mjs';
import './CountryFlags.mjs';
import './PlaylistManagement.mjs';

// Embed local playlist library for file:// builds (avoids fetch() restrictions).
import localPlaylistLibrary from '../local-playlist.json';
try {
  // eslint-disable-next-line no-undef
  globalThis.__POLARIS_LOCAL_PLAYLIST_LIBRARY__ = localPlaylistLibrary;
} catch {
  // ignore
}

initIconFontReadyClass();

// Start the app.
import './polaris2-player.mjs';
