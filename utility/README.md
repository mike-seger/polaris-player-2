# Polaris Player Utilities

This folder hosts Node.js helpers that integrate with YouTube. The current focus is a command line tool that recreates a playlist in your own YouTube account based on an exported `yt-playlist.json` file.

## Prerequisites

1. **Node.js 18+** (the script relies on native fetch and top-level async/await).
2. **Google Cloud credentials** (OAuth 2.0) scoped for the YouTube Data API v3.

### Creating the Google credentials

1. Browse to <https://console.cloud.google.com/> and sign in.
2. Create a new project (or reuse an existing one) dedicated to this tool.
3. In the left navigation open **APIs & Services → Library** and enable **YouTube Data API v3** for the project.
4. Still under **APIs & Services**, open **OAuth consent screen**:
   - Choose **External** user type.
   - Fill in the required fields (app name, support email, developer contact).
   - Under **Scopes**, add `.../auth/youtube` (the standard YouTube scope) or the more restrictive `.../auth/youtube.force-ssl`.
   - Add your Google account under **Test users** and save/publish.
5. Navigate to **Credentials → Create credentials → OAuth client ID**.
   - Application type: **Desktop app**.
   - Give it a name (e.g., `yt-playlist-import-cli`).
   - After creation, copy the **Client ID** and **Client Secret**. You can download the JSON if you prefer, but the env vars below are all the CLI needs.

### Environment variables

Surface the credentials to the CLI before running it (for example by putting them in the repo root `.env`):

```bash
export GOOGLE_CLIENT_ID="<your-client-id>"
export GOOGLE_CLIENT_SECRET="<your-client-secret>"
export GOOGLE_REDIRECT_URI="http://localhost:53682/oauth2callback"  # optional; matches the default in code
```

On first execution, the CLI opens a browser (or prints a URL) so you can authorize access to your YouTube account. Tokens are cached in `utility/.oauth-token.json`.

## Installation

From the `utility` directory:

```bash
npm install
```

## Usage

```bash
node utility/create-playlist.mjs --input /path/to/yt-playlist.json --title "My Recreated Playlist" [--privacy public|private|unlisted]
```

Alternatively, after `npm install -g` inside this folder, you can run `yt-playlist-import` globally.

### Arguments

- `--input` / `-i`: path to the exported playlist JSON (required).
- `--title` / `-t`: name for the new YouTube playlist (required).
- `--privacy` / `-p`: playlist visibility (`private`, `public`, or `unlisted`, default `private`).
- `--no-sort`: disable alphabetical sorting by `userTitle`; the JSON order will be preserved.
- `--transliterate-sort`: when sorting, transliterate Cyrillic to Latin so mixed-script titles sort more naturally.
- `--dry-run`: print the actions that would be taken without calling the YouTube API.
- `--token-path`: override where OAuth tokens are cached (default `utility/.oauth-token.json`).
- `--replace`: delete any of your existing playlists with the same title before creating the new one.
- `--append`: append to an existing playlist with the same title instead of creating a new one. The script loads the current playlist first and skips any videos that are already present. Cannot be combined with `--replace`.

### Output

On success the script prints:

```
Created playlist: https://www.youtube.com/playlist?list=PLAYLIST_ID
```

If any item cannot be added (e.g., unavailable video), the script logs the failure and moves on. A summary is provided at the end.

## Token storage

OAuth tokens are stored locally at `utility/.oauth-token.json`. Delete this file to force re-authentication.

---

## Creating a Spotify playlist from `local-playlist.json`

This repo can enrich playlist items with Spotify track IDs (see `spotifyId` fields in `public/local-playlist.json`). The script `utility/create-spotify-playlist.py` creates a public Spotify playlist from those IDs.

### Prerequisites

1. Create a Spotify app in the Spotify Developer Dashboard.
2. Add a Redirect URI to the app settings. It must match **exactly** what you use on the CLI (host, port, and path — including trailing slashes; note: `localhost` and `127.0.0.1` are different):
   - `http://localhost:8888/callback` (default)
   - `http://127.0.0.1:8888/callback` (also fine, if you pass `--redirect-uri`)
3. Create `.spotify.env` in the repo root:

```bash
clientID="<your-spotify-client-id>"
```

### Usage

```bash
python3 utility/create-spotify-playlist.py \
   --json public/local-playlist.json \
   --path user__wave_alternatives.items
```

If you are copying the auth URL from a terminal and hit errors like “Illegal scope”, re-run with `--copy-auth-url` (macOS) to copy the exact URL to your clipboard.

By default it replaces any existing playlist with the same name (unfollows it) and creates a new public playlist using the JSON title. Progress is checkpointed in `utility/.spotify-playlist-checkpoint.json` so you can rerun to resume if you get rate-limited.

---

**Note:** YouTube API quotas apply. Creating a large playlist will consume quota for each inserted item.

## Checking video availability

The helper script `utility/check-availability.mjs` audits every cached playlist entry using the YouTube oEmbed endpoint plus watch-page parsing. By default it scans all videos across `cache/playlists*.json`, flagging the ones that are removed, region blocked, shorter than 30 seconds, or missing duration metadata.

To focus on specific videos without touching the whole cache, set the `CHECK_AVAILABLE_IDS` environment variable to a comma-separated list of video IDs:

```bash
CHECK_AVAILABLE_IDS=_Udpz6EIT8c node utility/check-availability.mjs
```

Multiple IDs are supported (`CHECK_AVAILABLE_IDS=abc123,def456`). The script will restrict its checks to those IDs, making iterative debugging faster.
