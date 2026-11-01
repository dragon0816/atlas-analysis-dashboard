# Handoff — Atlas dashboard read producer contract (2026-11-01)

## Goal and boundary

Produce Atlas's existing dashboard read contract and goldens before AEP implements
its Knowledge-page import. AEP will read server-side without Origin, import only
analysis order into its own shared vault meta:dashboard, and compute hidden itself.
Atlas remains the owner of layout/transforms. No AEP edits, push or PR.

## Implemented

- docs/AEP_DASHBOARD_READ_CONTRACT.md defines the existing GET list/document
  routes, statuses, server-side no-Origin access, exact identity fields and order.
- Existing schemaVersion 2 identifies BI panels by datasource.id=aep.bi.result,
  query.vault and query.slug. No schema, generated identity or HTTP change needed.
- Verified server/http.py allows no-Origin loopback reads and still rejects
  foreign Host, external/null Origin and unapproved cross-site fetch-site.
- The panel model is flat, without tabs/groups. Duplicate panel preserves the
  same vault/slug; the coordinator chose first occurrence AFTER y/x/panel-id sort.
  AEP lists ignored duplicates in its preview. Atlas Duplicate behavior stays.
- Three exact response body goldens: web/tests/fixtures/atlas_dashboard_golden/
  list.json, dashboard-mixed.json and dashboard-legacy.json. Git attributes keep
  their bytes. The adjacent README and contract map filenames to request paths.
- scripts/generate-atlas-dashboard-golden.py creates fictional fixtures using the
  real Atlas encoder, never opens personal stores. No producer file is fabricated
  from AEP's consumer. Goldens are generated intentionally, not during tests.
- tests/server_dashboard_contract_test.py uses its own TemporaryDirectory and
  ephemeral loopback server: exact bodies/ETag/statuses, no-Origin success,
  cross-site refusal, geometry/dedup behavior and no stored-file rewrites.
- web/tests/atlas-dashboard-contract.test.mjs verifies old/mixed documents load,
  generated BI panels expose the documented identity, and fixture sorting/dedup.

## Fixture import result

Stored names: Legacy overview and Mixed BI layout. GET names as percent-encoded
path components, not dashboard IDs or filenames. For target feed-fixture, mixed
eligible IDs sort to bi-tech, bi-coverage, bi-region, bi-coverage-copy. Distinct
slug order: tech-updates, node-coverage, accounts-by-region. Ignore non-aep and
bi-other-vault; list bi-coverage-copy as a duplicate in AEP's preview. The legacy
dashboard yields no AEP entries. Geometry ties are intentional and resolved by ID.
Do not use array order or run responsive/settled layout before importing.

## Verification

New targeted HTTP tests: 5/5 passed. New frontend contract tests: 3/3 passed.
Final full checks: npm test 150 passed, 0 failed/cancelled/skipped (176394.9136 ms);
build TypeScript/Vite passed (173 modules, 42.66 s, existing chunk warnings);
Python server suite 40 tests OK (7 skipped, 26.747 s); upstream feed drift 17 files
match; git diff --check passes. See VALIDATION.md and TASKS.md.
See DECISIONS.md, 2026-11-01 Atlas dashboard read contract, for approved choices.

## Next steps

1. AEP vendors all three JSON files verbatim from this committed Atlas version,
   recording the producer commit, then implements/import-tests its own consumer.
2. AEP reads only source/vault/slug + stored y/x/id, previews ignored duplicates,
   and computes hidden itself. Positions/sizes/transforms are never imported.
3. Coordinate future contract changes on Atlas producer first, then revendor.

## Earlier BI continuity

Previous checkpoint eefc921 fixes published catalog reconciliation and passed
147 frontend tests, build, Python 35 tests (7 skips), 17-file AEP feed drift and
I1 plus a republish stub. The coordinator owns the real Agent Web rehearsal/I2
confirmation; this read-contract slice does not claim that acceptance. Earlier
Harness/Benchmarks browser acceptance remains independently pending.
