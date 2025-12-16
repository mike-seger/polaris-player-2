#!/usr/bin/env python3
"""
enrich_artists_with_iso.py

Enriches track lines of the form:
  "Artist ; Artist - Title"
with ISO-3166-1 alpha-2 country codes (semicolon-separated) using MusicBrainz.

Features:
- stdlib-only (no requests)
- input "-" => stdin, output "-" => stdout
- two modes:
    * TSV mode (default): requires header row; reads from --artists-col (default "artists")
    * line mode (--no-header): reads plain lines; writes a TSV with columns: artists, iso_countries
- streaming output (row-by-row) with optional forced flushing for immediate display
- low-noise progress to stderr (TTY only)
- optional verbose/debug trace to stderr
- JSON cache to speed up reruns
"""

from __future__ import annotations

import sys
import csv
import json
import time
import argparse
import urllib.parse
import urllib.request
import urllib.error
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

MB_BASE = "https://musicbrainz.org/ws/2"

HEADERS = {
    "Accept": "application/json",
    "User-Agent": "polaris-artist-country-enricher/1.4 (local-script)",
}

MIN_REQUEST_INTERVAL_SEC = 1.05
_last_request_ts = 0.0


# ----------------------------- diagnostics -----------------------------

def progress(msg: str) -> None:
    # Low-noise: only when stderr is a TTY (so redirects stay clean)
    if sys.stderr.isatty():
        print(msg, file=sys.stderr, flush=True)


def debug(msg: str, enabled: bool) -> None:
    if enabled:
        print(msg, file=sys.stderr, flush=True)


# ----------------------------- helpers ---------------------------------

def throttle() -> None:
    global _last_request_ts
    now = time.time()
    wait = MIN_REQUEST_INTERVAL_SEC - (now - _last_request_ts)
    if wait > 0:
        time.sleep(wait)
    _last_request_ts = time.time()


def open_input(path: str):
    if path == "-":
        return sys.stdin
    return open(path, newline="", encoding="utf-8")


def open_output(path: str):
    if path == "-":
        return sys.stdout
    return open(path, "w", newline="", encoding="utf-8")


def load_cache(path: Optional[str]) -> Dict[str, Any]:
    if not path:
        return {}
    p = Path(path)
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return {}


def save_cache(path: Optional[str], cache: Dict[str, Any]) -> None:
    if not path:
        return
    Path(path).write_text(json.dumps(cache, indent=2, ensure_ascii=False), encoding="utf-8")


def http_get_json(url: str, retries: int = 4, timeout: int = 30) -> Any:
    last_err: Optional[Exception] = None

    for attempt in range(retries + 1):
        try:
            throttle()
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()

            try:
                return json.loads(raw.decode("utf-8"))
            except Exception as e:
                snippet = raw[:400].decode("utf-8", errors="replace")
                raise RuntimeError(f"Non-JSON response from MusicBrainz:\n{snippet}") from e

        except urllib.error.HTTPError as e:
            body = e.read()
            snippet = body[:400].decode("utf-8", errors="replace")
            last_err = RuntimeError(f"HTTP {e.code} from MusicBrainz:\n{snippet}")

            if e.code in (429, 502, 503, 504) and attempt < retries:
                time.sleep(1.5 * (2 ** attempt))
                continue
            raise last_err

        except (urllib.error.URLError, TimeoutError, RuntimeError, json.JSONDecodeError) as e:
            last_err = e
            if attempt < retries:
                time.sleep(1.5 * (2 ** attempt))
                continue
            raise

    raise last_err or RuntimeError("Unknown MusicBrainz error")


# ----------------------------- parsing ---------------------------------

def split_track_line(line: str) -> Tuple[List[str], Optional[str]]:
    """
    Parse:
      "Artist A ; Artist B - Title (Remix)"
    Artists split by ';', artist/title split by first ' - '.
    """
    s = (line or "").strip()
    if not s:
        return [], None

    if " - " in s:
        artist_chunk, title = s.split(" - ", 1)
        title = title.strip() or None
    else:
        artist_chunk, title = s, None

    artists = [a.strip() for a in artist_chunk.split(";") if a.strip()]
    return artists, title


# ----------------------------- MusicBrainz -----------------------------

def mb_recording_search_one(artist: str, title: str) -> Optional[Dict[str, Any]]:
    q = f'recording:"{title}" AND artist:"{artist}"'
    params = urllib.parse.urlencode({"query": q, "fmt": "json", "limit": 1})
    url = f"{MB_BASE}/recording/?{params}"
    data = http_get_json(url)
    recs = data.get("recordings") or []
    return recs[0] if recs else None


def mb_artist_country(mbid: str) -> Optional[str]:
    url = f"{MB_BASE}/artist/{urllib.parse.quote(mbid)}?fmt=json"
    data = http_get_json(url)
    c = data.get("country")
    if isinstance(c, str) and c.strip():
        return c.strip()
    return None


# ----------------------------- core logic ------------------------------

def countries_for_track(line: str, cache: Dict[str, Any], debug_enabled: bool) -> List[str]:
    line = (line or "").strip()
    line_key = f"line::{line}"
    if line_key in cache:
        debug(f"cache hit line: {line}", debug_enabled)
        return cache[line_key] or []

    artists, title = split_track_line(line)
    debug(f"track: {line}", debug_enabled)
    debug(f"  artists={artists}, title={title}", debug_enabled)

    if not artists or not title:
        cache[line_key] = []
        return []

    mbids: List[str] = []

    for a in artists:
        rec_key = f"rec::{a}::{title}"
        if rec_key in cache:
            mbids = cache[rec_key] or []
        else:
            rec = mb_recording_search_one(a, title)
            found: List[str] = []
            if rec and rec.get("artist-credit"):
                for ac in rec["artist-credit"]:
                    art = ac.get("artist") or {}
                    mbid = art.get("id")
                    if mbid:
                        found.append(mbid)
            mbids = found
            cache[rec_key] = mbids

        if mbids:
            break

    debug(f"  artist mbids={mbids}", debug_enabled)

    iso: List[str] = []
    for mbid in mbids:
        akey = f"artist::{mbid}"
        if akey in cache:
            c = cache[akey]
        else:
            c = mb_artist_country(mbid)
            cache[akey] = c
        if c:
            iso.append(c)

    iso = list(dict.fromkeys(iso))
    debug(f"  iso={iso}", debug_enabled)

    cache[line_key] = iso
    return iso


# ----------------------------- main ------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("input", help="TSV input file or '-' for stdin")
    ap.add_argument("-o", "--output", default="-", help="TSV output file or '-' for stdout")
    ap.add_argument("--cache-json", help="JSON cache file")
    ap.add_argument("--artists-col", default="artists",
                    help="TSV column with 'Artist ; Artist - Title'")
    ap.add_argument("--no-header", action="store_true",
                    help="Input is plain lines (no TSV header)")
    ap.add_argument("--progress-every", type=int, default=10,
                    help="Progress every N tracks (TTY only, 0 disables)")
    ap.add_argument("--debug", action="store_true",
                    help="Verbose per-track diagnostics to stderr")
    ap.add_argument("--flush-every", type=int, default=1,
                    help="Flush stdout every N output rows (0 disables). Default 1 = immediate streaming.")
    args = ap.parse_args()

    cache = load_cache(args.cache_json)

    start_ts = time.time()
    processed = 0
    last_report = 0
    last_flush = 0

    def maybe_flush(fout, rows_written: int) -> None:
        if args.flush_every and (rows_written - last_flush) >= args.flush_every:
            fout.flush()

    with open_input(args.input) as fin, open_output(args.output) as fout:
        if args.no_header:
            writer = csv.writer(fout, delimiter="\t", lineterminator="\n")
            writer.writerow(["artists", "iso_countries"])
            fout.flush()
            out_rows = 1

            for raw in fin:
                line = raw.rstrip("\n")
                iso = countries_for_track(line, cache, args.debug)
                writer.writerow([line, ";".join(iso)])
                out_rows += 1

                # force streaming
                if args.flush_every and (out_rows - last_flush) >= args.flush_every:
                    fout.flush()
                    last_flush = out_rows

                processed += 1
                if args.progress_every and processed - last_report >= args.progress_every:
                    progress(f"[{processed}] tracks processed ({time.time() - start_ts:.1f}s)")
                    last_report = processed
        else:
            reader = csv.DictReader(fin, delimiter="\t")
            if not reader.fieldnames:
                raise SystemExit("Missing header; use --no-header for plain lines")

            fields = list(reader.fieldnames)
            if "iso_countries" not in fields:
                fields.append("iso_countries")

            writer = csv.DictWriter(fout, delimiter="\t", fieldnames=fields, lineterminator="\n")
            writer.writeheader()
            fout.flush()
            out_rows = 1

            for row in reader:
                track = (row.get(args.artists_col) or "").strip()
                iso = countries_for_track(track, cache, args.debug)
                row["iso_countries"] = ";".join(iso)
                writer.writerow(row)
                out_rows += 1

                if args.flush_every and (out_rows - last_flush) >= args.flush_every:
                    fout.flush()
                    last_flush = out_rows

                processed += 1
                if args.progress_every and processed - last_report >= args.progress_every:
                    progress(f"[{processed}] tracks processed ({time.time() - start_ts:.1f}s)")
                    last_report = processed

    save_cache(args.cache_json, cache)
    progress(f"done: {processed} tracks in {time.time() - start_ts:.1f}s")


if __name__ == "__main__":
    main()
