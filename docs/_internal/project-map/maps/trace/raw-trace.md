# Raw Trace

## Purpose

Raw trace is the durable append-only event log. It lets maintainers reconstruct
what happened without relying on product UI state.

See [summary-timeline-verify.md](summary-timeline-verify.md) for derived views
and [../session/session-store.md](../session/session-store.md) for session layout.

## Main Files

- `packages/core/src/trace.ts`
- `packages/core/src/trace-codec.ts`
- `packages/core/src/trace-store.ts`
- `packages/core/src/trace-session-consistency.ts`
- `packages/core/src/events.ts`
- `docs/adr/0006-jsonl-traces-with-tiered-detail.md`
- `docs/reference/PROTOCOL.md`
- `docs/reference/RUN_EVENTS.md`

## Data Flow

```txt
EventLog emits full event
  -> FileRunStore.prepareTraceEvent() in trace-store.ts
  -> filterTraceEvent(level) in trace-codec.ts
  -> redactor
  -> append trace.jsonl
  -> materialize artifact files when needed
```

## Contracts

- JSONL: one serialized `SparkwrightEvent` per line.
- Events are ordered by run-local `sequence`.
- `trace.jsonl` is append-only.
- Cross-run append order is not a chronological invariant: multi-agent traces
  may append a child run block before the parent's later tail. Timeline readers
  can project aggregate order, but `trace verify` must preserve the append-only
  contract and only enforce stable run-local/scoped invariants.
- Trace levels filter payload detail: `standard` or `debug`.
- `extension.process.progress` is suppressed in `standard` traces and folded
  into the matching `extension.process.completed` / `failed` event as
  `progressHead`, `progressTail`, and counts; `debug` traces keep raw progress.
  Terminal `progressDroppedSamples` are debug-only trace detail; standard traces
  keep `progressDropped` but filter the sample previews.
- Redaction happens at persistence/forwarding boundaries.
- `tool.requested.payload.preview` is optional bounded presentation metadata
  derived from the tool definition. Raw `arguments` remain the audit/execution
  input; preview must not become a policy or replay source.
- Terminal `tool.completed` / `tool.failed` metadata may include stage timing
  fields (`schemaValidationMs`, `inputValidationMs`, `policyForArgsMs`,
  `policyDecisionMs`, `approvalWaitMs`, `executionMs`,
  `resultValidationMs`). These are diagnostics on existing terminal events;
  they do not change span closure or event-family semantics.
- `workspace.read.denied` is the raw trace evidence for read-scope policy
  denial. It pairs with the enclosing read tool's `tool.failed`
  `READ_SCOPE_DENIED`; successful reads continue to use `workspace.read`.
- Workflow runtime lifecycle events are emitted by projection runs:
  `workflow.started`, `workflow.node.started`, `workflow.node.completed`,
  `workflow.waiting`, `workflow.interrupted`, `workflow.completed`,
  `workflow.failed`, and `workflow.cancelled`. P3 human nodes are the first
  `workflow.waiting` emitter; durable workflow waiting truth still lives in
  `WorkflowRunRecord.wait`, not in trace replay alone.
- P2 `WorkflowRunRecord.evidenceRefs` may point at raw trace/fact evidence
  such as run ids and FactLedger verifier result ids, but workflow records do
  not copy raw trace payloads and raw trace remains the audit source rather than
  a workflow-state bus.
- Unloaded deferred-tool schema failures use the normal `tool.failed` event
  with bounded recovery metadata (`schema_not_loaded`, `tool_search`, and
  `select:<toolName>`). Valid guessed arguments still follow the normal tool
  execution path until a future hard gate is explicitly introduced.
- Synthetic `REPEATED_TOOL_CALL_SKIPPED` tool failures may carry bounded
  `error.metadata.repeatedPriorFailure*` fields that describe the prior
  same-target failure category. These fields are diagnostic context for outcome
  and trace summary classification; they do not authorize or execute a skipped
  tool call.
- `run.started.payload.resolvedModel.pricing` is optional startup diagnostics
  copied from host model resolution. `missing_pricing` means cost estimates are
  unavailable; raw traces still rely on `model.completed`/`usage.updated` for
  actual token usage facts.
- Terminal `run.failed` payloads may carry both legacy top-level `metadata` and
  `failure.metadata`, but provider failure causes are sanitized before event
  emission. Raw provider request bodies, prompt input, and tool schemas must not
  appear as `metadata.cause` in raw trace JSONL; provider response headers are
  not persisted wholesale, with request id extracted as a narrow diagnostic.
- Terminal `run.completed` final-answer payloads may carry
  `factLedger.schemaVersion:"fact-ledger.v1"` with raw command facts,
  verifier `expect`/`satisfied` results, optional `verificationSource`,
  workspace write epochs, and stale markers plus forced-continuation
  `budgetExceeded` facts. This is a terminal snapshot on the existing event,
  not a new raw event family.
- `run.budget.exceeded` is the raw event for per-source forced-continuation
  budget exhaustion. Standard trace filtering keeps only the bounded
  `signal`/`family`/`source`/`used`/`limit`/`step`/`reason` payload fields.
  It refuses that forced continuation but does not by itself mark the run
  failed.
- `trace.ts` remains the named facade for public/core-internal imports; raw
  trace storage is implemented in `trace-store.ts`, while codec/filter/redaction
  primitives are implemented in the dependency-leaf `trace-codec.ts`.
- `artifact.created` remains the materialization boundary for large process
  stdout/stderr logs referenced by `ProcessOutputSummary.artifactIds`.
- Promoted shell task output is traced as `task.output` under the task span and
  summarized on terminal `task.*`; it does not create `extension.process.*`
  lifecycle rows.
- In-process delegate child workspace writes are traced in the child run as
  managed `workspace.write.*` events and summarized to the parent on
  `subagent.*` payloads. Sub-agent lifecycle metadata carries additive audit
  fields (`subagentDepth`, `agentId`, `delegateTool`, `entrypoint`, consistent
  parent/child run ids, and `taskId` when the child is owned by an
  `agent_task`). SparkWright child-run terminal payloads carry
  `terminalState` and `stepLimitReached`/`truncated` when derived from the child
  `run.*` outcome; external-process parent events must not invent those fields
  without a child `run.*` source.
  Derived trace reports may downgrade the severity of an incomplete child when
  later parent verification covers the current workspace state, but they must
  not rewrite these raw terminal facts.
  MCP tools use normal `tool.*` events; raw traces do not perform filesystem
  side-effect detection.
- `mcp.server.prepared` failures keep existing `errorCode`/`errorPhase` fields
  and may add actionable diagnostic metadata/payload fields:
  `errorCategory`, `nextAction`, `retryable`, and nested `error.category` /
  `error.serverName`.
- External command delegates keep `subagent.*` as their parent-facing lifecycle
  and suppress `extension.process.*`, but still pass the constrained
  `SPARKWRIGHT_PROCESS_PROTOCOL=stdio-v1` / `SPARKWRIGHT_EVENT_TOKEN`
  observation contract to the child process. Accepted stderr token progress is
  surfaced as a bounded summary on the delegate tool result and
  `subagent.completed.payload.result` (`progressCount`, `progressDropped`,
  `progressHead`, `progressTail`), rather than as raw process lifecycle rows.
- `workspace.write.untracked_access_granted` is an audit-boundary marker for
  process boundaries granted workspace write capability outside managed
  `workspace.write.*` APIs. External command delegates use it when direct
  read/write workspace access is granted; background shell tasks use it with
  `protocol: "background_shell"`, `backgroundOrigin`, and sandbox status. The
  TUI also accepts historical `promoted_shell` markers. It records access granted /
  untracked-write-capable only and is not counted as a managed
  `workspace.write.completed` event.
- Skill inline shell preprocessing, when enabled, uses
  `extension.process.*` with `kind: skill_script`; events may be buffered during
  pre-run skill loading and flushed once the run event log exists.
- Warning-severity capability discovery diagnostics, such as markdown agent
  profile id collisions, may also be buffered during host run preparation and
  flushed as `capability.index.failed` events with
  `severity: "warning"`. These are audit facts, not terminal run failures.
  Delegate tool name collisions, including collisions against reserved
  built-ins such as an existing delegate named `delegate_parallel` while
  parallel delegates are enabled, use the same warning channel.
- `workflow_hook.*` payloads carry a single canonical `hook` lifecycle field
  (`RunStart`, `TurnStart`, `ModelOutput`, `PreToolUse`, `PostToolUse`, `Stop`,
  `RunEnd`, or `RuntimeSignal`). Legacy configured-hook/mode payload fields are
  not emitted. Non-blocking configured event hooks use `user_hook.*` evidence.
- `agent.routing.evaluated` records sort-only configured delegate routing for
  the current goal when profiles declare `triggers` or `when.keywords`. Its
  payload is bounded to delegate ids/tool names, relevance, score, matched
  keywords, configured keywords, and a short reason. It is trace evidence for
  ranking/labels only; raw traces must not treat it as a hidden-tool or
  permission-change signal.
- Parallel delegate fan-out adds no new raw event family. The parent fan-out is
  a normal `tool.*` sequence for `delegate_parallel`; each child is represented
  by `subagent.*` metadata with `entrypoint: "delegate_parallel"` plus the
  child run's own `run.*` stream.
- On-demand `skill.failed` companion events carry the original `toolCallId` so
  raw traces can join them back to the corresponding `tool.failed` event.
- Session-scoped traces aggregate events under `.sparkwright/sessions/<session-id>/trace.jsonl`.
- Agent traces can also be written under `agents/<agent-id>/trace.jsonl`.
- Session run directories do not duplicate trace JSONL; they include
  `trace-pointer.json` with relative links to the session and agent traces.
- Workspace-level workflow run records under `.sparkwright/workflow-runs/` are
  durable workflow state, not raw trace storage. Raw trace JSONL remains in the
  session/agent trace roots above.
- Raw JSONL remains append-only. Derived diagnostics such as trace timeline and
  verify may project aggregate ordering from `timestamp`/scoped `monotonicUs`,
  but the writer does not rewrite existing rows to enforce that order.

## Consumers

- CLI `trace events`, `summary`, `timeline`, `report`, and `verify`.
- Host `session.inspect`.
- Session replay and resume fallback.
- External sinks and future trace backends.

## Change Checklist

- Add trace-level payload handling for new large event types.
- Keep artifacts out of large inline payloads.
- Check `transcript.jsonl` behavior if event-to-transcript mapping changes.
- Verify redaction still applies to trace and artifacts.
- Update docs and schemas when event envelope changes.

## Known Debts

- JSONL can grow without bound; retention/rotation remains an embedder concern.
- `workspace.read` can create high-volume noise.
- Stream chunk handling is collapsed at non-debug levels into contiguous
  `model.stream.text` segments; same-run non-chunk events split segments so
  persisted sequence order stays monotonic. Consumers must not rely on
  individual chunks unless `debug`. During a disk-degraded replay, sequence
  order remains authoritative but a segment's `chunkCount`/duration may be a
  conservative approximation if later chunks arrived before recovery.
- Large process output already materializes through shell/traced-process paths
  and `artifact.created`. A future generic large-result helper must avoid
  double-spilling tool-owned artifacts and honor `resultSize.neverPersist`.

## Last Verified

- Status: Read-only
- Date: 2026-07-12
- Scope: checked event-time Agent and Workflow package identity metadata; trace encoding contract is otherwise unchanged.
- Tests: focused host/agent-runtime tests passed; release gate pending.

- Status: Read-only
- Date: 2026-07-12T16:36:08+0800
- Scope: checked Workflow package identity persistence; raw trace event contract is unchanged.
- Tests: not run for trace-specific behavior; Phase 4 Workflow release gate passed.

- Status: Verified
- Date: 2026-07-11T22:55:00+0800
- Scope: documented degraded-buffer stream-segment telemetry approximation;
  persisted sequence ordering remains the hard invariant.
- Read: `packages/core/src/trace-store.ts`, `packages/core/test/trace.test.ts`.
- Tests: full `npm run release:check`.

- Status: Verified
- Date: 2026-07-11T19:53:00+0800
- Scope: fixed standard-level folded stream persistence when same-run
  background `task.output` events interleave; session and per-agent traces use
  the same ordered serialized batch.
- Read: `packages/core/src/trace-store.ts`,
  `packages/core/test/trace.test.ts`.
- Tests: `npm --workspace @sparkwright/core test -- test/trace.test.ts`;
  `npm --workspace @sparkwright/core run typecheck`.

- Status: Verified
- Date: 2026-07-07T16:15:00+0800
- Scope: `agent_task` child terminal trace attribution now projects the owning
  task id onto parent-visible `subagent.*` payloads and metadata, so raw trace
  diagnostics can join `task_create` outputs to completed child-run evidence.
- Read: `packages/agent-runtime/src/index.ts`,
  `packages/host/src/runtime.ts`,
  `docs/_internal/project-map/maps/trace/raw-trace.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
test/index.test.ts -t "multi-agent facts"`; `npm --workspace @sparkwright/host
test -- test/protocol.test.ts -t "background agent through the real
task_create"`; real mini trace
  `session_mradiara7baut36j` reported `REPEATED_TASK_CREATE_LIFECYCLE` with
  `trace verify` and `session check` `ok`.

- Status: Read-only
- Date: 2026-07-07T00:55:52+0800
- Scope: workflow distill/shadow filters blocked tool attempts only in offline
  observation. Raw traces still record the original `tool.requested` and
  terminal `tool.failed` evidence; event families, JSONL layout, trace levels,
  and raw workflow lifecycle contracts are unchanged.
- Read: `packages/host/src/workflow-trace-observation.ts`,
  `packages/host/src/workflow-distill.ts`,
  `packages/host/src/workflow-shadow.ts`,
  `docs/_internal/project-map/maps/trace/raw-trace.md`.
- Tests: `npm --workspace @sparkwright/host test --
test/workflow-shadow.test.ts test/workflow-distill.test.ts`; real Sonnet
  trace `session_mr9fmua899dimnc2` replayed through `workflow shadow` and
  `workflow distill`.

- Status: Verified
- Date: 2026-07-06T21:18:25+0800
- Scope: C13-② post-acceptance trace check: protocol runs using workspace
  config now emit `workspace.read` for allowed default-confidential paths and
  `workspace.read.denied` for explicit configured confidential paths. No raw
  trace event families or filtering rules changed.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/test/protocol.test.ts`,
  `packages/core/src/workspace.ts`,
  `packages/core/src/events.ts`.
- Tests: `npm --workspace @sparkwright/host test --
test/protocol.test.ts -t "confidential"`.

- Status: Verified
- Date: 2026-07-06T20:47:10+0800
- Scope: C13-② raw trace check: denied confidential reads use the existing
  `workspace.read.denied` event and `tool.failed READ_SCOPE_DENIED` without
  adding event families or changing trace filtering.
- Read: `packages/core/src/workspace.ts`, `packages/core/src/events.ts`,
  `packages/core/src/policy.ts`, `packages/cli/test/cli.test.ts`.
- Tests: `npm --workspace @sparkwright/core test -- test/policy.test.ts
test/workspace.test.ts`; `npm --workspace @sparkwright/cli test --
test/cli.test.ts -t "confidential"`.

- Status: Read-only
- Date: 2026-07-06T20:12:52+0800
- Scope: C10 route check for HostRuntime capability-inspection profile
  inventory. Raw trace JSONL locations, event envelopes, event families,
  filtering, and redaction are unchanged.
- Read: `packages/host/src/runtime.ts`, `packages/host/test/protocol.test.ts`,
  `packages/core/src/trace-store.ts`, `docs/_internal/proposals/consolidation-agenda.md`.
- Tests: `npm --workspace @sparkwright/host test --
test/protocol.test.ts -t "inspect reports inline agent profiles"`;
  `npm --workspace @sparkwright/host run typecheck`; `npm --workspace
@sparkwright/host run build`; `npm run release:check`.

- Status: Read-only
- Date: 2026-07-05T23:09:50+0800
- Scope: workflow-runtime-v1 P9a D5 routed-page check: fresh workflow state
  moved from session-local `workflow-runs/` to workspace
  `.sparkwright/workflow-runs/`, while session/agent raw trace JSONL locations,
  event envelopes, filtering, and redaction stayed unchanged.
- Read: `packages/host/src/runtime.ts`,
  `packages/agent-runtime/src/workflows/store.ts`,
  `packages/core/src/trace-store.ts`,
  `packages/host/test/workflows.test.ts`.
- Tests: not run for raw trace codec/store behavior; P9a changed workflow state
  lookup/storage, not raw trace persistence.

- Status: Read-only
- Date: 2026-07-05T22:20:59+0800
- Scope: workflow-runtime-v1 P8a routed-page check: offline `workflow shadow`
  reads existing raw trace events through `loadTraceEventsFile` but does not
  write trace events, mutate traces, add raw trace event types, or change trace
  filtering/redaction.
- Read: `packages/host/src/workflow-trace-observation.ts`,
  `packages/host/src/workflow-shadow.ts`,
  `packages/cli/src/cli.ts`,
  `packages/host/test/workflow-shadow.test.ts`.
- Tests: not run for raw trace codec/store behavior; P8a made no raw trace
  semantic change. Focused shadow gates passed in host/CLI.

- Status: Read-only
- Date: 2026-07-05T20:18:29+0800
- Scope: workflow-runtime-v1 P5 post-review trace check: explicit parallel
  transition validation, branch-verifier rejection, and delegate_parallel infra
  crash fail-closed behavior reuse existing `workflow.node.*` /
  `workflow.failed` payloads and durable evidence refs. Runtime terminal failure
  state now preserves `parallelBranches` for diagnostics, but no raw trace event
  family or schema field was added.
- Read: `packages/host/src/workflow-projection.ts`,
  `packages/agent-runtime/src/workflows/store.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test --
test/workflow-hooks.test.ts -t "parallel|join|delegate_parallel|branch
diagnostics"`; `npm --workspace @sparkwright/host test --
test/workflows.test.ts test/workflow-hooks.test.ts`.

- Status: Read-only
- Date: 2026-07-05T18:02:15+0800
- Scope: workflow-runtime-v1 P5 trace check: `parallel` / `join` reuse
  existing `workflow.node.*`, workflow terminal events, and evidence refs.
  Branch state is persisted in `WorkflowRunRecord.parallelBranches`; branch
  runtime errors now remain fail-closed through existing workflow failure events.
  No raw trace event type or schema was added.
- Read: `packages/host/src/workflow-projection.ts`,
  `packages/agent-runtime/src/workflows/types.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/workflow-hooks.test.ts
-t "parallel|join|delegate_parallel"`; `npm --workspace @sparkwright/host
test -- test/workflows.test.ts test/workflow-hooks.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`.

- Status: Read-only
- Date: 2026-07-05T11:36:37+0800
- Scope: workflow-runtime-v1 P3 Step 4a trace check: actor episode driver
  inversion does not add or rename raw event types. Existing run, workflow, and
  notification events remain the trace surface; actor episode driver metadata
  is stored on workflow records.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/test/workflows.test.ts`,
  `docs/_internal/project-map/maps/trace/raw-trace.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/workflows.test.ts`;
  no schema change.

- Status: Verified
- Date: 2026-07-05T11:21:09+0800
- Scope: workflow-runtime-v1 P3 Step 3 raw-trace boundary:
  `workflow.waiting` is now an active lifecycle event emitted by human nodes,
  while durable waiting state remains in `WorkflowRunRecord.wait` and the
  workflow actor outbox.
- Read: `packages/host/src/workflow-projection.ts`,
  `packages/host/src/runtime.ts`,
  `packages/agent-runtime/src/workflows/store.ts`,
  `packages/agent-runtime/src/workflows/notifications.ts`,
  `schemas/event.schema.json`,
  `docs/reference/PROTOCOL.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/workflow-hooks.test.ts`;
  `npm --workspace @sparkwright/host test -- test/workflows.test.ts`;
  `npm run schema:check`.

- Status: Verified
- Date: 2026-07-05T00:42:02+0800
- Scope: workflow-runtime-v1 P2 raw-trace boundary: workflow run records store
  references to run/fact evidence while `workflow.*` lifecycle events and
  terminal FactLedger snapshots remain the durable trace facts; P2 adds no new
  raw event family.
- Read: `packages/host/src/workflow-projection.ts`,
  `packages/host/src/runtime.ts`,
  `packages/core/src/fact-ledger.ts`,
  `docs/reference/RUN_EVENTS.md`.
- Tests: `npm --workspace @sparkwright/host test --
test/workflows.test.ts test/workflow-hooks.test.ts -t "workflow"`.

- Status: Verified
- Date: 2026-07-04T16:47:47+0800
- Scope: workflow-runtime-v1 P1.5 raw trace update: terminal FactLedger
  snapshots can carry `verificationSource` for projection-backed profile and
  documented-command verifier results; legacy `verification:` hook names remain
  old-trace compatibility only.
- Read: `packages/core/src/fact-ledger.ts`,
  `packages/core/src/run-outcome.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/host/src/verification.ts`,
  `packages/host/src/documented-command-check.ts`,
  `schemas/event.schema.json`,
  `docs/reference/PROTOCOL.md`,
  `docs/reference/RUN_EVENTS.md`,
  `docs/reference/PROTOCOL_CHANGELOG.md`.
- Tests: `npm --workspace @sparkwright/core test --
test/run-outcome.test.ts test/fact-ledger.test.ts`; `npm --workspace
@sparkwright/host test -- test/workflow-hooks.test.ts
test/documented-command-check.test.ts -t "verification|documented-command"`;

- Status: Verified
- Date: 2026-07-04T12:43:33+0800
- Scope: workflow-runtime-v1 S3 raw trace update: added
  `run.budget.exceeded` to the event vocabulary and trace codec bounded
  payload, and extended terminal FactLedger snapshots with `budgetExceeded`.
- Read: `packages/core/src/events.ts`,
  `packages/core/src/trace-codec.ts`,
  `packages/core/src/fact-ledger.ts`,
  `schemas/event.schema.json`,
  `docs/reference/PROTOCOL.md`,
  `docs/reference/PROTOCOL_CHANGELOG.md`.
- Tests: `npm --workspace @sparkwright/core test --
test/fact-ledger.test.ts test/run.test.ts -t
"FactLedger|revival|forced-continuation|budget"`;
  `npm --workspace @sparkwright/core run typecheck`.

- Status: Verified
- Date: 2026-07-04T09:30:36+0800
- Scope: workflow-runtime-v1 S2 raw trace contract: `run.completed` can persist
  a FactLedger snapshot while the event vocabulary and append-only trace
  contract stay unchanged.
- Read: `packages/core/src/run.ts`,
  `packages/core/src/fact-ledger.ts`,
  `packages/core/src/trace-diagnostics.ts`,
  `packages/core/test/run.test.ts`,
  `packages/core/test/trace.test.ts`,
  `docs/reference/PROTOCOL.md`,
  `docs/reference/RUN_EVENTS.md`,
  `docs/reference/PROTOCOL_CHANGELOG.md`.
- Tests: `npm --workspace @sparkwright/core test --
test/fact-ledger.test.ts test/run.test.ts test/trace.test.ts`;
  `npm --workspace @sparkwright/core run typecheck`.

- Status: Verified
- Date: 2026-07-04T08:16:19+0800
- Scope: reserved `workflow.*` raw trace event vocabulary in core/schema/docs
  only, with no emitters or trace persistence behavior changes.
- Read: `packages/core/src/events.ts`, `schemas/event.schema.json`,
  `docs/reference/PROTOCOL.md`,
  `docs/reference/PROTOCOL_CHANGELOG.md`,
  `docs/_internal/project-map/maps/trace/raw-trace.md`.
- Tests: `npm --workspace @sparkwright/core run typecheck`;
  `npm run schema:check`.

- Status: Verified
- Date: 2026-07-02T21:55:07+0800
- Scope: raw tool-failure events can include bounded repeated-prior-failure
  metadata for synthetic repeated skips; trace storage, event ordering, and
  standard/debug filtering contracts did not change.
- Read: `packages/core/src/run.ts`, `packages/core/src/trace-diagnostics.ts`,
  `packages/core/src/run-outcome.ts`, `packages/core/test/run.test.ts`,
  `packages/core/test/trace.test.ts`,
  `docs/_internal/project-map/maps/trace/raw-trace.md`.
- Tests: `npm --workspace @sparkwright/core test --
test/run.test.ts test/run-outcome.test.ts test/trace.test.ts`;
  `npm --workspace @sparkwright/core run typecheck`;
  `npm run build --workspace @sparkwright/core`;
  `npm run check:dist-fresh`.

- Status: Verified
- Date: 2026-06-30T23:59:00+0800
- Scope: terminal tool timing metadata, deferred schema recovery metadata, MCP
  prepared diagnostics, and large-result materialization boundaries.
- Read: `packages/core/src/run.ts`, `packages/core/src/trace-store.ts`,
  `packages/core/src/context.ts`, `packages/mcp-adapter/src/index.ts`,
  `packages/shell-tool/src/tool.ts`,
  `packages/host/src/traced-process-runner.ts`,
  `docs/_internal/project-map/maps/trace/raw-trace.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/run.test.ts`;
  `npm --workspace @sparkwright/mcp-adapter test -- test/index.test.ts`;
  `npm --workspace @sparkwright/core run typecheck`;
  `npm --workspace @sparkwright/mcp-adapter run typecheck`.

- Status: Verified
- Date: 2026-06-29T09:28:39+0800
- Scope: checked after canonical tool-name display changes; raw trace event
  envelope and storage format did not change, while new tool payloads use
  canonical names and parsers keep legacy compatibility.
- Read: `packages/core/src/trace-diagnostics.ts`,
  `packages/core/src/run-outcome.ts`, `packages/host/src/shell.ts`,
  `packages/tui/src/components/event-stream.tsx`,
  `docs/_internal/project-map/maps/trace/raw-trace.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/trace.test.ts`;
  `npm --workspace @sparkwright/host test -- test/protocol.test.ts`;
  `npm --workspace @sparkwright/tui test -- test/format-event.test.ts`.

- Status: Verified
- Date: 2026-06-28T13:34:37+0800
- Scope: process progress observation now enters raw traces from host-parsed
  `SPARKWRIGHT_EVENT:` stderr token lines; standard traces fold accepted
  progress and keep only drop counts, while debug traces keep raw progress and
  bounded dropped-token samples.
- Read: `packages/host/src/traced-process-runner.ts`,
  `packages/host/src/external-command-agent.ts`,
  `packages/core/src/trace-store.ts`, `packages/core/src/trace-codec.ts`,
  `packages/core/test/trace.test.ts`,
  `packages/host/test/traced-process-runner.test.ts`,
  `packages/host/test/external-command-agent.test.ts`,
  `packages/host/test/skill-inline-shell.test.ts`,
  `docs/reference/TRACE_EXTENSION_EVENTS.md`,
  `docs/reference/PROTOCOL.md`, `docs/reference/RUN_EVENTS.md`,
  `docs/_internal/project-map/maps/trace/raw-trace.md`.
- Tests: `npm --workspace @sparkwright/host test --
test/traced-process-runner.test.ts test/external-command-agent.test.ts
test/skill-inline-shell.test.ts test/workflow-hooks.test.ts`;
  `npm --workspace @sparkwright/core test --
test/trace.test.ts`; `npm --workspace @sparkwright/core run typecheck`;
  `npm --workspace @sparkwright/host run typecheck`.
- Prior verification — Date: 2026-06-27T22:36:34+0800
- Scope: workflow hook traces use canonical lifecycle names and carry one
  `hook` field; configured event hook subscribers emit `user_hook.*` evidence
  rather than `workflow_hook.*`.
- Prior verification — Date: 2026-06-27T12:31:56+0800
- Scope: delegate tool-name collisions, including `delegate_parallel`
  reserved-name collisions, use warning-severity `capability.index.failed`;
  parallel delegate fan-out still reuses parent `tool.*` plus child
  `subagent.*` evidence.
- Prior verification (delegate routing) — Date: 2026-06-27T11:29:02+0800
- Read: `packages/core/src/events.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/src/delegate-capability.ts`,
  `packages/host/test/protocol.test.ts`,
  `docs/reference/PROTOCOL.md`,
  `docs/reference/RUN_EVENTS.md`, `schemas/event.schema.json`,
  `docs/_internal/project-map/maps/trace/raw-trace.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t "delegate routing"`;
  `npm --workspace @sparkwright/core run typecheck`;
  `npm run schema:check`.
- Prior verification (access mode metadata) — Date: 2026-06-26T23:59:00+0800
- Read: `packages/core/src/events.ts`,
  `packages/core/src/run.ts`,
  `packages/core/src/trace-diagnostics.ts`, `packages/host/src/shell.ts`,
  `packages/host/src/model-builder.ts`, `packages/host/src/model-factory.ts`,
  `packages/host/src/runtime.ts`, `packages/host/src/external-command-agent.ts`,
  `packages/host/src/run-access.ts`,
  `packages/core/test/run.test.ts`, `packages/core/test/trace.test.ts`,
  `docs/reference/PROTOCOL.md`,
  `docs/reference/RUN_EVENTS.md`, `schemas/event.schema.json`,
  `docs/_internal/project-map/maps/trace/summary-timeline-verify.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/access-mode.test.ts`;
  `npm --workspace @sparkwright/core run typecheck`;
  `npm --workspace @sparkwright/host test -- test/run-access.test.ts test/protocol.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts`; `npm run build`;
  `npm run check:dist-fresh`.
