cd "$(dirname "$0")"

jq --rawfile vids videoIds.txt '
  # Convert videoIds.txt into array of IDs
  ($vids | split("\n") | map(select(length > 0))) as $ids
  |
  {
    overrides:
      (
        reduce
          ( .[] .items[] | select(.videoId as $v | $ids | index($v)) )
        as $item
        ({}; .[$item.videoId] = { title: $item.title })
      )
  }
' title-overrides.json > overrides-by-id.json
