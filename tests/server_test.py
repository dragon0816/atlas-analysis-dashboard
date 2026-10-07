"""Isolated persistence and actual HTTP contract/security tests."""

from __future__ import annotations

import copy
import http.client
import json
import multiprocessing
import os
from pathlib import Path
import socket
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import quote

from server.http import DashboardHTTPServer
from server.schema import InvalidDocument, MAX_BYTES, decode_document, encode_document, validate_document
from server.storage import DashboardStore, StoreError, default_data_dir, validate_name
from server.windows_acl import ADMINISTRATORS, OWNER_RIGHTS, SYSTEM, private_principals


def dashboard(title="分析範例"):
    return {
        "schemaVersion": 2, "id": "saved-overview", "title": title,
        "applicationId": "sample-application", "variables": [],
        "panels": [{
            "id": "panel-one", "title": "Measurements", "type": "table",
            "datasource": {"id": "rows"}, "transform": [], "mapping": {},
            "display": {}, "layout": {"x": 0, "y": 0, "w": 6, "h": 4},
        }],
    }


def race_update(directory, etag, start, results, title):
    store = DashboardStore(directory)
    try:
        start.wait(10)
        try:
            store.put("race", dashboard(title), if_match=etag)
            results.put(200)
        except StoreError as error:
            results.put(error.status)
    finally:
        store.close()


class SchemaTests(unittest.TestCase):
    def test_windows_localappdata_does_not_require_a_home_variable(self):
        with patch("server.storage.WINDOWS", True), patch.dict(os.environ, {"LOCALAPPDATA": "/private/local"}, clear=True), patch("server.storage.Path.home", side_effect=RuntimeError("No home configured")):
            self.assertEqual(default_data_dir(), Path("/private/local/AtlasAnalysisDashboard/dashboards"))

    def test_windows_owner_rights_is_scoped_to_a_trusted_owner(self):
        user = "S-1-5-21-100-200-300-1001"
        foreign = "S-1-5-21-100-200-300-1002"
        for owner in (user, ADMINISTRATORS):
            allowed = private_principals(owner, user)
            self.assertEqual(allowed, {user, SYSTEM, ADMINISTRATORS, OWNER_RIGHTS})
            for broad in ("S-1-1-0", "S-1-5-11", "S-1-5-32-545", "S-1-3-0", foreign):
                self.assertNotIn(broad, allowed)
        for owner in (foreign, "S-1-1-0", OWNER_RIGHTS, ""):
            with self.assertRaises(PermissionError):
                private_principals(owner, user)
        with self.assertRaises(PermissionError):
            private_principals(ADMINISTRATORS, "")

    def test_shared_frontend_contract(self):
        path = Path(__file__).parent / "fixtures" / "dashboard-contract.json"
        fixtures = json.loads(path.read_text(encoding="utf-8"))
        for fixture in fixtures:
            with self.subTest(fixture=fixture["name"]):
                if fixture["valid"]:
                    validate_document(fixture["document"])
                else:
                    with self.assertRaises(InvalidDocument):
                        validate_document(fixture["document"])

    def test_unicode_metadata_preserved(self):
        value = dashboard()
        value["metadata"] = {"owner": "範例", "custom": [False, None, 1.5]}
        self.assertEqual(decode_document(encode_document(value)), value)

    def test_legacy_and_missing_fields_rejected(self):
        for value in ({}, None, [], {"schemaVersion": 1}, {**dashboard(), "variables": None}):
            with self.subTest(value=value), self.assertRaises(InvalidDocument):
                validate_document(value)

    def test_structure_rejected(self):
        mutations = [
            lambda d: d["panels"].append(copy.deepcopy(d["panels"][0])),
            lambda d: d["panels"][0].update(type="script"),
            lambda d: d["panels"][0].update(transform=[{"op": "eval", "code": "anything"}]),
            lambda d: d["panels"][0].update(mapping={"x": 42}),
            lambda d: d["panels"][0].update(layout={"x": -1, "y": 0, "w": 1, "h": 1}),
            lambda d: d["panels"][0]["layout"].update(minW=12),
            lambda d: d["panels"][0]["layout"].update(w=True),
            lambda d: d["panels"][0].update(refresh=float("inf")),
            lambda d: d["panels"][0].update(script="alert(1)"),
            lambda d: d["panels"][0].update(interaction={"on_click": {"action": "execute"}}),
            lambda d: d.update(variables=[{"id": "x"}, {"id": "x"}]),
            lambda d: d.update(variables=[{"id": "x", "options": [True]}]),
        ]
        for mutate in mutations:
            value = dashboard()
            mutate(value)
            with self.subTest(value=value), self.assertRaises(InvalidDocument):
                validate_document(value)

    def test_valid_actions_variables_and_transforms(self):
        value = dashboard()
        value["variables"] = [{"id": "market", "type": "string", "default": "*", "options": ["*", "TW"]}]
        value["values"] = {"market": "TW"}
        value["panels"][0]["interaction"] = {"on_click": [{"action": "set_filter", "values": {"market": "$market"}}]}
        value["panels"][0]["transform"] = [{"op": "filter", "field": "market", "value": "$market"}]
        self.assertEqual(validate_document(value), value)

    def test_json_duplicate_keys_and_nonfinite_rejected(self):
        for payload in (b'{"schemaVersion":2,"schemaVersion":2}', b'{"x":NaN}', b'\xff', b'{'):
            with self.subTest(payload=payload), self.assertRaises(InvalidDocument):
                decode_document(payload)

    def test_depth_and_payload_limits(self):
        value = dashboard()
        nested = {}
        value["metadata"] = nested
        for _ in range(65):
            nested["child"] = {}
            nested = nested["child"]
        with self.assertRaises(InvalidDocument):
            validate_document(value)
        with self.assertRaises(InvalidDocument):
            decode_document(b" " * (MAX_BYTES + 1))
        with self.assertRaises(InvalidDocument):
            encode_document({**dashboard(), "metadata": "x" * MAX_BYTES})


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name) / "private"
        self.store = DashboardStore(self.directory)

    def tearDown(self):
        self.store.close()
        self.temporary.cleanup()

    def assert_status(self, status, function, *args, **kwargs):
        with self.assertRaises(StoreError) as caught:
            function(*args, **kwargs)
        self.assertEqual(caught.exception.status, status)

    @unittest.skipIf(os.name == "nt", "Unix XDG default; Windows uses LOCALAPPDATA")
    def test_default_outside_source(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(default_data_dir(), Path.home() / ".local/share/atlas-analysis-dashboard/dashboards")

    @unittest.skipUnless(os.name == "nt", "Windows-specific private directory and default path")
    def test_windows_private_storage(self):
        from server.filesystem import private_directory
        private_directory(self.store._directory_fd)
        with patch.dict(os.environ, {"LOCALAPPDATA": str(Path(self.temporary.name) / "local")}, clear=True):
            self.assertEqual(default_data_dir(), Path(self.temporary.name) / "local/AtlasAnalysisDashboard/dashboards")
        self.store.put("private", dashboard(), if_none_match="*")
        self.assertEqual(json.loads(self.store.get("private")[0]), dashboard())

    def test_save_read_update_delete(self):
        etag, created = self.store.put("我的 dashboard", dashboard(), if_none_match="*")
        self.assertTrue(created)
        self.assertEqual(self.store.names(), ["我的 dashboard"])
        payload, read_etag = self.store.get("我的 dashboard")
        self.assertEqual(json.loads(payload), dashboard())
        self.assertEqual(read_etag, etag)
        next_etag, created = self.store.put("我的 dashboard", dashboard("Updated"), if_match=etag)
        self.assertFalse(created)
        self.assertNotEqual(next_etag, etag)
        self.store.delete("我的 dashboard", if_match=next_etag)
        self.assertEqual(self.store.names(), [])

    def test_read_never_rewrites(self):
        self.store.put("original", dashboard(), if_none_match="*")
        path = self.directory / "original.json"
        before = path.stat().st_mtime_ns
        self.store.get("original")
        self.store.names()
        self.assertEqual(path.stat().st_mtime_ns, before)

    @unittest.skipIf(os.name == "nt", "POSIX mode bits; Windows enforces native ACLs")
    def test_private_directory_and_files(self):
        self.store.put("private", dashboard(), if_none_match="*")
        self.assertEqual(self.directory.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.directory / "private.json").stat().st_mode & 0o777, 0o600)
        public = Path(self.temporary.name) / "public"
        public.mkdir(mode=0o755)
        self.assert_status(403, DashboardStore, public)

    def test_preconditions(self):
        self.assert_status(428, self.store.put, "fresh", dashboard())
        self.assert_status(412, self.store.put, "fresh", dashboard(), if_match='"unknown"')
        etag, _ = self.store.put("fresh", dashboard(), if_none_match="*")
        self.assert_status(412, self.store.put, "fresh", dashboard(), if_none_match="*")
        self.assert_status(400, self.store.put, "fresh", dashboard(), if_match=etag, if_none_match="*")
        self.assert_status(412, self.store.put, "fresh", dashboard(), if_match='W/' + etag)
        self.assert_status(412, self.store.put, "fresh", dashboard(), if_match="*")
        self.assert_status(428, self.store.delete, "fresh")
        self.assert_status(412, self.store.delete, "fresh", if_match='"old"')
        self.assert_status(404, self.store.get, "unknown")

    def test_unsafe_names(self):
        for name in ("", ".", "..", "../other", "/root", "a/b", "a\\b", "a:b", "a%2fb", " a", "a ", ".hidden", "a.", "CON", "LPT1.txt", "a\x00b", "a\nb", "e\u0301", "字" * 61):
            with self.subTest(name=name):
                self.assert_status(400, validate_name, name)

    @unittest.skipIf(os.name == "nt", "Creating Windows symlinks requires extra OS privileges")
    def test_symlink_read_write_delete_and_listing(self):
        external = Path(self.temporary.name) / "external.json"
        external.write_bytes(encode_document(dashboard("Untouched")))
        external.chmod(0o600)
        (self.directory / "link.json").symlink_to(external)
        self.assert_status(403, self.store.get, "link")
        self.assert_status(403, self.store.put, "link", dashboard(), if_none_match="*")
        self.assert_status(403, self.store.delete, "link", if_match='"anything"')
        self.assertEqual(self.store.names(), [])
        self.assertEqual(json.loads(external.read_bytes())["title"], "Untouched")

    @unittest.skipIf(os.name == "nt", "Creating Windows symlinks requires extra OS privileges")
    def test_symlink_directory_rejected(self):
        link = Path(self.temporary.name) / "linked"
        link.symlink_to(self.directory, target_is_directory=True)
        with self.assertRaises(OSError):
            DashboardStore(link)

    @unittest.skipIf(os.name == "nt", "Creating Windows symlinks requires extra OS privileges")
    def test_symlink_lock_rejected(self):
        destination = Path(self.temporary.name) / "locked"
        destination.mkdir(mode=0o700)
        (destination / ".lock").symlink_to(self.directory / ".lock")
        with self.assertRaises(OSError):
            DashboardStore(destination)

    @unittest.skipIf(os.name == "nt", "POSIX FIFO coverage")
    def test_hardlink_and_fifo_rejected(self):
        outside = Path(self.temporary.name) / "file.json"
        outside.write_bytes(encode_document(dashboard()))
        outside.chmod(0o600)
        os.link(outside, self.directory / "hard.json")
        os.mkfifo(self.directory / "fifo.json", 0o600)
        self.assert_status(403, self.store.get, "hard")
        self.assert_status(403, self.store.get, "fifo")

    def test_failed_atomic_replace_preserves_original(self):
        etag, _ = self.store.put("atomic", dashboard("Before"), if_none_match="*")
        with patch("server.storage.replace_file", side_effect=OSError("simulated failure")):
            with self.assertRaises(OSError):
                self.store.put("atomic", dashboard("After"), if_match=etag)
        self.assertEqual(json.loads(self.store.get("atomic")[0])["title"], "Before")
        self.assertFalse(any(path.name.startswith(".pending-") for path in self.directory.iterdir()))

    def test_cross_process_compare_and_swap(self):
        etag, _ = self.store.put("race", dashboard("Before"), if_none_match="*")
        context = multiprocessing.get_context("spawn")
        start = context.Event()
        results = context.Queue()
        processes = [context.Process(target=race_update, args=(self.directory, etag, start, results, title)) for title in ("First", "Second")]
        for process in processes:
            process.start()
        start.set()
        for process in processes:
            process.join(15)
            self.assertEqual(process.exitcode, 0)
        self.assertEqual(sorted(results.get(timeout=5) for _ in processes), [200, 412])
        self.assertIn(json.loads(self.store.get("race")[0])["title"], ("First", "Second"))
        results.close()


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.store = DashboardStore(root / "data")
        self.static = root / "dist"
        self.static.mkdir()
        (self.static / "index.html").write_text("<!doctype html><title>Standalone dashboard</title>")
        (self.static / "app.js").write_text("console.log('local asset')")
        self.server = DashboardHTTPServer(("127.0.0.1", 0), self.store, self.static)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)
        self.store.close()
        self.temporary.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def put(self, name="sample", value=None, **headers):
        return self.request("PUT", "/dashboards/" + quote(name, safe=""), json.dumps(value or dashboard()).encode(), {"Content-Type": "application/json", **headers})

    def raw(self, wire):
        with socket.create_connection(("127.0.0.1", self.port), timeout=5) as connection:
            connection.sendall(wire)
            connection.shutdown(socket.SHUT_WR)
            response = http.client.HTTPResponse(connection)
            response.begin()
            return response.status, dict(response.getheaders()), response.read()

    def prefix(self, extra=b""):
        return b"PUT /dashboards/chunked HTTP/1.1\r\nHost: 127.0.0.1:" + str(self.port).encode() + b"\r\nContent-Type: application/json\r\nIf-None-Match: *\r\n" + extra

    def test_roundtrip_and_stale_revision(self):
        status, headers, _ = self.put("測試", **{"If-None-Match": "*"})
        self.assertEqual(status, 201)
        etag = headers["ETag"]
        status, headers, body = self.request("GET", "/dashboards/" + quote("測試"))
        self.assertEqual(status, 200)
        self.assertEqual(headers["ETag"], etag)
        self.assertEqual(json.loads(body), dashboard())
        self.assertEqual(json.loads(self.request("GET", "/dashboards")[2]), ["測試"])
        status, changed, _ = self.put("測試", dashboard("Changed"), **{"If-Match": etag})
        self.assertEqual(status, 200)
        self.assertNotEqual(changed["ETag"], etag)
        self.assertEqual(self.put("測試", **{"If-Match": etag})[0], 412)
        self.assertEqual(self.request("DELETE", "/dashboards/" + quote("測試"), headers={"If-Match": etag})[0], 412)
        self.assertEqual(self.request("DELETE", "/dashboards/" + quote("測試"), headers={"If-Match": changed["ETag"]})[0], 204)
        self.assertEqual(self.request("GET", "/dashboards/" + quote("測試"))[0], 404)

    def test_preconditions_and_schema_are_required(self):
        self.assertEqual(self.put()[0], 428)
        self.assertEqual(self.put(value={"schemaVersion": 1}, **{"If-None-Match": "*"})[0], 422)
        self.assertEqual(self.request("DELETE", "/dashboards/sample")[0], 428)
        self.assertEqual(self.request("POST", "/dashboards")[0], 405)

    def test_security_headers_and_static_assets(self):
        status, headers, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"Standalone dashboard", body)
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(self.request("GET", "/app.js")[1]["Content-Type"], "text/javascript")
        self.assertEqual(self.request("GET", "/workspace/view")[0], 200)
        self.assertEqual(self.request("GET", "/missing.js")[0], 404)
        self.assertEqual(self.request("HEAD", "/")[2], b"")

    @unittest.skipIf(os.name == "nt", "Creating Windows symlinks requires extra OS privileges")
    def test_static_symlink_and_traversal_rejected(self):
        (self.static / "leak.json").symlink_to(Path(self.temporary.name) / "data/.lock")
        for path in ("/leak.json", "/%2e%2e/data/.lock", "/.env", "/dir%5csecret"):
            with self.subTest(path=path):
                self.assertIn(self.request("GET", path)[0], (400, 403))

    def test_api_traversal_rejected(self):
        for path in ("/dashboards/%2e%2e", "/dashboards/a%2fb", "/dashboards/a%5cb", "/dashboards/a%00b", "/dashboards/%zz", "/dashboards/%ff"):
            with self.subTest(path=path):
                self.assertEqual(self.request("GET", path)[0], 400)

    def test_host_origin_and_fetch_site_protection(self):
        self.assertEqual(self.request("GET", "/dashboards", headers={"Host": "attacker.example"})[0], 403)
        self.assertEqual(self.put(**{"If-None-Match": "*", "Origin": "https://attacker.example"})[0], 403)
        self.assertEqual(self.request("GET", "/dashboards", headers={"Sec-Fetch-Site": "cross-site"})[0], 403)
        self.assertEqual(self.put(**{"If-None-Match": "*", "Origin": f"http://localhost:{self.port}"})[0], 201)

    def test_bind_and_extra_origins_reject_public_destinations(self):
        with self.assertRaises(ValueError):
            DashboardHTTPServer(("0.0.0.0", 0), self.store, self.static)
        with self.assertRaises(ValueError):
            DashboardHTTPServer(("127.0.0.1", 0), self.store, self.static, ["https://example.com"])

    def test_content_type_and_compression(self):
        self.assertEqual(self.request("PUT", "/dashboards/new", b"{}", {"Content-Type": "text/plain", "If-None-Match": "*"})[0], 415)
        self.assertEqual(self.put(**{"If-None-Match": "*", "Content-Encoding": "gzip"})[0], 415)

    def test_oversized_content_length_before_body(self):
        status, _, _ = self.raw(self.prefix(b"Content-Length: 2000001\r\n\r\n"))
        self.assertEqual(status, 413)

    def test_valid_chunked_document(self):
        body = encode_document(dashboard())
        chunks = [body[:11], body[11:]]
        wire = self.prefix(b"Transfer-Encoding: chunked\r\n\r\n")
        wire += b"".join(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n" for chunk in chunks)
        status, headers, _ = self.raw(wire + b"0\r\n\r\n")
        self.assertEqual(status, 201)
        self.assertIn("ETag", headers)
        self.assertEqual(json.loads(self.request("GET", "/dashboards/chunked")[2]), dashboard())

    def test_malformed_chunked_and_length_requests(self):
        cases = (
            (b"Transfer-Encoding: chunked\r\nContent-Length: 2\r\n\r\n{}", 400),
            (b"Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}", 400),
            (b"Content-Length: -1\r\n\r\n", 400),
            (b"Transfer-Encoding: gzip\r\n\r\n", 400),
            (b"Transfer-Encoding: chunked\r\n\r\nzz\r\n", 400),
            (b"Transfer-Encoding: chunked\r\n\r\n1e8481\r\n", 413),
            (b"Transfer-Encoding: chunked\r\n\r\n2\r\n{}xx", 400),
            (b"Transfer-Encoding: chunked\r\n\r\n0\r\nIf-Match: *\r\n\r\n", 400),
            (b"Content-Length: 20\r\n\r\n{}", 400),
            (b"\r\n", 411),
        )
        for wire, expected in cases:
            with self.subTest(wire=wire):
                self.assertEqual(self.raw(self.prefix(wire))[0], expected)

    def test_oversized_chunked_aggregate(self):
        chunk = b" " * 1_000_001
        wire = self.prefix(b"Transfer-Encoding: chunked\r\n\r\n") + f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n" + f"{len(chunk):x}\r\n".encode()
        self.assertEqual(self.raw(wire)[0], 413)

    def test_missing_build_is_actionable(self):
        self.server.static_dir = Path(self.temporary.name) / "unbuilt"
        status, _, body = self.request("GET", "/")
        self.assertEqual(status, 503)
        self.assertIn(b"npm run build", body)


if __name__ == "__main__":
    unittest.main()
