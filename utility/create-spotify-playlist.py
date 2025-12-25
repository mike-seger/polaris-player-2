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
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


SPOTIFY_ACCOUNTS_BASE = "https://accounts.spotify.com"
SPOTIFY_API_BASE = "https://api.spotify.com"


def _b64url_no_pad(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _now() -> float:
    return time.time()


def _is_spotify_track_id(value: str) -> bool:
    if not isinstance(value, str):
        return False
    s = value.strip()
    if len(s) != 22:
        return False
    # Base62-ish. Spotify track IDs are typically [0-9A-Za-z].
    for ch in s:
        if not ("0" <= ch <= "9" or "A" <= ch <= "Z" or "a" <= ch <= "z"):
            return False
    return True


def _track_uri_from_any(value: str) -> Optional[str]:
    if not isinstance(value, str):
        return None
    s = value.strip()
    if _is_spotify_track_id(s):
        return f"spotify:track:{s}"
    if s.startswith("spotify:track:"):
        tid = s.split(":")[-1]
        return f"spotify:track:{tid}" if _is_spotify_track_id(tid) else None
    if "open.spotify.com/track/" in s:
        try:
            parsed = urllib.parse.urlparse(s)
            parts = [p for p in parsed.path.split("/") if p]
            if len(parts) >= 2 and parts[0] == "track":
                tid = parts[1]
                return f"spotify:track:{tid}" if _is_spotify_track_id(tid) else None
        except Exception:
            return None
    return None


def _extract_track_uri(item: Any) -> Optional[str]:
    if not isinstance(item, dict):
        return None

    # Common fields in this repo: spotifyId
    candidates: List[Any] = []
    for key in (
        "spotifyId",
        "spotify_id",
        "spotifyTrackId",
        "spotifyTrackID",
        "spotifyUri",
        "spotifyURI",
        "spotifyTrackUri",
        "spotifyTrackURI",
        "trackUri",
        "uri",
        "id",
        "trackId",
    ):
        if key in item:
            candidates.append(item.get(key))

    # Some items may nest data
    for parent_key in ("spotify", "track"):
        parent = item.get(parent_key)
        if isinstance(parent, dict):
            for key in ("id", "uri", "spotifyId", "spotifyUri"):
                if key in parent:
                    candidates.append(parent.get(key))

    for cand in candidates:
        if isinstance(cand, str):
            uri = _track_uri_from_any(cand)
            if uri:
                return uri

    return None


def _sha256_of_lines(lines: Iterable[str]) -> str:
    h = hashlib.sha256()
    for line in lines:
        h.update(line.encode("utf-8"))
        h.update(b"\n")
    return h.hexdigest()


def _read_text_file(path: Path) -> str:
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
    candidates = []
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
            env = _parse_env_assignments(_read_text_file(p))
            for key in (
                "clientID",
                "CLIENT_ID",
                "SPOTIFY_CLIENT_ID",
                "spotifyClientId",
                "SPOTIFY_CLIENTID",
            ):
                v = env.get(key)
                if v:
                    return v.strip()

    raise SystemExit(
        "Missing Spotify client ID. Create .spotify.env with clientID=<your_spotify_app_client_id> "
        "(or set SPOTIFY_CLIENT_ID), or pass --client-id."
    )


def _navigate_json_path(root: Any, path: str) -> Any:
    cur = root
    for key in [p for p in path.split(".") if p]:
        if isinstance(cur, dict):
            if key not in cur:
                raise KeyError(f"Missing key '{key}' while resolving path '{path}'.")
            cur = cur[key]
        else:
            raise TypeError(f"Cannot resolve key '{key}' on non-object while resolving path '{path}'.")
    return cur


def _guess_items_path(root: Any) -> str:
    if not isinstance(root, dict):
        raise SystemExit("JSON root is not an object; please provide --path.")

    candidates: List[str] = []
    for k, v in root.items():
        if not isinstance(v, dict):
            continue
        items = v.get("items")
        if not isinstance(items, list) or not items:
            continue
        # must contain at least one spotifyId-like
        if any(_extract_track_uri(it) for it in items[:50]):
            candidates.append(f"{k}.items")

    if len(candidates) == 1:
        return candidates[0]

    if not candidates:
        raise SystemExit("Could not find any '<playlist>.items' containing Spotify IDs; please provide --path.")

    raise SystemExit(
        "Multiple candidate playlists found; please provide --path. Candidates:\n  "
        + "\n  ".join(candidates)
    )


@dataclass
class OAuthToken:
    access_token: str
    refresh_token: str
    expires_at: float
    scope: str = ""
    token_type: str = "Bearer"

    @staticmethod
    def from_json(obj: Dict[str, Any]) -> "OAuthToken":
        return OAuthToken(
            access_token=str(obj.get("access_token", "")),
            refresh_token=str(obj.get("refresh_token", "")),
            expires_at=float(obj.get("expires_at", 0)),
            scope=str(obj.get("scope", "")),
            token_type=str(obj.get("token_type", "Bearer")),
        )

    def to_json(self) -> Dict[str, Any]:
        return {
            "access_token": self.access_token,
            "refresh_token": self.refresh_token,
            "expires_at": self.expires_at,
            "scope": self.scope,
            "token_type": self.token_type,
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
        obj = json.loads(_read_text_file(self._token_path))
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

    def force_refresh(self) -> OAuthToken:
        if self._token is None:
            self.load()
        if self._token is None:
            raise RuntimeError("No token loaded")
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
        scope = str(resp.get("scope", token.scope or ""))
        token_type = str(resp.get("token_type", token.token_type or "Bearer"))
        refresh_token = str(resp.get("refresh_token", token.refresh_token))

        if not access_token:
            raise RuntimeError("Failed to refresh token")

        return OAuthToken(
            access_token=str(access_token),
            refresh_token=refresh_token,
            expires_at=_now() + expires_in,
            scope=scope,
            token_type=token_type,
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
        # quiet
        return


def _start_local_callback_server(redirect_uri: str) -> Tuple[HTTPServer, str, int]:
    parsed = urllib.parse.urlparse(redirect_uri)
    if parsed.scheme not in ("http",):
        raise SystemExit("redirect_uri must be http://127.0.0.1:<port>/... for the local callback server")

    host = parsed.hostname or "localhost"
    if host not in ("localhost", "127.0.0.1"):
        raise SystemExit("redirect_uri host must be localhost")

    port = parsed.port or 8888
    server = HTTPServer((host, port), _OAuthCallbackHandler)
    # attach dynamic attrs
    server.oauth_code = None  # type: ignore[attr-defined]
    server.oauth_state = None  # type: ignore[attr-defined]
    return server, host, port


def _pkce_authorize_and_exchange(
    *,
    client_id: str,
    redirect_uri: str,
    scope: str,
    token_store: TokenStore,
    open_browser: bool,
    copy_auth_url: bool,
    timeout_seconds: int = 300,
) -> OAuthToken:
    verifier = _b64url_no_pad(os.urandom(64))
    challenge = _b64url_no_pad(hashlib.sha256(verifier.encode("ascii")).digest())
    state = secrets.token_urlsafe(16)

    server, host, port = _start_local_callback_server(redirect_uri)

    params = {
        "client_id": client_id,
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "code_challenge_method": "S256",
        "code_challenge": challenge,
        "state": state,
        "scope": scope,
        "show_dialog": "false",
    }
    auth_url = f"{SPOTIFY_ACCOUNTS_BASE}/authorize?{urllib.parse.urlencode(params)}"

    print("Open this URL to authorize (one line):")
    print(auth_url)

    if copy_auth_url and shutil.which("pbcopy"):
        try:
            subprocess.run(["pbcopy"], input=auth_url.encode("utf-8"), check=False)
            print("(Copied URL to clipboard via pbcopy)")
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
    token_type = str(resp.get("token_type", "Bearer"))
    scope_out = str(resp.get("scope", scope))

    if not access_token or not refresh_token:
        raise SystemExit("Token exchange failed; missing access_token/refresh_token.")

    tok = OAuthToken(
        access_token=str(access_token),
        refresh_token=str(refresh_token),
        expires_at=_now() + expires_in,
        scope=scope_out,
        token_type=token_type,
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


def spotify_api_json(
    token_store: TokenStore,
    method: str,
    path: str,
    *,
    query: Optional[Dict[str, Any]] = None,
    body_obj: Optional[Dict[str, Any]] = None,
    max_retries: int = 10,
    throttle_ms: int = 250,
) -> Dict[str, Any]:
    url = f"{SPOTIFY_API_BASE}{path}"
    if query:
        url += "?" + urllib.parse.urlencode({k: str(v) for k, v in query.items() if v is not None})

    last_err: Optional[Exception] = None
    for attempt in range(max_retries + 1):
        tok = token_store.ensure_valid()
        headers = {
            "Authorization": f"Bearer {tok.access_token}",
            "Accept": "application/json",
        }
        body: Optional[bytes] = None
        if body_obj is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(body_obj).encode("utf-8")

        try:
            if throttle_ms > 0:
                time.sleep(throttle_ms / 1000.0)
            return http_request_json(method, url, headers=headers, body=body)
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

            # 401: refresh and retry once
            if e.code == 401 and attempt < max_retries:
                try:
                    token_store.force_refresh()
                    continue
                except Exception:
                    pass

            # 429 and 5xx: backoff and retry
            if e.code in (429, 500, 502, 503, 504) and attempt < max_retries:
                base = 1.0
                cap = 120.0
                jitter = 0.25 + (secrets.randbelow(1000) / 1000.0) * 0.75
                delay = min(cap, base * (2**attempt) * jitter)
                if retry_after is not None:
                    delay = max(delay, retry_after)
                print(f"HTTP {e.code} from Spotify; retrying in {delay:.1f}s...")
                time.sleep(delay)
                continue

            # otherwise, fail
            raise
        except Exception as e:
            last_err = e
            if attempt < max_retries:
                base = 1.0
                cap = 60.0
                jitter = 0.25 + (secrets.randbelow(1000) / 1000.0) * 0.75
                delay = min(cap, base * (2**attempt) * jitter)
                print(f"Request error; retrying in {delay:.1f}s... ({e})")
                time.sleep(delay)
                continue
            raise

    if last_err:
        raise last_err
    raise RuntimeError("Unexpected request failure")


def _spotify_get_me(token_store: TokenStore, throttle_ms: int) -> Dict[str, Any]:
    return spotify_api_json(token_store, "GET", "/v1/me", throttle_ms=throttle_ms)


def _spotify_find_playlist_by_name(
    token_store: TokenStore, name: str, throttle_ms: int
) -> Optional[Dict[str, Any]]:
    limit = 50
    offset = 0
    while True:
        page = spotify_api_json(
            token_store,
            "GET",
            "/v1/me/playlists",
            query={"limit": limit, "offset": offset},
            throttle_ms=throttle_ms,
        )
        items = page.get("items")
        if not isinstance(items, list):
            return None
        for pl in items:
            if isinstance(pl, dict) and pl.get("name") == name:
                return pl
        if page.get("next") is None:
            return None
        offset += limit


def _spotify_unfollow_playlist(token_store: TokenStore, playlist_id: str, throttle_ms: int) -> None:
    spotify_api_json(
        token_store,
        "DELETE",
        f"/v1/playlists/{playlist_id}/followers",
        throttle_ms=throttle_ms,
    )


def _spotify_create_playlist(
    token_store: TokenStore,
    user_id: str,
    name: str,
    public: bool,
    description: str,
    throttle_ms: int,
) -> Dict[str, Any]:
    return spotify_api_json(
        token_store,
        "POST",
        f"/v1/users/{user_id}/playlists",
        body_obj={"name": name, "public": bool(public), "description": description},
        throttle_ms=throttle_ms,
    )


def _spotify_add_tracks(
    token_store: TokenStore, playlist_id: str, uris: List[str], throttle_ms: int
) -> Dict[str, Any]:
    return spotify_api_json(
        token_store,
        "POST",
        f"/v1/playlists/{playlist_id}/tracks",
        body_obj={"uris": uris},
        throttle_ms=throttle_ms,
    )


def _default_checkpoint_path() -> Path:
    return Path(__file__).resolve().parent / ".spotify-playlist-checkpoint.json"


def _default_token_path() -> Path:
    return Path(__file__).resolve().parent / ".spotify-oauth-token.json"


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Create a (public) Spotify playlist from polaris-player-2 JSON items (expects spotifyId fields)."
    )
    ap.add_argument("--json", required=True, help="Path to playlist JSON (e.g. public/local-playlist.json)")
    ap.add_argument(
        "--path",
        default="",
        help="Dot-path to the items array (e.g. user__wave_alternatives.items). If omitted, script will try to guess.",
    )
    ap.add_argument(
        "--name",
        default="",
        help="Target playlist name. If omitted, uses the JSON playlist's title.",
    )
    ap.add_argument(
        "--replace",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Replace (unfollow) any existing playlist with the same name when starting fresh.",
    )
    ap.add_argument(
        "--resume",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Resume a previously-started run using the checkpoint file.",
    )
    ap.add_argument(
        "--checkpoint",
        default="",
        help="Path to checkpoint file (default: utility/.spotify-playlist-checkpoint.json)",
    )
    ap.add_argument(
        "--token",
        default="",
        help="Path to token cache (default: utility/.spotify-oauth-token.json)",
    )
    ap.add_argument(
        "--public",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Create a public playlist.",
    )
    ap.add_argument(
        "--description",
        default="Created by polaris-player-2 utility/create-spotify-playlist.py",
        help="Playlist description.",
    )
    ap.add_argument("--client-id", default="", help="Spotify app client ID (overrides .spotify.env)")
    ap.add_argument("--env-file", default="", help="Path to .spotify.env (optional)")
    ap.add_argument(
        "--redirect-uri",
        default="http://127.0.0.1:8888/callback",
        help="Must match a Redirect URI configured in your Spotify app.",
    )
    ap.add_argument(
        "--open-browser",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Open the Spotify auth URL in a browser.",
    )
    ap.add_argument(
        "--copy-auth-url",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="Copy the Spotify auth URL to clipboard (macOS pbcopy) to avoid line-wrap copy issues.",
    )
    ap.add_argument(
        "--throttle-ms",
        type=int,
        default=250,
        help="Minimum delay between Spotify API requests.",
    )

    args = ap.parse_args()

    json_path = Path(args.json)
    if not json_path.exists():
        raise SystemExit(f"JSON file not found: {json_path}")

    root = json.loads(_read_text_file(json_path))
    items_path = args.path.strip() or _guess_items_path(root)

    # For title inference, if path ends with .items
    playlist_obj: Optional[Dict[str, Any]] = None
    if items_path.endswith(".items"):
        prefix = items_path[: -len(".items")].rstrip(".")
        try:
            obj = _navigate_json_path(root, prefix)
            if isinstance(obj, dict):
                playlist_obj = obj
        except Exception:
            playlist_obj = None

    items = _navigate_json_path(root, items_path)
    if not isinstance(items, list):
        raise SystemExit(f"Resolved --path '{items_path}' but it is not an array.")

    title = ""
    if isinstance(playlist_obj, dict):
        t = playlist_obj.get("title")
        if isinstance(t, str):
            title = t

    playlist_name = (args.name or title).strip()
    if not playlist_name:
        raise SystemExit("Missing playlist name. Provide --name or ensure JSON contains a title.")

    uris: List[str] = []
    skipped = 0
    for it in items:
        uri = _extract_track_uri(it)
        if uri:
            uris.append(uri)
        else:
            skipped += 1

    if not uris:
        raise SystemExit(f"No Spotify track IDs found at '{items_path}'.")

    uri_hash = _sha256_of_lines(uris)

    checkpoint_path = Path(args.checkpoint).expanduser() if args.checkpoint else _default_checkpoint_path()
    token_path = Path(args.token).expanduser() if args.token else _default_token_path()

    client_id = _find_spotify_client_id(args.env_file or None, args.client_id or None)
    token_store = TokenStore(token_path, client_id)

    # Minimum needed for this script:
    # - create playlist (public/private)
    # - add tracks
    # - list playlists by name
    scope = "playlist-modify-public playlist-modify-private playlist-read-private"

    checkpoint: Dict[str, Any] = {}
    if args.resume and checkpoint_path.exists():
        try:
            checkpoint = json.loads(_read_text_file(checkpoint_path))
        except Exception:
            checkpoint = {}

    def checkpoint_matches(cp: Dict[str, Any]) -> bool:
        return (
            cp.get("source_json") == str(json_path)
            and cp.get("source_path") == items_path
            and cp.get("playlist_name") == playlist_name
            and cp.get("uri_hash") == uri_hash
            and isinstance(cp.get("playlist_id"), str)
        )

    resuming = (
        args.resume
        and isinstance(checkpoint, dict)
        and checkpoint_matches(checkpoint)
        and checkpoint.get("status") == "in_progress"
    )

    # Ensure we have a token (refresh if cached)
    tok = token_store.load()
    if tok is None:
        tok = _pkce_authorize_and_exchange(
            client_id=client_id,
            redirect_uri=args.redirect_uri,
            scope=scope,
            token_store=token_store,
            open_browser=bool(args.open_browser),
            copy_auth_url=bool(args.copy_auth_url),
        )
    else:
        token_store.ensure_valid()

    me = _spotify_get_me(token_store, throttle_ms=args.throttle_ms)
    user_id = me.get("id")
    if not isinstance(user_id, str) or not user_id:
        raise SystemExit("Failed to get Spotify user ID from /v1/me")

    playlist_id: Optional[str] = None
    next_index = 0

    if resuming:
        playlist_id = str(checkpoint.get("playlist_id"))
        next_index = int(checkpoint.get("next_index", 0))
        total = int(checkpoint.get("total", len(uris)))
        print(f"Resuming: playlist_id={playlist_id}, next_index={next_index}/{total}")
    else:
        existing = _spotify_find_playlist_by_name(token_store, playlist_name, throttle_ms=args.throttle_ms)
        if existing and args.replace:
            old_id = existing.get("id")
            if isinstance(old_id, str) and old_id:
                print(f"Unfollowing existing playlist '{playlist_name}' ({old_id})")
                _spotify_unfollow_playlist(token_store, old_id, throttle_ms=args.throttle_ms)

        created = _spotify_create_playlist(
            token_store,
            user_id,
            playlist_name,
            public=bool(args.public),
            description=str(args.description or ""),
            throttle_ms=args.throttle_ms,
        )
        playlist_id = created.get("id")
        if not isinstance(playlist_id, str) or not playlist_id:
            raise SystemExit("Failed to create playlist (missing id)")

        checkpoint = {
            "status": "in_progress",
            "created_at": int(_now()),
            "source_json": str(json_path),
            "source_path": items_path,
            "playlist_name": playlist_name,
            "playlist_id": playlist_id,
            "public": bool(args.public),
            "total": len(uris),
            "next_index": 0,
            "skipped_items": skipped,
            "uri_hash": uri_hash,
        }
        checkpoint_path.write_text(json.dumps(checkpoint, indent=2) + "\n", encoding="utf-8")
        print(f"Created playlist '{playlist_name}' ({playlist_id})")

    assert playlist_id is not None

    total = len(uris)
    if next_index >= total:
        print("Nothing to do; checkpoint already complete.")
        checkpoint["status"] = "completed"
        checkpoint["completed_at"] = int(_now())
        checkpoint_path.write_text(json.dumps(checkpoint, indent=2) + "\n", encoding="utf-8")
        return 0

    # Add in batches of 100.
    batch_size = 100
    i = next_index
    while i < total:
        batch = uris[i : i + batch_size]
        print(f"Adding tracks {i + 1}-{min(i + len(batch), total)} of {total}...")
        _spotify_add_tracks(token_store, playlist_id, batch, throttle_ms=args.throttle_ms)
        i += len(batch)
        checkpoint["next_index"] = i
        checkpoint_path.write_text(json.dumps(checkpoint, indent=2) + "\n", encoding="utf-8")

    checkpoint["status"] = "completed"
    checkpoint["completed_at"] = int(_now())
    checkpoint_path.write_text(json.dumps(checkpoint, indent=2) + "\n", encoding="utf-8")

    print(f"Done. Added {total} tracks to '{playlist_name}'. Skipped items without Spotify IDs: {skipped}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
