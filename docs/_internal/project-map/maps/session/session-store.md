# Session Store

## Purpose

The session store groups related runs and records session-local facts. It gives
CLI, TUI, host, and diagnostics a stable place to find a conversation/work unit.

See [../trace/raw-trace.md](../trace/raw-trace.md) for raw event evidence.

## Main Files

- `packages/core/src/session.ts`
- `packages/core/src/session-compaction.ts`
- `packages/core/src/trace.ts`
- `packages/core/src/trace-store.ts`
- `packages/core/src/trace-diagnostics.ts`
- `packages/host/src/runtime.ts`
- `docs/reference/STATE_AND_TRACE_MODEL.md`

## Data Flow

```txt
Host chooses/validates sessionId
  -> FileSessionStore.create/append/appendEvent
  -> session.json + events.jsonl
  -> FileRunStore (trace-store.ts) writes session trace/transcript and agent run files

Manual compact
  -> compactSessionTurns()
  -> compact.json
  -> later runs seed compact context when throughRunId is anchored
```

## Contracts

- Default root: `<workspace>/.sparkwright/sessions`.
- `session.json` contains id, timestamps, ordered `runIds`, metadata, and event count.
- `events.jsonl` contains append-only `SessionEvent` rows with session-local sequence.
- Session-scoped `FileRunStore` writes session `trace.jsonl` /
  `transcript.jsonl`, `agents/<agent-id>/trace.jsonl`, per-run `run.json` /
  `result.json`, and `trace-pointer.json` files that point from each run
  directory back to the aggregate session and agent traces.
- Manual session compact writes `compact.json` as a `session-compact.v2`
  artifact only when there is net savings. The artifact stores source run ids,
  `throughRunId`, original/summary char counts, top-level `freedChars`, and
  host metadata such as applied/skipped stages and measurement. If explicit Tier
  3 summarization is requested, provider/scripted refs can write model-backed
  summaries with `summaryFingerprint`; deterministic refs record preview output
  plus a warning.
- `validateSessionTraceConsistency` remains in the `trace.ts` facade seam; it
  checks agreement between session files, trace metadata, run files, and
  safety-relevant failures while reusing diagnostics parse/summary helpers.
- `repairSessionTraceConsistency` only repairs derived session metadata; it does not invent missing run/result files.

## Consumers

- Host `session.list`, `session.inspect`, `session.compact`, `session.fork`.
- CLI `session summary|check|repair|compact|resume`.
- TUI session list, switch, inspect, fork, compact, export.

## Change Checklist

- Keep `sessionId`, `runId`, and `SessionEvent.sequence` semantics separate.
- Update trace consistency checks when layout or metadata changes.
- Preserve unknown `session.json` metadata when file stores reopen existing sessions.
- Check multi-agent paths under `agents/<agent-id>/`.
- Keep compact artifacts additive; do not rewrite `trace.jsonl`,
  `transcript.jsonl`, or run `result.json` during compaction.

## Known Debts

- File-backed session updates are best-effort and not a full database transaction model.
- Session metadata should make terminal run state easier to inspect.

## Last Verified

- Status: Verified
- Date: 2026-06-21
- Read: `packages/core/src/session.ts`, `packages/core/src/trace.ts`,
  `packages/core/src/trace-store.ts`,
  `packages/core/src/trace-diagnostics.ts`,
  `packages/core/src/trace-codec.ts`, `packages/core/src/index.ts`,
  `packages/core/src/internal.ts`, `packages/core/test/trace.test.ts`,
  `packages/cli/test/cli.test.ts`,
  `docs/_internal/project-map/designs/trace-diagnostics-refactor.md`,
  `docs/_internal/project-map/maps/trace/raw-trace.md`,
  `docs/_internal/project-map/maps/trace/summary-timeline-verify.md`.
- Tests: `npx prettier --check packages/core/src/trace.ts packages/core/src/trace-codec.ts packages/core/src/trace-diagnostics.ts packages/core/src/trace-store.ts`;
  `npm run build`; `npm --workspace @sparkwright/streaming-runtime run build`;
  `npm --workspace @sparkwright/core test -- test/trace.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts`.
