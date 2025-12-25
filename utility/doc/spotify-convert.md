# Links to Spotify managment tools

## export spotify playlist to CSV
https://exportify.net/

## create a spotify playlist from a JSON playlist
python3 utility/create-spotify-playlist.py --json public/local-playlist.json --path \
    user__wave_alternatives.items --redirect-uri http://127.0.0.1:8000/ \
    --no-open-browser --copy-auth-url

## enrich playlist json with ISRC
python3 utility/enrich_spotify_isrc.py \
  --json public/local-playlist.json \
  --max-wait-seconds 30 \
  --throttle-ms 1000 \
  > public/local-playlist.isrc.json
