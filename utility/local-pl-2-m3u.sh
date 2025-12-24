#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <json_file> <jq_path>" >&2
  exit 2
fi

JSON_FILE="$1"
JQ_PATH="$2"

command -v jq >/dev/null || { echo "Missing dependency: jq" >&2; exit 1; }
command -v yt-dlp >/dev/null || { echo "Missing dependency: yt-dlp" >&2; exit 1; }
command -v python3 >/dev/null || { echo "Missing dependency: python3" >&2; exit 1; }

BASE_DIR="yt-downloads"   # <-- your change
AUDIO_DIR="${BASE_DIR}/audio"
VIDEO_DIR="${BASE_DIR}/video"
STATE_DIR="${BASE_DIR}/state"
mkdir -p "$AUDIO_DIR" "$VIDEO_DIR" "$STATE_DIR"

AUDIO_ARCHIVE="${STATE_DIR}/archive-audio.txt"
VIDEO_ARCHIVE="${STATE_DIR}/archive-video.txt"
AUDIO_M3U="${BASE_DIR}/audio.m3u"
VIDEO_M3U="${BASE_DIR}/video.m3u"

# Precomputed ID lists for fast skip checks (avoid invoking yt-dlp if already archived)
AUDIO_ARCHIVE_IDS="${STATE_DIR}/archive-audio.ids"
VIDEO_ARCHIVE_IDS="${STATE_DIR}/archive-video.ids"

# ---- JS runtime / EJS (optional: reduces yt-dlp warnings) ----
JS_ARGS=()
if command -v deno >/dev/null; then
  JS_ARGS+=( --js-runtimes deno --remote-components ejs:npm )
elif command -v bun >/dev/null; then
  JS_ARGS+=( --js-runtimes bun --remote-components ejs:npm )
elif command -v node >/dev/null; then
  JS_ARGS+=( --js-runtimes node )
fi

EXTRACTOR_ARGS=( --extractor-args "youtube:player_client=tv,android,-web" )

#EXTRACTOR_ARGS=( --extractor-args "youtube:player_client=default,-web_safari" )

YT_COMMON=(
  --ignore-errors
  --no-overwrites
  --continue
  --retries 20
  --fragment-retries 50
  --retry-sleep "fragment:exp=1:60"
  --concurrent-fragments 2
  --sleep-requests 1
  --sleep-interval 1
  --max-sleep-interval 5
  --progress
  # Strongly recommended for YouTube reliability:
  --cookies-from-browser chrome
  --js-runtimes node
  --remote-components ejs:github
)



json_objects_stream() {
  jq -c "$JQ_PATH
    | (if type == \"array\" then .[] else . end)
    | select(type == \"object\")
  " "$JSON_FILE"
}

build_archive_ids() {
  local archive_file="$1"
  local out_ids_file="$2"

  if [[ -f "$archive_file" ]]; then
    # yt-dlp archive format is typically: "extractor videoId" per line.
    # Keep this tolerant: if there's only one field, treat it as the ID.
    awk 'NF { if (NF >= 2) print $2; else print $1 }' "$archive_file" \
      | LC_ALL=C sort -u > "$out_ids_file"
  else
    : > "$out_ids_file"
  fi
}

archive_has_id() {
  local ids_file="$1"
  local video_id="$2"
  [[ -s "$ids_file" ]] && grep -Fqx -- "$video_id" "$ids_file"
}

# Pick name: userTitle -> title -> videoId (trimmed, no heuristics)
pick_name() {
  local obj="$1"
  jq -r '
    def trim: gsub("^[[:space:]]+|[[:space:]]+$";"");
    (.userTitle // .title // .videoId // "untitled")
    | tostring
    | trim
    | if length > 0 then . else "untitled" end
  ' <<<"$obj"
}

# Sanitize while keeping Unicode (Cyrillic etc). Avoid leading '-'.
sanitize_filename() {
  python3 - "$1" <<'PY'
import re, sys
s = sys.argv[1]

s = re.sub(r'[\x00-\x1f\x7f]', '', s)                 # control chars
s = re.sub(r'[\\/:"*<>|]', '_', s)                    # path/bad chars
s = s.replace("'", "’").replace('"', "”")             # nicer quotes
s = re.sub(r'\s+', ' ', s).strip()                    # collapse spaces
s = re.sub(r'^[. ]+|[. ]+$', '', s)                   # trim dots/spaces

if s.startswith('-'):
  s = '_' + s.lstrip('-').lstrip()

if not s:
  s = "untitled"

print(s)
PY
}

download_audio() {
  local url="$1"
  local outbase="$2"
  yt-dlp "${YT_COMMON[@]}" "${JS_ARGS[@]}" "${EXTRACTOR_ARGS[@]}" \
    --download-archive "$AUDIO_ARCHIVE" \
    -f "bestaudio/best" \
    --extract-audio \
    --audio-format m4a \
    --audio-quality 0 \
    --paths "$AUDIO_DIR" \
    -o "${outbase}.%(ext)s" \
    "$url"
}

download_video() {
  local url="$1"
  local outbase="$2"
  yt-dlp "${YT_COMMON[@]}" "${JS_ARGS[@]}" "${EXTRACTOR_ARGS[@]}" \
    --download-archive "$VIDEO_ARCHIVE" \
    -f "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best" \
    --merge-output-format mp4 \
    --paths "$VIDEO_DIR" \
    -o "${outbase}.%(ext)s" \
    "$url"
}

make_m3u() {
  local dir="$1"
  local out="$2"
  local prefix="$3"
  {
    echo "#EXTM3U"
    find "$dir" -maxdepth 1 -type f \
      ! -name "*.part" ! -name "*.ytdl" \
      -printf "%f\n" \
      | LC_ALL=C sort \
      | while IFS= read -r f; do
          printf '%s%s\n' "$prefix" "$f"
        done
  } > "$out"
}

echo "Reading items from: $JSON_FILE  (jq: $JQ_PATH)" >&2

build_archive_ids "$AUDIO_ARCHIVE" "$AUDIO_ARCHIVE_IDS"
build_archive_ids "$VIDEO_ARCHIVE" "$VIDEO_ARCHIVE_IDS"

count=0
json_objects_stream | while IFS= read -r obj; do
  videoId="$(jq -r '.videoId // empty' <<<"$obj")"
  [[ -n "$videoId" ]] || continue

  audio_archived=false
  video_archived=false
  if archive_has_id "$AUDIO_ARCHIVE_IDS" "$videoId"; then
    audio_archived=true
  fi
  if archive_has_id "$VIDEO_ARCHIVE_IDS" "$videoId"; then
    video_archived=true
  fi

  ((count++)) || true
  if $audio_archived && $video_archived; then
    echo "[$count] $videoId  (skip: archived audio+video)" >&2
    continue
  fi

  raw_name="$(pick_name "$obj")"
  safe_name="$(sanitize_filename "$raw_name")"
  url="https://www.youtube.com/watch?v=${videoId}"
  echo "[$count] $videoId  ->  $safe_name" >&2

  if ! $audio_archived; then
    download_audio "$url" "$safe_name"
  else
    echo "  audio: skip (archived)" >&2
  fi

  if ! $video_archived; then
    download_video "$url" "$safe_name"
  else
    echo "  video: skip (archived)" >&2
  fi
done

make_m3u "$AUDIO_DIR" "$AUDIO_M3U" "audio/"
make_m3u "$VIDEO_DIR" "$VIDEO_M3U" "video/"

echo "Done." >&2
echo "Audio playlist: $AUDIO_M3U" >&2
echo "Video playlist: $VIDEO_M3U" >&2
