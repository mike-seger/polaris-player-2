#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

INPUT_FONT="MaterialIconsRound-Regular.otf"
#INPUT_FONT="MaterialIcons-Regular.ttf"
UNICODES=$(cat ../public/used-symbols.txt | grep -v '^#' | cut -f1| grep -v '^#'  | paste -sd, -)   # your U+E0xx list, one per line

# TTF subset (debug / inspection)
pyftsubset "$INPUT_FONT" \
  --unicodes="$UNICODES" \
  --no-hinting \
  --output-file="../public/player.ttf"

# WOFF
pyftsubset "$INPUT_FONT" \
  --unicodes="$UNICODES" \
  --no-hinting \
  --flavor=woff \
  --output-file="../public/player.woff"

# WOFF2
pyftsubset "$INPUT_FONT" \
  --unicodes="$UNICODES" \
  --no-hinting \
  --flavor=woff2 \
  --output-file="../public/player.woff2"
