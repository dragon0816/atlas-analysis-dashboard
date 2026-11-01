# Atlas dashboard read contract for AEP

Revision: 2026-11-01. Producer: Atlas; consumer: AEP Knowledge-page import.
This documents the existing schemaVersion 2 API. No new route or schema field.
Atlas owns personal layout; AEP imports only an analysis order into its vault and
computes hidden itself. This does not authorize AEP to write to Atlas.

## Reads and access

Default base: `http://127.0.0.1:8127` (the configured Atlas server port).

| Request | Success body/status |
| --- | --- |
| `GET /dashboards` | 200, bare JSON array of stored dashboard names (possibly empty); sorted by `(name.casefold(), name)` |
| `GET /dashboards/{name}` | 200, bare dashboard JSON with `schemaVersion: 2`; ETag header |
| `HEAD` on either route | Same status/headers as GET, no body |

Use a name returned by the list, UTF-8 percent-encoded as a single path component
(e.g. `/dashboards/Mixed%20BI%20layout`). It is the stored name, not dashboard.id,
not a filename, and case-sensitive. GET reads never rewrite the document. Responses
use `application/json; charset=utf-8` and `Cache-Control: no-store`; GET does not
implement 304 conditional responses. Document size is bounded to 2,000,000 bytes.

Read errors: 400 malformed URL/name or duplicate security headers; 403 refused
Host/Origin/fetch-site or unsafe storage; 404 missing dashboard; 413 oversized
stored document; 422 invalid stored JSON/schema; 500 storage unavailable. Error
bodies are `{"detail":{"message":"..."}}`. Unsupported methods on these read
routes (e.g. POST) return 405. Existing PUT/DELETE behavior is outside this import
contract; the consumer uses GET only. Connection refusal means Atlas is not running.

`server/http.py` already allows a server-side request **without Origin** when Host
matches the listening loopback address/port and Sec-Fetch-Site is not cross-site.
No token or CORS handshake is needed for AEP's server-side HTTP client. The server
binds only literal loopback addresses. Foreign Host, external Origin, `Origin: null`,
and unapproved cross-site requests remain 403, including cross-site requests that
omit Origin. Same-server local Origins are accepted; additional local dev Origins
require explicit server configuration. There is no wildcard cross-origin allowance.

## Panel identity and order

For the target AEP vault, select only panels satisfying all three conditions:

- `panels[].datasource.id == "aep.bi.result"` (logical source identifier).
- `panels[].query.vault == <target vault id>` (exact string).
- `panels[].query.slug` is a nonempty analysis slug string.

Do not infer identity from title, panel.id, applicationId, display.aepBi, chart
type or the dashboard-level selected-vault variable. Mixed-vault dashboards are
allowed: foreign-vault and non-AEP panels are ignored. Query digest/params are not
needed for this import; legacy BI panels without them remain identifiable.

Sort the eligible panels by the **stored** `(layout.y, layout.x, id)`, ascending
(top-to-bottom, left-to-right, then case-sensitive panel id). Use saved numeric
coordinates, not array order, responsive/rendered positions or a settled layout.
SchemaVersion 2 has a flat panels array, no panel tabs/groups. Panel IDs are unique;
multiple panels may refer to the same analysis, and stored geometries may tie.

After sorting, keep each `(query.vault, query.slug)`'s FIRST occurrence. Later
occurrences do not contribute to order. **AEP lists these ignored duplicate panels
in its import preview.** Atlas continues to allow Duplicate panel. AEP projects the
retained panels to their distinct slugs for `meta:dashboard.order`, validates them
against its vault analyses, and computes hidden itself. Atlas provides no hidden
field. Positions, sizes, transforms, mappings, styling, parameters and chart specs
are not imported into AEP.

## Producer goldens

Stable path: `web/tests/fixtures/atlas_dashboard_golden/`.

| File | Request |
| --- | --- |
| `list.json` | `GET /dashboards` |
| `dashboard-mixed.json` | `GET /dashboards/Mixed%20BI%20layout` |
| `dashboard-legacy.json` | `GET /dashboards/Legacy%20overview` |

These are exact HTTP response body bytes, without a final newline. The mixed
fixture intentionally has array order unlike geometry order, a geometry/id tie,
a non-AEP panel with misleading BI-looking query/display fields, another vault,
and a later duplicate. For `feed-fixture`, sorted IDs are `bi-tech`, `bi-coverage`,
`bi-region`, `bi-coverage-copy`. The imported order is `tech-updates`, `node-coverage`,
`accounts-by-region`; the ignored duplicate is `bi-coverage-copy`. The legacy
fixture has no AEP panels and yields no analysis order entries.

`tests/server_dashboard_contract_test.py` stores these synthetic documents in its
own temporary private store and asserts exact real HTTP bodies without Origin,
security refusals, statuses/ETag and read-only behavior. Frontend tests verify both
documents load unchanged and generated BI panels retain the documented identity.
Regenerate intentionally with `python -B scripts/generate-atlas-dashboard-golden.py`
from the Atlas root, then review changes and run both test suites. AEP vendors the
producer files verbatim; a contract change starts here, not in the consumer copy.
