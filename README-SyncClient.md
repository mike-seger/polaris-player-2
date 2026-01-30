# SyncClient – Minimal standalone usage

This repo includes a WebSocket-based sync client at `public/js/SyncClient.mjs`.

This document shows the **target simplest setup**: a single HTML page with:
- a `<video>` element
- a small **status/toggle button** (ToggleButton is created internally by `SyncClient.mjs`)
- a configurable sync server address (`host:port`)

## 1) Folder layout (minimal)

You need these files available under the same web root:

- `index.html` (the page below)
- `./js/SyncClient.mjs`
- `./js/ToggleButton.js` (imported by SyncClient)
- `./img/link.svg` (or your own SVG)

If you’re using this repository as-is, those already exist under `public/`.

## 2) Minimal HTML page

Create `public/syncclient-minimal.html` (or any file under `public/`) with:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>SyncClient Minimal</title>
</head>
<body style="background:#000;color:#fff;font-family:system-ui, sans-serif; padding:16px;">
  <h1 style="font-size:18px; margin:0 0 12px;">SyncClient Minimal</h1>

  <!-- The local player element SyncClient will control -->
  <video
    id="LocalPlayer"
    src="./video/example.mp4"
    controls
    playsinline
    preload="metadata"
    style="width: min(900px, 100%); display:block; background:#111;"
  ></video>

  <!-- Container where SyncClient will mount the ToggleButton -->
  <div id="syncButton" style="margin-top:12px;"></div>

  <script type="module">
    import { initSyncClient } from './js/SyncClient.mjs';

    // Change this to your server (host:port)
    const syncServer = 'localhost:5001';

    // Create + connect sync client, and mount a toggle/status button.
    // - connected: red
    // - disconnected: white
    // - unavailable: gray
    const client = initSyncClient('LocalPlayer', null, syncServer, {
      container: '#syncButton',
      svgUrl: './img/link.svg',
      size: 40,
      colorConnected: '#cc0000',
      colorDisconnected: '#ffffff',
      colorUnavailable: '#a8b3c7',
    });

    // Optional: expose for debugging
    window.syncClient = client;
  </script>
</body>
</html>
```

Notes:
- The page must be served over HTTP(S). Module imports will not work reliably from `file://`.
- Replace `./video/example.mp4` with any local media file reachable by the browser.
- Replace `./img/link.svg` with your own SVG if desired.

## 3) Run it

From the repo root:

### Serve the static files

Option A (Python):

```bash
cd public
python3 -m http.server 8080
```

Option B (Node):

```bash
cd public
npx serve -l 8080
```

Then open:

- `http://localhost:8080/syncclient-minimal.html`

### Run the sync server

If you use the built-in server under `sync-player/`, start it in another terminal:

```bash
cd sync-player
node sync-server.js
```

## 4) Behavior

- The button is created by `SyncClient.mjs` via its `toggleButtonConfig` parameter.
- Clicking the button toggles connect/disconnect.
- Button colors:
  - **Connected**: `#cc0000` (turns red after the first successful sync)
  - **Disconnected**: `#ffffff`
  - **Unavailable**: `#a8b3c7`

If you want the button to be disabled/unavailable in certain app modes, do that in the caller (e.g., pass a custom `onChange`).

### Optional: block toggling in some states

If your app has “modes” (e.g., sync only allowed for local playback), you can veto toggles:

```js
const client = initSyncClient('LocalPlayer', null, syncServer, {
  container: '#syncButton',
  onBeforeToggle: (checked, syncClient) => {
    const allowed = /* your condition */ true;
    if (!allowed) {
      syncClient.updateButtonState('unavailable');
      return false; // revert the click
    }
    return true;
  }
});
```
