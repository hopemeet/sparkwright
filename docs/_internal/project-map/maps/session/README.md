# Session Maps

## Purpose

Session maps explain how SparkWright groups runs, stores session-level facts,
replays prior runs, resumes work, and exposes inspection/repair workflows.

## Main Files

- `packages/core/src/session.ts`
- `packages/core/src/trace.ts`
- `packages/host/src/runtime.ts`
- `packages/cli/src/cli.ts`
- `packages/tui/src/state/run-controller.ts`
- `docs/reference/STATE_AND_TRACE_MODEL.md`

## Data Flow

```txt
run.start with sessionId
  -> FileSessionStore membership/events
  -> FileRunStore session trace/transcript/run files
  -> replay/inspect/resume/compact/fork
```

## Contracts

- A session groups runs; it is not memory and not a permission cache.
- `session.json` and `events.jsonl` are session-level state.
- `trace.jsonl` is run evidence aggregated under the session.
- Replay projects run events into session order; it is not full process resume.

## Consumers

- Host runtime start/resume/inspect/compact/fork.
- CLI session commands.
- TUI session browser, switch, retry, fork, compact, export.

## Change Checklist

- Read [session-store.md](session-store.md) before changing file layout.
- Read [resume-replay.md](resume-replay.md) before changing resume or replay.
- Check trace consistency validation and repair after layout changes.

## Known Debts

- Session metadata terminal/completion state could be surfaced more strongly.
- Some session facts are derived from trace and must not become competing truth.

## Last Verified

- Status: Read-only
- Date: 2026-06-18
- Read: `packages/core/src/session.ts`, `packages/core/src/trace.ts`, `packages/host/src/runtime.ts`, `packages/cli/src/cli.ts`, `packages/tui/src/state/run-controller.ts`.
- Tests: not run; documentation-only map pass.
