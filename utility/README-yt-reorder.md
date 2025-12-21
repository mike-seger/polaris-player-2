Yes — the standard way is to use yt-dlp (no YouTube Data API key / quota). It scrapes the playlist page and extracts entries.

IDs only (one per line)
```
yt-dlp --flat-playlist --print "%(id)s" "https://www.youtube.com/playlist?list=PLxxxxxxxxxxxx"
```

--flat-playlist = don’t resolve each video (fast; avoids fetching each watch page)

%(id)s prints the videoId equivalent

IDs + title (TSV-ish)
```
yt-dlp --flat-playlist --print "%(id)s\t%(title)s" "https://www.youtube.com/playlist?list=PLxxxxxxxxxxxx"
```

JSON (then use jq)

Get a single JSON blob:
```
yt-dlp --flat-playlist -J "https://www.youtube.com/playlist?list=PLxxxxxxxxxxxx" > playlist.json
```

Then extract IDs:
```
jq -r '.entries[].id' playlist.json
```

If the playlist is unlisted/private / age-gated

You may need browser cookies:
```
yt-dlp --cookies-from-browser chrome --flat-playlist --print "%(id)s" "https://www.youtube.com/playlist?list=PLxxxxxxxxxxxx"
```

(Use firefox instead of chrome if that’s your browser.)

Notes / gotchas

If you omit --flat-playlist, yt-dlp may fetch each video page, which is slower and can hit rate limits sooner.

Some playlists paginate heavily; yt-dlp handles continuation tokens, but if you get partial results, add:
```
yt-dlp --flat-playlist --extractor-retries 10 --retry-sleep 1 --print "%(id)s" "…"
```