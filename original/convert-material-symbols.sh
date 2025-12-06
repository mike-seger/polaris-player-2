#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INPUT_FONT_DEFAULT="${SCRIPT_DIR}/MaterialSymbolsRounded[FILL,GRAD,opsz,wght].ttf"
NAMES_FILE_DEFAULT="${SCRIPT_DIR}/used-symbols-names.txt"
OUTPUT_DIR_DEFAULT="${SCRIPT_DIR}/../public"
PREVIEW_FILE_DEFAULT="${SCRIPT_DIR}/index.html"

FILL_VALUE="0"
GRAD_VALUE="0"
OPSZ_VALUE="24"
WGHT_VALUE="400"
INPUT_FONT="$INPUT_FONT_DEFAULT"
NAMES_FILE="$NAMES_FILE_DEFAULT"
OUTPUT_DIR="$OUTPUT_DIR_DEFAULT"
PREVIEW_FILE="$PREVIEW_FILE_DEFAULT"
PYFTSUBSET_BIN="${PYFTSUBSET_BIN:-pyftsubset}"
FONTTOOLS_BIN="${FONTTOOLS_BIN:-fonttools}"

usage() {
  cat <<'EOF'
Usage: ./convert-material-symbols.sh [options]

Subset the Material Symbols Rounded variable font using glyph names from
original/used-symbols-names.txt and emit player.woff2 into the public directory.

Options:
  --fill <value>        Set the FILL axis (default: 0)
  --grad <value>        Set the GRAD axis (default: 0)
  --opsz <value>        Set the opsz axis (default: 24)
  --wght <value>        Set the wght axis (default: 400)
  --font <path>         Override the source font file
  --names-file <path>   Override the glyph name list file
  --output-dir <path>   Override the output directory
  --preview-file <path> Override the generated preview HTML file
  --help                Show this help and exit

Example:
  ./convert-material-symbols.sh --fill 0 --grad 0 --opsz 24 --wght 400
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fill)
      FILL_VALUE="$2"
      shift 2
      ;;
    --grad)
      GRAD_VALUE="$2"
      shift 2
      ;;
    --opsz)
      OPSZ_VALUE="$2"
      shift 2
      ;;
    --wght|--weight)
      WGHT_VALUE="$2"
      shift 2
      ;;
    --font)
      INPUT_FONT="$2"
      shift 2
      ;;
    --names-file)
      NAMES_FILE="$2"
      shift 2
      ;;
    --output-dir)
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --preview-file)
      PREVIEW_FILE="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! command -v "$PYFTSUBSET_BIN" >/dev/null 2>&1; then
  echo "Error: pyftsubset is required but not found in PATH." >&2
  exit 1
fi

if ! command -v "$FONTTOOLS_BIN" >/dev/null 2>&1; then
  echo "Error: fonttools CLI is required but not found in PATH." >&2
  exit 1
fi

if [[ ! -f "$INPUT_FONT" ]]; then
  echo "Error: input font not found at $INPUT_FONT" >&2
  exit 1
fi

if [[ ! -f "$NAMES_FILE" ]]; then
  echo "Error: glyph names file not found at $NAMES_FILE" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

mapfile -t ICON_NAMES < <(grep -v '^#' "$NAMES_FILE" | awk 'NF' | awk '!seen[$0]++')

if [[ ${#ICON_NAMES[@]} -eq 0 ]]; then
  echo "Error: no glyph names discovered in $NAMES_FILE" >&2
  exit 1
fi

GLYPH_LIST=$(printf '%s\n' "${ICON_NAMES[@]}" | paste -sd, -)
ICON_NAME_TEXT=$(printf '%s ' "${ICON_NAMES[@]}" | sed 's/ $//')
TEXT_ASCII=" _abcdefghijklmnopqrstuvwxyz0123456789"
TEXT_PAYLOAD="${ICON_NAME_TEXT}${TEXT_ASCII}"

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

INSTANCE_FONT="$TEMP_DIR/material-symbols-instance.ttf"

"$FONTTOOLS_BIN" varLib.instancer "$INPUT_FONT" \
  "FILL=${FILL_VALUE}" \
  "GRAD=${GRAD_VALUE}" \
  "opsz=${OPSZ_VALUE}" \
  "wght=${WGHT_VALUE}" \
  --static \
  --output "$INSTANCE_FONT"

subset_font() {
  local flavor="$1"
  local output_file="$2"
  local args=("$INSTANCE_FONT" \
    --glyphs="$GLYPH_LIST" \
    --no-hinting \
    --ignore-missing-glyphs \
    --no-layout-closure \
    --glyph-names \
    --text="$TEXT_PAYLOAD" \
    --output-file="$output_file")

  if [[ -n "$flavor" ]]; then
    args+=(--flavor="$flavor")
  fi

  "$PYFTSUBSET_BIN" "${args[@]}"
  echo "✔ created $output_file"
}

subset_font "woff2" "$OUTPUT_DIR/player.woff2"

generate_preview_html() {
  local preview_file="$1"
  local preview_dir
  preview_dir="$(dirname "$preview_file")"
  mkdir -p "$preview_dir"

  cat >"$preview_file" <<'EOF'
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Material Symbols Preview</title>
  <style>
    @font-face {
      font-family: 'Material Icons Round-Regular';
      font-style: normal;
      font-weight: 400;
      font-display: swap;
      src: url('../public/player.woff2') format('woff2');
    }

    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      margin: 0;
      padding: 2rem;
      background: #0f1115;
      color: #f5f7fa;
    }

    h1 {
      margin-top: 0;
      font-size: 1.4rem;
    }

    p {
      color: #a8b3c7;
      max-width: 40rem;
    }

    ul {
      list-style: none;
      padding: 0;
      margin: 2rem 0 0;
      display: grid;
      gap: 1rem;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    }

    li {
      display: flex;
      gap: 0.75rem;
      align-items: center;
      padding: 0.75rem;
      border: 1px solid #2b2f3a;
      border-radius: 8px;
      background: #161921;
    }

    .icon {
      font-family: 'Material Icons Round-Regular';
      font-size: 32px;
      line-height: 1;
      min-width: 32px;
      text-rendering: optimizeLegibility;
      font-feature-settings: 'liga';
      font-variation-settings: 'FILL' 0, 'GRAD' 0, 'opsz' 24, 'wght' 400;
    }

    code {
      font-family: 'SFMono-Regular', Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
      font-size: 0.9rem;
      color: #a8b3c7;
    }
  </style>
</head>
<body>
  <main>
    <h1>Material Symbols Preview</h1>
    <p>This file is generated by convert-material-symbols.sh and lists every ligature included in player.woff2.</p>
    <ul>
EOF

  for icon_name in "${ICON_NAMES[@]}"; do
    printf '      <li>\n        <span class="icon" aria-hidden="true">%s</span>\n        <code>%s</code>\n      </li>\n' "$icon_name" "$icon_name" >>"$preview_file"
  done

  cat >>"$preview_file" <<'EOF'
    </ul>
  </main>
</body>
</html>
EOF

  echo "✔ created $preview_file"
}

generate_preview_html "$PREVIEW_FILE"
