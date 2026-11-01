# AEP telemetry requirements

## AEP BI scope (2026-11-01)

Implement A1 (bounded provider) then A2 (published analysis viewer) from AEP's
`docs/phases/BI_ANALYSIS_DASHBOARD_ATLAS_BRIEF.md`, following design §5–6.
The AEP checkout is read-only. I1 must wait for the owner's explicit notification
that F3 is on AEP main, even if a fixture server appears before that notification.
Do not change the feed contract in Atlas. Vendor producer F1 golden JSON verbatim.
Atlas owns personal layouts only; existing server persistence is reused.
The coordinator confirmed enum params.<name>.values as resolved string choices on 2026-11-01. Atlas offers exactly these choices and never resolves values_from.

Implement the sequence authorized on 2026-10-10: contract, bounded offline ingestion, REST runs/detail views, nested timeline and directed transitions with metrics, then live ingestion.

The AEP repository at C:/Users/Chi_L/Documents/ChatGPT/agentic-engineering-platform is read-only. No commands that mutate AEP configuration, source, stored telemetry or runtime are permitted.

Acceptance: real runs are listed with pagination; selecting a run shows its events and spans; JSONL can be replayed locally; duplicates and out-of-order events reduce deterministically; invalid records and partial data are visible; model/skill filters preserve whole matching runs; disconnects preserve stale data; all resources are cleaned up on switching or disposal. Existing applications, security headers and persistence remain compatible.

Limits: 8 MiB imported/read payload, 64 KiB per event, 10,000 retained events, bounded pages and warnings. Never bundle real traces. No new third-party dependencies.
