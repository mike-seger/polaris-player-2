#!/usr/bin/env python3
"""Development web server that disables HTTP caching."""
import argparse
import os
import re
from datetime import datetime, timezone
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler


class NoCacheRequestHandler(SimpleHTTPRequestHandler):
    """Serve files while forcing clients to re-download every time."""

    # Keep the default protocol behavior. We rely on explicit Content-Length/
    # Range responses rather than persistent connections.

    _RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")

    def log_date_time_string(self):
        # ISO 8601, UTC
        return datetime.now(timezone.utc).isoformat(timespec="seconds")

    def end_headers(self):
        # Prevent the browser from reusing cached responses so assets always refresh.
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        # Identifies this server vs `python -m http.server`.
        self.send_header("X-Polaris-No-Cache-Server", "1")
        # Allow all CORS requests
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, HEAD")
        self.send_header("Access-Control-Allow-Headers", "*")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def handle(self):
        # Browsers commonly abort in-flight responses during seeks/source switches.
        # Avoid printing full tracebacks for normal disconnects.
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            return

    def copyfile(self, source, outputfile):
        # SimpleHTTPRequestHandler streams files via shutil.copyfileobj.
        # When the browser cancels a request (seek, stop, source switch), the
        # socket can raise BrokenPipe/ConnectionReset; treat that as normal.
        try:
            super().copyfile(source, outputfile)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            return

    def send_head(self):
        # Mostly based on SimpleHTTPRequestHandler, but with explicit Range support
        # (needed for smooth <video> seeking on some setups).
        path = self.translate_path(self.path)

        if os.path.isdir(path):
            parts = self.path.split('?', 1)
            self.path = parts[0]
            for index in ("index.html", "index.htm"):
                index_path = os.path.join(path, index)
                if os.path.exists(index_path):
                    path = index_path
                    break
            else:
                return self.list_directory(path)

        ctype = self.guess_type(path)
        try:
            f = open(path, 'rb')
        except OSError:
            self.send_error(404, "File not found")
            return None

        try:
            fs = os.fstat(f.fileno())
            size = fs.st_size
            range_header = self.headers.get('Range')
            if range_header:
                m = self._RANGE_RE.match(range_header.strip())
                if not m:
                    # Malformed Range
                    self.send_error(400, "Invalid Range header")
                    f.close()
                    return None

                start_s, end_s = m.group(1), m.group(2)
                if start_s == '' and end_s == '':
                    self.send_error(400, "Invalid Range header")
                    f.close()
                    return None

                if start_s == '':
                    # suffix bytes: -N
                    suffix_len = int(end_s)
                    if suffix_len <= 0:
                        self.send_error(416, "Requested Range Not Satisfiable")
                        f.close()
                        return None
                    start = max(0, size - suffix_len)
                    end = size - 1
                else:
                    start = int(start_s)
                    end = int(end_s) if end_s != '' else size - 1

                if start < 0 or start >= size or end < start:
                    self.send_response(416)
                    self.send_header('Content-Range', f'bytes */{size}')
                    self.send_header('Accept-Ranges', 'bytes')
                    self.end_headers()
                    f.close()
                    return None

                end = min(end, size - 1)
                length = end - start + 1

                self.send_response(206)
                self.send_header('Content-type', ctype)
                self.send_header('Accept-Ranges', 'bytes')
                self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
                self.send_header('Content-Length', str(length))
                self.send_header('Last-Modified', self.date_time_string(fs.st_mtime))
                self.end_headers()

                f.seek(start)

                # Wrap file so copyfile only sends the requested segment.
                class _RangeFile:
                    def __init__(self, fp, remaining):
                        self._fp = fp
                        self._remaining = remaining
                    def read(self, n=-1):
                        if self._remaining <= 0:
                            return b''
                        if n is None or n < 0 or n > self._remaining:
                            n = self._remaining
                        data = self._fp.read(n)
                        self._remaining -= len(data)
                        return data
                    def close(self):
                        return self._fp.close()

                return _RangeFile(f, length)

            # No Range: serve whole file.
            self.send_response(200)
            self.send_header('Content-type', ctype)
            self.send_header('Content-Length', str(size))
            self.send_header('Last-Modified', self.date_time_string(fs.st_mtime))
            self.send_header('Accept-Ranges', 'bytes')
            self.end_headers()
            return f
        except Exception:
            f.close()
            raise


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
    # Threaded server prevents request serialization (important for pages with
    # many assets).
    httpd = ThreadingHTTPServer(server_address, handler)

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
