"""Loopback-only HTTP API and static frontend hosting."""

from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import mimetypes
import os
from pathlib import Path
import re
import socket
import stat
from urllib.parse import unquote, urlsplit

from .schema import InvalidDocument, MAX_BYTES, decode_document
from .storage import DashboardStore, StoreError, validate_name
from .filesystem import (NONBLOCK, close_directory, duplicate_directory, open_directory,
                         open_file, subdirectory)

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' http: https: ws: wss:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
}


class DashboardHTTPServer(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True
    allow_reuse_address = True

    def __init__(self, address, store, static_dir, allowed_origins=()):
        host, _port = address
        try:
            if not ipaddress.ip_address(host).is_loopback:
                raise ValueError
        except ValueError as error:
            raise ValueError("Bind host must be a literal loopback address (127.0.0.1 or ::1)") from error
        self.address_family = socket.AF_INET6 if ":" in host else socket.AF_INET
        self.store = store
        self.static_dir = Path(static_dir)
        self.allowed_origins = frozenset(allowed_origins)
        for origin in self.allowed_origins:
            parsed = urlsplit(origin)
            if parsed.port is not None and not 1 <= parsed.port <= 65535:
                raise ValueError("Additional origin port is invalid")
            if parsed.scheme != "http" or parsed.hostname not in ("localhost", "127.0.0.1", "::1") or parsed.path or parsed.query or parsed.fragment or parsed.username or parsed.password:
                raise ValueError("Additional origins must be exact local HTTP origins")
        super().__init__(address, DashboardHandler)


class DashboardHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "AtlasDashboard/1"
    sys_version = ""
    timeout = 10

    def setup(self):
        super().setup()
        self.connection.settimeout(self.timeout)

    def log_message(self, _format, *args):
        # Avoid logging dashboard names, query strings, or private content.
        pass

    def _send(self, status, payload=b"", content_type="application/json; charset=utf-8", headers=None):
        self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Connection", "close")
        self.send_header("Cache-Control", "no-store")
        for key, value in SECURITY_HEADERS.items():
            self.send_header(key, value)
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD" and status != 204:
            self.wfile.write(payload)

    def _json(self, status, value, headers=None):
        self._send(status, json.dumps(value, ensure_ascii=False).encode("utf-8"), headers=headers)

    def _error(self, status, message):
        self._json(status, {"detail": {"message": message}})

    def _single_header(self, name):
        values = self.headers.get_all(name, [])
        if len(values) > 1:
            raise StoreError(400, f"Duplicate {name} headers are not supported")
        return values[0] if values else None

    def _check_origin(self):
        port = self.server.server_address[1]
        accepted_hosts = {f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}"}
        if port == 80:
            accepted_hosts.update(("127.0.0.1", "localhost", "[::1]"))
        host = self._single_header("Host")
        if host not in accepted_hosts:
            raise StoreError(403, "Only a local loopback Host is allowed")
        origin = self._single_header("Origin")
        local_origins = {"http://" + host for host in accepted_hosts}
        if origin is not None and origin not in local_origins | self.server.allowed_origins:
            raise StoreError(403, "This request origin is not allowed")
        navigation = (self.command in ("GET", "HEAD")
                      and self.headers.get("Sec-Fetch-Mode") == "navigate"
                      and self.headers.get("Sec-Fetch-Dest") == "document"
                      and not self.path.startswith("/dashboards"))
        if self.headers.get("Sec-Fetch-Site") == "cross-site" and origin not in self.server.allowed_origins and not navigation:
            raise StoreError(403, "Cross-site requests are not allowed")

    def _route(self):
        try:
            parsed = urlsplit(self.path)
        except ValueError as error:
            raise StoreError(400, "Invalid request path") from error
        if parsed.scheme or parsed.netloc or parsed.fragment:
            raise StoreError(400, "Only relative request paths are supported")
        if re.search(r"%(?![0-9a-fA-F]{2})", parsed.path):
            raise StoreError(400, "Invalid URL encoding")
        try:
            path = unquote(parsed.path, encoding="utf-8", errors="strict")
        except UnicodeError as error:
            raise StoreError(400, "Invalid UTF-8 URL") from error
        if path == "/dashboards":
            return "list", None
        if path.startswith("/dashboards/"):
            return "document", validate_name(path[len("/dashboards/"):])
        return "static", path

    def _read_exact(self, size):
        payload = self.rfile.read(size)
        if len(payload) != size:
            raise StoreError(400, "Incomplete request body")
        return payload

    def _line(self, limit=8192):
        line = self.rfile.readline(limit + 1)
        if len(line) > limit or not line.endswith(b"\r\n"):
            raise StoreError(400, "Malformed chunked request")
        return line[:-2]

    def _body(self):
        content_type = self._single_header("Content-Type")
        if not content_type or content_type.split(";", 1)[0].strip().lower() != "application/json":
            raise StoreError(415, "Use Content-Type: application/json")
        if self._single_header("Content-Encoding") not in (None, "identity"):
            raise StoreError(415, "Compressed request bodies are not supported")
        length = self._single_header("Content-Length")
        transfer = self._single_header("Transfer-Encoding")
        if length is not None and transfer is not None:
            raise StoreError(400, "Content-Length and Transfer-Encoding cannot be combined")
        if transfer is not None:
            if transfer.lower() != "chunked":
                raise StoreError(400, "Only chunked transfer encoding is supported")
            body = bytearray()
            framing = 0
            while True:
                line = self._line()
                framing += len(line) + 2
                if framing > 131_072:
                    raise StoreError(413, "Chunk framing exceeds its limit")
                raw_size = line.split(b";", 1)[0]
                if not re.fullmatch(rb"[0-9A-Fa-f]{1,16}", raw_size):
                    raise StoreError(400, "Invalid chunk size")
                size = int(raw_size, 16)
                if size > MAX_BYTES - len(body):
                    raise StoreError(413, "Dashboard exceeds 2 MB")
                if size == 0:
                    trailer_bytes = 0
                    while True:
                        trailer = self._line()
                        trailer_bytes += len(trailer) + 2
                        if trailer_bytes > 16_384:
                            raise StoreError(413, "Request trailers exceed their limit")
                        if not trailer:
                            return bytes(body)
                        # No trailer changes may affect routing, preconditions, or framing.
                        if b":" not in trailer or trailer.split(b":", 1)[0].lower() not in (b"digest", b"x-checksum"):
                            raise StoreError(400, "Unsupported request trailer")
                body.extend(self._read_exact(size))
                if self._read_exact(2) != b"\r\n":
                    raise StoreError(400, "Malformed chunk boundary")
        if length is None:
            raise StoreError(411, "A request body length is required")
        if not re.fullmatch(r"[0-9]{1,12}", length):
            raise StoreError(400, "Invalid Content-Length")
        size = int(length)
        if size > MAX_BYTES:
            raise StoreError(413, "Dashboard exceeds 2 MB")
        return self._read_exact(size)

    def _static(self, path):
        if "\\" in path or any(ord(character) < 32 for character in path):
            raise StoreError(400, "Invalid static path")
        components = [part for part in path.split("/") if part]
        if any(part.startswith(".") or ":" in part or "%" in part for part in components):
            raise StoreError(403, "Static path is not allowed")
        try:
            root = open_directory(self.server.static_dir)
        except FileNotFoundError as error:
            raise StoreError(503, "Frontend is not built; run npm run build in web first") from error
        except OSError as error:
            raise StoreError(403, "Frontend directory cannot be accessed safely") from error
        descriptor = None
        directory = duplicate_directory(root)
        try:
            if not components:
                components = ["index.html"]
            try:
                for component in components[:-1]:
                    next_dir = subdirectory(directory, component)
                    close_directory(directory)
                    directory = next_dir
                descriptor = open_file(directory, components[-1], os.O_RDONLY | NONBLOCK)
                filename = components[-1]
            except FileNotFoundError:
                if "." in components[-1]:
                    raise StoreError(404, "Static file was not found")
                try:
                    descriptor = open_file(root, "index.html", os.O_RDONLY | NONBLOCK)
                except FileNotFoundError as error:
                    raise StoreError(404, "Frontend index was not found; rebuild web/dist") from error
                except OSError as error:
                    raise StoreError(403, "Frontend index cannot be accessed safely") from error
                filename = "index.html"
            except OSError as error:
                raise StoreError(403, "Static file cannot be accessed safely") from error
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 32_000_000:
                raise StoreError(403, "Static file is not supported")
            with os.fdopen(descriptor, "rb", closefd=False) as stream:
                payload = stream.read(32_000_001)
            if len(payload) > 32_000_000:
                raise StoreError(413, "Static file exceeds its limit")
            mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
            if filename.endswith((".js", ".mjs")):
                mime = "text/javascript"
            self._send(200, payload, mime)
        finally:
            if descriptor is not None:
                os.close(descriptor)
            close_directory(directory)
            close_directory(root)

    def _handle(self):
        try:
            self._check_origin()
            route, value = self._route()
            if self.command in ("GET", "HEAD"):
                if route == "list":
                    self._json(200, self.server.store.names())
                elif route == "document":
                    payload, etag = self.server.store.get(value)
                    self._send(200, payload, headers={"ETag": etag})
                else:
                    self._static(value)
            elif self.command == "PUT" and route == "document":
                if_match = self._single_header("If-Match")
                if_none_match = self._single_header("If-None-Match")
                document = decode_document(self._body())
                etag, created = self.server.store.put(value, document, if_match=if_match, if_none_match=if_none_match)
                self._json(201 if created else 200, {"name": value}, {"ETag": etag})
            elif self.command == "DELETE" and route == "document":
                if self._single_header("Transfer-Encoding") is not None or self._single_header("Content-Length") not in (None, "0"):
                    raise StoreError(400, "DELETE requests must not have a body")
                if self._single_header("If-None-Match") is not None:
                    raise StoreError(400, "Deletion only supports If-Match")
                self.server.store.delete(value, if_match=self._single_header("If-Match"))
                self._send(204)
            else:
                raise StoreError(405, "Method is not supported for this route")
        except StoreError as error:
            self._error(error.status, error.message)
        except InvalidDocument as error:
            self._error(422, str(error))
        except (socket.timeout, TimeoutError):
            self._error(408, "Request body timed out")
        except (OSError, ValueError):
            self._error(500, "Local storage is unavailable; check the private data directory")

    do_GET = _handle
    do_HEAD = _handle
    do_PUT = _handle
    do_DELETE = _handle
    do_POST = _handle
    do_PATCH = _handle
    do_OPTIONS = _handle

    def handle_expect_100(self):
        # Validate headers before accepting a body, and always bound the later read.
        try:
            self._check_origin()
            length = self._single_header("Content-Length")
            if length is not None and re.fullmatch(r"[0-9]{1,12}", length) and int(length) > MAX_BYTES:
                raise StoreError(413, "Dashboard exceeds 2 MB")
        except StoreError as error:
            self._error(error.status, error.message)
            return False
        self.send_response_only(100)
        self.end_headers()
        return True


def main(argv=None):
    parser = argparse.ArgumentParser(description="Standalone private analysis dashboard server")
    parser.add_argument("--host", default="127.0.0.1", help="Literal loopback address only")
    parser.add_argument("--port", type=int, default=8127)
    parser.add_argument("--data-dir", type=Path, help="Private 0700 directory; defaults outside source under the user data directory")
    parser.add_argument("--static-dir", type=Path, default=Path(__file__).resolve().parents[1] / "web" / "dist")
    parser.add_argument("--allow-origin", action="append", default=[], help="An exact additional local HTTP origin for a development proxy")
    args = parser.parse_args(argv)
    store = DashboardStore(args.data_dir)
    try:
        server = DashboardHTTPServer((args.host, args.port), store, args.static_dir, args.allow_origin)
        host = "[::1]" if ":" in args.host else args.host
        print(f"Atlas Analysis Dashboard: http://{host}:{server.server_address[1]}/", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
    finally:
        store.close()


if __name__ == "__main__":
    main()
