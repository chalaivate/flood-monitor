@AGENTS.md

# Flood Monitor — project notes

- Read `docs/DESIGN.md` (architecture, API contract) and `docs/DATA-SOURCES.md` (upstream quirks) before changing sources, engine or API.
- Shared contracts live in `src/lib/types.ts`; API response types in `src/lib/server/public.ts` (type-only, safe for the client).
- User-facing text (UI, alerts, docs) is Thai; code and comments are English.
- `*.bangkok.go.th` only answers Thai IPs — never assume BMA sources work from CI or cloud. Tests must inject `fetch`/`sleep` and use `tests/fixtures/`.
- Status is driven by freeboard (lower bank − water level); BMA's own warning/critical levels are informational only.
- `DATA_MODE=fixture` = simulated demo data (separate DB file `flood-demo.db`), always labelled in the UI.
- Gates before committing: `npm run typecheck && npm run lint && npm test && npm run build`.
