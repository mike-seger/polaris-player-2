cd $(dirname "$0")

jq -r '."user:1b3f8510-29cf-433b-9d9e-830810028645".items[].title'  ../public/local-playlist.json |\
  python3 enrich_artists_with_iso.py - --no-header \
    --cache-json mb-cache.json \
    --progress-every 10 \
    --flush-every 1