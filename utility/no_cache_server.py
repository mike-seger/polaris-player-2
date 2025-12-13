#!/usr/bin/env python3
"""Development web server that disables HTTP caching."""
import argparse
from datetime import datetime, timezone
from functools import partial
from http.server import HTTPServer, SimpleHTTPRequestHandler


class NoCacheRequestHandler(SimpleHTTPRequestHandler):
    """Serve files while forcing clients to re-download every time."""

    def log_date_time_string(self):
        # ISO 8601, UTC
        return datetime.now(timezone.utc).isoformat(timespec="seconds")

    def end_headers(self):
        # Prevent the browser from reusing cached responses so assets always refresh.
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve files without HTTP caching.")
    parser.add_argument("--port", type=int, default=8000, help="Port to bind to (default: 8000)")
    parser.add_argument("--directory", default="public", help="Directory to serve (default: public)")
    parser.add_argument("--bind", default="0.0.0.0", help="Interface to bind (default: 0.0.0.0)")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    server_address = (args.bind, args.port)
    handler = partial(NoCacheRequestHandler, directory=args.directory)
    httpd = HTTPServer(server_address, handler)

    host_for_print = "localhost" if args.bind in ("0.0.0.0", "127.0.0.1") else args.bind
    print(f"Serving no-cache HTTP on http://{host_for_print}:{args.port}/ (dir: {args.directory})")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server...")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
