#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

INPUT_FONT="MaterialIconsRound-Regular.otf"

# Turn newline-separated glyph names into comma-separated list
GLYPHS=$(cat ../public/used-symbols.txt | grep -v '^#' | cut -f2 | paste -sd, -)

echo $GLYPHS
for FLAVOR in woff woff2; do
  pyftsubset "$INPUT_FONT" \
    --glyphs="$GLYPHS" \
    --no-hinting \
    --flavor="$FLAVOR" \
    --output-file="../public/player.$FLAVOR"

  echo "✔ created ../public/player.$FLAVOR (glyphs: $GLYPHS)"
done

