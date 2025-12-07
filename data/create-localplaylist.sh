#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

PLAYLIST_FILE="yt-playlist.json"
OVERRIDES_FILE="overrides-by-id.json"
OUTPUT_DIR="../localcache"
OUTPUT_FILE="$OUTPUT_DIR/local-playlist.json"

if [[ ! -f $PLAYLIST_FILE ]]; then
  echo "Error: $PLAYLIST_FILE not found" >&2
  exit 1
fi

if [[ ! -f $OVERRIDES_FILE ]]; then
  echo "Error: $OVERRIDES_FILE not found" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

NOW="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

jq \
  --slurpfile playlist "$PLAYLIST_FILE" \
  --slurpfile overrides "$OVERRIDES_FILE" \
  --arg now "$NOW" \
  -n '
    def apply_override($ov):
      . as $item
      | ($ov[$item.videoId].title // null) as $override
      | if $override != null and $override != $item.title then
          .userTitle = $override
        else
          del(.userTitle)
        end;

    ($playlist[0] // {}) as $pl
    | ($overrides[0].overrides // {}) as $ov
    | ($pl.playlistId // empty) as $id
    | if ($id | length) == 0 then
        error("playlistId missing in yt-playlist.json")
      else . end
    | ($pl.items // []) as $rawItems
    | {
        ($id): {
          playlistId: $id,
          fetchedAt: ($pl.fetchedAt // $now),
          title: ($pl.title // $pl.playlistTitle // ("Local playlist (" + $id + ")")),
          items: ($rawItems | sort_by(.position) | map(apply_override($ov)))
        }
      }
  ' > "$OUTPUT_FILE"

echo "Wrote $OUTPUT_FILE"
