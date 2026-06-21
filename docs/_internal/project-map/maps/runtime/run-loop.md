# Run Loop

## Purpose

The run loop turns a goal into controlled model/tool/workspace activity with
events, policy checks, approvals, artifacts, and terminal results.

See [tool-orchestration.md](tool-orchestration.md) and [../trace/raw-trace.md](../trace/raw-trace.md).

## Main Files

- `packages/core/src/run.ts`
- `packages/core/src/events.ts`
- `packages/core/src/run-validation.ts`
- `packages/core/src/run-outcome.ts`
- `packages/host/src/runtime.ts`

## Data Flow

```txt
createRun/resumeRunFromCheckpoint
  -> context assembly
  -> prompt build
  -> model call / streaming
  -> tool batch handling
  -> policy + approval + workspace/artifact effects
  -> terminal result + store.finish()
```

## Contracts

- Terminal states are `completed`, `failed`, and `cancelled`.
- Do not infer terminal run outcome from `model.completed` or `tool.completed`.
- State transitions emit diagnostics when rejected.
- Budget and max-step behavior are part of runtime semantics.
- Runtime compaction stages run before prompt-bound model calls when configured.
  Stage results with no net savings are reported as skipped rather than applied,
  and compaction failures preserve partial progress and continue.
- Same-turn repeated tool-call fan-out remains a doom-loop signal even when the
  duplicate observations are labeled as in-flight rather than completed-result
  repeats.
- Sinks should not break event emission.

## Consumers

- Host runtime and direct-core CLI path.
- Trace summary/timeline/verify.
- TUI live state and approval UI.

## Change Checklist

- Update `RUN_EVENTS.md` when phase or event-family semantics change.
- Check trace filtering for new events.
- Check resume checkpoint shape when adding live loop state.
- Check host continuation/supervisor behavior.

## Known Debts

- Some live state is resumability-sensitive and not fully serializable.
- Repeated tool-call handling exists but diagnostics can still be noisy.

## Last Verified

- Status: Verified
- Date: 2026-06-21
- Read: `packages/core/src/run.ts`, `packages/core/src/pipeline.ts`, `packages/core/test/run.test.ts`, `packages/core/test/run-loop-extensions.test.ts`, `docs/reference/RUN_EVENTS.md`, `docs/reference/STATE_AND_TRACE_MODEL.md`, `docs/_internal/project-map/maps/runtime/tool-orchestration.md`.
- Tests: `npm --workspace @sparkwright/core test`; `npm run build`; `npm run typecheck:test`.
