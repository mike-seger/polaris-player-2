#!/usr/bin/env python3

import argparse
import base64
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from copy import deepcopy
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


SPOTIFY_ACCOUNTS_BASE = "https://accounts.spotify.com"
SPOTIFY_API_BASE = "https://api.spotify.com"


class RateLimitWaitTooLong(RuntimeError):
    def __init__(self, wait_seconds: float):
        super().__init__(f"Spotify asked us to wait {wait_seconds:.1f}s")
        self.wait_seconds = float(wait_seconds)


def _b64url_no_pad(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _now() -> float:
    return time.time()


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _parse_env_assignments(text: str) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k:
            out[k] = v
    return out


def _find_spotify_client_id(env_file: Optional[str], explicit_client_id: Optional[str]) -> str:
    if explicit_client_id:
        cid = explicit_client_id.strip()
        if cid:
            return cid

    repo_root = Path(__file__).resolve().parents[1]
    candidates: List[Path] = []
    if env_file:
        candidates.append(Path(env_file))
    candidates.extend(
        [
            repo_root / ".spotify.env",
            repo_root / "utility" / ".spotify.env",
            Path.cwd() / ".spotify.env",
        ]
    )

    for p in candidates:
        if p.exists() and p.is_file():
            env = _parse_env_assignments(_read_text(p))
            for key in (
                "clientID",
                "SPOTIFY_CLIENT_ID",
                "CLIENT_ID",
                "spotifyClientId",
            ):
                v = env.get(key)
                if v:
                    return v.strip()

    raise SystemExit(
        "Missing Spotify client ID. Create .spotify.env with clientID=<your_spotify_app_client_id> "
        "(or set SPOTIFY_CLIENT_ID), or pass --client-id."
    )


def _is_spotify_track_id(value: str) -> bool:
    if not isinstance(value, str):
        return False
    s = value.strip()
    if len(s) != 22:
        return False
    for ch in s:
        if not ("0" <= ch <= "9" or "A" <= ch <= "Z" or "a" <= ch <= "z"):
            return False
    return True


def _extract_spotify_id(item: Any) -> str:
    if not isinstance(item, dict):
        return ""

    for key in ("spotifyId", "spotify_id", "spotifyTrackId", "trackId", "id"):
        v = item.get(key)
        if isinstance(v, str) and _is_spotify_track_id(v):
            return v

    # also accept spotify:track:...
    for key in ("spotifyUri", "spotifyURI", "spotifyTrackUri", "uri"):
        v = item.get(key)
        if isinstance(v, str) and v.startswith("spotify:track:"):
            tid = v.split(":")[-1].strip()
            if _is_spotify_track_id(tid):
                return tid

    return ""


def _get_in(root: Any, path: str) -> Any:
    cur = root
    if not path:
        return cur
    for part in path.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
            continue
        raise KeyError(f"Path segment '{part}' not found")
    return cur


def _iter_items_lists(root: Any, explicit_path: str) -> List[Tuple[str, List[Any]]]:
    if explicit_path:
        items = _get_in(root, explicit_path)
        if not isinstance(items, list):
            raise SystemExit(f"JSON path '{explicit_path}' did not resolve to a list.")
        return [(explicit_path, items)]

    # Default: find all dict values containing an 'items' list.
    out: List[Tuple[str, List[Any]]] = []
    if isinstance(root, dict):
        for k, v in root.items():
            if isinstance(v, dict) and isinstance(v.get("items"), list):
                out.append((f"{k}.items", v["items"]))

    if not out:
        raise SystemExit("No '<playlist>.items' arrays found; pass --json-path.")

    return out


@dataclass
class OAuthToken:
    access_token: str
    refresh_token: str
    expires_at: float

    @staticmethod
    def from_json(obj: Dict[str, Any]) -> "OAuthToken":
        return OAuthToken(
            access_token=str(obj.get("access_token", "")),
            refresh_token=str(obj.get("refresh_token", "")),
            expires_at=float(obj.get("expires_at", 0)),
        )

    def to_json(self) -> Dict[str, Any]:
        return {
            "access_token": self.access_token,
            "refresh_token": self.refresh_token,
            "expires_at": self.expires_at,
        }

    def is_expired(self, skew_seconds: float = 30) -> bool:
        return _now() >= (self.expires_at - skew_seconds)


class TokenStore:
    def __init__(self, token_path: Path, client_id: str):
        self._token_path = token_path
        self._client_id = client_id
        self._token: Optional[OAuthToken] = None

    def load(self) -> Optional[OAuthToken]:
        if not self._token_path.exists():
            return None
        obj = json.loads(_read_text(self._token_path))
        tok = OAuthToken.from_json(obj)
        if not tok.access_token or not tok.refresh_token:
            return None
        self._token = tok
        return tok

    def save(self, token: OAuthToken) -> None:
        self._token_path.parent.mkdir(parents=True, exist_ok=True)
        self._token_path.write_text(json.dumps(token.to_json(), indent=2) + "\n", encoding="utf-8")
        self._token = token

    def ensure_valid(self) -> OAuthToken:
        if self._token is None:
            self.load()
        if self._token is None:
            raise RuntimeError("No token loaded")
        if self._token.is_expired():
            self._token = self.refresh(self._token)
            self.save(self._token)
        return self._token

    def refresh(self, token: OAuthToken) -> OAuthToken:
        data = {
            "grant_type": "refresh_token",
            "refresh_token": token.refresh_token,
            "client_id": self._client_id,
        }
        resp = http_request_json(
            "POST",
            f"{SPOTIFY_ACCOUNTS_BASE}/api/token",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            body=urllib.parse.urlencode(data).encode("utf-8"),
            allow_unauthorized=True,
        )
        access_token = resp.get("access_token")
        expires_in = float(resp.get("expires_in", 3600))
        refresh_token = str(resp.get("refresh_token", token.refresh_token))
        if not access_token:
            raise RuntimeError("Failed to refresh token")
        return OAuthToken(
            access_token=str(access_token),
            refresh_token=refresh_token,
            expires_at=_now() + expires_in,
        )


class _OAuthCallbackHandler(BaseHTTPRequestHandler):
    server_version = "SpotifyOAuthCallback/1.0"

    def do_GET(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        code = (qs.get("code") or [None])[0]
        state = (qs.get("state") or [None])[0]

        self.server.oauth_code = code  # type: ignore[attr-defined]
        self.server.oauth_state = state  # type: ignore[attr-defined]

        body = (
            "<html><body><h2>Spotify authorization received.</h2>"
            "<p>You can close this tab and return to the terminal.</p></body></html>"
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        return


def _start_local_callback_server(redirect_uri: str) -> HTTPServer:
    parsed = urllib.parse.urlparse(redirect_uri)
    if parsed.scheme != "http":
        raise SystemExit("redirect_uri must be http://127.0.0.1:<port>/... for the local callback server")

    host = parsed.hostname or "127.0.0.1"
    if host not in ("127.0.0.1", "localhost"):
        raise SystemExit("redirect_uri host must be localhost or 127.0.0.1")

    port = parsed.port or 8000
    server = HTTPServer((host, port), _OAuthCallbackHandler)
    server.oauth_code = None  # type: ignore[attr-defined]
    server.oauth_state = None  # type: ignore[attr-defined]
    return server


def _pkce_authorize_and_exchange(
    *,
    client_id: str,
    redirect_uri: str,
    token_store: TokenStore,
    open_browser: bool,
    copy_auth_url: bool,
    timeout_seconds: int = 300,
) -> OAuthToken:
    verifier = _b64url_no_pad(os.urandom(64))
    challenge = _b64url_no_pad(hashlib.sha256(verifier.encode("ascii")).digest())
    state = secrets.token_urlsafe(16)

    server = _start_local_callback_server(redirect_uri)

    params = {
        "client_id": client_id,
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "code_challenge_method": "S256",
        "code_challenge": challenge,
        "state": state,
        # No scopes needed for /v1/tracks.
        "show_dialog": "false",
    }
    auth_url = f"{SPOTIFY_ACCOUNTS_BASE}/authorize?{urllib.parse.urlencode(params)}"

    print("Open this URL to authorize (one line):", file=sys.stderr)
    print(auth_url, file=sys.stderr)

    if copy_auth_url and shutil.which("pbcopy"):
        try:
            subprocess.run(["pbcopy"], input=auth_url.encode("utf-8"), check=False)
            print("(Copied URL to clipboard via pbcopy)", file=sys.stderr)
        except Exception:
            pass

    if open_browser:
        try:
            webbrowser.open(auth_url, new=1, autoraise=True)
        except Exception:
            pass

    deadline = _now() + timeout_seconds
    try:
        while _now() < deadline:
            server.timeout = 1
            server.handle_request()
            code = getattr(server, "oauth_code", None)
            got_state = getattr(server, "oauth_state", None)
            if code:
                if got_state != state:
                    raise SystemExit("OAuth state mismatch; aborting.")
                break
        else:
            raise SystemExit("Timed out waiting for Spotify authorization callback.")
    finally:
        try:
            server.server_close()
        except Exception:
            pass

    code = getattr(server, "oauth_code", None)
    if not code:
        raise SystemExit("Missing authorization code from callback.")

    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "client_id": client_id,
        "code_verifier": verifier,
    }

    resp = http_request_json(
        "POST",
        f"{SPOTIFY_ACCOUNTS_BASE}/api/token",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        body=urllib.parse.urlencode(data).encode("utf-8"),
        allow_unauthorized=True,
    )

    access_token = resp.get("access_token")
    refresh_token = resp.get("refresh_token")
    expires_in = float(resp.get("expires_in", 3600))

    if not access_token or not refresh_token:
        raise SystemExit("Token exchange failed; missing access_token/refresh_token.")

    tok = OAuthToken(
        access_token=str(access_token),
        refresh_token=str(refresh_token),
        expires_at=_now() + expires_in,
    )
    token_store.save(tok)
    return tok


def _read_http_body(resp: urllib.response.addinfourl) -> bytes:
    return resp.read() or b""


def http_request_json(
    method: str,
    url: str,
    *,
    headers: Optional[Dict[str, str]] = None,
    body: Optional[bytes] = None,
    allow_unauthorized: bool = False,
) -> Dict[str, Any]:
    req = urllib.request.Request(url, data=body, method=method)
    for k, v in (headers or {}).items():
        req.add_header(k, v)

    try:
        with urllib.request.urlopen(req) as resp:
            raw = _read_http_body(resp)
            if not raw:
                return {}
            return json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read() or b""
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            payload = {"raw": raw.decode("utf-8", errors="replace")}

        if e.code == 401 and not allow_unauthorized:
            raise

        raise urllib.error.HTTPError(
            e.url,
            e.code,
            str(payload),
            e.headers,
            e.fp,
        )


def spotify_get_tracks(
    token_store: TokenStore,
    ids: List[str],
    *,
    throttle_ms: int = 250,
    max_retries: int = 10,
    max_wait_seconds: float = 600.0,
) -> List[Dict[str, Any]]:
    if not ids:
        return []

    url = f"{SPOTIFY_API_BASE}/v1/tracks?" + urllib.parse.urlencode({"ids": ",".join(ids)})

    last_err: Optional[Exception] = None
    for attempt in range(max_retries + 1):
        tok = token_store.ensure_valid()
        headers = {
            "Authorization": f"Bearer {tok.access_token}",
            "Accept": "application/json",
        }
        try:
            if throttle_ms > 0:
                time.sleep(throttle_ms / 1000.0)
            resp = http_request_json("GET", url, headers=headers)
            tracks = resp.get("tracks")
            return tracks if isinstance(tracks, list) else []
        except urllib.error.HTTPError as e:
            last_err = e

            retry_after = None
            try:
                if e.headers is not None:
                    ra = e.headers.get("Retry-After")
                    if ra:
                        retry_after = float(ra)
            except Exception:
                retry_after = None

            if e.code == 401 and attempt < max_retries:
                try:
                    refreshed = token_store.refresh(tok)
                    token_store.save(refreshed)
                    continue
                except Exception:
                    pass

            if e.code in (429, 500, 502, 503, 504) and attempt < max_retries:
                base = 1.0
                cap = 120.0
                jitter = 0.25 + (secrets.randbelow(1000) / 1000.0) * 0.75
                delay = min(cap, base * (2**attempt) * jitter)
                if retry_after is not None:
                    delay = max(delay, retry_after)
                if e.code == 429 and delay > float(max_wait_seconds):
                    raise RateLimitWaitTooLong(delay)
                print(f"HTTP {e.code} from Spotify; retrying in {delay:.1f}s...", file=sys.stderr)
                time.sleep(delay)
                continue

            raise
        except Exception as e:
            last_err = e
            if attempt < max_retries:
                base = 1.0
                cap = 60.0
                jitter = 0.25 + (secrets.randbelow(1000) / 1000.0) * 0.75
                delay = min(cap, base * (2**attempt) * jitter)
                print(f"Request error; retrying in {delay:.1f}s... ({e})", file=sys.stderr)
                time.sleep(delay)
                continue
            raise

    if last_err:
        raise last_err
    return []


def chunks(seq: List[str], size: int) -> Iterable[List[str]]:
    for i in range(0, len(seq), size):
        yield seq[i : i + size]


def _load_isrc_cache(path: Path) -> Dict[str, Optional[str]]:
    if not path.exists():
        return {}
    try:
        obj = json.loads(_read_text(path))
        if isinstance(obj, dict):
            out: Dict[str, Optional[str]] = {}
            for k, v in obj.items():
                if isinstance(k, str) and _is_spotify_track_id(k):
                    if v is None or isinstance(v, str):
                        out[k] = v
            return out
    except Exception:
        return {}
    return {}


def _save_isrc_cache(path: Path, cache: Dict[str, Optional[str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(cache, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(
        description=(
            "Enrich playlist JSON items with ISRC (via Spotify Web API /v1/tracks) using existing spotifyId fields. "
            "Writes enriched JSON to stdout; progress/stats go to stderr."
        )
    )
    p.add_argument("--json", dest="json_path", required=True, help="Input JSON file path (e.g. public/local-playlist.json)")
    p.add_argument(
        "--json-path",
        dest="json_path_expr",
        default="",
        help=(
            "Optional dotted path to a specific items list (e.g. user__wave_alternatives.items). "
            "If omitted, all '<playlist>.items' arrays under the root object are processed."
        ),
    )
    p.add_argument("--field", dest="field", default="isrc", help="Field name to write (default: isrc)")

    p.add_argument("--client-id", default="", help="Spotify app client ID (overrides .spotify.env)")
    p.add_argument("--env-file", default="", help="Path to .spotify.env (optional)")
    p.add_argument(
        "--redirect-uri",
        default="http://127.0.0.1:8000/",
        help="Must match a Redirect URI configured in your Spotify app.",
    )
    p.add_argument(
        "--open-browser",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Open the Spotify auth URL in a browser.",
    )
    p.add_argument(
        "--copy-auth-url",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="Copy the Spotify auth URL to clipboard (macOS pbcopy).",
    )
    p.add_argument(
        "--token",
        default=str(Path(__file__).resolve().parent / ".spotify-oauth-token.json"),
        help="Path to token cache (default: utility/.spotify-oauth-token.json)",
    )
    p.add_argument(
        "--throttle-ms",
        type=int,
        default=250,
        help="Minimum delay between Spotify API requests.",
    )
    p.add_argument(
        "--cache",
        default=str(Path(__file__).resolve().parent / ".spotify-isrc-cache.json"),
        help="Path to ISRC cache/checkpoint (default: utility/.spotify-isrc-cache.json)",
    )
    p.add_argument(
        "--max-wait-seconds",
        type=float,
        default=600.0,
        help="If Spotify responds with Retry-After larger than this, stop and exit after writing partial output.",
    )

    args = p.parse_args(argv)

    json_path = Path(args.json_path)
    data = json.loads(json_path.read_text(encoding="utf-8"))
    data_out = deepcopy(data)

    items_lists = _iter_items_lists(data_out, args.json_path_expr)

    # Collect unique spotify IDs that are missing ISRC.
    field_name = str(args.field or "isrc")

    all_ids: List[str] = []
    total_items = 0
    already = 0
    missing_spotify = 0

    for _, items in items_lists:
        total_items += len(items)
        for it in items:
            if not isinstance(it, dict):
                continue
            if isinstance(it.get(field_name), str) and it.get(field_name):
                already += 1
                continue
            sid = _extract_spotify_id(it)
            if sid:
                all_ids.append(sid)
            else:
                missing_spotify += 1

    unique_ids = sorted(set(all_ids))

    if not unique_ids:
        print(json.dumps(data_out, ensure_ascii=False, indent=2) + "\n")
        print(
            json.dumps(
                {
                    "items_total": total_items,
                    "spotify_ids": 0,
                    "enriched": 0,
                    "already_had_isrc": already,
                    "missing_spotifyId": missing_spotify,
                },
                indent=2,
            ),
            file=sys.stderr,
        )
        return 0

    client_id = _find_spotify_client_id(args.env_file or None, args.client_id or None)
    token_store = TokenStore(Path(args.token).expanduser(), client_id)

    tok = token_store.load()
    if tok is None:
        _pkce_authorize_and_exchange(
            client_id=client_id,
            redirect_uri=args.redirect_uri,
            token_store=token_store,
            open_browser=bool(args.open_browser),
            copy_auth_url=bool(args.copy_auth_url),
        )
    else:
        token_store.ensure_valid()

    cache_path = Path(args.cache).expanduser()
    isrc_cache = _load_isrc_cache(cache_path)

    fetched = 0
    incomplete_due_to_rate_limit: Optional[float] = None

    pending_ids = [sid for sid in unique_ids if sid not in isrc_cache]

    # Spotify /v1/tracks supports up to 50 IDs per request.
    for batch in chunks(pending_ids, 50):
        try:
            tracks = spotify_get_tracks(
                token_store,
                batch,
                throttle_ms=int(args.throttle_ms),
                max_wait_seconds=float(args.max_wait_seconds),
            )
        except RateLimitWaitTooLong as e:
            incomplete_due_to_rate_limit = e.wait_seconds
            break

        fetched += len(batch)
        # Spotify returns a list aligned with ids; unknown ids become null.
        for i, t in enumerate(tracks):
            sid = batch[i] if i < len(batch) else None
            if not sid:
                continue
            if not isinstance(t, dict):
                isrc_cache[sid] = None
                continue
            ext = t.get("external_ids")
            isrc = ext.get("isrc") if isinstance(ext, dict) else None
            isrc_cache[sid] = isrc if isinstance(isrc, str) and isrc else None

        _save_isrc_cache(cache_path, isrc_cache)

    enriched = 0
    not_found = 0

    for _, items in items_lists:
        for it in items:
            if not isinstance(it, dict):
                continue
            if isinstance(it.get(field_name), str) and it.get(field_name):
                continue
            sid = _extract_spotify_id(it)
            if not sid:
                continue
            isrc = isrc_cache.get(sid)
            if isrc:
                it[field_name] = isrc
                enriched += 1
            else:
                not_found += 1

    print(json.dumps(data_out, ensure_ascii=False, indent=2) + "\n")

    print(
        json.dumps(
            {
                "items_total": total_items,
                "spotify_ids_unique": len(unique_ids),
                "spotify_ids_cached": sum(1 for v in isrc_cache.values() if isinstance(v, str) and v),
                "fetched_ids": fetched,
                "enriched": enriched,
                "already_had_isrc": already,
                "missing_spotifyId": missing_spotify,
                "not_found_in_spotify": not_found,
                "incomplete": bool(incomplete_due_to_rate_limit),
                "rate_limited_wait_seconds": incomplete_due_to_rate_limit,
            },
            indent=2,
        ),
        file=sys.stderr,
    )

    return 2 if incomplete_due_to_rate_limit else 0


if __name__ == "__main__":
    raise SystemExit(main())
