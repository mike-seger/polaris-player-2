#!/usr/bin/env python3

import argparse
import csv
import json
import re
import sys
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


_ALNUM_RE = re.compile(r"[^0-9a-z]+", re.IGNORECASE)


def _norm(s: str) -> str:
    """Normalize for fuzzy containment: lowercase and drop non-alphanumerics."""
    s = (s or "").strip().lower()
    s = _ALNUM_RE.sub("", s)
    return s


def _get_in(root: Any, path: str) -> Any:
    """Resolve a dotted path through dicts (e.g., 'a.b.c')."""
    cur = root
    if not path:
        return cur
    for part in path.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
            continue
        raise KeyError(f"Path segment '{part}' not found")
    return cur


def _find_csv_column(fieldnames: List[str], desired: str) -> Optional[str]:
    desired_l = desired.strip().lower()
    for f in fieldnames:
        ff = (f or "")
        ff = ff.lstrip("\ufeff").strip().lower()
        if ff == desired_l:
            return f
    return None


def _extract_spotify_id(track_uri: str) -> str:
    s = (track_uri or "").strip()
    if not s:
        return ""
    if s.startswith("spotify:track:"):
        return s.split(":")[-1].strip()
    if re.fullmatch(r"[0-9A-Za-z]{10,}", s):
        return s
    return ""


@dataclass
class CsvRow:
    raw: Dict[str, str]
    track_name: str
    artist_name: str
    spotify_id: str


def load_csv_rows(csv_path: Path) -> Tuple[List[str], List[CsvRow]]:
    with csv_path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames:
            raise ValueError("CSV has no header")
        header = list(reader.fieldnames)

        track_col = _find_csv_column(header, "Track Name")
        artist_col = _find_csv_column(header, "Artist Name") or _find_csv_column(header, "Artist Name(s)")
        uri_col = _find_csv_column(header, "Track URI")

        if not track_col:
            raise ValueError("CSV missing required column 'Track Name'")
        if not artist_col:
            raise ValueError("CSV missing required column 'Artist Name' (or 'Artist Name(s)')")
        if not uri_col:
            raise ValueError("CSV missing required column 'Track URI'")

        rows: List[CsvRow] = []
        for r in reader:
            track_name = (r.get(track_col) or "").strip()
            artist_name_raw = (r.get(artist_col) or "").strip()
            # Spotify exports multiple artists separated by ';'.
            # The playlist userTitle typically starts with the primary artist.
            artist_name = artist_name_raw.split(';', 1)[0].strip()
            spotify_id = _extract_spotify_id(r.get(uri_col) or "")
            rows.append(CsvRow(raw=r, track_name=track_name, artist_name=artist_name, spotify_id=spotify_id))

        return header, rows


def match_row(user_title: str, rows: List[CsvRow]) -> List[int]:
    t = _norm(user_title)
    if not t:
        return []

    matches: List[int] = []
    for i, r in enumerate(rows):
        tn = _norm(r.track_name)
        an = _norm(r.artist_name)
        if not tn or not an:
            continue
        if tn in t and an in t:
            matches.append(i)
    return matches


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(
        description=(
            "Enrich playlist JSON items with spotifyId by matching userTitle against a Spotify-export CSV. "
            "Writes enriched.json and unused.csv to the current directory."
        )
    )
    p.add_argument("--json", dest="json_path", required=True, help="Input JSON file path")
    p.add_argument("--json-path", dest="json_path_expr", required=True, help="Dotted path to the items list")
    p.add_argument("--csv", dest="csv_path", required=True, help="Input CSV file path")
    p.add_argument("--out-json", dest="out_json", default="enriched.json", help="Output JSON file name")
    p.add_argument("--out-unused", dest="out_unused", default="unused.csv", help="Output CSV file name")
    p.add_argument(
        "--unmatched-value",
        dest="unmatched_value",
        default="unmatched",
        help="Value to write to spotifyId when no unique match is found (default: unmatched)",
    )
    p.add_argument(
        "--fill-missing",
        action="store_true",
        help=(
            "Also process items that are missing spotifyId (or have empty spotifyId), setting them to the "
            "unmatched value when no unique match is found. Without this flag, only items whose spotifyId "
            "already equals the unmatched value are updated."
        ),
    )

    args = p.parse_args(argv)

    json_path = Path(args.json_path)
    csv_path = Path(args.csv_path)
    out_json = Path(args.out_json)
    out_unused = Path(args.out_unused)

    data = json.loads(json_path.read_text(encoding="utf-8"))
    data_out = deepcopy(data)

    header, csv_rows = load_csv_rows(csv_path)

    try:
        items = _get_in(data_out, args.json_path_expr)
    except KeyError as e:
        raise SystemExit(f"JSON path not found: {args.json_path_expr}. {e}")

    if not isinstance(items, list):
        raise SystemExit(f"JSON path '{args.json_path_expr}' did not resolve to a list.")

    used_indices: set[int] = set()
    enriched = 0
    ambiguous = 0
    missing = 0
    skipped = 0

    for item in items:
        if not isinstance(item, dict):
            continue

        existing = item.get("spotifyId")

        # Default behavior: only update items explicitly marked as unmatched.
        if existing is None:
            if not args.fill_missing:
                skipped += 1
                continue
        elif isinstance(existing, str):
            if existing.strip() == "":
                if not args.fill_missing:
                    skipped += 1
                    continue
            elif existing != args.unmatched_value:
                skipped += 1
                continue
        else:
            skipped += 1
            continue

        user_title = (item.get("userTitle") or item.get("title") or "").strip()
        if not user_title:
            item["spotifyId"] = args.unmatched_value
            missing += 1
            continue

        matches = match_row(user_title, csv_rows)
        if len(matches) == 1:
            idx = matches[0]
            spotify_id = csv_rows[idx].spotify_id
            if spotify_id:
                item["spotifyId"] = spotify_id
                used_indices.add(idx)
                enriched += 1
            else:
                item["spotifyId"] = args.unmatched_value
                missing += 1
        elif len(matches) == 0:
            item["spotifyId"] = args.unmatched_value
            missing += 1
        else:
            item["spotifyId"] = args.unmatched_value
            ambiguous += 1

    out_json.write_text(json.dumps(data_out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    with out_unused.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=header)
        writer.writeheader()
        for i, r in enumerate(csv_rows):
            if i in used_indices:
                continue
            writer.writerow(r.raw)

    print(
        json.dumps(
            {
                "items_total": len(items),
                "enriched": enriched,
                "unmatched": missing,
                "ambiguous": ambiguous,
                "csv_total": len(csv_rows),
                "csv_unused": len(csv_rows) - len(used_indices),
                "skipped": skipped,
            },
            indent=2,
        ),
        file=sys.stderr,
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
