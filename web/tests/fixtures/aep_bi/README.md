# AEP BI golden fixtures

Copied verbatim from AEP main commit
`b6a139c5cfae4b21ac42c27f471e9b028e3679b1` (merged 2026-11-01).
Source: `tests/fixtures/bi_feed/golden/` in
`C:/Users/Chi_L/Documents/ChatGPT/agentic-engineering-platform`.

All 17 JSON files are producer-owned, including requests.json (the request/status
manifest). Never regenerate or normalize them in Atlas. Run:
`npm run check:aep-bi -- --aep <AEP repo>` from web/.
