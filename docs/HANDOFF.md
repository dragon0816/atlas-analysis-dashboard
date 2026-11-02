# Handoff — Read-only Atlas embeds, saved boards and dashboard files (2026-11-02)

## Goal and boundary

AEP's general AI chat frames real Atlas panels and dashboards in a conversation. Layouts
stay personal: AEP never writes Atlas dashboards. When Atlas is not running, AEP falls back to
its own chart, which is AEP's work. This branch (`atlas-embed`) holds the Atlas side only. The
AEP checkout was read-only. Nothing was pushed or merged, and no PR was opened.

The contract is docs/AEP_EMBED_CONTRACT.md. The decision record is DECISIONS.md, 2026-11-02,
which amends the 2026-11-01 "no embed" position. Results are in VALIDATION.md, 2026-11-02.

## Implemented

- server/http.py: `/embed/*` serves index.html with `frame-ancestors` limited to Agent Web by
  default and no X-Frame-Options; every other route and every error stays DENY.
  `--allow-frame-ancestor` replaces the defaults and grants no API access. A framed cross-site
  document request passes only with a Referer from an allowed ancestor.
- web/src/pages/EmbedPage.tsx: both routes, reusing DashboardCanvas, the renderers, the BI
  provider, polling and reconcile. BiControls gained an `embed` option. No write path is imported.
- web/src/platform/embedRoute.ts (URL grammar), aep/biEmbed.ts (state and parameter logic).
- Goldens for AEP to vendor: web/tests/fixtures/atlas_embed_golden/.
- The read-contract golden dashboard-mixed.json: limit key corrected from `count` to `n`.
- scripts/test-aep-embed-i1.mjs: headless check, `npm run test:aep-embed:i1`.
- Saved boards no longer gain analyses, in the app and in embeds (DECISIONS.md, second 2026-11-02
  entry). Live boards are unchanged. "Add analysis" in the BI controls adds one by hand, through
  the editor.
- Import and Export buttons (platform/dashboardFile.ts, ImportDashboardDialog). A file is the GET
  document, unwrapped, which is what AEP's Knowledge page accepts.

## Verification

All passed on the final tree: npm test; build (179 modules); Python 53 tests OK (7 platform skips);
drift 17 files; embed I1 19/19; BI I1 6/6 plus the republish stub; `git diff --check`. Numbers are
in VALIDATION.md. Goldens are unchanged since c7f9468. The machine was never quiet (CPU 53-100%,
33-43 python processes).

## Known issues and risks

1. test_cross_process_compare_and_swap has a 15 s join. It failed twice in the suite and once in
   three solo runs at CPU 100% with 31 python processes, then passed 10 of 10 solo and twice in
   the suite at 33-37 python processes. Storage code is unchanged. It looks load-related, but
   this was not measured on a quiet machine, so that is not proven. The test was not relaxed.
2. Not verified: framing from real Agent Web (the check uses a stand-in parent with Agent Web's
   no-referrer header); Firefox, whose missing `location.ancestorOrigins` makes the size message
   depend on `document.referrer`, so with no-referrer it posts nothing. The contract already
   treats that message as optional.
3. A slow script result can rest on `waiting` until Refresh, under the 2026-11-01 retry rule.
   Under load even the fixture's 2 s delay can outlast the retries.
4. A saved board meeting a real republish was only unit-tested: the fixture never publishes a second
   version. An empty saved dashboard now stays empty, which is a consequence of the owner's rule.
5. BI I1 failed twice before any case at CPU 100% and passed at 55%. Load is likely, not proven.
6. The I1 runners share port 53611 and must not overlap. The embed runner also needs 53612-53614
   and ATLAS_PYTHON set to Python 3.13+ on Windows; the BI runner needs 5179.

## Next steps

1. AEP vendors the final contract commit's goldens, including the changed dashboard-mixed.json,
   and renders the iframe with `referrerpolicy="origin"` and no opaque sandbox.
2. Check framing from real Agent Web once AEP's side lands. Owner-present I2 stays separate.
3. Rerun the compare-and-swap test on a quiet machine to settle item 1, and add a republish case
   for saved boards to a browser run if item 4 matters.

## Earlier continuity

The 2026-11-01 read contract and BI work remain as recorded in DECISIONS.md and VALIDATION.md.
Harness and Benchmarks browser acceptance is still independently pending (TASKS.md).
