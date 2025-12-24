# Generic playlist player refactor package (ESM)

This zip is meant to be pasted into your repo and used as a change request for Copilot.

## Goal

Make your player backend generic across:
- YouTube IFrame player (in-browser video)
- Local files via `<video>` (in-browser media)
- VLC via HTTP web interface (video shown outside browser)

Key UI requirement: for backends that do **not** render video in-browser (VLC), the adapter supplies a **placeholder image** to show in the "video pane" so your layout stays consistent.

## What’s included

`src/core/`
- `types.mjs`: JSDoc typedefs for Track/Capability/MediaPane/etc.
- `Emitter.mjs`: tiny event emitter with unsubscribe
- `placeholder.mjs`: generates an SVG data URL placeholder image

`src/`
- `PlayerHost.mjs`: routes tracks to adapters and exposes one unified event surface
- `YTController.mjs`: UPDATED YouTube-specific controller (still YT-only), now with:
  - `mount(container)` / `unmount()`
  - `stop()`, `setVolume()`, `getVolume()`, `setMuted()`, `isMuted()`, `setRate()`, `getRate()`
  - `onError()`, and wires `onError` into YT player `events`
- `adapters/YouTubeAdapter.mjs`: wraps YTController into the generic adapter interface
- `adapters/HtmlVideoAdapter.mjs`: local file adapter using `<video>`
- `adapters/VlcHttpAdapter.mjs`: VLC HTTP adapter skeleton (placeholder image + polling scaffold)

`src/index.mjs`: exports everything

## How to integrate (high-level)

1) Add these files into your repo (recommend: `player-generic/` or merge into your existing `src/`).
2) Update your existing playlist logic so a `Track` has `source.kind`:
   - YouTube: `{ source: { kind: "youtube", videoId } }`
   - Local file: `{ source: { kind: "file", url } }`
   - VLC: `{ source: { kind: "vlc", input } }`

3) Create a PlayerHost with adapters:

   ```js
   import { PlayerHost } from "./player-generic/src/PlayerHost.mjs";
   import { YouTubeAdapter } from "./player-generic/src/adapters/YouTubeAdapter.mjs";
   import { HtmlVideoAdapter } from "./player-generic/src/adapters/HtmlVideoAdapter.mjs";
   import { VlcHttpAdapter } from "./player-generic/src/adapters/VlcHttpAdapter.mjs";

   const host = new PlayerHost([
     new YouTubeAdapter({ controls: 0, autoplay: false, elementId: null }),
     new HtmlVideoAdapter(),
     new VlcHttpAdapter({ baseUrl: "http://127.0.0.1:8080", password: "your-vlc-pass" }),
   ]);

   host.mount(document.getElementById("videoPane")); // a div in your UI layout
   ```

4) Update your "video pane" renderer:
   - If `host.getMediaPane().kind === "iframe"` or `"video"`, ensure the adapter has mounted its element into the pane.
   - If `kind === "image"`, show an `<img src="imageUrl">` and maybe `title/subtitle`.

5) Wire events once:
   ```js
   host.on("state", (s) => renderState(s));
   host.on("time", (t) => renderTime(t));
   host.on("ended", () => queueNext());
   host.on("error", (e) => console.error(e));
   ```

## What you should update in your existing app

- Replace direct usage of your old `YTController` from UI code with `PlayerHost`.
- Keep queue/playlist selection logic outside adapters.
- UI controls should consult capabilities:
  - `host.getCapabilities().canSeek` etc, to enable/disable controls.

## VLC adapter notes (you must finish these parts)

`VlcHttpAdapter.mjs` is a scaffold:
- Confirm the correct VLC endpoints/params for your VLC build.
- Map VLC volume scale to 0..1 properly.
- Implement mute and (optional) rate properly.
- Parse `/requests/status.json` response fields to set:
  - positionMs/durationMs
  - playing/paused/stopped state

The placeholder image requirement is already implemented via `getMediaPane()`.

## Why this structure

- Avoids leaking backend specifics into UI code.
- Handles “external video” (VLC) cleanly by making the media pane a *render hint*.
- Keeps your current YouTube logic intact, but wrapped in an adapter.

