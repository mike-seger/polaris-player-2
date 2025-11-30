jq --rawfile vids videoIds.txt '
  # split raw text into array of IDs
  ($vids | split("\n") | map(select(length > 0))) as $ids
  |
  {
    overrides: [
      .[] .items[]
      | select(.videoId as $v | $ids | index($v))
      | { videoId, title }
    ]
  }
' title-overrides.json > filtered-title-overrides.json
