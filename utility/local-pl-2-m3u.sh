#!/usr/bin/env bash
set -euo pipefail

# local-pl-2-m3u.sh
#
# Usage:
#   ./local-pl-2-m3u.sh <json_file> <jq_path>
#
# Example:
#   ./local-pl-2-m3u.sh local-playlist.json '.user__wave_alternatives.items[]'
#   ./local-pl-2-m3u.sh yt-playlist.json '.items'

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <json_file> <jq_path>" >&2
  exit 2
fi

JSON_FILE="$1"
JQ_PATH="$2"

command -v jq >/dev/null || { echo "Missing dependency: jq" >&2; exit 1; }
command -v yt-dlp >/dev/null || { echo "Missing dependency: yt-dlp" >&2; exit 1; }
command -v python3 >/dev/null || { echo "Missing dependency: python3" >&2; exit 1; }

BASE_DIR="plex-downloads"
AUDIO_DIR="${BASE_DIR}/audio"
VIDEO_DIR="${BASE_DIR}/video"
STATE_DIR="${BASE_DIR}/state"
mkdir -p "$AUDIO_DIR" "$VIDEO_DIR" "$STATE_DIR"

AUDIO_ARCHIVE="${STATE_DIR}/archive-audio.txt"
VIDEO_ARCHIVE="${STATE_DIR}/archive-video.txt"
AUDIO_M3U="${BASE_DIR}/audio.m3u"
VIDEO_M3U="${BASE_DIR}/video.m3u"

# ---- JS runtime / EJS (fixes the "No supported JavaScript runtime" warning) ----
# yt-dlp now relies on an external JS runtime for YouTube deciphering. :contentReference[oaicite:5]{index=5}
JS_ARGS=()
if command -v deno >/dev/null; then
  # For deno/bun, enable remote EJS components from npm. :contentReference[oaicite:6]{index=6}
  JS_ARGS+=( --js-runtimes deno --remote-components ejs:npm )
elif command -v bun >/dev/null; then
  JS_ARGS+=( --js-runtimes bun --remote-components ejs:npm )
elif command -v node >/dev/null; then
  JS_ARGS+=( --js-runtimes node )
elif command -v quickjs >/dev/null; then
  JS_ARGS+=( --js-runtimes quickjs )
elif command -v qjs >/dev/null; then
  JS_ARGS+=( --js-runtimes qjs )
else
  echo "WARNING: No JS runtime found (deno/node/bun/quickjs). YouTube extraction may be degraded." >&2
fi

# ---- Extractor args to reduce SABR/web_safari noise (not always avoidable) ----
# SABR warnings are tied to YouTube removing URLs for some clients. :contentReference[oaicite:7]{index=7}
# This commonly helps: avoid the web_safari client.
EXTRACTOR_ARGS=( --extractor-args "youtube:player_client=default,-web_safari" )

# ---- helpers ----

json_objects_stream() {
  # Accept both array paths and direct stream paths
  jq -c "$JQ_PATH
    | (if type == \"array\" then .[] else . end)
    | select(type == \"object\")
  " "$JSON_FILE"
}

pick_display_name() {
  # Prefer userTitle only if it's actually meaningful; else fallback to title/videoId
  # This avoids cases where userTitle is "-" or similarly useless.
  local obj="$1"
  jq -r '
    def clean(s):
      (s // "") | tostring
      | gsub("[\\u0000-\\u001F\\u007F]";"")
      | gsub("[[:space:]]+";" ")
      | gsub("^ +| +$";"");

    def meaningful(s):
      # remove spaces and common punctuation; require length >= 2
      (clean(s) | gsub("[[:space:][:punct:]]+";"") | length) >= 2;

    . as $o
    | (clean($o.userTitle) as $u
      | if meaningful($u) and $u != "-" then $u
        else clean($o.title) end
      ) as $n
    | if meaningful($n) then $n else ($o.videoId // "untitled") end
  ' <<<"$obj"
}

sanitize_filename() {
  # Keep Unicode letters/digits; normalize whitespace; remove path separators and shell-trouble chars
  python3 - "$1" <<'PY'
import re, sys
s = sys.argv[1]

# strip control chars
s = re.sub(r'[\x00-\x1f\x7f]', '', s)

# replace path separators & other problematic chars
s = re.sub(r'[\\/:"*?<>|]', '_', s)

# make quotes less annoying
s = s.replace("'", "’").replace('"', "”")

# collapse whitespace
s = re.sub(r'\s+', ' ', s).strip()

# avoid empty or dot-only filenames
s = re.sub(r'^[. ]+|[. ]+$', '', s)

# avoid leading dash (some tools treat it like an option in edge cases)
if s.startswith('-'):
  s = '_' + s.lstrip('-').lstrip()

# final fallback
if not s:
  s = "untitled"

print(s)
PY
}

# ---- yt-dlp settings ----
YT_COMMON=(
  --ignore-errors
  --no-overwrites
  --continue
  --retries 20
  --fragment-retries 20
  --concurrent-fragments 8
  --progress
)

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
    -f "bestvideo*+bestaudio/best" \
    --merge-output-format mkv \
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

# ---- main ----
echo "Reading items from: $JSON_FILE  (jq: $JQ_PATH)" >&2

count=0
json_objects_stream | while IFS= read -r obj; do
  videoId="$(jq -r '.videoId // empty' <<<"$obj")"
  [[ -n "$videoId" ]] || continue

  raw_name="$(pick_display_name "$obj")"
  safe_name="$(sanitize_filename "$raw_name")"

  url="https://www.youtube.com/watch?v=${videoId}"

  ((count++)) || true
  echo "[$count] $videoId  ->  $safe_name" >&2

  download_audio "$url" "$safe_name"
  download_video "$url" "$safe_name"
done

make_m3u "$AUDIO_DIR" "$AUDIO_M3U" "audio/"
make_m3u "$VIDEO_DIR" "$VIDEO_M3U" "video/"

echo "Done." >&2
echo "Audio playlist: $AUDIO_M3U" >&2
echo "Video playlist: $VIDEO_M3U" >&2
