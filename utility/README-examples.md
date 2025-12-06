# examples

```
node utility/create-playlist.mjs --input data/yt-playlist.json --title "Trance Decade 1" --privacy public | tee /tmp/1

# append to existing playlist, skipping duplicates already present
node utility/create-playlist.mjs --input data/yt-playlist.json --title "Trance Decade 1" --privacy public --append
```