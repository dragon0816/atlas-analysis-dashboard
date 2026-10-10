# Handoff — AEP telemetry and benchmark integration (2026-10-10)

## Status update (2026-10-10, Claude Code)

- Windows backend tests now pass on Python 3.13.15: 35 tests OK, 7 platform skips (see VALIDATION.md). Interpreter: `C:/Users/Chi_L/AppData/Roaming/uv/python/cpython-3.13-windows-x86_64-none/python.exe` (installed with `uv python install 3.13`).
- Committed as e59655d (Codex) plus this documentation update. Not pushed.
- **Only remaining item: real browser acceptance** of the AEP Harness and AEP Benchmarks dashboards, including Live during a running benchmark. It needs the owner at the computer.

## Goal and scope

Connect local AEP telemetry and benchmark results to Atlas. The user authorized committing the combined Atlas changes after Claude Code's handoff. This task only modifies and commits Atlas; it does not modify AEP or push either repository.

## Implemented work

- Codex: bounded JSONL validation, deterministic event index/reducer, custom REST provider, shared WebSocket ingestion/reconnect/health checks, stale warnings, Harness preset, nested spans, directed paths, and coverage-aware metrics.
- Claude Code: `benchmarks.ts`, benchmark/grading sessions in the provider, trace drill-down, five benchmark sources and the AEP Benchmarks preset, plus six regression tests. These additions depend on the previously uncommitted Codex integration and are committed together as one integration change.
- AEP reference: Claude Code reports producer commit `d29ac63`, telemetry contract v0.3 §3a. Benchmark runs emit case progress/verdicts; grading runs refer to their parent benchmark; cases link to AEP conversation runs through trace IDs. Older AEP builds may ignore server-side filters, so the consumer also filters returned rows.

## Validation and limitations

- Frontend dependency installation is complete; do not reinstall merely to resume work.
- Current production build and TypeScript check passed during commit preparation. The >500 kB chunk warning is nonfatal.
- See VALIDATION.md for the final full-suite result from commit preparation.
- Prior Claude Code read-only smoke check reported benchmark cases, pass rate, grading coverage and trace-to-span drill-down working against AEP d29ac63. This was a shell/provider check, not browser acceptance.
- Real browser acceptance of Harness and Benchmarks remains pending, including Live during an active benchmark, switching runs/presets, offline import and cleanup.
- Windows backend tests remain blocked by the available Python 3.12 runtime; the existing private-directory guard requires Python 3.13+. Backend code is unchanged. Do not weaken the guard.
- This commit records implemented work, not completion of all project acceptance requirements. No push is authorized or performed.

## Decisions and local artifacts

See DECISIONS.md for the bounded history/index, direct loopback reads, cursor lifecycle and metrics decisions. Harness defaults to 24 hours; benchmark sessions default to seven days and load runs separately to avoid crowding by general telemetry. No new dependencies, credentials, real traces or backend proxy were added.

`docs/claude-benchmarks-provider.patch` is Claude Code's temporary diff against the original uncommitted provider. Keep it locally as a reference; it is excluded from the commit because Git now records the actual implementation.

## Next actions

1. Obtain a Windows Python 3.13+ interpreter and run `-B -m unittest discover -s tests -p 'server*.py'` at the Atlas root.
2. Start Atlas using LOCAL_DEVELOPMENT.md and perform browser acceptance for both AEP presets; use a narrow Harness window on busy hosts.
3. Address any acceptance findings with regression tests and update TASKS.md / VALIDATION.md.
4. Do not modify or launch benchmark jobs in AEP without task authorization. No push unless requested.
