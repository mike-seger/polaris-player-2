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

# Or, if you already have a TSV with `videoId` in column 1:
npx yt-spectrum-cache --tsv ../data/videoIds.tsv --outDir ../public/spectrum-cache
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

## bulk insert/update titles from TSV

If you maintain a list of title overrides/additions as a TSV file (one line per track):

- Format: `videoId<TAB>userTitle`
- Example: `data/add.tsv`, `data/delete.tsv`

You can insert/update all tracks from the TSV into a playlist inside `public/local-playlist.json`, placing them in the alphabetically correct position (A-Z by `userTitle/title`) and re-numbering `position`:

```zsh
cd utility

# Dry-run first
node ./create-playlist.mjs insert-tsv \
	--playlist ../public/local-playlist.json \
	--playlistId PL_50zHBR2OufB7T5fHLrhviM0-s_3g4pA \
	--tsv ../data/add.tsv \
	--dry-run

# Apply changes
node ./create-playlist.mjs insert-tsv \
	--playlist ../public/local-playlist.json \
	--playlistId PL_50zHBR2OufB7T5fHLrhviM0-s_3g4pA \
	--tsv ../data/add.tsv
```

To delete tracks listed in a TSV (title column is ignored):

```zsh
cd utility

# Dry-run first
node ./create-playlist.mjs delete-tsv \
	--playlist ../public/local-playlist.json \
	--playlistId PL_50zHBR2OufB7T5fHLrhviM0-s_3g4pA \
	--tsv ../data/delete.tsv \
	--dry-run

# Apply changes
node ./create-playlist.mjs delete-tsv \
	--playlist ../public/local-playlist.json \
	--playlistId PL_50zHBR2OufB7T5fHLrhviM0-s_3g4pA \
	--tsv ../data/delete.tsv
```

To delete from the real YouTube playlist (uses YouTube Data API quota):

```zsh
cd utility

# Always start with a dry-run so you can inspect what will be deleted
node ./create-playlist.mjs youtube-delete-tsv \
	--playlistId PL_50zHBR2OufB7T5fHLrhviM0-s_3g4pA \
	--tsv ../data/delete.tsv \
	--dry-run

# Then do a small limited run (optional) to reduce risk/quota impact
node ./create-playlist.mjs youtube-delete-tsv \
	--playlistId PL_50zHBR2OufB7T5fHLrhviM0-s_3g4pA \
	--tsv ../data/delete.tsv \
	--limit 10 \
	--sleepMs 500
```


# Sorting csv, tsv

```
mlr --tsv sort -c title then uniq -g yt_video_id,title yt-darkwave,coldwave.tsv
```
