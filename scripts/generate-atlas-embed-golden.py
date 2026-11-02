"""Generate Atlas-owned embed goldens from the real handler; never read private stores."""

from pathlib import Path
import http.client
import json
import sys
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server.http import DEFAULT_FRAME_ANCESTORS, DashboardHTTPServer  # noqa: E402
from server.storage import DashboardStore  # noqa: E402

GOLDEN = ROOT / "web/tests/fixtures/atlas_embed_golden"
VOLATILE = {"Content-Length", "Content-Type", "Date", "Server", "Connection", "ETag"}
EMBED_PATHS = ["/embed/dashboard/Mixed%20BI%20layout", "/embed/panel?vault=feed-fixture&slug=node-coverage"]
OTHER_PATHS = ["/", "/some/page", "/dashboards", "/dashboards/Mixed%20BI%20layout"]
IFRAME = {"Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "iframe"}
AGENT_WEB = "http://localhost:53583"
PANEL = "/embed/panel?vault=feed-fixture&slug=node-coverage"
ACCESS = [
    ("server-side availability probe", "HEAD", PANEL, {}),
    ("framed by Agent Web on the same host (same-site, no Referer needed)", "GET", PANEL,
     {**IFRAME, "Sec-Fetch-Site": "same-site"}),
    ("framed cross-site by an allowed ancestor, referrerpolicy=origin", "GET", PANEL,
     {**IFRAME, "Sec-Fetch-Site": "cross-site", "Referer": AGENT_WEB + "/"}),
    ("framed cross-site with no Referer (Agent Web's no-referrer, no iframe attribute)", "GET", PANEL,
     {**IFRAME, "Sec-Fetch-Site": "cross-site"}),
    ("framed cross-site by another site", "GET", PANEL,
     {**IFRAME, "Sec-Fetch-Site": "cross-site", "Referer": "https://example.com/"}),
    ("framed cross-site by a loopback origin that is not an ancestor", "GET", PANEL,
     {**IFRAME, "Sec-Fetch-Site": "cross-site", "Referer": "http://localhost:60000/"}),
    ("cross-site object/embed element", "GET", PANEL,
     {"Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "embed", "Sec-Fetch-Site": "cross-site",
      "Referer": AGENT_WEB + "/"}),
    ("cross-site fetch of an embed page", "GET", PANEL,
     {"Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty", "Sec-Fetch-Site": "cross-site",
      "Referer": AGENT_WEB + "/"}),
    ("framing a non-embed page cross-site", "GET", "/some/page",
     {**IFRAME, "Sec-Fetch-Site": "cross-site", "Referer": AGENT_WEB + "/"}),
    ("framing the dashboards API cross-site", "GET", "/dashboards",
     {**IFRAME, "Sec-Fetch-Site": "cross-site", "Referer": AGENT_WEB + "/"}),
    ("browser fetch from Agent Web to the dashboards API", "GET", "/dashboards", {"Origin": AGENT_WEB}),
    ("write from Agent Web", "PUT", "/dashboards/Written",
     {"Origin": AGENT_WEB, "Content-Type": "application/json", "If-None-Match": "*"}),
    ("delete from Agent Web", "DELETE", "/dashboards/Mixed%20BI%20layout", {"Origin": AGENT_WEB}),
]
EXAMPLE_URLS = [
    ("saved dashboard", "/embed/dashboard/Mixed%20BI%20layout", {"kind": "dashboard", "name": "Mixed BI layout"}),
    ("non-ASCII dashboard name", "/embed/dashboard/%E5%84%80%E8%A1%A8%E6%9D%BF", {"kind": "dashboard", "name": "儀表板"}),
    ("dashboard name with a dot", "/embed/dashboard/v1.2%20layout", {"kind": "dashboard", "name": "v1.2 layout"}),
    ("panel with default parameters", "/embed/panel?vault=feed-fixture&slug=node-coverage",
     {"kind": "panel", "vault": "feed-fixture", "slug": "node-coverage", "params": {}}),
    ("panel with one parameter", "/embed/panel?vault=feed-fixture&slug=accounts-by-region&domain=AIDC",
     {"kind": "panel", "vault": "feed-fixture", "slug": "accounts-by-region", "params": {"domain": "AIDC"}}),
    ("key order does not matter", "/embed/panel?domain=wireless&slug=tech-updates&vault=feed-fixture",
     {"kind": "panel", "vault": "feed-fixture", "slug": "tech-updates", "params": {"domain": "wireless"}}),
    ("percent-encoded text, bool and date values",
     "/embed/panel?vault=v%2F1&slug=s&q=a%20%26%20b%3D%E5%80%BC&active=true&since=2026-11-02",
     {"kind": "panel", "vault": "v/1", "slug": "s",
      "params": {"q": "a & b=值", "active": "true", "since": "2026-11-02"}}),
    ("plus decodes to a space, as in form encoding", "/embed/panel?vault=v&slug=s&q=a+b",
     {"kind": "panel", "vault": "v", "slug": "s", "params": {"q": "a b"}}),
    ("an empty value is a value", "/embed/panel?vault=v&slug=s&q=",
     {"kind": "panel", "vault": "v", "slug": "s", "params": {"q": ""}}),
    ("missing vault", "/embed/panel?slug=s", {"kind": "invalid", "reason": "missing_vault"}),
    ("missing slug", "/embed/panel?vault=v", {"kind": "invalid", "reason": "missing_slug"}),
    ("repeated parameter", "/embed/panel?vault=v&slug=s&q=a&q=b", {"kind": "invalid", "reason": "duplicate_param"}),
    ("repeated reserved key", "/embed/panel?vault=v&vault=w&slug=s", {"kind": "invalid", "reason": "duplicate_param"}),
    ("dashboard without a name", "/embed/dashboard/", {"kind": "invalid", "reason": "missing_name"}),
    ("malformed name encoding", "/embed/dashboard/%E5%84", {"kind": "invalid", "reason": "malformed_name"}),
    ("dashboard path with extra segments", "/embed/dashboard/a/b", {"kind": "invalid", "reason": "unknown_route"}),
    ("unknown embed route", "/embed/editor", {"kind": "invalid", "reason": "unknown_route"}),
]


def write(name, value):
    (GOLDEN / name).write_bytes((json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))


def main():
    GOLDEN.mkdir(parents=True, exist_ok=True)
    document = json.loads((GOLDEN.parent / "atlas_dashboard_golden/dashboard-mixed.json").read_bytes())
    with tempfile.TemporaryDirectory(prefix="atlas-embed-golden-") as directory:
        static = Path(directory) / "static"
        static.mkdir()
        (static / "index.html").write_bytes(b"<!doctype html>")
        store = DashboardStore(Path(directory) / "private")
        server = DashboardHTTPServer(("127.0.0.1", 0), store, static)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def call(path, method="GET", headers=None, body=None):
            connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            try:
                connection.request(method, path, body=body, headers=headers or {})
                response = connection.getresponse()
                response.read()
                return response.status, {k: v for k, v in response.getheaders() if k not in VOLATILE}
            finally:
                connection.close()

        try:
            store.put("Mixed BI layout", document, if_none_match="*")
            groups = {}
            for group, paths in (("embed", EMBED_PATHS), ("other", OTHER_PATHS)):
                seen = [call(path) for path in paths]
                if any(status != 200 or headers != seen[0][1] for status, headers in seen):
                    raise SystemExit(f"Route group {group} does not share one header set: {seen}")
                groups[group] = {"paths": paths, "headers": dict(sorted(seen[0][1].items()))}
            write("response-headers.json", {
                "format": "atlas.embed.response_headers/v1",
                "defaults": {"frame_ancestors": list(DEFAULT_FRAME_ANCESTORS)},
                "excluded": sorted(VOLATILE), **groups,
            })
            cases = []
            for name, method, path, headers in ACCESS:
                body = json.dumps(document) if method == "PUT" else None
                status, _ = call(path, method, headers, body)
                case = {"name": name, "method": method, "path": path, "headers": headers, "status": status}
                if body is not None:
                    case["body"] = body
                cases.append(case)
            write("access-decisions.json", {"format": "atlas.embed.access_decisions/v1", "cases": cases})
        finally:
            server.shutdown()
            server.server_close()
            thread.join(5)
            store.close()
    write("example-urls.json", {
        "format": "atlas.embed.example_urls/v1", "base": "http://127.0.0.1:8127",
        "reserved_query_keys": ["vault", "slug"],
        "urls": [{"name": name, "url": url, "route": route} for name, url, route in EXAMPLE_URLS],
    })


if __name__ == "__main__":
    main()
