# Session Store

## Purpose

The session store groups related runs and records session-local facts. It gives
CLI, TUI, host, and diagnostics a stable place to find a conversation/work unit.

See [../trace/raw-trace.md](../trace/raw-trace.md) for raw event evidence.

## Main Files

- `packages/core/src/session.ts`
- `packages/core/src/trace.ts`
- `packages/host/src/runtime.ts`
- `docs/reference/STATE_AND_TRACE_MODEL.md`

## Data Flow

```txt
Host chooses/validates sessionId
  -> FileSessionStore.create/append/appendEvent
  -> session.json + events.jsonl
  -> FileRunStore writes session trace/transcript and agent run files
```

## Contracts

- Default root: `<workspace>/.sparkwright/sessions`.
- `session.json` contains id, timestamps, ordered `runIds`, metadata, and event count.
- `events.jsonl` contains append-only `SessionEvent` rows with session-local sequence.
- Session-scoped `FileRunStore` writes session `trace.jsonl` /
  `transcript.jsonl`, `agents/<agent-id>/trace.jsonl`, per-run `run.json` /
  `result.json`, and `trace-pointer.json` files that point from each run
  directory back to the aggregate session and agent traces.
- `validateSessionTraceConsistency` checks agreement between session files, trace metadata, run files, and safety-relevant failures.
- `repairSessionTraceConsistency` only repairs derived session metadata; it does not invent missing run/result files.

## Consumers

- Host `session.list`, `session.inspect`, `session.compact`, `session.fork`.
- CLI `session summary|check|repair|resume`.
- TUI session list, switch, inspect, fork, compact, export.

## Change Checklist

- Keep `sessionId`, `runId`, and `SessionEvent.sequence` semantics separate.
- Update trace consistency checks when layout or metadata changes.
- Preserve unknown `session.json` metadata when file stores reopen existing sessions.
- Check multi-agent paths under `agents/<agent-id>/`.

## Known Debts

- File-backed session updates are best-effort and not a full database transaction model.
- Session metadata should make terminal run state easier to inspect.

## Last Verified

- Status: Verified
- Date: 2026-06-20
- Read: `packages/core/src/session.ts`, `packages/core/src/trace.ts`, `packages/host/src/runtime.ts`, `packages/acp-adapter/test/round-trip.test.ts`, `docs/reference/STATE_AND_TRACE_MODEL.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/trace.test.ts`; `npm --workspace @sparkwright/acp-adapter test -- test/round-trip.test.ts test/session-root.test.ts`; `npm run release:check`.
