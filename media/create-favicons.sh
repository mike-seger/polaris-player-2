#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEFAULT_SRC="${ROOT_DIR}/media/playlist-app.png"
DEFAULT_DEST="${ROOT_DIR}/public"

SRC_IMAGE="${1:-$DEFAULT_SRC}"
DEST_DIR="${2:-$DEFAULT_DEST}"

if ! command -v magick >/dev/null 2>&1; then
  echo "Error: ImageMagick 'magick' command is required but not found in PATH." >&2
  exit 1
fi

if [[ ! -f "${SRC_IMAGE}" ]]; then
  echo "Error: source image not found: ${SRC_IMAGE}" >&2
  exit 1
fi

mkdir -p "${DEST_DIR}"

# Generate standard PNG favicon sizes
sizes=(
  "512:android-chrome-512x512.png"
  "192:android-chrome-192x192.png"
  "180:apple-touch-icon.png"
  "32:favicon-32x32.png"
  "16:favicon-16x16.png"
)

for entry in "${sizes[@]}"; do
  size="${entry%%:*}"
  name="${entry##*:}"
  magick "${SRC_IMAGE}" -resize "${size}x${size}" "${DEST_DIR}/${name}"
done

# Generate multi-resolution .ico file
magick "${SRC_IMAGE}" -define icon:auto-resize=16,24,32,48,64,128,256 "${DEST_DIR}/favicon.ico"

echo "Favicons generated in ${DEST_DIR}"