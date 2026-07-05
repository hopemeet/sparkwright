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
- `cancel()` emits `run.cancelled` synchronously and kicks the `RunEnd`
  workflow-hook phase with `state:"cancelled"` / `reason:"manual_cancelled"`.
  `RunEnd` remains fire-and-forget.
- Do not infer terminal run outcome from `model.completed` or `tool.completed`.
- State transitions emit diagnostics when rejected.
- Budget and max-step behavior are part of runtime semantics.
- Runtime compaction stages run before prompt-bound model calls when configured.
  Stage results with no net savings are reported as skipped rather than applied,
  and compaction failures preserve partial progress and continue.
- `run.started.payload.resolvedModel.pricing` is startup diagnostics from the
  host model factory. Missing pricing is warning-only and does not affect model
  execution, validation, or terminal state.
- Same-turn repeated tool-call fan-out remains a doom-loop signal even when the
  duplicate observations are labeled as in-flight rather than completed-result
  repeats.
- A repeated tool call after a same-target failure carries prior failure
  context into the synthetic `REPEATED_TOOL_CALL_SKIPPED` result. Policy and
  approval denials keep their expected-denial category through the guard; other
  repeated calls keep the normal argument/runtime failure classification.
- Before emitting `tool.requested`, the run loop asks the concrete
  `ToolDefinition.previewArgs()` for bounded display text and stores it on the
  event payload as `preview`; this is presentation metadata and does not affect
  validation, policy, or execution.
- The run loop owns live run-health feedback subscription. `RunHealthAnalyzer`
  observes the event log and appends `run.health` context after a read-like tool
  returns the same unchanged file window again; this is model feedback, not a
  terminal failure or protocol event.
- The run loop also owns the live `FactLedger` subscription. It observes the
  same append-only event log for shell command facts, hook-launched command
  facts, verifier result satisfaction, forced-continuation budget exhaustion,
  workspace writes, and the global write epoch. `WorkflowHookInput.facts`
  exposes a read-only view to hooks.
- Tool gate argument failures, including synchronous `policyForArgs()`
  normalization errors, stay inside the tool lifecycle as `tool.failed` rather
  than escaping the loop and leaving an unterminated trace.
- Tool input processing order is schema validation, optional
  `ToolDefinition.validateInput()`, `policyForArgs()`, policy decision,
  approval, execute, then output validation. Semantic `validateInput()`
  failures are model-correctable tool failures before policy/approval, while
  `policyForArgs()` exceptions keep their existing `phase: "policyForArgs"`
  metadata.
- Host assembles workflow hooks in configured hooks, built-in verification
  invariant hooks, built-in documented-command invariant hooks, then selected
  workflow asset projection order before passing them to core. This is an
  assembly invariant, not a new run-loop execution path; P1.5/D25 removes the
  old verification/documented-command gate producers and keeps run-level
  invariants outside the linear workflow state machine.
- Deferred tool calls are not hard-blocked solely because their schema was not
  model-loaded. When schema validation fails for an unloaded deferred tool, the
  run loop emits the normal requested -> failed span and adds recovery metadata
  pointing at `tool_search` with `select:<toolName>`. The schema-loaded check
  is based on the loaded-deferred set captured at the start of that model turn;
  same-turn `tool_search` results update the live set for the next model request
  but do not erase recovery metadata from sibling invalid deferred calls.
- Concurrent tool batches keep event emission and hooks in real completion
  order, but model-visible tool observations are appended after the batch in
  original request order. This keeps trace fidelity while stabilizing the next
  model call's context.
- `fail()` is the terminal failure boundary for payload hygiene. It sanitizes
  `metadata.cause` to a bounded diagnostic summary before emitting
  `run.failed`, returning `RunResult`, or invoking `RunEnd` hooks; raw
  provider request bodies, prompt input, and tool schemas must not be carried as
  failure metadata.
- `complete("final_answer")` snapshots the live FactLedger onto
  `run.completed.factLedger` and derives the terminal command outcome from that
  ledger. A clean ledger does not fall back to legacy event recompute; the
  existing `commandOutcome` and `outcome` shapes remain the public terminal
  projection when failures are present.
- Sinks should not break event emission.
- Host pre-run preparation can buffer capability diagnostics before `createRun`
  exists. When flushed into the real run event log, warning-severity
  `capability.index.failed` events are diagnostics only and must not be treated
  as terminal failures.
- Host pre-run preparation can also emit `agent.routing.evaluated` after
  sorting configured delegate tools by profile routing hints for the current
  goal. This event is observability for tool ordering/labels only; it does not
  remove tools, change run outcome, or grant permissions.
- Host pre-run capability snapshots can include `rules.workflow` descriptors for
  configured workflow hooks, verification invariants, and built-in verifier
  rules, plus `rules.events` descriptors for non-blocking event subscribers.
  These are inspection metadata only; the run loop still executes the existing
  `workflowHooks` array with canonical lifecycle values. Built-in
  documented-command hooks remain absent for inactive runs; active results may
  carry built-in rule metadata for trace explanation.
- Host event hook rules are outside the awaited `workflowHooks` array. They
  subscribe to run events through `bindUserHooks()`, so slow or failed event
  actions emit `user_hook.*` diagnostics without blocking the run loop.
- The `workflowHooks` array, by contrast, is awaited at each lifecycle gate
  because its results (`block`/`advance`/`rewrite`/`continue` context)
  deterministically steer the loop — you cannot block a `Stop`, advance a
  healthy `ModelOutput`/`Stop` continuation, rewrite `PreToolUse` arguments, or
  inject context without the result before proceeding. A host `agent` workflow
  action therefore runs a full sub-agent synchronously inside that gate and
  spends foreground run time; non-blocking automation must use event hooks
  instead. Guards live in the host (`enforceWorkflowHookEffect`, agent reentrancy
  and Stop-block dedupe); see [../../modules/host.md](../../modules/host.md).
- The opt-in `delegate_parallel` fan-out path is still a normal foreground tool
  call from the core run loop's perspective. The parent observes one
  `tool.*` lifecycle for the fan-out request, while host/agent-runtime child
  runs emit their own parent-visible `subagent.*` events and child `run.*`
  streams.
- Core notification revival uses the shared `NotificationSource` contract. At
  step start, the run loop drains sources and injects messages through the
  existing `run.notification.injected` path; do not add synthetic user turns or
  a separate notification event family for task revival.
- `waiting_tasks` is an internal live run state only, not a `RunResult` state.
  It waits for awaited task readiness, command input, or abort. Task readiness
  must come from a non-consuming queue wait; command readiness must be derived
  from `run.command.enqueued`; abort uses the run abort signal. Checkpoints mark
  this live state as not durable rather than pretending it can resume awaited
  task revival. Revival turns use the `revival` source of the per-source
  forced-continuation budget (`maxRevivalTurns` remains the default-5 alias),
  not `maxSteps`; the revival step still increments monotonically, but the loop
  guard lets a budgeted `waiting_tasks` wake enter after `step > maxSteps`.
  Exhaustion emits `run.budget.exceeded` / FactLedger `budgetExceeded` and
  refuses revival without failing the run directly. All three race legs share
  one per-wait abort signal for cleanup.
- P3 Step 2 keeps the terminal ordering as Stop-before-await:
  `workflowHooks(Stop)` run before `waitForAwaitedTasksBeforeTerminal()`.
  A Stop-time `task_terminal` verifier observes pre-await run state and pays one
  extra forced turn after an awaited task wake; core does not move the await
  gate ahead of Stop in this slice.
- Workflow projection continuations from `workflow:` hooks use the same
  per-source forced-continuation budget under source `workflow`. Healthy
  `advance`, verifier/error `block`, and projection-error retry turns consume
  that source and carry `forcedContinuationSource:"workflow"` transition
  metadata, so `maxSteps` remains the foreground work budget. Source exhaustion
  emits `run.budget.exceeded`, kicks an awaited workflow-source
  `RuntimeSignal(budget.exceeded)`, and refuses the forced continuation; host
  projection decides any workflow interruption or terminal failure.
- P2 workflow durability remains host-side. Core still executes one ordinary
  run loop with immutable hook arrays; host projection snapshots persist
  workflow position/attempt/verdict/transition state into `WorkflowRunRecord`.
  Cross-run `workflow resume` starts a new core run with the pinned workflow
  definition and optional resume re-verification before the stored node
  position is trusted.
- P3 Step 3 human waiting remains host projection/store behavior rather than a
  new core run state. A `human` node emits `workflow.waiting`, persists
  `WorkflowRunRecord.status:"waiting"`, and lets the ordinary host run finish;
  host finalization treats that waiting record as resumable instead of a
  workflow runtime failure. This does not change core `waiting_tasks` or
  Stop-before-await ordering.
- P3 Step 4a does not change core run-loop semantics. Host retired
  `startSupervisedRunChain()` and now uses
  `startWorkflowActorEpisodeChain()` to create ordinary core
  `createRun()`/`resumeRunFromCheckpoint()` worker episodes while the
  workflow/todo actor owns the chain shape through
  `runTodoSupervised()` -> `runWorkflowRunChain()`.
- P3 Step 4b.2 still keeps core workflow-unaware: host selects the active
  workflow node's model adapter and `runBudget` before `createRun()`, so core
  only enforces an ordinary worker run budget and emits ordinary usage/outcome
  facts. Retry-time model escalation needs a future model-node boundary split
  that starts a new worker episode; it is not a new in-loop mutation.
- P4 script nodes also keep core workflow-unaware. Host projection drains a
  script node before the next model boundary and records verdict/evidence into
  `WorkflowRunRecord`; core only sees ordinary workflow-hook advances, blocks,
  and forced-continuation budget events. The script stdio node API reads prior
  node evidence through host-owned `getEvidence(nodeId)`; there is no expression
  language, no direct trace writer in the script, and no node-boundary
  compaction trigger in this slice.
- P5 bounded `parallel` / `join` also stays outside core loop semantics. Host
  projection drains the non-model parallel node, records branch verdict/evidence
  in `WorkflowRunRecord.parallelBranches`, preserves branch runtime errors as
  fail-closed node verdicts, rejects branch-local verifiers that are not wired
  in P5, and drains `join` by reading durable state from the unique producer
  parallel node. `parallel` requires explicit `onPass` so the portable state
  machine's default next-node transition cannot fall through into branch
  execution. Core still observes normal awaited workflow hooks,
  `advance`/`block` results, and the existing workflow forced-continuation
  source; there is no branch scheduler, branch cancellation bus, or multiple
  concurrent model episode loop inside core.
- P9a D5 workspace-root workflow storage also stays host-side. Fresh
  `WorkflowRunRecord` files move to workspace `.sparkwright/workflow-runs/`,
  list/resume still read legacy session-local stores, and the resumed worker
  episode still enters core as an ordinary run with the pinned workflow
  definition.

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
- Repeated read-window feedback now exists, but broader live duplicate-tool
  handling can still be noisy.

## Last Verified

- Status: Verified
- Date: 2026-07-05T23:09:50+0800
- Scope: workflow-runtime-v1 P9a D5 run-loop boundary: moving fresh workflow
  run records to the workspace store changes host lookup/persistence only.
  Core `createRun`/resume/checkpoint semantics, workflow hook lifecycle, and
  forced-continuation budgets remain unchanged.
- Read: `packages/host/src/runtime.ts`,
  `packages/agent-runtime/src/workflows/store.ts`,
  `packages/host/test/workflows.test.ts`,
  `packages/host/test/protocol.test.ts`.
- Tests: `npm --workspace @sparkwright/host test --
  test/workflows.test.ts -t "workflow"`; `npm --workspace @sparkwright/host
  test -- test/protocol.test.ts -t "workflow"`; `npm --workspace
  @sparkwright/host run typecheck`.

- Status: Read-only
- Date: 2026-07-05T22:20:59+0800
- Scope: workflow-runtime-v1 P8a routed-page check: offline `workflow shadow`
  does not call `createRun`, instantiate workflow projection hooks, advance
  workflow runtime state, affect cancellation, or write terminal run outcomes.
- Read: `packages/host/src/workflow-shadow.ts`,
  `packages/cli/src/cli.ts`,
  `packages/host/test/workflow-shadow.test.ts`,
  `packages/cli/test/cli.test.ts`.
- Tests: not run for live run-loop behavior; P8a made no run-loop semantic
  change. Focused shadow gates passed in host/CLI.

- Status: Verified
- Date: 2026-07-05T20:18:29+0800
- Scope: workflow-runtime-v1 P5 post-review run-loop boundary: explicit
  `parallel.onPass` and branch-verifier validation are host projection
  constructor rules, delegate_parallel infra errors become workflow node
  runtime errors through the existing hook path, and runtime terminal failures
  preserve durable branch diagnostics without adding core loop state.
- Read: `packages/host/src/workflow-projection.ts`,
  `packages/agent-runtime/src/workflows/machine.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test --
  test/workflow-hooks.test.ts -t "parallel|join|delegate_parallel|branch
  diagnostics"`; `npm --workspace @sparkwright/host test --
  test/workflows.test.ts test/workflow-hooks.test.ts`.

- Status: Verified
- Date: 2026-07-05T18:02:15+0800
- Scope: workflow-runtime-v1 P5 run-loop boundary: bounded parallel/join is
  host projection plus durable workflow state, including delegate fan-out
  batching and fail-closed branch runtime errors; core loop/hook lifecycle,
  workflow forced-continuation budget, and cancellation semantics are unchanged.
- Read: `packages/core/src/run.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/workflow-hooks.test.ts
  -t "parallel|join|delegate_parallel"`; `npm --workspace @sparkwright/host
  test -- test/workflows.test.ts test/workflow-hooks.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`.

- Status: Verified
- Date: 2026-07-05T15:31:20+0800
- Scope: workflow-runtime-v1 P4 run-loop boundary: script node execution is a
  host projection drain through the stdio node API, while core loop semantics,
  hook lifecycles, forced-continuation budgets, and compaction timing remain
  unchanged.
- Read: `packages/core/src/run.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/host/src/workflow-node-api.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test --
  test/workflow-hooks.test.ts`; `npm --workspace @sparkwright/host run
  typecheck`; `npm run release:check`.

- Status: Verified
- Date: 2026-07-05T12:15:55+0800
- Scope: workflow-runtime-v1 P3 Step 4b.2 run-loop boundary: node
  `runBudget` is applied by host at worker `createRun()` entry and core
  remains workflow-unaware; existing budget/run tests cover the unchanged core
  semantics.
- Read: `packages/core/src/run.ts`, `packages/core/test/run.test.ts`,
  `packages/host/src/runtime.ts`, `packages/host/test/workflows.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/run.test.ts -t
  "budget|workflow source budget"`; `npm --workspace @sparkwright/host test --
  test/workflows.test.ts -t "node model and budget"`.

- Status: Verified
- Date: 2026-07-05T11:36:37+0800
- Scope: workflow-runtime-v1 P3 Step 4a run-loop boundary: deleting
  `startSupervisedRunChain()` changes host episode ownership only. Core still
  sees ordinary run/resume workers, unchanged workflow hook phases, and
  unchanged waiting_tasks semantics.
- Read: `packages/core/src/run.ts`,
  `packages/core/test/run-loop-extensions.test.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/test/protocol.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/core test --
  test/run-loop-extensions.test.ts -t "resumeRunFromCheckpoint"`;
  `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t
  "resumes a session-scoped checkpoint|fails orphaned in-process awaited
  tasks|legacy run directory|workflow"`.

- Status: Verified
- Date: 2026-07-05T11:21:09+0800
- Scope: workflow-runtime-v1 P3 Step 3 run-loop boundary: human waiting is
  host projection/store state with reliable workflow actor notification; core
  still runs ordinary hook phases and `waiting_tasks` semantics are unchanged.
- Read: `packages/core/src/run.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `packages/host/test/workflows.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/workflow-hooks.test.ts`;
  `npm --workspace @sparkwright/host test -- test/workflows.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`.

- Status: Verified
- Date: 2026-07-05T10:39:09+0800
- Scope: workflow-runtime-v1 P3 Step 2 run-loop ordering boundary: core keeps
  Stop workflow hooks before `waitForAwaitedTasksBeforeTerminal()`, so
  `task_terminal` observes pre-await state and awaited-task wakes pay one extra
  forced turn; non-model workflow node execution remains host projection work,
  not a new core loop state.
- Read: `packages/core/src/run.ts`,
  `packages/core/test/run.test.ts`,
  `packages/host/src/workflow-projection.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/run.test.ts -t
  "waiting_tasks|awaited task|workflow source budget|Stop workflow hooks before
  entering waiting_tasks"`; `npm --workspace @sparkwright/core run typecheck`.

- Status: Verified
- Date: 2026-07-05T10:13:38+0800
- Scope: workflow-runtime-v1 P3 Step 1 run-loop boundary: the todo
  continuation chain now uses the workflow-owned `runWorkflowRunChain()` driver,
  while core still sees ordinary `createRun` / `resumeRunFromCheckpoint` runs
  and unchanged workflow hook/forced-continuation semantics.
- Read: `packages/core/src/run.ts`,
  `packages/host/src/runtime.ts`,
  `packages/agent-runtime/src/todo/supervisor.ts`,
  `packages/agent-runtime/src/workflows/run-chain.ts`,
  `packages/host/test/workflows.test.ts`,
  `packages/host/test/protocol.test.ts`.
- Tests: `npm --workspace @sparkwright/host test -- test/workflows.test.ts`;
  `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t
  "workflow|resume.*todo|unfinished todos|run.resume"`; `npm --workspace
  @sparkwright/agent-runtime test -- test/todo.test.ts -t
  "runTodoSupervised|workflow run-chain"`.

- Status: Verified
- Date: 2026-07-05T00:42:02+0800
- Scope: workflow-runtime-v1 P2 run-loop boundary: workflow durability and
  resume re-verification are host projection/store concerns; core hook arrays,
  FactLedger snapshots, forced-continuation budget semantics, and normal run
  terminal states remain unchanged.
- Read: `packages/core/src/run.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `packages/host/test/workflows.test.ts`.
- Tests: `npm --workspace @sparkwright/host test --
  test/workflows.test.ts test/workflow-hooks.test.ts -t "workflow"`;
  `npm --workspace @sparkwright/host run typecheck`.

- Status: Verified
- Date: 2026-07-04T22:20:04+0800
- Scope: workflow-runtime-v1 D25 run-loop integration: host supplies
  verification/documented-command invariant hooks as ordinary awaited workflow
  hooks while core continues to own FactLedger snapshots, write epochs, and
  budget refusal facts; explicit workflow projections remain the only governing
  workflow state machine.
- Read: `packages/core/src/run.ts`,
  `packages/core/src/run-outcome.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/src/invariant-projection.ts`,
  `packages/host/test/workflow-hooks.test.ts`.
- Tests: `npm --workspace @sparkwright/core test --
  test/fact-ledger.test.ts test/run-outcome.test.ts`; `npm --workspace
  @sparkwright/host test -- test/workflow-hooks.test.ts -t "runtime workflow
  hook assembly|createInvariantProjectionHooks|createVerificationWorkflowHooks"`;
  `npm run check`; `npm run release:check`.

- Status: Verified
- Date: 2026-07-04T16:47:47+0800
- Scope: workflow-runtime-v1 P1.5 run-loop integration: host now passes
  projection-compiled implicit verification/documented-command hooks, delegate
  child runs use the same assembly, and terminal command/profile outcomes prefer
  FactLedger snapshots.
- Read: `packages/core/src/run.ts`,
  `packages/core/src/run-outcome.ts`,
  `packages/core/src/fact-ledger.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/src/verification.ts`,
  `packages/host/src/documented-command-check.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/host/test/workflow-hooks.test.ts`.
- Tests: `npm --workspace @sparkwright/core test --
  test/run-outcome.test.ts test/fact-ledger.test.ts`; `npm --workspace
  @sparkwright/host test -- test/workflow-hooks.test.ts
  test/documented-command-check.test.ts test/workflows.test.ts
  test/protocol.test.ts -t "workflow|verification|documented-command|documented
  command"`; `npm --workspace @sparkwright/host test -- test/tools.test.ts -t
  "profile workflow hooks|delegate_parallel child runs|resolves profile workflow
  hooks"`.

- Status: Verified
- Date: 2026-07-04T12:43:33+0800
- Scope: workflow-runtime-v1 S3 run-loop integration: per-source
  forced-continuation budget, revival migration preserving `waiting_tasks`
  wake metadata and `revivalTurnsUsed`, `workflow` source registration with no
  consumer, `run.budget.exceeded` emission, and checkpoint snapshot of forced
  continuation budget state.
- Read: `packages/core/src/run.ts`,
  `packages/core/src/types.ts`,
  `packages/core/src/fact-ledger.ts`,
  `packages/core/test/run.test.ts`,
  `packages/core/test/fact-ledger.test.ts`.
- Tests: `npm --workspace @sparkwright/core test --
  test/fact-ledger.test.ts test/run.test.ts -t
  "FactLedger|revival|forced-continuation|budget"`;
  `npm --workspace @sparkwright/core run typecheck`.

- Status: Verified
- Date: 2026-07-04T10:10:34+0800
- Scope: workflow-runtime-v1 S2 run-loop integration: live FactLedger
  subscription, read-only facts passed to workflow hooks, and terminal
  `run.completed.factLedger` plus ledger-backed command outcome projection
  without stale raw-event fallback.
- Read: `packages/core/src/run.ts`,
  `packages/core/src/workflow-hooks.ts`,
  `packages/core/src/fact-ledger.ts`,
  `packages/core/src/run-outcome.ts`,
  `packages/core/test/fact-ledger.test.ts`,
  `packages/core/test/run.test.ts`,
  `packages/host/src/verification.ts`.
- Tests: `npm --workspace @sparkwright/core test --
  test/fact-ledger.test.ts test/run-outcome.test.ts test/run.test.ts
  test/trace.test.ts`; `npm --workspace @sparkwright/core run typecheck`;
  `npm --workspace @sparkwright/host test -- test/workflow-hooks.test.ts`.

- Status: Verified
- Date: 2026-07-04T08:16:19+0800
- Scope: pinned the host workflow hook assembly order
  configured -> verification -> documented-command and the current configured
  hook `advance` surface (`ModelOutput` and `Stop`) without changing core
  run-loop behavior.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `packages/core/src/workflow-hooks.ts`,
  `docs/_internal/project-map/maps/runtime/run-loop.md`.
- Tests: `npm --workspace @sparkwright/host test --
  test/workflow-hooks.test.ts -t "runtime workflow hook assembly|pins
  configured advance"`; `npm --workspace @sparkwright/host run typecheck`.

- Status: Verified
- Date: 2026-07-03T09:33:55+0800
- Scope: run-loop workflow hooks now distinguish healthy `advance`
  continuations from blocked hook violations; `ModelOutput` and `Stop`
  advance results inject continuation context, increment loop step/turn, set
  `workflow_hook_advanced` transition metadata, and keep trace on
  `workflow_hook.completed`.
- Read: `packages/core/src/run.ts`,
  `packages/core/src/workflow-hooks.ts`, `packages/core/src/types.ts`,
  `packages/core/test/workflow-hooks.test.ts`,
  `packages/host/src/workflow-hooks.ts`.
- Tests: `npm --workspace @sparkwright/core test --
  test/workflow-hooks.test.ts`; `npm --workspace @sparkwright/host test --
  test/workflow-hooks.test.ts -t "stdout JSON|workflow hook"`; `npm run build
  --workspace @sparkwright/core`; `npm --workspace @sparkwright/core run
  typecheck`; `npm --workspace @sparkwright/host run typecheck`; `npm run
  check:dist-fresh`.

- Status: Verified
- Date: 2026-07-02T21:55:07+0800
- Scope: run-loop repeated-tool nudges now carry prior failure category and use
  policy/approval-specific guidance for repeated expected denials without
  changing tool execution, policy decision order, approvals, or terminal run
  states.
- Read: `packages/core/src/run.ts`, `packages/core/src/run-outcome.ts`,
  `packages/core/src/types.ts`, `packages/core/test/run.test.ts`,
  `packages/core/test/run-outcome.test.ts`,
  `docs/_internal/project-map/maps/runtime/run-loop.md`.
- Tests: `npm --workspace @sparkwright/core test --
  test/run.test.ts test/run-outcome.test.ts test/trace.test.ts`;
  `npm --workspace @sparkwright/core run typecheck`;
  `npm run build --workspace @sparkwright/core`;
  `npm run check:dist-fresh`.

- Status: Verified
- Date: 2026-07-02T09:30:00+0800
- Scope: refreshed run-loop revival contract after adding independent
  `maxRevivalTurns`, allowing final-step awaited notification injection beyond
  `maxSteps`, cleaning up losing wait race legs through one abort signal, and
  reporting revival readiness failures as notification source failures.
- Read: `packages/core/src/run.ts`, `packages/core/test/run.test.ts`,
  `packages/host/src/runtime.ts`,
  `docs/_internal/proposals/background-task-lifecycle.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/run.test.ts -t
  "awaited task|waiting_tasks|revival"`; `npm --workspace @sparkwright/core run
  typecheck`.

- Status: Verified
- Date: 2026-07-02T01:15:00+0800
- Scope: core run loop revival spine: notification sources are drained at step
  start through `run.notification.injected`, awaited task terminal suspension
  uses internal `waiting_tasks`, wakeups race task readiness, event-derived
  command readiness, and abort, and checkpoints explicitly do not serialize
  live waiting-task state.
- Read: `packages/core/src/run.ts`, `packages/core/src/types.ts`,
  `packages/core/src/events.ts`, `packages/core/test/run.test.ts`,
  `packages/host/src/runtime.ts`.
- Tests: `npm --workspace @sparkwright/core test -- test/run.test.ts
  test/access-mode.test.ts`;
  `npm --workspace @sparkwright/core run typecheck`;
  `npm run build --workspace @sparkwright/core`.

- Status: Verified
- Date: 2026-07-01T11:56:08+0800
- Scope: checked core run-loop deferred-schema turn snapshot behavior and
  terminal span/timing preservation for the recovery path.
- Read: `packages/core/src/run.ts`, `packages/core/test/run.test.ts`,
  `docs/_internal/project-map/maps/runtime/run-loop.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/run.test.ts`;
  `npm --workspace @sparkwright/core run typecheck`.

- Status: Verified
- Date: 2026-06-30T23:59:00+0800
- Scope: checked core run-loop ordering for deferred recovery,
  `validateInput()`, terminal tool timing metadata, and concurrent observation
  context stabilization.
- Read: `packages/core/src/run.ts`, `packages/core/src/tools.ts`,
  `packages/core/test/run.test.ts`,
  `docs/_internal/project-map/maps/runtime/run-loop.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/run.test.ts`;
  `npm --workspace @sparkwright/core run typecheck`.

- Status: Verified
- Date: 2026-06-29T09:28:39+0800
- Scope: checked after catalog/tool identity consolidation; core run-loop
  scheduling semantics did not change, and deferred tools still load through
  `tool_search`.
- Read: `packages/core/src/run.ts`, `packages/core/src/tool-search.ts`,
  `packages/host/src/tool-catalog.ts`, `packages/host/src/runtime.ts`,
  `docs/_internal/project-map/maps/runtime/run-loop.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/tool-search.test.ts test/context.test.ts test/run.test.ts test/trace.test.ts`;
  `npm --workspace @sparkwright/host test -- test/tools.test.ts test/protocol.test.ts test/config.test.ts`.

- Status: Verified
- Date: 2026-06-28T12:05:59+0800
- Scope: documented why the `workflowHooks` array is awaited (its results steer
  the loop) while event hooks stay non-blocking, and that a host `agent` workflow
  action runs a sub-agent synchronously in the gate. No core run-loop code change
  in this pass; the HTTP SSRF hardening was host-side (see host.md).
- Read: `packages/core/src/run.ts`, `packages/core/src/workflow-hooks.ts`,
  `packages/host/src/workflow-hooks.ts`.
- Tests: `npm --workspace @sparkwright/host test -- test/workflow-hooks.test.ts`
  (25 passed); `npm --workspace @sparkwright/host run typecheck`.
- Prior verification — Date: 2026-06-27T22:36:34+0800
- Scope: P3/P4/P5 canonical-only work updates run-loop workflow lifecycle names,
  keeps event subscribers outside awaited workflow gates, and preserves
  documented-command conditional hook construction.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/active-rules.ts`,
  `packages/host/src/workflow-hooks.ts`,
  `packages/host/src/verification.ts`,
  `packages/host/src/documented-command-check.ts`,
  `packages/core/src/workflow-hooks.ts`,
  `packages/core/src/user-hooks.ts`,
  `packages/host/test/documented-command-check.test.ts`,
  `packages/host/test/protocol.test.ts`,
  `docs/reference/EXTENSION_INTERFACES.md`,
  `docs/reference/PROTOCOL.md`,
  `docs/_internal/project-map/maps/runtime/run-loop.md`.
- Tests: `npm --workspace @sparkwright/core test --
test/workflow-hooks.test.ts test/user-hooks.test.ts`;
  `npm --workspace @sparkwright/host test -- test/workflow-hooks.test.ts
test/config.test.ts test/protocol.test.ts -t "workflow|event|http|agent|stdoutJson|configured
workflow hooks|active workflow rule"`.
- Prior verification — Date: 2026-06-27T21:06:53+0800
- Scope: documented-command P1 kept runtime behavior compatible: inactive runs
  still do not receive a built-in Stop hook, active hook results now carry
  built-in rule metadata, and lifecycle values/executor wiring remain
  unchanged. P2 docs clarify lifecycle effects without core code changes.
- Tests: `npm --workspace @sparkwright/host test --
test/documented-command-check.test.ts test/protocol.test.ts -t "documented
command|documented-command|workflow rule"`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/protocol run build`;
  `npm --workspace @sparkwright/host run build`.
- Prior verification — Date: 2026-06-27T20:24:22+0800
- Scope: active-rule inspection adds host capability snapshot metadata only;
  workflow hook execution arrays, lifecycle values, and run-loop behavior remain
  unchanged.
- Tests: `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t
"workflow rule|documented-command built-in"`;
  `npm --workspace @sparkwright/host run typecheck`.
- Prior verification — Date: 2026-06-27T12:16:45+0800
- Scope: `delegate_parallel` remains a normal foreground parent tool call from
  the core run-loop perspective; host-owned child runs provide the sub-agent
  lifecycle evidence.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/test/protocol.test.ts`,
  `packages/host/test/tools.test.ts`,
  `docs/reference/RUN_EVENTS.md`,
  `docs/_internal/project-map/maps/runtime/run-loop.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t "delegate_parallel|reserved by an existing delegate|reserved name"`;
  `npm --workspace @sparkwright/host test -- test/tools.test.ts -t "delegate_parallel|foreground parallel|write-capable delegates"`;
  `npm run check`.
- Prior verification (delegate routing) — Date: 2026-06-27T11:29:02+0800
- Read: `packages/core/src/events.ts`, `packages/host/src/runtime.ts`,
  `packages/host/src/delegate-capability.ts`,
  `packages/host/test/protocol.test.ts`,
  `docs/reference/RUN_EVENTS.md`,
  `docs/_internal/project-map/maps/runtime/run-loop.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t "delegate routing"`;
  `npm --workspace @sparkwright/core run typecheck`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm run schema:check`.
- Prior verification (access mode) — Date: 2026-06-26T23:59:00+0800
- Read: `packages/core/src/run.ts`, `packages/core/src/tools.ts`,
  `packages/core/src/trace-diagnostics.ts`, `packages/core/test/run.test.ts`,
  `packages/core/test/trace.test.ts`,
  `packages/host/src/runtime.ts`, `packages/host/src/run-access.ts`,
  `docs/_internal/project-map/maps/runtime/tool-orchestration.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/access-mode.test.ts`;
  `npm --workspace @sparkwright/host test -- test/run-access.test.ts test/protocol.test.ts`;
  `npm --workspace @sparkwright/core run typecheck`; `npm run build`;
  `npm run check:dist-fresh`.
