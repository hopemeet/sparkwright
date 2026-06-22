# Resume Replay

## Purpose

Resume and replay let SparkWright continue or seed future work from persisted
state without pretending all live process state is durable.

See [session-store.md](session-store.md) and [../runtime/context-compaction.md](../runtime/context-compaction.md).

## Main Files

- `packages/core/src/run.ts`
- `packages/core/src/trace.ts`
- `packages/core/src/session.ts`
- `packages/host/src/runtime.ts`
- `packages/cli/src/cli.ts`
- `packages/tui/src/state/run-controller.ts`

## Data Flow

```txt
Normal run
  -> checkpoint.json + trace.jsonl + run/result files
  -> run resume uses checkpoint

Missing checkpoint
  -> loadCheckpointFromRunDir({ fallbackFromTrace: true })
  -> partial checkpoint
  -> force required

Session resume
  -> replay session run events
  -> summary/context items
  -> new run in same session

Future run in compacted session
  -> load compact.json when throughRunId matches completed turns
  -> compact context item + later un-compacted turns
  -> warning context item if compact artifact cannot be anchored
```

## Contracts

- Checkpoint resume is the normal path.
- From-trace resume is best-effort recovery; it restores counters/coarse step data, not full in-loop context.
- Reconstructed checkpoints are marked not fully resumable and require explicit force.
- Session replay projects persisted events into context; it is not live-process restoration.
- Session compact artifacts seed future context only when `throughRunId` can be
  matched to completed turns. A mismatch produces an explicit
  conversation-layer warning item and falls back to replaying completed turns.
- TUI session switch replays persisted events for display and filters stream-only events.

## Consumers

- CLI `run resume` and `session resume`.
- Host `run.resume`.
- TUI session switch, retry, and resume flows.

## Change Checklist

- Keep checkpoint schema changes backward aware.
- Update both CLI and host resume paths.
- Check TUI replay when new event families affect visible transcript.
- Do not silently treat from-trace reconstruction as full resume.

## Known Debts

- Reconstructed resume cannot restore pending summaries, in-flight tool/model work, or full context.
- Replay-derived context can become noisy for long sessions.
- Deterministic session compact and opt-in model-backed Tier 3 summarization
  reduce future context noise; background auto-trigger policy still needs a
  run-loop integration.

## Last Verified

- Status: Verified
- Date: 2026-06-21
- Read: `packages/core/src/run.ts`, `packages/core/src/trace.ts`, `packages/core/src/session.ts`, `packages/core/src/session-compaction.ts`, `packages/host/src/runtime.ts`, `packages/cli/src/cli.ts`, `packages/tui/src/state/run-controller.ts`.
- Tests: `npm --workspace @sparkwright/core test -- session-compact.test.ts`;
  `npm --workspace @sparkwright/host test -- protocol.test.ts`;
  `npm --workspace @sparkwright/tui test -- sdk-cutover.test.ts`;
  `npm run release:check`.
