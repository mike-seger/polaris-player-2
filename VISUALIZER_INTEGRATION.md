# Visualizer Integration Guide

This document explains how to use the Interactive Particles Music Visualizer as an alternative display mode for local audio/video files in the Polaris Player.

## Architecture

The visualizer integration uses an **IFrame Adapter** pattern:

- **VisualizerAdapter** (`public/js/players/adapters/VisualizerAdapter.mjs`) - Player adapter that loads the visualizer in an iframe
- **visualizer-bridge.html** (`public/visualizer-bridge.html`) - Communication bridge between Polaris and the visualizer
- **postMessage API** - Sends commands (play, pause, seek, volume) from Polaris to visualizer

### Benefits of This Approach

✅ **Minimal modifications to visualizer repo** - It remains standalone  
✅ **Complete isolation** - Visualizer runs independently in a nested iframe  
✅ **Easy to toggle** - Switch between standard video and visualizer via console  
✅ **Player stays static** - All integration code is optional and non-invasive  
✅ **Works with server restrictions** - Bridge file served from public/ directory  

## Setup
Available

The visualizer should be at:
```
tmp/Interactive-Particles-Music-Visualizer/
```

The bridge file will attempt to load it from `../tmp/Interactive-Particles-Music-Visualizer/index.html`

Verify the visualizer exists:
```bash
ls tmp/Interactive-Particles-Music-Visualizer/index
ls tmp/Interactive-Particles-Music-Visualizer/bridge.html
```

### 2. Start Your Server

The visualizer needs to be served alongside Polaris:

```bash
# If using the Python server:
python3 utility/no_cache_server.py

# Or your preferred method to serve the public/ directory
```

## Usage

### Enable Visualizer Mode

Open the browser console (F12 or Cmd+Option+I) and run:

```javascript
__polarisVisualizer.enable()
```

You'll see: `[Polaris] Visualizer enabled. Reload the current track to activate.`

### Disable Visualizer Mode

To return to standard video/audio player:

```javascript
__polarisVisualizer.disable()
```

### Check Status

```javascript
__polarisVisualizer.status()
// Returns: [Polaris] Visualizer is ENABLED or DISABLED
```

### Apply Changes

After enabling/disabling the visualizer, you need to **reload the current track** for the change to take effect:

1. Skip to next track, then back
2. Or click on the same track in the playlist
3. Or restart playback

The player will then use the appropriate adapter (VisualizerAdapter or HtmlVideoAdapter).

## How It Works

### Adapter Priority

When visualizer is **enabled**, adapters are checked in this order:
1. YouTubeAdapter (for YouTube videos)
2. **VisualizerAdapter** (for local files)
3. HtmlVideoAdapter (for local files - fallback)
4. SpotifyAdapter (for Spotify)

When visualizer is **disabled**, adapters are checked in this order:
1. YouTubeAdapter
2. VisualizerAdapter (skipped - returns `supports("file") = false`)
3. **HtmlVideoAdapter** (for local files)
4. SpotifyAdapter

### Communication Flow

```public/visualizer-bridge.html]
    ↓ loads nested iframe
[iframe: tmp/.../index.html - Visualizer App]
    ↓ audio playback in bridgeml]
    ↓ initializes
[Visualizer App]
    ↓ audio events
[postMessage back to parent]
    ↓
Polaris updates UI
```

### Supported Commands

**From Polaris → Visualizer:**
- `LOAD_TRACK` - Load a new audio/video file
- `PLAY` / `PAUSE` / `STOP`
- `SEEK` - Jump to specific time
- `SET_VOLUME` / `SET_MUTED` / `SET_RATE`

**From Visualizer → Polaris:**
- `VISUALIZER_READY` - Initialization complete
- `TIME_UPDATE` - Periodic playback position
- `PLAYING` / `PAUSED` / `ENDED` / `BUFFERING`
- `ERROR` - Playback error

## Customization

### Change Visualizer Path

If you move the visualizer to a different location, update the path when creating the adapter:

```javascript
// In polaris2-player.mjs around line 2467:
const visualizerAdap/custom-bridge.html'
});
```

### Change Nested Visualizer Path

The bridge loads the visualizer from `../tmp/Interactive-Particles-Music-Visualizer/index.html` by default. To change this, edit [`public/visualizer-bridge.html`](public/visualizer-bridge.html):

```javascript
// Around line 33:
const VISUALIZER_PATH = '../path/to/your/visualizer/index.html'enabled: false,
  visualizerPath: '../path/to/your/visualizer/bridge.html'
});
```

### Persist Visualizer Preference

To save the visualizer preference across sessions, you could extend the `SettingsStore`:

```javascript
// Load preference on startup
const visualizerEnabled = settings.visualizerEnabled === true;
const visualizerAdapter = new VisualizerAdapter({ enabled: visualizerEnabled });

// Save when toggled
__polarisVisualizer.enable = () => {
  visualizerAdapter.setEnabled(true);
  settingsStore.patch({ visualizerEnabled: true });
  console.log('[Polaris] Visualizer enabled.');
};
```

### Add UI Toggle Button

You could add a button in the player controls:

```html
<!-- In public/index.html -->
<button id="visualizerToggle" type="button" aria-label="Toggle visualizer">
  <span class="icon">audiotrack</span>
</button>
```

```javascript
// In polaris2-player.mjs
document.getElementById('visualizerToggle').addEventListener('click', () => {
  if (visualizerAdapter.isEnabled()) {
    __polarisVisualizer.disable();
  } else {the visualizer exists at `tmp/Interactive-Particles-Music-Visualizer/index.html`
3. Check that the path in `visualizer-bridge.html` is correct (line ~33)
4. Ensure the visualizer's dependencies are built (run `npm run dev` or `npm run build` in visualizer directory)
5. Check for CORS errors if serving from different origins
});
```

## Troubleshooting

### Visualizer doesn't load

1. Check browser console for errors
2. Verify bridge.html exists at the correct path
3. Ensure CORS is configured if serving from different origins
4. Check that the visualizer's dependencies are installed (`npm install` in visualizer directory)

### No audio/video in visualizer

1. Verify the track source URL is accessible
2. Check browser console for audio loading errors
3. Ensure the audio file format is supported (mp3, mp4, m4a, wav, ogg, webm, flac)

### Visualizer shows but doesn't respond to controls

1. Open browser console and check for postMessage errors
2. Verify the visualizer App is initialized (`App.audioManager` should exist)
3. C├── visualizer-bridge.html              (NEW - served bridge file)
│   └── js/
│       ├── polaris2-player.mjs         (registers VisualizerAdapter)
│       └── players/
│           └── adapters/
│               ├── HtmlVideoAdapter.mjs    (standard video player)
│               └── VisualizerAdapter.mjs   (NEW - visualizer adapter)
└── tmp/
    └── Interactive-Particles-Music-Visualizer/
        ├── index.html                       (original standalone - loaded by bridg
├── public/
│   ├── index.html
│   └── js/
│       ├── polaris2-player.mjs         (registers VisualizerAdapter)
│       └── players/
│           └── adapters/
│               ├── HtmlVideoAdapter.mjs    (standard video player)
│               └── VisualizerAdapter.mjs   (NEW - visualizer adapter)
└── tmp/
    └── Interactive-Particles-Music-Visualizer/
        ├── bridge.html                      (NEW - communication bridge)
        ├── index.html                       (original standalone)
        └── src/
            └── js/Zero - completely untouched |
| Player repo invasiveness | ✅ Minimal (2 new files, 2 small edits) |
| Can disable visualizer | ✅ Yes, instant toggle |
| Player remains static | ✅ Yes, no runtime changes |
| Easy maintenance | ✅ Both apps stay independent |
| Works with web server | ✅ Bridge served from public/

## Benefits Summary

| Aspect | Status |
|--------|--------|
| Visualizer repo modifications | ✅ None (1 new bridge file) |
| Player repo invasiveness | ✅ Minimal (2 new files, 2 small edits) |
| Can disable visualizer | ✅ Yes, instant toggle |
| Player remains static | ✅ Yes, no runtime changes |
| Easy maintenance | ✅ Both apps stay independent |

## Future Enhancements

- [ ] Add UI button for visualizer toggle
- [ ] Persist preference in localStorage
- [ ] Add visualizer settings panel
- [ ] Support multiple visualizer themes
- [ ] Create playlist-level visualizer mode toggle
