# Polaris Player 2

This is a web audio player supporting playlists.
Currently it supports playing Youtube Audio/Video playlists.

For its full functionality, it requires the provided server application and an API
key.

It does support running serverless, but currently only with a static YT
playlist.  

## build instructions for mac OS
```
brew install node
npm install

cp .env.example .env

# in .env
YT_API_KEY=YOUR_API_KEY_HERE
PORT=33001

npm start

# Or use auto-reload during development
npm run dev

```

## start a plain file server
```
python3 utility/no_cache_server.py --port 8080 --directory public --bind 127.0.0.1
```

## offline spectrum cache (winamp-style)

The UI can display a tiny spectrum bar graph (between the transport buttons and the A↕Z icon). Because browser audio access to YouTube is restricted, this spectrum is generated **offline** and cached per `videoId`.

- Cache location: `public/spectrum-cache/<videoId>.spc32`
- Default resolution: 16 bins @ 20fps (bytes 0–255)

Generate a cache file for a YouTube video id:

```zsh
cd utility
npm install
npx yt-spectrum-cache --videoId=VIDEO_ID
```

Notes:
- If a `videoId` starts with `-`, use the equals form: `--videoId=-abc`.
- The generator **skips** work when `public/spectrum-cache/<videoId>.spc32` already exists. Use `--force` to regenerate.

Example: generate caches for many ids (safe for whitespace/CRLF):

```zsh
cd utility

# Extract ids, strip CRLF, and generate missing caches
jq -r '.. | objects | .videoId? // empty' ../data/yt-playlist.json \
	| tr -d '\r' \
	| while IFS= read -r id; do
			[[ -z "$id" ]] && continue
			npx yt-spectrum-cache --videoId="$id" --outDir ../public/spectrum-cache
		done
```

Requires `yt-dlp` and `ffmpeg` on your PATH.

You can also analyze a local audio file instead of downloading:

```zsh
cd utility
npx yt-spectrum-cache --videoId=VIDEO_ID --source /path/to/audio-file.mp3
```

Other example
```
npx yt-spectrum-cache --videoId=3lNq3MfH_h0 --outDir ../public/spectrum-cache

# Regenerate even if the cache already exists
npx yt-spectrum-cache --videoId=3lNq3MfH_h0 --outDir ../public/spectrum-cache --force
```


