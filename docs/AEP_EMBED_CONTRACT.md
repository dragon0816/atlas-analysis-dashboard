# Atlas embed contract for AEP

Revision: 2026-11-02. Producer: Atlas; consumer: AEP's general AI chat (Agent Web).
AEP frames real Atlas panels or dashboards in a conversation. Embeds are read-only:
an embed page never sends PUT or DELETE, and AEP never writes Atlas dashboards (the
owner's layouts stay personal). When Atlas is not running, AEP falls back to its own
chart; that fallback is AEP's work.

## URLs

Default base: `http://127.0.0.1:8127` (the configured Atlas server port).

| URL | Shows |
| --- | --- |
| `/embed/dashboard/<name>` | A saved dashboard, without the editor. |
| `/embed/panel?vault=<id>&slug=<slug>&<param>=<value>...` | One in-memory `aep.bi.result` panel. |

**Dashboard.** `<name>` is a name returned by `GET /dashboards`, UTF-8 percent-encoded
as one path segment (`encodeURIComponent`), the same encoding as the read contract
(`AEP_DASHBOARD_READ_CONTRACT.md`). It is not `dashboard.id` and is case-sensitive.

**Panel.** The chart comes from the feed's published analysis spec, and nothing is
read from or written to Atlas's dashboard store. `<param>=<value>` sets a starting
value; omitted parameters use the feed's default. Controls for the analysis's
parameters are shown and change the view in memory only: nothing is saved and the URL
does not change.

Encoding, for all query keys and values: `application/x-www-form-urlencoded`
(`URLSearchParams`; `+` and `%20` both decode to a space). Key order does not matter.

- `vault` and `slug` are reserved query keys. An analysis parameter with either name
  cannot be set by URL and keeps its default.
- A repeated key is refused (`invalid_link`), not resolved.
- Values are checked against the published analysis: `enum` must be one of
  `params.<name>.values`, `bool` must be `true` or `false`, `date` must be `YYYY-MM-DD`,
  `text` is free. An unknown parameter or a bad value is refused (`invalid_link`),
  so a link never silently shows other data than it names.
- After a republish, the existing reconcile rule applies: a value no longer valid falls
  back to the new default.

## Framing

Serve-time rules, frozen in the goldens below:

- `/embed/*` documents have no `X-Frame-Options` and send
  `frame-ancestors http://127.0.0.1:53583 http://localhost:53583` inside the otherwise
  unchanged `Content-Security-Policy`. The browser enforces this; every other route keeps
  `X-Frame-Options: DENY` and `frame-ancestors 'none'`, and so does any error response
  under `/embed/`.
- `python -m server --allow-frame-ancestor <origin>` (repeatable) **replaces** the
  defaults. Values must be exact `http://127.0.0.1[:port]` or `http://localhost[:port]`
  origins; anything else stops the server at startup. `::1` cannot be listed, because CSP
  source expressions have no IPv6 form.
- Being a frame ancestor grants **no API access**. A browser request from Agent Web to
  `/dashboards` (GET, PUT or DELETE, with `Origin`) stays 403. `--allow-origin` is
  separate and is not needed for embedding.

The iframe AEP must render:

```html
<iframe src="http://127.0.0.1:8127/embed/panel?vault=...&slug=..."
        referrerpolicy="origin" title="..."></iframe>
```

- **`referrerpolicy="origin"` is required when the host names differ.** Browsers count
  `127.0.0.1:53583` → `127.0.0.1:8127` as same-site, and that passes without a Referer.
  `localhost:53583` → `127.0.0.1:8127` is cross-site: a framed GET has no `Origin`, so
  Atlas identifies the parent only by the Referer's origin, and refuses (403) when it is
  missing or not a frame ancestor. Agent Web's pages send `Referrer-Policy: no-referrer`,
  which leaves no Referer unless this attribute overrides it. Always set the attribute.
- **Do not sandbox it to an opaque origin.** The chat file viewer's `sandbox="allow-scripts"`
  will not work here: an opaque origin cannot load Atlas's module scripts, and both Atlas
  and the AEP feed refuse `Origin: null`. Use no `sandbox`, or include `allow-scripts
  allow-same-origin`; the frame stays cross-origin to Agent Web either way.
- If Agent Web adds a CSP later, its `frame-src` must list the Atlas origin. It must not
  send `Cross-Origin-Embedder-Policy: require-corp`, because Atlas documents answer
  `Cross-Origin-Resource-Policy: same-origin`.
- Every ancestor must be allowed, so a chat nested in another frame needs that origin
  listed too.

**Is Atlas running?** From the AEP server, `HEAD http://127.0.0.1:<port>/embed/panel`
without `Origin`: 200 means framable. A refused connection means not running, and 503
means the frontend is not built; fall back in both cases. An iframe's load event cannot
tell these apart, so probe before rendering it.

## Sizing

The embed fills its frame; AEP owns the frame's size. Content that does not fit scrolls
inside the frame. A panel embed stretches its one panel over the height left below its
controls. A dashboard embed keeps its grid and scrolls.

The embed may also post its preferred height to its parent:

```js
window.parent.postMessage({ type: "atlas-embed-size", height }, targetOrigin)
```

- `height` is a positive integer in CSS pixels, computed from content and never from the
  frame's height, so resizing the frame to it cannot loop. It is posted when it changes.
- `targetOrigin` is the parent's origin, which `frame-ancestors` has already restricted to
  an allowed ancestor. The embed reads it from `location.ancestorOrigins`, else the
  `document.referrer` origin. If neither is known it does not post, and never uses `*`.
- AEP should check `event.source === iframe.contentWindow` and `event.origin` against the
  Atlas origin, clamp `height` to its own limits, and treat the message as optional: a
  frame with a sensible default height must work without it.

## States

The embed's root element is `[data-embed-state="<state>"]`, for tests and diagnostics:

| State | Meaning | What is shown |
| --- | --- | --- |
| `loading` | First reads are in progress | Loading message |
| `ready` | Content is shown and current | The panel or dashboard |
| `waiting` | The feed answered `409 result_not_ready` | Waiting message in the panel, last data if any |
| `offline` | AEP's feed cannot be reached | Offline status; last data is kept, polling recovers on its own |
| `unknown_dashboard` | Atlas has no dashboard with that name (404) | Clear message naming it |
| `unknown_vault` | Panel embed only: the feed has no such published vault | Clear message naming it |
| `unknown_analysis` | The vault's published version has no such slug, including one removed by a later republish | Clear message naming it |
| `invalid_link` | Malformed URL, repeated key, unknown parameter or bad value | Clear message naming the problem |
| `error` | Anything else: an Atlas storage or schema error, an unusable feed answer, or a panel that failed | The error message |

`loading` lasts until every BI panel has answered, so `ready` means their results are shown.

**One panel failing (dashboard embed).** Each panel reports inside its own card as in the
full app, and the layout stays. A panel that cannot render (say a bad saved transform) shows
"Could not render this panel" with Retry; a feed error shows `AEP BI error: <message>`. The
others keep working. The root reports the most urgent across panels: `error`, then `offline`,
then `waiting`, then `ready`, and returns to `ready` once the panel recovers.

**A dashboard's vault no longer exists.** This is not `unknown_vault`, because the stored
layout is still real: the root is `error`, the panels asking that vault show the feed's
message in their cards, the status line names it, and panels of other vaults keep working.

**Waiting retries run out.** After the first read, the panel retries `result_not_ready` three
times, one second apart, then stops. The state stays `waiting` with no alert, and only the
panel's Refresh button (↻) or changing a parameter asks again; the 15-second polls do not.
A result computed after that stays unseen until then. So a slow script result can leave a
frame on `waiting`: AEP should say nothing is wrong and leave the frame up, not fall back.

## Behaviour

- Panels poll and reconcile as in the app: results every 15 seconds, and the vault's
  published version every 15 seconds, updating chart, title and parameters in place.
  A dashboard embed reconciles in memory and the stored dashboard is untouched: panels whose
  analysis changed update, and panels whose analysis was unpublished disappear, but a saved
  dashboard never gains analyses by itself. It shows what was saved, so a person adds a new
  analysis by hand in Atlas.
- Interactions are limited to in-memory cross-panel filters and graph highlights.
  `navigate`, `open_link`, details dialogs, and all editing are off.
- Any saved dashboard of an installed application can be embedded, including one imported
  from a file in Atlas. A panel whose vault or slug does not exist on this PC stays as its own
  error card, as under States. A non-BI dashboard shows
  its saved filter values; there are no filter controls, and a "Reset filters" button
  appears after an interaction changes a filter.

## Goldens

Stable path: `web/tests/fixtures/atlas_embed_golden/`. Generated from the real handler by
`python -B scripts/generate-atlas-embed-golden.py`. Git preserves the bytes.

| File | Content |
| --- | --- |
| `response-headers.json` | Exact stable response headers for `/embed/*` vs other routes, default ancestors |
| `access-decisions.json` | Requests (method, path, headers) and the status Atlas answers |
| `example-urls.json` | Example URLs, valid and invalid, with their parsed meaning |

`tests/server_embed_contract_test.py` asserts the first two against real HTTP from an isolated
temporary store. `web/tests/atlas-embed-contract.test.mjs` asserts every example URL against
the page's parser. AEP vendors the files verbatim and records the Atlas commit. A contract
change starts here, not in the consumer copy.
