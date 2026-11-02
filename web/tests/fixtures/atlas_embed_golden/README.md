# Atlas-owned embed goldens

See `docs/AEP_EMBED_CONTRACT.md` for the contract and how to read these files.
They contain fictional data only; regeneration never opens a user dashboard store.

Producer generation: `python -B scripts/generate-atlas-embed-golden.py`.
Server verification: `python -B -m unittest discover -s tests -p 'server*.py'`.
Frontend verification: `npm test` from web/.

AEP should vendor all three JSON files from the committed Atlas producer version and
record that source commit. Git attributes preserve their bytes.
