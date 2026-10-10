# AEP telemetry requirements

Implement the sequence authorized on 2026-10-10: contract, bounded offline ingestion, REST runs/detail views, nested timeline and directed transitions with metrics, then live ingestion.

The AEP repository at C:/Users/Chi_L/Documents/ChatGPT/agentic-engineering-platform is read-only. No commands that mutate AEP configuration, source, stored telemetry or runtime are permitted.

Acceptance: real runs are listed with pagination; selecting a run shows its events and spans; JSONL can be replayed locally; duplicates and out-of-order events reduce deterministically; invalid records and partial data are visible; model/skill filters preserve whole matching runs; disconnects preserve stale data; all resources are cleaned up on switching or disposal. Existing applications, security headers and persistence remain compatible.

Limits: 8 MiB imported/read payload, 64 KiB per event, 10,000 retained events, bounded pages and warnings. Never bundle real traces. No new third-party dependencies.
