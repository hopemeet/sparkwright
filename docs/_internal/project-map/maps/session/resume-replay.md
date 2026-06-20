# Resume Replay

## Purpose

Resume and replay let Sparkwright continue or seed future work from persisted
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
```

## Contracts

- Checkpoint resume is the normal path.
- From-trace resume is best-effort recovery; it restores counters/coarse step data, not full in-loop context.
- Reconstructed checkpoints are marked not fully resumable and require explicit force.
- Session replay projects persisted events into context; it is not live-process restoration.
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

## Last Verified

- Status: Read-only
- Date: 2026-06-18
- Read: `packages/core/src/run.ts`, `packages/core/src/trace.ts`, `packages/core/src/session.ts`, `packages/host/src/runtime.ts`, `packages/cli/src/cli.ts`, `packages/tui/src/state/run-controller.ts`.
- Tests: not run; documentation-only map pass.
