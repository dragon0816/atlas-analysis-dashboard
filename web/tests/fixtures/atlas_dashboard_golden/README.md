# Atlas-owned dashboard read goldens

See `docs/AEP_DASHBOARD_READ_CONTRACT.md` for the frozen read contract and mappings.
These three JSON files are exact HTTP response bodies, not pretty-printed storage
examples. Do not normalize whitespace or add a final newline. Git preserves bytes.
They contain fictional data only; regeneration never opens a user dashboard store.

Producer generation: `python -B scripts/generate-atlas-dashboard-golden.py`.
Server verification: `python -B -m unittest discover -s tests -p 'server*.py'`.
Frontend verification: `npm test` from web/.

AEP should vendor all three JSON files from the committed Atlas producer version
and record that source commit. The mixed dashboard's duplicated node-coverage
panel is deliberate: geometry-sort first, keep each vault/slug's first occurrence,
and list `bi-coverage-copy` as an ignored duplicate in the AEP import preview.
