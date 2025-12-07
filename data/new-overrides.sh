#!/bin/bash

partial() {
  jq '{
    overrides: (
      .items
      | map({ key: .videoId, value: { title: .userTitle } })
      | from_entries
    )
  }'
}

full() {
  # stdin: yt-playlist.json
  # $1: overrides-by-id.json
  # jq -s will slurp [ existing-from-file, new-from-stdin ]
  partial | jq -s '
    .[0] as $existing
    | .[1].overrides |= with_entries(
        select(
          .key as $k
          | ($existing.overrides | has($k)) | not
        )
      )
    | .[1]
  ' "$1" -
}

if [ -f "$1" ]; then
  full "$1"
else
  partial
fi
