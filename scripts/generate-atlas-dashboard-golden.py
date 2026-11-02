"""Generate Atlas-owned dashboard read response goldens; never read private stores."""

from pathlib import Path
import json
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server.schema import encode_document  # noqa: E402

GOLDEN = ROOT / "web/tests/fixtures/atlas_dashboard_golden"


def bi_panel(panel_id, slug, x, y, *, vault="feed-fixture"):
    return {
        "id": panel_id, "title": slug, "type": "table",
        "datasource": {"id": "aep.bi.result"},
        "query": {"vault": vault, "slug": slug, "params": {"domain": "robotics"}},
        "transform": [{"op": "limit", "n": 5}], "mapping": {},
        "display": {"aepBi": True}, "layout": {"x": x, "y": y, "w": 6, "h": 8},
    }


def main():
    GOLDEN.mkdir(parents=True, exist_ok=True)
    legacy = {
        "schemaVersion": 2, "id": "legacy-overview", "title": "Legacy overview",
        "applicationId": "sample-application", "variables": [],
        "panels": [{
            "id": "legacy-table", "title": "Legacy table", "type": "table",
            "datasource": {"id": "legacy.rows"}, "transform": [], "mapping": {},
            "display": {}, "layout": {"x": 0, "y": 0, "w": 6, "h": 4},
        }],
    }
    other = bi_panel("non-aep", "not-an-analysis", 0, 0)
    other["datasource"]["id"] = "synthetic.rows"
    mixed = {
        "schemaVersion": 2, "id": "mixed-bi-overview", "title": "Mixed BI layout",
        "applicationId": "aep_bi", "variables": [], "values": {"bi:vault": "feed-fixture"},
        "panels": [
            bi_panel("bi-region", "accounts-by-region", 6, 0),
            other,
            bi_panel("bi-coverage", "node-coverage", 6, 0),
            bi_panel("bi-tech", "tech-updates", 0, 0),
            bi_panel("bi-other-vault", "node-coverage", 0, 0, vault="other-vault"),
            bi_panel("bi-coverage-copy", "node-coverage", 0, 20),
        ],
    }
    # Exact HTTP response bodies: documents use the store's canonical encoder;
    # list uses DashboardHandler._json's default JSON separators. No final newline.
    (GOLDEN / "list.json").write_bytes(json.dumps(
        ["Legacy overview", "Mixed BI layout"], ensure_ascii=False
    ).encode("utf-8"))
    (GOLDEN / "dashboard-mixed.json").write_bytes(encode_document(mixed))
    (GOLDEN / "dashboard-legacy.json").write_bytes(encode_document(legacy))


if __name__ == "__main__":
    main()
