#!/bin/sh

# Download YouTube thumbnails referenced by a Polaris playlist JSON.
#
# Naming:
# - If a videoId occurs once:   thumbnail/vid_<videoId>.jpg
# - If a videoId occurs >1x:    thumbnail/vid_<videoId>-001.jpg, -002.jpg, ... (occurrence order)

usage() {
  echo "$1" >&2
  echo "Usage: $0 <playlist file>" >&2
  exit 1
}

playlist="$1"
[ -z "$playlist" ] || [ ! -f "$playlist" ] && usage "Playlist '$playlist' does not exist"

command -v jq >/dev/null 2>&1 || usage "Missing dependency: jq"

# Prefer wget, fall back to curl.
DOWNLOADER=""
if command -v wget >/dev/null 2>&1; then
  DOWNLOADER="wget"
elif command -v curl >/dev/null 2>&1; then
  DOWNLOADER="curl"
else
  usage "Missing dependency: wget or curl"
fi

mkdir -p thumbnail || exit 1

mkdir -p thumbnail || exit 1

tmpfile="$(mktemp -t polaris-thumbs.XXXXXX)" || exit 1
trap 'rm -f "$tmpfile"' EXIT INT TERM

# Extract all (videoId, thumbnailUrl) pairs in playlist order.
jq -r '.items[] | select(.videoId? and .thumbnail?) | "\(.videoId)\t\(.thumbnail)"' "$playlist" > "$tmpfile"

# Build the output filename(s) in a POSIX-friendly way using awk's associative arrays.
# Output columns:
#   outPath<TAB>url<TAB>videoId
awk -F '\t' '
  {
    ids[$1] += 1
    vid[NR] = $1
    url[NR] = $2
  }
  END {
    for (i = 1; i <= NR; i += 1) {
      id = vid[i]
      u = url[i]
      seen[id] += 1
      n = seen[id]
      t = ids[id]
      if (t > 1) {
        suffix = sprintf("%03d", n)
        out = "thumbnail/vid_" id "-" suffix ".jpg"
      } else {
        out = "thumbnail/vid_" id ".jpg"
      }
      print out "\t" u "\t" id
    }
  }
' "$tmpfile" | while IFS="$(printf '\t')" read -r out url id; do
  [ -z "$id" ] && continue
  [ -z "$url" ] && continue

  printf "%s   \r" "$id"

  if [ -f "$out" ]; then
    continue
  fi

  if [ "$DOWNLOADER" = "wget" ]; then
    wget -nv -O "$out" "$url"
  else
    curl -L -sS -o "$out" "$url"
  fi
done

echo
