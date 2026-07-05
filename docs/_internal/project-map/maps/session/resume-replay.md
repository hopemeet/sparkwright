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

Workflow resume
  -> locate session workflow-runs/<workflowRunId>.json
  -> acquire single-writer lease
  -> consume input waits at the actor boundary when status is waiting
  -> start a transient worker run with the pinned workflow definition
  -> re-run verifier nodes whose latest verdict passed when verifyOnResume is true

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
- `sparkwright session resume` starts a new run in the existing session context.
  It does not infer the previous run's CLI/TUI model override from trace
  history; pass `--model provider/model` to choose an explicit resume model.
- `sparkwright workflow resume <workflowRunId>` is workflow-state adoption, not
  checkpoint replay. It resumes only non-terminal workflow records, uses the
  stored compiled definition snapshot rather than the live asset folder, and
  defaults `verifyOnResume` to true so completed verifier nodes whose latest
  verdict passed are rechecked before trusting the stored position.
- Session compact artifacts seed future context only when `throughRunId` can be
  matched to completed turns. A mismatch produces an explicit
  conversation-layer warning item and falls back to replaying completed turns.
- Core `waiting_tasks` is live in-process run state only. Checkpoints record
  that it is not durable; resume must not claim to reconstruct awaited task
  revival until a durable waiting-state/outbox design exists.
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
- Durable detach/resume for awaited background task revival remains deferred;
  CLI `--detach` should not be added without durable waiting-state/checkpoint
  reconstruction.
- Replay-derived context can become noisy for long sessions.
- Deterministic session compact and opt-in model-backed Tier 3 summarization
  reduce future context noise; background auto-trigger policy still needs a
  run-loop integration.

## Last Verified

- Status: Verified
- Date: 2026-07-05T11:36:37+0800
- Scope: workflow-runtime-v1 P3 Step 4a resume boundary: host run resume and
  workflow resume now route through `startWorkflowActorEpisodeChain()` after
  `startSupervisedRunChain()` deletion. Workflow resume consumes input waits at
  the actor boundary before creating the next worker episode; protocol payloads
  and checkpoint schema are unchanged.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/test/protocol.test.ts`,
  `packages/host/test/workflows.test.ts`,
  `packages/cli/test/cli.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t
  "resumes a session-scoped checkpoint|fails orphaned in-process awaited
  tasks|legacy run directory|workflow"`; `npm --workspace @sparkwright/host
  test -- test/workflows.test.ts`; `npm --workspace @sparkwright/cli test --
  test/cli.test.ts -t "workflow|run resume through the host"`.

- Status: Verified
- Date: 2026-07-05T10:13:38+0800
- Scope: workflow-runtime-v1 P3 Step 1 resume boundary: `run.resume` and
  `workflow.resume` still start ordinary host/core runs, but any todo
  continuation in the supervised chain now runs through the workflow-owned
  `runWorkflowRunChain()` driver via `runTodoSupervised()`. No protocol resume
  payload or checkpoint semantics changed.
- Read: `packages/host/src/runtime.ts`,
  `packages/agent-runtime/src/todo/supervisor.ts`,
  `packages/agent-runtime/src/workflows/run-chain.ts`,
  `packages/host/test/protocol.test.ts`,
  `packages/host/test/workflows.test.ts`.
- Tests: `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t
  "workflow|resume.*todo|unfinished todos|run.resume"`; `npm --workspace
  @sparkwright/host test -- test/workflows.test.ts`; `npm --workspace
  @sparkwright/host run typecheck`.

- Status: Verified
- Date: 2026-07-05T09:01:34+0800
- Scope: P2 post-review resume semantics: workflow resume still adopts under a
  single-writer lease and pinned definition snapshot, but resume
  re-verification is limited to verifier nodes whose latest stored verdict is
  passed so historical failed-onFail paths are not treated as completed nodes.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/test/workflows.test.ts`,
  `packages/host/test/workflow-hooks.test.ts`.
- Tests: `npm --workspace @sparkwright/host test --
  test/workflows.test.ts -t "workflow"`; `npm --workspace @sparkwright/host
  test -- test/workflow-hooks.test.ts -t "resume|workflow
  projection|projection"`; `npm run typecheck:test`.

- Status: Verified
- Date: 2026-07-05T00:42:02+0800
- Scope: workflow-runtime-v1 P2 resume path: durable workflow resume is a
  separate host/CLI surface from core checkpoint resume and session replay; it
  adopts a `WorkflowRunRecord` under a single-writer lease, starts a new run in
  the same session, and re-verifies completed command-verifier nodes by default.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/cli/src/cli.ts`,
  `packages/host/test/workflows.test.ts`,
  `packages/host/test/workflow-hooks.test.ts`.
- Tests: `npm --workspace @sparkwright/host test --
  test/workflows.test.ts test/workflow-hooks.test.ts -t "workflow"`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "workflow"`.

- Status: Verified
- Date: 2026-07-02T01:15:00+0800
- Scope: documented that background-task revival `waiting_tasks` is not durable
  checkpoint state yet, so P4+ CLI detach/resume remains deferred until awaited
  task revival can be reconstructed from durable state.
- Read: `packages/core/src/run.ts`,
  `docs/_internal/proposals/background-task-lifecycle.md`,
  `docs/_internal/project-map/maps/session/resume-replay.md`.
- Tests: core run-loop waiting-task focused tests; no resume behavior change
  was implemented.

- Status: Verified
- Date: 2026-06-29T17:40:00+0800
- Scope: CLI `run resume --help` is side-effect-free help output and does not
  enter checkpoint lookup, host resume validation, or session/trace creation.
  Resume storage semantics did not change.
- Read: `packages/cli/src/cli.ts`, `packages/cli/test/cli.test.ts`,
  `docs/_internal/project-map/maps/session/resume-replay.md`.
- Tests: `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t
  "help|run resume"`; `node packages/cli/dist/index.js run resume --help`;
  `npm run check:dist-fresh`.

- Status: Verified
- Date: 2026-06-29T09:28:39+0800
- Scope: checked after tool display/name consolidation; resume/replay storage,
  checkpoint lookup, and session replay semantics did not change.
- Read: `packages/cli/src/cli.ts`,
  `packages/host/src/runtime.ts`,
  `packages/core/src/context.ts`,
  `docs/_internal/project-map/maps/session/resume-replay.md`.
- Tests: `npm --workspace @sparkwright/cli test -- test/cli.test.ts test/config-schema.test.ts`;
  `npm --workspace @sparkwright/core test -- test/context.test.ts test/run.test.ts test/trace.test.ts`.

- Status: Verified
- Date: 2026-06-26T23:59:00+0800
- Scope: `run.resume` accessMode/ceiling projection at the host boundary; no
  change to checkpoint replay semantics.
- Read: `packages/core/src/run.ts`, `packages/core/src/trace.ts`,
  `packages/core/src/session.ts`, `packages/core/src/session-compaction.ts`,
  `packages/host/src/runtime.ts`, `packages/host/src/run-access.ts`,
  `packages/cli/src/cli.ts`, `packages/tui/src/state/run-controller.ts`.
- Tests: `npm --workspace @sparkwright/host test -- test/run-access.test.ts test/protocol.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts`;
  `npm run build`; `npm run check:dist-fresh`.
