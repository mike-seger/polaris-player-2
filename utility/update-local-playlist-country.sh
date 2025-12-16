#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  utility/update-local-playlist-country.sh [--json <path>] [--tsv <path>] [--out <path>] [--playlist-key <key>] [--no-backup]

Defaults:
  --json         public/local-playlist.json
  --tsv          data/country-artist-iso3.tsv
  --playlist-key user:1b3f8510-29cf-433b-9d9e-830810028645

Behavior:
  - Removes item attributes: channelTitle, position (for all playlists)
  - For items in the specified playlist key: adds "country" (iso3) when a TSV artist matches
    the item's userTitle as a case-insensitive substring.
  - If --out is omitted, writes in-place to --json (creates a timestamped .bak copy unless --no-backup)

EOF
}

root_dir() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
}

ROOT="$(root_dir)"
JSON_PATH="$ROOT/public/local-playlist.json"
TSV_PATH="$ROOT/data/country-artist-iso3.tsv"
OUT_PATH=""
PLAYLIST_KEY="user:1b3f8510-29cf-433b-9d9e-830810028645"
NO_BACKUP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --json)
      JSON_PATH="$2"; shift 2
      ;;
    --tsv)
      TSV_PATH="$2"; shift 2
      ;;
    --out)
      OUT_PATH="$2"; shift 2
      ;;
    --playlist-key)
      PLAYLIST_KEY="$2"; shift 2
      ;;
    --no-backup)
      NO_BACKUP=1; shift 1
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required but was not found in PATH." >&2
  exit 1
fi

if [[ ! -f "$JSON_PATH" ]]; then
  echo "JSON file not found: $JSON_PATH" >&2
  exit 1
fi

if [[ ! -f "$TSV_PATH" ]]; then
  echo "TSV file not found: $TSV_PATH" >&2
  exit 1
fi

if [[ -z "$OUT_PATH" ]]; then
  OUT_PATH="$JSON_PATH"
fi

tmp_out="${OUT_PATH}.tmp.$(date +%s)"

# Create a backup if writing in-place.
if [[ "$OUT_PATH" == "$JSON_PATH" && "$NO_BACKUP" -eq 0 ]]; then
  bak="${JSON_PATH}.bak.$(date +%Y%m%d%H%M%S)"
  cp -p "$JSON_PATH" "$bak"
  echo "Backup: $bak" >&2
fi

jq \
  --rawfile tsv "$TSV_PATH" \
  --arg playlistKey "$PLAYLIST_KEY" \
  '
  def norm: ascii_downcase;

  def parseArtists($raw):
    $raw
    | gsub("\r"; "")
    | split("\n")
    | map(select(length > 0))
    | (if length > 0 then .[1:] else [] end) # drop header
    | map(split("\t"))
    | map({artist: (.[0] // ""), iso3: (.[1] // "")})
    | map(select(.artist != "" and .iso3 != "" and (.iso3 | length) > 0));

  def bestIso3($title; $artists):
    ($title // "") as $t
    | ($t | norm) as $tl
    | reduce $artists[] as $a (
        {len: 0, iso3: ""};
        ($a.artist | norm) as $al
        | if ($al != "" and ($tl | contains($al)) and ($a.iso3 | length) > 0 and ($al | length) > .len)
          then {len: ($al | length), iso3: $a.iso3}
          else .
          end
      )
    | .iso3;

  def cleanItem:
    del(.channelTitle, .position);

  ($tsv | parseArtists(.)) as $artists
  | with_entries(
      .value |= (
        if (.items | type) == "array" then
          .items |= map(cleanItem)
        else
          .
        end
      )
    )
  | if (has($playlistKey) and (.[$playlistKey].items | type) == "array") then
      .[$playlistKey].items |= map(
        cleanItem
        | ((.userTitle // .title // "") as $ut
           | (bestIso3($ut; $artists) as $c
              | if ($c | length) > 0 then .country = $c else . end))
      )
    else
      .
    end
  ' \
  "$JSON_PATH" > "$tmp_out"

mv "$tmp_out" "$OUT_PATH"

echo "Wrote: $OUT_PATH" >&2
