#!/usr/bin/env python3
"""
Reorder a YouTube playlist to match a desired order of videoIds.

Inputs:
  - TSV: one videoId per line (or first column is videoId; header optional)
  - JSON: extract videoIds from a dotted path with [] for arrays, e.g.
        'user:... .items[].videoId'
    (keys may contain ':' and '-' etc; don't split keys except on '.')

Features:
  - Dry-run: prints planned moves without calling playlistItems.update
  - Nearly-sorted optimization: computes a minimal set of moves using LIS
  - Applies only moves (typically small if playlist is mostly sorted)
  - No extra API calls during the move phase (only one initial playlistItems.list scan)

Auth:
  Uses OAuth (installed app flow). You need a Google Cloud OAuth Client (Desktop app)
  and a credentials JSON file.

Usage examples:
  # TSV input (videoId in first column)
  ./yt_reorder_playlist.py --playlist-id PLxxxx --tsv desired.tsv --dry-run

  # JSON input (extract order from JSON file)
  ./yt_reorder_playlist.py --playlist-id PLxxxx --json my.json \
     --json-path 'user:1b3f8510-29cf-433b-9d9e-830810028645.items[].videoId' --dry-run

  # Actually apply changes
  ./yt_reorder_playlist.py --playlist-id PLxxxx --tsv desired.tsv

Notes:
  - Duplicates in a playlist: this script moves the *first* matching occurrence.
  - VideoIds in desired order but not currently in playlist are skipped.
  - Items in playlist but not in desired list keep their relative order and remain in place
    after the reordered subset (unless you choose --mode=full to force full ordering).
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

# Google API deps:
#   pip install --upgrade google-api-python-client google-auth-httplib2 google-auth-oauthlib
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from google_auth_oauthlib.flow import InstalledAppFlow
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request


SCOPES = ["https://www.googleapis.com/auth/youtube"]


@dataclass
class PlItem:
    playlist_item_id: str
    video_id: str
    position: int


def eprint(*a: Any) -> None:
    print(*a, file=sys.stderr)


def load_videoids_from_tsv(path: str, no_header: bool) -> List[str]:
    out: List[str] = []
    with open(path, "r", encoding="utf-8", newline="") as f:
        reader = csv.reader(f, delimiter="\t")
        first = True
        for row in reader:
            if not row:
                continue
            vid = row[0].strip()
            if not vid:
                continue
            if first and not no_header:
                # Heuristic: treat as header if it contains non-videoId-ish stuff.
                # VideoIds are typically 11 chars of [A-Za-z0-9_-], but be lenient.
                if vid.lower() in ("videoid", "video_id", "yt_video_id", "id"):
                    first = False
                    continue
            out.append(vid)
            first = False
    return out


def parse_json_path(path: str) -> List[Tuple[str, bool]]:
    """
    Supports a dotted path where each segment may end in [] to denote array expansion.
    Example: 'a.b[].c' -> [('a', False), ('b', True), ('c', False)]
    Keys may contain ':' etc; only '.' splits segments.
    """
    if not path or path.strip() == "":
        raise ValueError("json-path is empty")
    segs: List[Tuple[str, bool]] = []
    for raw in path.split("."):
        raw = raw.strip()
        if not raw:
            continue
        is_arr = raw.endswith("[]")
        key = raw[:-2] if is_arr else raw
        if key == "":
            raise ValueError(f"Invalid json-path segment: '{raw}'")
        segs.append((key, is_arr))
    if not segs:
        raise ValueError("json-path did not contain any usable segments")
    return segs


def extract_json_path(data: Any, path: str) -> List[Any]:
    """
    Returns a list of values (even if single), expanding arrays when [] is used.
    """
    segs = parse_json_path(path)
    cur: List[Any] = [data]
    for key, is_arr in segs:
        nxt: List[Any] = []
        for obj in cur:
            if isinstance(obj, dict):
                if key not in obj:
                    continue
                val = obj[key]
            else:
                continue

            if is_arr:
                if isinstance(val, list):
                    nxt.extend(val)
                else:
                    # If not a list, treat as empty expansion
                    continue
            else:
                nxt.append(val)
        cur = nxt
    return cur


def load_videoids_from_json(path: str, json_path: str) -> List[str]:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    vals = extract_json_path(data, json_path)
    out: List[str] = []
    for v in vals:
        if isinstance(v, str) and v.strip():
            out.append(v.strip())
    return out


def load_credentials(client_secrets: Optional[str], token_path: str) -> Credentials:
    creds: Optional[Credentials] = None

    if os.path.exists(token_path):
        creds = Credentials.from_authorized_user_file(token_path, SCOPES)

    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
        with open(token_path, "w", encoding="utf-8") as f:
            f.write(creds.to_json())
        return creds

    # Prefer env vars if present
    env_client_id = os.getenv("GOOGLE_CLIENT_ID")
    env_client_secret = os.getenv("GOOGLE_CLIENT_SECRET")

    if env_client_id and env_client_secret:
        client_config = {
            "installed": {
                "client_id": env_client_id,
                "client_secret": env_client_secret,
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
                "redirect_uris": ["http://localhost"],
            }
        }
        flow = InstalledAppFlow.from_client_config(client_config, SCOPES)

    elif client_secrets:
        flow = InstalledAppFlow.from_client_secrets_file(client_secrets, SCOPES)

    else:
        raise RuntimeError(
            "No OAuth credentials available. "
            "Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET or provide --client-secrets."
        )

    creds = flow.run_local_server(port=0)

    with open(token_path, "w", encoding="utf-8") as f:
        f.write(creds.to_json())

    return creds



def fetch_playlist_items(youtube, playlist_id: str) -> List[PlItem]:
    items: List[PlItem] = []
    page_token: Optional[str] = None
    while True:
        resp = (
            youtube.playlistItems()
            .list(
                part="snippet",
                playlistId=playlist_id,
                maxResults=50,
                pageToken=page_token,
            )
            .execute()
        )
        for it in resp.get("items", []):
            pid = it["id"]
            sn = it["snippet"]
            vid = sn["resourceId"]["videoId"]
            pos = int(sn["position"])
            items.append(PlItem(pid, vid, pos))
        page_token = resp.get("nextPageToken")
        if not page_token:
            break
    # Ensure sorted by position
    items.sort(key=lambda x: x.position)
    return items


def lis_indices(seq: List[int]) -> List[int]:
    """
    Returns indices of a Longest Increasing Subsequence (strict).
    Standard O(n log n) patience algorithm, reconstructing indices.
    """
    if not seq:
        return []
    # tails[k] = value of smallest tail of increasing subseq of length k+1
    tails: List[int] = []
    # tails_idx[k] = index in seq of that tail
    tails_idx: List[int] = []
    # prev[i] = previous index in seq for reconstruction
    prev: List[int] = [-1] * len(seq)

    import bisect

    for i, x in enumerate(seq):
        j = bisect.bisect_left(tails, x)
        if j == len(tails):
            tails.append(x)
            tails_idx.append(i)
        else:
            tails[j] = x
            tails_idx[j] = i
        if j > 0:
            prev[i] = tails_idx[j - 1]

    # Reconstruct
    k = tails_idx[-1]
    out: List[int] = []
    while k != -1:
        out.append(k)
        k = prev[k]
    out.reverse()
    return out


def plan_moves_minimal(current: List[PlItem], desired_videoids: List[str]) -> List[Tuple[str, int]]:
    """
    Compute a minimal-ish set of moves (videoId -> desiredPosition) by:
      - considering only videos present in both current and desired
      - keeping a LIS of desired positions in current order fixed
      - moving the rest into place

    Returns moves as a list of (videoId, target_index_in_filtered_order).
    """
    current_vids = [it.video_id for it in current]
    # Filter desired to videos that are actually present, preserving desired order.
    present = set(current_vids)
    desired_f = [v for v in desired_videoids if v in present]

    desired_pos: Dict[str, int] = {v: i for i, v in enumerate(desired_f)}

    # Sequence of desired positions as they appear in current order
    seq = [desired_pos[v] for v in current_vids if v in desired_pos]

    keep_seq_idx = set(lis_indices(seq))  # indices within seq list
    # Map seq index back to videoId in current order
    current_common_vids = [v for v in current_vids if v in desired_pos]
    keep_vids = set(current_common_vids[i] for i in keep_seq_idx)

    # Items to move: all desired_f vids not in keep_vids
    moves = [(v, desired_pos[v]) for v in desired_f if v not in keep_vids]
    # Apply in increasing target order (important for stable simulation)
    moves.sort(key=lambda t: t[1])
    return moves


def simulate_and_render_plan(current: List[PlItem], moves: List[Tuple[str, int]]) -> List[Tuple[PlItem, int, int]]:
    """
    Simulate the effect of moving each item to target index and return a concrete plan:
      (item, from_pos, to_pos) in terms of indices in the *current list* during simulation.

    We simulate list behavior locally so we don't need extra API calls.
    """
    # Work on a list of PlItem references
    work: List[PlItem] = list(current)

    # index helper for duplicates: videoId -> list of indices (first match used)
    def find_index(video_id: str) -> int:
        for i, it in enumerate(work):
            if it.video_id == video_id:
                return i
        return -1

    plan: List[Tuple[PlItem, int, int]] = []
    for vid, target in moves:
        from_idx = find_index(vid)
        if from_idx < 0:
            continue
        to_idx = max(0, min(target, len(work) - 1))
        if from_idx == to_idx:
            continue
        it = work.pop(from_idx)
        work.insert(to_idx, it)
        plan.append((it, from_idx, to_idx))
    return plan


def apply_plan(youtube, playlist_id: str, plan: List[Tuple[PlItem, int, int]], dry_run: bool) -> None:
    """
    Execute playlistItems.update for each move.
    IMPORTANT: YouTube uses 0-based position within playlist.
    """
    for it, from_idx, to_idx in plan:
        if dry_run:
            print(f"DRY  move videoId={it.video_id} playlistItemId={it.playlist_item_id} {from_idx} -> {to_idx}")
            continue

        body = {
            "id": it.playlist_item_id,
            "snippet": {
                "playlistId": playlist_id,
                "position": int(to_idx),
                "resourceId": {"kind": "youtube#video", "videoId": it.video_id},
            },
        }
        try:
            youtube.playlistItems().update(part="snippet", body=body).execute()
            print(f"OK   move videoId={it.video_id} {from_idx} -> {to_idx}")
        except HttpError as e:
            eprint(f"ERR  move videoId={it.video_id} {from_idx}->{to_idx}: {e}")
            # Continue so you can resume later; you can re-run dry-run to see remaining drift.
            continue


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--playlist-id", required=True, help="Target playlist ID (e.g., PLxxxx)")
    ap.add_argument("--client-secrets", default=None, help="OAuth client secrets JSON (ignored if env vars are set)")
    ap.add_argument("--token", default="token.json", help="Path to store OAuth token")
    ap.add_argument("--dry-run", action="store_true", help="Print planned moves, do not update playlist")

    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--tsv", help="TSV file with videoIds in the first column")
    src.add_argument("--json", help="JSON file to extract videoIds from")
    ap.add_argument("--json-path", help="Dotted path with [] expansions to extract videoIds (required with --json)")

    ap.add_argument("--no-header", action="store_true", help="TSV has no header row (default: header allowed)")

    args = ap.parse_args()

    if args.json and not args.json_path:
        ap.error("--json-path is required when using --json")

    if args.tsv:
        desired = load_videoids_from_tsv(args.tsv, no_header=args.no_header)
    else:
        desired = load_videoids_from_json(args.json, args.json_path)

    desired = [v.strip() for v in desired if v and v.strip()]
    if not desired:
        eprint("No videoIds found in input.")
        return 2

    creds = load_credentials(args.client_secrets, args.token)
    youtube = build("youtube", "v3", credentials=creds)

    eprint("Fetching playlist items...")
    current = fetch_playlist_items(youtube, args.playlist_id)
    eprint(f"Playlist items fetched: {len(current)}")

    # Plan minimal moves
    moves = plan_moves_minimal(current, desired)
    eprint(f"Planned moves (LIS-minimized): {len(moves)}")

    plan = simulate_and_render_plan(current, moves)

    # Summary
    if not plan:
        print("No moves required (playlist already matches desired relative order for present items).")
        return 0

    print(f"Moves to apply: {len(plan)}")
    for it, from_idx, to_idx in plan[:50]:
        print(f"{'DRY ' if args.dry_run else 'PLAN'} move {from_idx:4d}->{to_idx:4d}  {it.video_id}  ({it.playlist_item_id})")
    if len(plan) > 50:
        print(f"... ({len(plan)-50} more moves)")

    apply_plan(youtube, args.playlist_id, plan, dry_run=args.dry_run)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
