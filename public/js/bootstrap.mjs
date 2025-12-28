import { initIconFontReadyClass } from './FontLoad.mjs';

// Provide temporary globals for any legacy code paths.
import './OverlayShared.mjs';
import './CountryFlags.mjs';
import './PlaylistManagement.mjs';

initIconFontReadyClass();

// Ensure the font/overlay shims are in place before the app starts.
const ASSET_VERSION = '2025-12-28-1';
await import(`./polaris2-player.mjs?v=${ASSET_VERSION}`);
