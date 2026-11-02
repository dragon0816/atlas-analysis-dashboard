"""Embed headers and framing access, using only isolated temporary storage."""

from __future__ import annotations

import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest

from server.http import DEFAULT_FRAME_ANCESTORS, DashboardHTTPServer, main
from server.storage import DashboardStore

GOLDEN = Path(__file__).resolve().parents[1] / "web/tests/fixtures/atlas_embed_golden"
INDEX = b"<!doctype html><title>Atlas fixture</title>"
VOLATILE = {"Content-Length", "Content-Type", "Date", "Server", "Connection", "ETag"}
IFRAME = {"Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "iframe"}


def golden(name):
    return json.loads((GOLDEN / name).read_bytes())


class EmbedServerCase(unittest.TestCase):
    ancestors = None

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="atlas-embed-contract-")
        root = Path(self.temporary.name)
        static = root / "static"
        static.mkdir()
        (static / "index.html").write_bytes(INDEX)
        (static / "app.js").write_bytes(b"export {};")
        self.store = DashboardStore(root / "private")
        self.store.put("Mixed BI layout", json.loads(
            (GOLDEN.parent / "atlas_dashboard_golden/dashboard-mixed.json").read_bytes()
        ), if_none_match="*")
        options = {} if self.ancestors is None else {"frame_ancestors": self.ancestors}
        self.server = DashboardHTTPServer(("127.0.0.1", 0), self.store, static, **options)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)
        self.store.close()
        self.temporary.cleanup()

    def request(self, path, headers=None, method="GET", body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()


class EmbedHeaderGoldenTests(EmbedServerCase):
    def test_every_route_group_matches_the_header_golden(self):
        expected = golden("response-headers.json")
        self.assertEqual(expected["defaults"]["frame_ancestors"], list(DEFAULT_FRAME_ANCESTORS))
        for group in ("embed", "other"):
            for path in expected[group]["paths"]:
                with self.subTest(path=path):
                    status, headers, _ = self.request(path)
                    self.assertEqual(status, 200)
                    stable = {k: v for k, v in headers.items() if k not in VOLATILE}
                    self.assertEqual(stable, expected[group]["headers"])

    def test_header_golden_states_the_contract_directly(self):
        expected = golden("response-headers.json")
        embed, other = expected["embed"]["headers"], expected["other"]["headers"]
        self.assertNotIn("X-Frame-Options", embed)
        self.assertIn("frame-ancestors http://127.0.0.1:53583 http://localhost:53583;",
                      embed["Content-Security-Policy"])
        self.assertNotIn("frame-ancestors 'none'", embed["Content-Security-Policy"])
        self.assertEqual(other["X-Frame-Options"], "DENY")
        self.assertIn("frame-ancestors 'none'", other["Content-Security-Policy"])

    def test_access_decisions_match_the_golden(self):
        cases = golden("access-decisions.json")["cases"]
        self.assertEqual({case["status"] for case in cases}, {200, 403})
        for case in cases:
            with self.subTest(case=case["name"]):
                status, _, _ = self.request(case["path"], case["headers"], case["method"], case.get("body"))
                self.assertEqual(status, case["status"])
        self.assertEqual(self.store.names(), ["Mixed BI layout"])

    def test_access_golden_states_the_framing_rules_directly(self):
        outcome = {case["name"]: case["status"] for case in golden("access-decisions.json")["cases"]}
        self.assertEqual(outcome["framed cross-site by an allowed ancestor, referrerpolicy=origin"], 200)
        self.assertEqual(outcome["framed by Agent Web on the same host (same-site, no Referer needed)"], 200)
        for refused in ("framed cross-site with no Referer (Agent Web's no-referrer, no iframe attribute)",
                        "framed cross-site by another site",
                        "framed cross-site by a loopback origin that is not an ancestor",
                        "cross-site object/embed element", "cross-site fetch of an embed page",
                        "framing a non-embed page cross-site", "framing the dashboards API cross-site",
                        "browser fetch from Agent Web to the dashboards API",
                        "write from Agent Web", "delete from Agent Web"):
            self.assertEqual(outcome[refused], 403, refused)

    def test_error_responses_under_embed_stay_unframeable(self):
        status, headers, _ = self.request("/embed/panel", {**IFRAME, "Sec-Fetch-Site": "cross-site"})
        self.assertEqual(status, 403)
        self.assertEqual(headers["X-Frame-Options"], "DENY")
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
        status, headers, _ = self.request("/embed/panel", method="POST")
        self.assertEqual(status, 405)
        self.assertEqual(headers["X-Frame-Options"], "DENY")


class EmbedRoutingTests(EmbedServerCase):
    def test_embed_serves_index_even_for_names_the_static_route_would_refuse(self):
        # A valid stored name may contain a dot, which the static route treats as a file.
        for path in ("/embed/dashboard/v1.2%20layout", "/embed/panel?vault=a&slug=b.c&q=x.y",
                     "/embed/dashboard/Mixed%20BI%20layout"):
            with self.subTest(path=path):
                status, headers, body = self.request(path)
                self.assertEqual(status, 200)
                self.assertEqual(body, INDEX)
                self.assertEqual(headers["Content-Type"], "text/html")

    def test_encoded_prefix_is_not_an_embed_route(self):
        # The page only enters embed mode for a literal /embed/ pathname.
        status, headers, _ = self.request("/%65mbed/panel")
        self.assertEqual(status, 200)
        self.assertEqual(headers["X-Frame-Options"], "DENY")

    def test_bare_embed_and_assets_keep_default_headers(self):
        for path in ("/embed", "/embedded/panel", "/app.js"):
            with self.subTest(path=path):
                status, headers, _ = self.request(path)
                self.assertEqual(status, 200)
                self.assertEqual(headers["X-Frame-Options"], "DENY")

    def test_head_matches_get_for_the_availability_probe(self):
        status, headers, body = self.request("/embed/panel", method="HEAD")
        self.assertEqual((status, body), (200, b""))
        self.assertEqual(int(headers["Content-Length"]), len(INDEX))
        self.assertNotIn("X-Frame-Options", headers)

    def test_frame_ancestor_gets_no_api_access(self):
        origin = {"Origin": DEFAULT_FRAME_ANCESTORS[0]}
        document = (GOLDEN.parent / "atlas_dashboard_golden/dashboard-mixed.json").read_bytes()
        put = {**origin, "Content-Type": "application/json", "If-None-Match": "*"}
        self.assertEqual(self.request("/dashboards/Written", put, "PUT", document)[0], 403)
        self.assertEqual(self.request("/dashboards/Mixed%20BI%20layout", origin, "DELETE")[0], 403)
        self.assertEqual(self.request("/dashboards", origin)[0], 403)
        self.assertEqual(self.store.names(), ["Mixed BI layout"])


class ConfiguredFrameAncestorTests(EmbedServerCase):
    ancestors = ("http://localhost:60001",)

    def test_configuration_replaces_the_defaults_everywhere(self):
        _, headers, _ = self.request("/embed/panel")
        self.assertIn("frame-ancestors http://localhost:60001;", headers["Content-Security-Policy"])
        self.assertNotIn("53583", headers["Content-Security-Policy"])
        allowed = {**IFRAME, "Sec-Fetch-Site": "cross-site", "Referer": "http://localhost:60001/"}
        self.assertEqual(self.request("/embed/panel", allowed)[0], 200)
        previous = {**allowed, "Referer": "http://localhost:53583/"}
        self.assertEqual(self.request("/embed/panel", previous)[0], 403)


class FrameAncestorValidationTests(unittest.TestCase):
    def test_unsafe_values_are_rejected_before_any_header_is_built(self):
        for value in ("*", "https://127.0.0.1:53583", "http://example.com:53583", "http://[::1]:53583",
                      "http://127.0.0.1:53583/", "http://127.0.0.1:0", "http://127.0.0.1:70000",
                      "http://127.0.0.1:53583;script-src *", "http://127.0.0.1:53583 http://evil.example",
                      "'none'", "http://user@127.0.0.1:53583", "http://127.0.0.1:53583\r\nX: y"):
            with self.subTest(value=value), tempfile.TemporaryDirectory() as directory:
                store = DashboardStore(Path(directory) / "private")
                try:
                    with self.assertRaises(ValueError):
                        DashboardHTTPServer(("127.0.0.1", 0), store, directory, frame_ancestors=(value,))
                finally:
                    store.close()

    def test_command_line_rejects_an_unsafe_frame_ancestor(self):
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(ValueError):
            main(["--port", "0", "--data-dir", str(Path(directory) / "private"),
                  "--allow-frame-ancestor", "http://example.com:1"])


if __name__ == "__main__":
    unittest.main()
