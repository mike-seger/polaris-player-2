#!/usr/bin/env bash
set -euo pipefail

# local-pl-2-m3u.sh
#
# Usage:
#   ./local-pl-2-m3u.sh <json_file> <jq_path>
#
# Example:
#   ./local-pl-2-m3u.sh yt-playlist.json '.items'
#   ./local-pl-2-m3u.sh local-playlist.json '."user:...".items'
#
# The jq_path should point to either:
#   - an array of objects, or
#   - a stream of objects
#
# Each object should contain at least: videoId
# Optional: userTitle (preferred for filename), title (fallback)

cd "$(dirname "$0")"

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <json_file> <jq_path>" >&2
  exit 2
fi

JSON_FILE="$1"
JQ_PATH="$2"

if [[ ! -f "$JSON_FILE" ]]; then
  echo "Error: JSON file not found: $JSON_FILE" >&2
  exit 1
else
  LOCAL_JSON_FILE=$(basename "$JSON_FILE")
  if [[ "$LOCAL_JSON_FILE" != "$JSON_FILE" || ! -f "$LOCAL_JSON_FILE" ]]; then
    cp "$JSON_FILE" "$LOCAL_JSON_FILE"
  fi
fi

command -v jq >/dev/null || { echo "Missing dependency: jq" >&2; exit 1; }
command -v yt-dlp >/dev/null || { echo "Missing dependency: yt-dlp" >&2; exit 1; }

BASE_DIR="plex-downloads"
AUDIO_DIR="${BASE_DIR}/audio"
VIDEO_DIR="${BASE_DIR}/video"
STATE_DIR="${BASE_DIR}/state"

mkdir -p "$AUDIO_DIR" "$VIDEO_DIR" "$STATE_DIR"

AUDIO_ARCHIVE="${STATE_DIR}/archive-audio.txt"
VIDEO_ARCHIVE="${STATE_DIR}/archive-video.txt"

AUDIO_M3U="${BASE_DIR}/audio.m3u"
VIDEO_M3U="${BASE_DIR}/video.m3u"

# ---- helpers ----

# Very conservative filename sanitizer (works fine on Linux + avoids Plex weirdness):
# - strips control chars
# - replaces path separators and other troublesome chars with '_'
# - trims whitespace
# - collapses repeated underscores
sanitize_filename() {
  # stdin -> sanitized string
  jq -Rr '
    gsub("[\\u0000-\\u001F\\u007F]";"") |
    gsub("[/\\\\:*?\"<>|]";"_") |
    gsub("[[:space:]]+";" ") |
    gsub("^ +| +$";"") |
    gsub("_+";"_")
  '
}

# Extract objects from JSON:
# - Evaluate $JQ_PATH
# - If it's an array, expand to .[]
# - If it's already a stream/object, pass through
json_objects_stream() {
  jq -c "$JQ_PATH
    | (if type == \"array\" then .[] else . end)
    | select(type == \"object\")
  " "$JSON_FILE"
}

# ---- yt-dlp settings ----
# Audio choice: bestaudio, remux/convert to m4a for broad Plex support.
# Video choice: bestvideo+bestaudio, merged to mkv (safe container, keeps best streams).
#
# Resume/skip:
#   -c / --continue resumes partial .part downloads
#   --download-archive prevents re-downloading already completed items
#   --no-overwrites avoids clobbering existing complete files
#
# Robustness:
#   --fragment-retries, --retries help with flaky connections
#   --concurrent-fragments speeds things up on a powerful server
#
# NOTE:
#   If you want to force Plex-friendly H.264/AAC MP4 (at the cost of re-encode),
#   that’s a different pipeline (ffmpeg transcode). This script keeps "best"
#   and relies on Plex server/client to direct-play or transcode as needed.

YT_COMMON=(
  --ignore-errors
  --no-overwrites
  --continue
  --retries 20
  --fragment-retries 20
  --concurrent-fragments 8
  --no-progress
  --progress
)

download_audio() {
  local url="$1"
  local outbase="$2"

  yt-dlp "${YT_COMMON[@]}" \
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

  yt-dlp "${YT_COMMON[@]}" \
    --download-archive "$VIDEO_ARCHIVE" \
    -f "bestvideo*+bestaudio/best" \
    --merge-output-format mkv \
    --paths "$VIDEO_DIR" \
    -o "${outbase}.%(ext)s" \
    "$url"
}

# ---- main loop ----

echo "Reading items from: $JSON_FILE  (jq: $JQ_PATH)" >&2
count=0
skipped=0

json_objects_stream | while IFS= read -r obj; do
  videoId="$(jq -r '.videoId // empty' <<<"$obj")"
  if [[ -z "$videoId" ]]; then
    ((skipped++)) || true
    continue
  fi

  # Prefer userTitle; fallback to title; final fallback to videoId
  name="$(jq -r '.userTitle // .title // .videoId // "untitled"' <<<"$obj")"
  safe_name="$(printf '%s' "$name" | sanitize_filename)"

  # If sanitization results in empty, use videoId
  if [[ -z "$safe_name" ]]; then
    safe_name="$videoId"
  fi

  url="https://www.youtube.com/watch?v=${videoId}"

  echo "[$((++count))] $videoId  ->  $safe_name" >&2

  # Download audio and video (each independently resumable and archive-tracked)
  download_audio "$url" "$safe_name"
  download_video "$url" "$safe_name"
done

# ---- playlists ----
# Simple M3U: one file path per line (relative paths help when moving the folder).
# Plex can usually import/scan media regardless, but M3U can be handy in some clients.

make_m3u() {
  local dir="$1"
  local out="$2"
  local prefix="$3"  # e.g. "audio/" or "video/"

  {
    echo "#EXTM3U"
    # Sort deterministically; exclude partials
    find "$dir" -maxdepth 1 -type f \
      ! -name "*.part" ! -name "*.ytdl" \
      -printf "%f\n" \
    | LC_ALL=C sort \
    | while IFS= read -r f; do
        printf '%s%s\n' "$prefix" "$f"
      done
  } > "$out"
}

make_m3u "$AUDIO_DIR" "$AUDIO_M3U" "audio/"
make_m3u "$VIDEO_DIR" "$VIDEO_M3U" "video/"

echo "Done." >&2
echo "Audio files: $AUDIO_DIR" >&2
echo "Video files: $VIDEO_DIR" >&2
echo "Audio playlist: $AUDIO_M3U" >&2
echo "Video playlist: $VIDEO_M3U" >&2
