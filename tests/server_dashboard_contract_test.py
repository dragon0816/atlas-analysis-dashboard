"""Producer dashboard read contract, using only isolated temporary storage."""

from __future__ import annotations

import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.parse import quote

from server.http import DashboardHTTPServer
from server.storage import DashboardStore, revision

GOLDEN = Path(__file__).resolve().parents[1] / "web/tests/fixtures/atlas_dashboard_golden"
DOCUMENTS = {
    "Legacy overview": "dashboard-legacy.json",
    "Mixed BI layout": "dashboard-mixed.json",
}


class DashboardReadContractTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="atlas-read-contract-")
        root = Path(self.temporary.name)
        self.store = DashboardStore(root / "private")
        for name, filename in DOCUMENTS.items():
            self.store.put(name, json.loads((GOLDEN / filename).read_bytes()), if_none_match="*")
        self.server = DashboardHTTPServer(("127.0.0.1", 0), self.store, root / "unused-static")
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)
        self.store.close()
        self.temporary.cleanup()

    def get(self, path, headers=None, method="GET"):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.request(method, path, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_server_side_reads_match_all_golden_bytes_without_origin(self):
        cases = [("/dashboards", "list.json")]
        cases.extend(("/dashboards/" + quote(name, safe=""), filename)
                     for name, filename in DOCUMENTS.items())
        for route, filename in cases:
            with self.subTest(route=route):
                status, headers, body = self.get(route)
                self.assertEqual(status, 200)
                self.assertEqual(body, (GOLDEN / filename).read_bytes())
                self.assertEqual(headers["Content-Type"], "application/json; charset=utf-8")
                self.assertEqual(headers["Cache-Control"], "no-store")
                self.assertNotIn("Access-Control-Allow-Origin", headers)
                if filename != "list.json":
                    self.assertEqual(headers["ETag"], revision(body))

    def test_cross_site_null_origin_and_foreign_host_still_refused(self):
        for route in ("/dashboards", "/dashboards/Mixed%20BI%20layout"):
            for headers in (
                {"Origin": "https://example.com"}, {"Origin": "null"},
                {"Sec-Fetch-Site": "cross-site"}, {"Host": "attacker.example"},
            ):
                with self.subTest(route=route, headers=headers):
                    status, _, body = self.get(route, headers)
                    self.assertEqual(status, 403)
                    self.assertIsInstance(json.loads(body)["detail"]["message"], str)
            self.assertEqual(self.get(route, {"Origin": f"http://localhost:{self.port}"})[0], 200)

    def test_read_status_codes_and_head(self):
        self.assertEqual(self.get("/dashboards/missing")[0], 404)
        self.assertEqual(self.get("/dashboards/%2e%2e")[0], 400)
        self.assertEqual(self.get("/dashboards", method="POST")[0], 405)
        status, headers, body = self.get("/dashboards/Mixed%20BI%20layout", method="HEAD")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"")
        self.assertEqual(int(headers["Content-Length"]), len((GOLDEN / "dashboard-mixed.json").read_bytes()))
        self.assertIn("ETag", headers)

    def test_geometry_order_first_occurrence_and_ignored_panels(self):
        document = json.loads(self.get("/dashboards/Mixed%20BI%20layout")[2])
        eligible = [p for p in document["panels"] if p["datasource"]["id"] == "aep.bi.result"
                    and p.get("query", {}).get("vault") == "feed-fixture"]
        ordered = sorted(eligible, key=lambda p: (p["layout"]["y"], p["layout"]["x"], p["id"]))
        self.assertEqual([p["id"] for p in ordered],
                         ["bi-tech", "bi-coverage", "bi-region", "bi-coverage-copy"])
        seen, order, duplicates = set(), [], []
        for panel in ordered:
            identity = panel["query"]["vault"], panel["query"]["slug"]
            if identity in seen:
                duplicates.append(panel["id"])
            else:
                seen.add(identity)
                order.append(identity[1])
        self.assertEqual(order, ["tech-updates", "node-coverage", "accounts-by-region"])
        self.assertEqual(duplicates, ["bi-coverage-copy"])
        legacy = json.loads(self.get("/dashboards/Legacy%20overview")[2])
        self.assertFalse(any(p["datasource"]["id"] == "aep.bi.result" for p in legacy["panels"]))

    def test_reads_do_not_rewrite_stored_fixtures(self):
        before = {name: ((self.store.directory / (name + ".json")).stat().st_mtime_ns,
                         self.store.get(name)[0]) for name in DOCUMENTS}
        self.get("/dashboards")
        for name in DOCUMENTS:
            self.get("/dashboards/" + quote(name, safe=""))
        after = {name: ((self.store.directory / (name + ".json")).stat().st_mtime_ns,
                        self.store.get(name)[0]) for name in DOCUMENTS}
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
