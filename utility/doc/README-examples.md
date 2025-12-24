# examples

```
# New playlist
node utility/create-playlist.mjs --input data/yt-playlist.json --title "Trance Decade 1" --privacy public | tee /tmp/1

# New or append playlist  dry run with cyrillic transliteration sorting
node utility/create-playlist.mjs --dry-run --input data/yt-playlist.json --title "Wave alterntives" --privacy public --append --transliterate-sort

# append to existing playlist, skipping duplicates already present
node utility/create-playlist.mjs --input data/yt-playlist.json --title "Trance Decade 1" --privacy public --append
```