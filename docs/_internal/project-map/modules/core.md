# Core

## Purpose

`@sparkwright/core` owns the runtime kernel: run lifecycle, event emission,
trace/session storage interfaces, policy checks, approvals, workspace effects,
artifacts, checkpoints, and replay helpers.

See also [../maps/runtime/run-loop.md](../maps/runtime/run-loop.md),
[../maps/trace/raw-trace.md](../maps/trace/raw-trace.md), and
[../maps/session/session-store.md](../maps/session/session-store.md).

## Main Files

- `packages/core/src/run.ts`
- `packages/core/src/runtime/tool-result-analysis.ts` — pure duplicate/repeat/failure/no-op/compaction classifiers
- `packages/core/src/run-budget.ts`
- `packages/core/src/context.ts`
- `packages/core/src/pipeline.ts`
- `packages/core/src/session-compaction.ts`
- `packages/core/src/trace.ts`
- `packages/core/src/trace-codec.ts`
- `packages/core/src/trace-diagnostics.ts`
- `packages/core/src/trace-session-consistency.ts`
- `packages/core/src/trace-store.ts`
- `packages/core/src/file-atomic.ts`
- `packages/core/src/path-display.ts`
- `packages/core/src/session.ts`
- `packages/core/src/events.ts`
- `packages/core/src/workflow-hooks.ts`
- `packages/core/src/fact-classifier.ts`
- `packages/core/src/fact-ledger.ts`
- `packages/core/src/run-outcome.ts`
- `packages/core/src/policy.ts`
- `packages/core/src/environment.ts`
- `packages/core/src/workspace.ts`
- `packages/core/test/run.test.ts`
- `packages/core/test/run-budget.test.ts`
- `packages/core/test/trace.test.ts`
- `packages/core/test/session.test.ts`

## Owns / Does Not Own

Owns:

- per-run state transitions and `RunResult`
- append-only run event contracts and run-local `sequence`
- `RunStore`, `FileRunStore`, `TraceSink`, `MemoryTrace`
- trace JSONL codec, redaction, and standard/debug payload filtering
- trace summary, timeline, report, and verification primitives
- `SessionStore` interfaces and file/memory implementations
- checkpoint save/load and best-effort reconstruction from trace
- synchronous run-local and inherited descendant-tree work-budget accounts

Does not own:

- product UI state
- provider selection and host config loading
- MCP process startup
- CLI/TUI command syntax
- long-term memory product behavior

## Contracts

- Facts enter append-only event streams before derived stores or views.
- `runId` routes kernel work; `sessionId` groups runs at the edge.
- Run command admission is a single lifecycle-aware operation:
  `tryEnqueueCommand()` either enqueues and emits `run.command.enqueued`, or
  rejects with `terminal`/`closing`. Embedders must not split acceptance into a
  state probe followed by dispatch.
- `event.sequence` is per run, not per session.
- `ToolDefinition.previewArgs()` is the tool-owned request preview contract.
  The run loop calls it before execution and stores bounded text on
  `tool.requested.payload.preview`, so product UIs do not need to know every
  tool's argument shape.
- `ToolDefinition.approvalSummaryForArgs()` is the tool-owned approval-summary
  contract for argument-dependent capability grants. When a tool gate requests
  approval, the run loop uses this bounded summary before falling back to
  `Run tool <name>`. The hook must be pure and must tolerate invalid model
  arguments by throwing or returning undefined.
- `ToolDefinition.validateInput()` is the small runtime-level semantic input
  validation seam. Core calls it after JSON schema validation and before
  `policyForArgs()` / policy / approval. It must validate only, not mutate
  args, write the workspace, create artifacts, or call external networks.
  Failures produce model-visible `tool.failed` observations with
  `metadata.phase: "validateInput"`.
- Tool outcome recovery can classify empty `task` monitor placeholder argument
  failures as recovered only when a later same-action concrete `task` monitor
  call succeeds. This is a narrow recovery rule for model batching artifacts,
  not a general policy/approval denial recovery path.
- Tool outcome classification also preserves expected-denial semantics across
  repeated-tool guards: when a synthetic `REPEATED_TOOL_CALL_SKIPPED` follows a
  same-target policy/approval denial, it is a non-failing expected-denial
  derivative, not an unresolved model argument error.
- Terminal tool events can include stage timing metadata
  (`schemaValidationMs`, `inputValidationMs`, `policyForArgsMs`,
  `policyDecisionMs`, `approvalWaitMs`, `executionMs`,
  `resultValidationMs`). These are diagnostic metadata on existing
  `tool.completed` / `tool.failed` events, not a new event family.
- `workflow.*` event names in `events.ts` are trace vocabulary used by
  host-owned workflow projections and host-owned built-in invariant
  projections. Core owns the generic event vocabulary and run-outcome projection
  for terminal `workflow.failed` facts; host owns workflow/invariant state,
  lifecycle emission, and projection hooks. Run-outcome intentionally ignores
  `workflow.failed` events with `projectionKind:"invariant"` as generic
  workflow failures because verification/documented-command buckets carry those
  facts.
- FactLedger verifier snapshots may carry `verificationSource` metadata. Core
  run-outcome reads terminal FactLedger snapshots first for verification profile
  and documented-command verdicts, treats stale satisfied verifier facts as
  failed, keys invariant results by `hookName + verifierId`, and keeps
  `verification:<profile>:<id>` hookName parsing only for old-trace
  compatibility.
- Command outcome projections from FactLedger include non-stale
  `model-initiated` commands and verification-relevant `verifier-launched`
  commands. Generic hook-launched command facts stay out unless marked
  verification-relevant, but workflow command verifier failures must appear in
  `commandFailures.verification` and completed-run verification outcome checks.
- Concurrent tool batches preserve real-time event emission and after-tool hook
  execution, while deferring only the next-turn `tool_result` context append so
  model observations are ordered by the original tool-call order.
- Tool concurrency classification is argument-aware only through an explicit
  `ToolDefinition.isConcurrencySafe(args)` implementation. A tool that declares
  `policyForArgs()` without that classifier fails closed to serial batching, so
  argument-level risk or side effects cannot be discovered only after Core has
  already admitted the call to a concurrent batch.
- `RunBudgetAccount` is an internal orchestration primitive owned by Core. Each
  run consumes one local account plus any ancestor-owned descendant-tree
  accounts; model/tool reservations synchronously check every account before
  committing any counter, while provider token/cost and duration limits remain
  reactive checks. A run's configured budget creates a separate account for its
  descendants, so siblings and deeper descendants share that ceiling without
  changing the parent run's established local-budget semantics.
- Work-budget inheritance is separate from `maxSteps`, per-source forced-
  continuation budgets, and host run-chain ceilings. Checkpoint resume restores
  consumable counters but intentionally restarts elapsed duration for the new
  active execution segment, matching the prior local run-budget behavior.
- `SessionEvent.sequence` is session-local. Host-level session compaction
  writes `session.compaction.completed` / `session.compaction.skipped` events
  to the append-only session event stream for durable audit.
- `LocalWorkspace` owns managed workspace path containment. It combines
  realpath containment with inspection of the original lexical path and denies
  stable symlink segments for writes, including symlinks whose target remains
  inside the workspace. `removeFile()` rejects symlink ancestors but may unlink
  a symlink leaf without following its target; Host rollback uses the internal
  binary write path so restoration shares these guards. Callers must not weaken
  this by pre-resolving paths before passing them to the workspace API.
- Core `createWorkspaceShellPolicy` is a structured `command + args` embedder
  policy, not the Host shell-tool command parser. Relative `cwd` is evaluated
  against its configured workspace root, while the original request remains
  unchanged for the embedder executor. Host shell-tool separately owns parsing
  a command string, heredoc stripping, and execution-time `cwd` normalization;
  do not merge these different input contracts into a generic path helper.
- Trace levels are `standard` and `debug`; `minimal` is not a valid mode.
- Standard trace stream folding emits one `model.stream.text` marker per
  contiguous run-local chunk segment. A same-run non-chunk event flushes the
  open segment first, so background task events cannot make persisted sequence
  order move backwards while folded `chunkCount` remains contiguous evidence.
  Disk-degraded replay preserves that ordering but may conservatively
  approximate segment chunk count/duration if later chunks arrive before drain.
- Repeated-call guidance owned by a tool is eligible only after a successful
  state observation. A same-target prior failure stays on the generic failed
  repeat path and cannot be converted into a completed no-op nudge.
- Trace reporting treats a naturally completed `lifetime:service` shell task
  as an informational classification advisory, not a correctness failure;
  finite commands should normally be classified as jobs.
- `traceId`, `spanId`, and `parentSpanId` are correlation fields only.
- `trace.ts` is the stable named facade used by `index.ts` and `internal.ts`;
  storage lives in `trace-store.ts`, diagnostics live in
  `trace-diagnostics.ts`, session consistency/repair lives in
  `trace-session-consistency.ts`, and codec/filter/redaction primitives live in
  the leaf `trace-codec.ts`.
- `trace-store.ts` may import `trace-codec.ts` but not diagnostics or session
  consistency; moved trace endpoint modules must not import the `trace.ts`
  facade.
- `ProcessInvocationBase`, `ProcessOutputSummary`, and `SandboxSummary` are
  shared process-observation shapes; host runners own execution and core owns
  the event vocabulary plus trace persistence behavior.
- `extension.process.progress` is high-volume host process detail: `debug`
  traces keep raw progress, while `standard` traces aggregate progress
  head/tail onto the terminal process event. Core trace filtering also keeps
  terminal `progressDroppedSamples` debug-only; standard traces retain only
  `progressDropped`.
- `ContextItem.content` remains the text summary used by trace/UI surfaces;
  optional `ContextItem.parts` carries provider-neutral multimodal parts
  (`text`, `image`, `file`, `audio`) into prompt construction.
- Observation formatting lifts dynamic `spawn_agent` child-answer facts
  (`childRunId`, `role`/`agentName`, `stepLimitReached`, `truncated`, and
  `finality`) into `ContextItem.metadata`, so later context compaction can
  preserve whether a child tool result was complete or partial.
- Observation formatting preserves read-like tool window metadata
  (`startLine`, `endLine`, `totalLines`) and uses a larger model-visible budget
  for read page content so host pagination windows are visible to the model.
- `ToolResultPresentation.kind` is the thin semantic contract for result
  rendering and observation budgeting. Core owns the public kind vocabulary,
  including `file_read`, `file_discovery`, `text_search`, `shell_output`,
  `diagnostic`, and `generic`; concrete tools own their factual result fields.
- Provider prompts must render context sources through the model-visible
  projection in `context.ts`; diagnostic provenance may keep host absolute
  paths in metadata, but prompt source labels must not expose them.
- Command outcome snapshots distinguish unresolved verification failures from
  recovered failures: legacy `verification.lastCommand` points only at the last
  unresolved failure, while `lastFailure*` and
  `lastSuccessfulVerificationCommand` preserve recovered evidence.
- `FactLedger` is the core-owned live fact substrate for command facts,
  verifier result satisfaction, forced-continuation budget exhaustion facts,
  workspace write facts, and the global write epoch. Managed
  `workspace.write.completed` events and conservative
  `workspace.write.untracked_access_granted` boundaries both bump the epoch.
  `fact-classifier.ts` owns shared command/tool identity helpers used by
  run-outcome, run-health, the live ledger, and trace diagnostics. Raw command
  facts keep `exitCode`/`timedOut`; verifier interpretation lives on
  verification-result entries with `expect` and `satisfied`.
- `WorkflowHookInput.facts` is a read-only FactLedger view supplied by the run
  loop. Host governance hooks may read it, but core does not let hooks mutate
  the ledger.
- Command outcome classification treats ad-hoc `node -e` snippets as probes,
  not verification commands. Trace diagnostics recompute command outcomes when
  raw shell command evidence is complete, while keeping persisted snapshots for
  standard/legacy traces that omit command arguments.
- Terminal failure metadata is sanitized at the run-loop `fail()` boundary
  before it reaches `run.failed`, `RunResult`, or `RunEnd` hooks.
  `metadata.cause` is reduced to a small primitive or provider diagnostic
  summary (`name`, `message`, `code`, status fields, request id, and truncated
  `responseBodyPreview`); raw provider request bodies, prompt input, and tool
  schemas must not cross that boundary. `metadata.modelError` remains the
  structured model failure surface for consumers.
- Usage snapshots record `usage_not_reported` when a model call returns no
  usage block, while provider adapters can still report `missing_pricing` when
  token usage exists but no pricing is configured.
- Trace reports include run-scoped efficiency advisories. `LOW_NET_PROGRESS`
  fires when many model/tool cycles within one run produce little file-write
  progress, repeated unchanged reads, or delayed verification after the last
  write; `REPEATED_TOOL_REQUESTS` also thresholds within a run. Multi-run
  parent/child traces must not sum normal sub-agent work or independent reads
  before thresholding. The repeated-tool and
  low-net-progress thresholds live in `run-health.ts` so report diagnostics and
  live run feedback share one definition. Report duplicate-read evidence uses
  read window identity when `tool.completed` includes line-window metadata, so
  sequential pagination is not treated as repeating the same read. Workspace
  read noise is also attributed through existing `spanId` / `parentSpanId`
  tool spans so grep-style scan reads can be distinguished from explicit
  read-like tool calls without changing raw `workspace.read` payloads.
- Trace reports also include a task-lifecycle advisory for repeated equivalent
  `task_create` calls inside one run. Equivalence is `kind` plus stable
  `payload` fingerprint, while scheduling fields such as `mode`/`awaited` are
  ignored. The finding requires evidence that a prior task id reached a
  reusable completed terminal state before the later create request, and skips
  failed, cancelled, partial, or truncated prior tasks.
- The run loop subscribes `RunHealthAnalyzer` to its event log and appends
  model-visible `run.health` context when `read_file`/read-like tools return the
  same unchanged file window again; workspace writes clear prior read snapshots
  for that path.
- Awaited task revival is budgeted by the core per-source
  forced-continuation budget (`revival` source), separate from `maxSteps`.
  `CreateRunOptions.maxRevivalTurns` remains the legacy alias with default 5.
  A `waiting_tasks` wake can enter a revival turn after `maxSteps` is otherwise
  spent; task readiness, command readiness, and abort share one per-wait abort
  signal so losing race legs clean up promptly. Workflow projection
  continuations from `workflow:` hook names consume the `workflow` source and
  carry `forcedContinuationSource:"workflow"` transition metadata; source
  exhaustion emits `run.budget.exceeded` / FactLedger `budgetExceeded` and
  refuses that forced continuation without core emitting workflow terminal
  state.
- Trace report facts are private report implementation detail inside
  `trace-diagnostics.ts`; there is no public/general `TraceFacts` model.
  `SessionTraceFacts` remains owned by session compaction and must not be
  generalized into report facts without a second shared consumer.
- Trace timelines use semantic phase keys before span fallback; `subagent.*`
  lifecycle rows are grouped by child run id so a parent request and child
  terminal event do not split into pending and completed phases when spans
  differ. When a run has a terminal `run.*` event, any still-open phases for
  that run are reconciled to the run's terminal status so `pending` remains a
  true truncated-trace/no-terminal signal.
- Trace timelines use a derived aggregate projection order
  (`timestamp`, scoped `monotonicUs`, then original line order), rather than
  run-local `sequence`, for cross-run phase ordering. Raw trace JSONL remains
  append-only and is not rewritten to satisfy this projection.
- Trace reports score multi-agent auditability facts from the raw trace:
  incomplete child terminal states (`SUBAGENT_INCOMPLETE`), in-flight duplicate
  storms, repeated approval denials, and untracked write-capable boundary
  markers. These markers stay medium severity whenever workspace writes are
  outside managed `workspace.write.*` attribution; filesystem isolation details
  may appear in evidence but do not by themselves downgrade the finding.
- Tool execution diagnostics distinguish same-batch `in_flight_duplicate`
  skips from completed-result duplicate repeats. In-flight duplicate skips get
  an accurate observation and do not mark the target as failed/no-op for
  next-turn bookkeeping; same-batch duplicate multiplicity still feeds the
  repeated-call / doom-loop guard.
- Tool gate argument normalization errors from `policyForArgs()` are captured
  as `tool.failed` with `TOOL_ARGUMENTS_INVALID`; the tool span closes and the
  run remains able to continue or terminate normally.
- `createWorkspaceMutationPolicy({ allowWorkspaceWrites: false })` is the hard
  run write gate: `workspace.write` and write-side-effect `tool.execute`
  actions are denied before approval. Write-enabled runs still route managed
  workspace mutations through the `workspace.write` diff approval path and
  write guardrails.
- Read-confidentiality is a separate workspace-read policy layer.
  `resolveRunConfidentialPaths()` is the run-boundary helper that prepends
  SparkWright's conservative defaults unless `confidentialDefaults:false` is
  explicitly supplied, then appends caller `confidentialPaths`. Matching reads
  emit `workspace.read.denied` and fail the tool with `READ_SCOPE_DENIED`;
  successful reads still emit `workspace.read`.
- `WorkflowHook` is the deterministic project-facing rule layer. Current public
  lifecycle values are canonical-only: `RunStart`, `TurnStart`, `ModelOutput`,
  `PreToolUse`, `PostToolUse`, `Stop`, `RunEnd`, and `RuntimeSignal`. Core no
  longer resolves legacy lifecycle aliases or owns a workflow-hook observe mode.
  Block/advance/rewrite effects are lifecycle-specific: `advance` is a healthy
  continuation for `ModelOutput` and `Stop` that emits `workflow_hook.completed`
  instead of `workflow_hook.blocked`. Tool-call `PreToolUse` is two-stage:
  rewrite hooks run first, core applies argument rewrites, then governance hooks
  see the rewritten payload before budget, repeat, policy, approval, and
  execution. Host-owned
  `capabilities.hooks.events` uses the user-hook event lane outside the awaited
  workflow hook executor. `RunHook.beforeToolCall.skip` and `ValidationHook`
  remain supported lower-level seams for embedders, telemetry, workspace-write
  internals, and compatibility, not the recommended surface for new project
  policy.
- Trace safety summaries count `workspace.write.untracked_access_granted` as
  `untrackedWriteCapableProcesses` for compatibility, separate from managed
  `workspace.write.completed` counts.
- `events.ts` includes `agent.routing.evaluated` as a first-class runtime event
  name. Host owns its payload and emission timing; core treats it as another
  append-only event for trace persistence and downstream diagnostics.
- Trace summaries keep persisted `agentIds` and parent-visible sub-agent
  identities separate. `agentIds` comes from event metadata `agentId`, while
  `subagentIds` is derived from `subagent.*` metadata/payload using
  `childAgentId` before profile/run fallbacks.
- Trace summary `errorCount` remains a raw public count; trace report derives
  high-severity `TRACE_ERRORS` from a reportable failure ledger after expected
  denials, tool recovery, and companion-event correlation. New `.failed` event
  families should be visible through that fallback unless they are explicitly
  expected denials or tied to an already-classified tool failure.
- `path-display.ts` owns shared display-only path projection: workspace paths
  become relative, and external absolute paths collapse to non-host locators.
- Compaction stages return the shared `CompactionResult` protocol
  (`items`, `freedChars`, optional `skippedReason`/`warnings`/metadata) and are
  tagged by tier (`dedup`, `extract`, `evict`, `summarize`).
  `CompactionStageResult` is not a separate public alias.
- `session.ts` owns the `session-compact.v2` artifact parser/writer; artifacts
  require top-level `freedChars` and are ignored when the schema or
  `throughRunId` anchor is invalid.
- `file-atomic.ts` owns the package-bottom atomic text writer used by
  core-owned stores and by the `agent-runtime` doc-store public wrapper. Core
  must not import `agent-runtime`; shared file atomics live below runtime
  packages to preserve package boundaries.
- `session-compaction.ts` owns deterministic session-turn extraction and
  old-turn eviction over completed user/assistant turns; it also exposes the
  `SessionSummarizer` seam, deterministic summarizer preview, trace-derived
  `SessionSignals` oracle, and dedicated Tier 3 wake/spend/acceptance gates.
  Accepted summarizer output carries fingerprint metadata and every result
  carries P3d `measurement`; host owns when to call it and how to expose
  protocol responses.

## Consumers

- `@sparkwright/host` composes core into run/session protocol methods.
- CLI trace/session commands call core summary, timeline, verify, and repair helpers.
- TUI consumes host events and session diagnostics derived from core stores.
- Tests and docs rely on `docs/reference/PROTOCOL.md`, `RUN_EVENTS.md`, and `STATE_AND_TRACE_MODEL.md`.

## Change Checklist

- Update `docs/reference/RUN_EVENTS.md` for new event families.
- Update `docs/reference/PROTOCOL.md` and schemas for envelope or payload contracts.
- Update standard/debug trace filters when adding payload-heavy events.
- Check host runtime, CLI diagnostics, and TUI event rendering for downstream assumptions.
- Add or update tests in `packages/core/test/trace.test.ts` and relevant run/session tests.

## Known Debts

- Raw traces can become large.
- `workspace.read` noise and repeated tool calls can dominate diagnostics; shell
  repeat detection keys on command plus cwd rather than incidental fields such
  as `timeoutMs`.
- Runtime feedback now covers unchanged repeated read windows; broader
  non-read repeated tool loops still rely mostly on the existing repeated-call
  guard and trace diagnostics.

## Last Verified

- Status: Verified
- Date: 2026-07-15T07:35:27+0800
- Scope: moved pure tool-result duplicate, repeat-target, failure-context,
  idempotent-noop, nudge, and compaction-request analysis to a dependency leaf.
  SparkwrightRun retains RunRecord, loop state, events, commands, budgets,
  tools/models, and checkpoint ownership.
- Read: Core run loop and tool-result-analysis leaf.
- Tests: Core run/runtime-guardrails/trace, Core build/typecheck, Agent Runtime
  downstream, Host protocol/tools, repo-pilot, import/boundary, and map drift.

- Status: Verified
- Date: 2026-07-14T14:35:00+0800
- Scope: P6 routed review; deprecated server-runtime convenience APIs remain
  isolated and Core run/session/event ownership is unchanged.
- Tests: server-runtime 30/30 and Host 571/571 passed.

- Status: Verified
- Date: 2026-07-14
- Scope: reviewed Host execution lanes and atomic command acceptance; Core
  remains the per-run state machine and canonical run-event owner.

- Status: Verified
- Date: 2026-07-14
- Scope: added atomic terminal/closing-aware run command acceptance and
  idempotent terminal cancellation.
- Read: Core run command queue, terminal transitions, abort handling, Host
  injection adapter, and focused tests.
- Tests: Core run 129/129; Core and Host typecheck; Host protocol integration.

- Status: Verified
- Date: 2026-07-14
- Scope: extracted reusable Core work-budget accounts and made child runs
  consume local plus ancestor descendant-tree ceilings atomically.
- Read: `run-budget.ts`, run-loop reservations/usage/checkpoint paths, and
  agent-runtime child inheritance.
- Tests: Core budget/run/resume/trace 275/275; Core typecheck/build;
  agent-runtime Agent suites 65/65; Host integration 102/102.

- Status: Verified
- Date: 2026-07-14
- Scope: made dynamic-policy tool batching fail closed unless the tool supplies
  an explicit argument-level concurrency classifier.
- Read: Core tool registry/orchestration and Host Agent consumers.
- Tests: Core run 127/127; affected package and test typechecks passed.

- Status: Verified
- Date: 2026-07-13T22:42:00+0800
- Scope: corrected the standalone workspace Shell policy's relative-cwd anchor
  without changing its non-transforming embedder request contract.
- Read: Core environment policy/tests and Host shell-tool path-scope boundary.
- Tests: Core environment/policy 35/35; Core typecheck/build; shell-tool 42/42.

- Status: Verified
- Date: 2026-07-13T22:30:00+0800
- Scope: added guarded binary restoration and safe symlink-leaf unlinking for
  Host snapshot rollback while preserving managed text-write semantics.
- Read: Core LocalWorkspace and checkpoint/workspace tests; Host snapshot
  consumer.
- Tests: Core workspace/checkpoint 31/31; Core typecheck/build; Host snapshot
  and tools 102/102.

- Status: Read-only
- Date: 2026-07-13
- Scope: checked shared argv sandbox launch decision in Host/MCP; Core process
  events, spans, sandbox summary types, and run semantics did not change.
- Read: Host traced process runner and Core process/trace type boundary.
- Tests: Host traced-process focused tests passed; no Core contract changed.

- Status: Verified
- Date: 2026-07-13
- Scope: hardened `LocalWorkspace` managed writes so same-workspace directory
  and file symlink segments are denied without changing per-run policy state or
  read semantics.
- Read: `packages/core/src/workspace.ts`, `packages/core/src/policy.ts`, and
  focused workspace/policy tests.
- Tests: Core workspace/checkpoint/policy tests 59/59 passed; Core typecheck
  passed.

- Status: Verified
- Date: 2026-07-12T23:45:00+0800
- Scope: run-local deferred schema state now accepts registered dependencies
  from successful Skill body loads in addition to explicit tool search.
- Read: `packages/core/src/run.ts`, `packages/core/src/context.ts`, and focused
  run tests.
- Tests: focused core deferred-tool tests passed.

- Status: Verified
- Date: 2026-07-11T22:55:00+0800
- Scope: prior-failure-safe repeated observation guidance and degraded stream
  segment telemetry semantics.
- Read: `packages/core/src/run.ts`, `packages/core/src/trace-store.ts`, focused
  tests.
- Tests: full `npm run release:check`.

- Status: Verified
- Date: 2026-07-11T21:45:00+0800
- Scope: clarified contiguous stream-marker telemetry semantics and added an
  informational finite-service classification advisory.
- Read: `packages/core/src/trace-store.ts`,
  `packages/core/src/trace-diagnostics.ts`, `packages/core/test/trace.test.ts`.
- Tests: `npm exec -- vitest run packages/core/test/trace.test.ts`.

- Status: Verified
- Date: 2026-07-11T19:53:00+0800
- Scope: standard trace stream folding now preserves physical run-local order
  when background task events interleave; tools may provide bounded corrective
  guidance for skipped repeated state observations without inventing a tool
  failure.
- Read: `packages/core/src/trace-store.ts`, `packages/core/src/run.ts`,
  `packages/core/src/tools.ts`, `packages/core/test/trace.test.ts`,
  `packages/core/test/run.test.ts`.
- Tests: `npm --workspace @sparkwright/core test -- test/run.test.ts
test/trace.test.ts`; `npm --workspace @sparkwright/core run typecheck`.

- Status: Verified
- Date: 2026-07-07T15:21:23+0800
- Scope: trace report added `REPEATED_TASK_CREATE_LIFECYCLE` for completed
  same-payload repeated `task_create` lifecycle misuse while skipping failed
  prior tasks.
- Read: `packages/core/src/trace-diagnostics.ts`,
  `packages/core/test/trace.test.ts`.
- Tests: `npm --workspace @sparkwright/core test -- test/trace.test.ts`;
  `npm --workspace @sparkwright/core run typecheck`.

- Status: Verified
- Date: 2026-07-06T23:31:01+0800
- Scope: FactLedger command outcome projection fix: workflow command verifier
  facts with `initiator:"verifier-launched"` and `verificationRelevant:true` now
  count in verification command summaries while stale and unrelated hook commands
  remain excluded.
- Read: `packages/core/src/run-outcome.ts`,
  `packages/core/src/fact-ledger.ts`,
  `packages/core/test/trace.test.ts`.
- Tests: `npm --workspace @sparkwright/core test -- test/trace.test.ts`;
  `npm --workspace @sparkwright/core run typecheck`.

- Status: Verified
- Date: 2026-07-06T20:47:10+0800
- Scope: C13-② read-confidentiality defaults: core owns the shared
  `resolveRunConfidentialPaths()` resolver and the read-scope policy still
  emits `workspace.read.denied` / `READ_SCOPE_DENIED` without changing write
  gates or approval semantics.
- Read: `packages/core/src/policy.ts`, `packages/core/src/workspace.ts`,
  `packages/core/test/policy.test.ts`, `packages/core/test/workspace.test.ts`,
  `docs/_internal/proposals/consolidation-agenda.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/policy.test.ts
test/workspace.test.ts`.

- Status: Verified
- Date: 2026-07-06T19:24:51+0800
- Scope: C9 S1 migration: core gained `file-atomic.ts` as the lower-level
  atomic text writer so `FileSessionStore.writeSession()` and
  `agent-runtime` doc-store share one implementation without making core
  depend on runtime packages. Session file format, event ordering, and
  compaction contracts are unchanged.
- Read: `packages/core/src/file-atomic.ts`, `packages/core/src/session.ts`,
  `packages/core/src/internal.ts`,
  `packages/agent-runtime/src/doc-store/index.ts`,
  `scripts/check-internal-imports.mjs`,
  `docs/_internal/proposals/consolidation-agenda.md`,
  `docs/_internal/proposals/substrate-sequencing.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/session.test.ts`;
  `npm --workspace @sparkwright/agent-runtime test -- test/doc-store.test.ts`;
  `npm --workspace @sparkwright/core run typecheck`; `npm --workspace
@sparkwright/agent-runtime run typecheck`; `npm run
check:internal-imports`; `npm run check:package-boundaries`.

- Status: Verified
- Date: 2026-07-05T23:08:34+0800
- Scope: P10a D20 two-stage `PreToolUse`: core keeps canonical lifecycle names
  while splitting tool-call hook execution into rewrite and governance passes so
  rewritten arguments are checked before budget/policy/approval/execution.
- Read: `packages/core/src/run.ts`, `packages/core/src/workflow-hooks.ts`,
  `packages/core/src/index.ts`, `packages/core/test/workflow-hooks.test.ts`,
  `packages/host/src/workflow-hooks.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/host/test/workflow-hooks.test.ts`.
- Tests: `npm --workspace @sparkwright/core test --
test/workflow-hooks.test.ts -t "PreToolUse|workflowHooks"`; `npm
--workspace @sparkwright/core run typecheck`; `npm --workspace
@sparkwright/core run build`; `npm --workspace @sparkwright/host test --
test/workflow-hooks.test.ts -t "PreToolUse|blocks tools outside|configured
PreToolUse"`; `npm --workspace @sparkwright/host run typecheck`.

- Status: Read-only
- Date: 2026-07-05T16:03:27+0800
- Scope: workflow-runtime-v1 P5 routed-page check: bounded
  `parallel` / `join` stayed in host workflow projection and agent-runtime
  durable state. Core workflow hook lifecycle, run events, FactLedger, policy,
  checkpoint, and trace storage semantics were not changed.
- Read: `packages/core/src/run.ts`,
  `packages/core/src/workflow-hooks.ts`,
  `packages/host/src/workflow-projection.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test --
test/workflow-hooks.test.ts`; `npm --workspace @sparkwright/host run
typecheck`.

- Status: Verified
- Date: 2026-07-04T22:20:04+0800
- Scope: workflow-runtime-v1 D25 core outcome repair: terminal FactLedger
  profile results treat stale satisfied facts as failed, invariant profile
  results are keyed by hook + verifier id, documented-command invariant
  failures have their own completed-run outcome bucket, and
  `projectionKind:"invariant"` workflow failures no longer double-count as
  generic workflow failures.
- Read: `packages/core/src/run-outcome.ts`,
  `packages/core/test/run-outcome.test.ts`,
  `packages/core/test/fact-ledger.test.ts`.
- Tests: `npm --workspace @sparkwright/core test --
test/fact-ledger.test.ts test/run-outcome.test.ts`; `npm --workspace
@sparkwright/core run build`; `npm run check`; `npm run release:check`.

- Status: Verified
- Date: 2026-07-04T16:47:47+0800
- Scope: workflow-runtime-v1 P1.5 core boundary: FactLedger command and
  verifier snapshots preserve `verificationSource`, completed-run outcome and
  profile-result analysis prefer terminal ledger snapshots, and legacy
  `verification:` hookName parsing remains only for old traces.
- Read: `packages/core/src/fact-classifier.ts`,
  `packages/core/src/fact-ledger.ts`,
  `packages/core/src/run-outcome.ts`,
  `packages/core/test/run-outcome.test.ts`,
  `packages/core/test/fact-ledger.test.ts`.
- Tests: `npm --workspace @sparkwright/core test --
test/run-outcome.test.ts test/fact-ledger.test.ts`; `npm --workspace
@sparkwright/core run typecheck`;
  `npm run build --workspace @sparkwright/core`.

- Status: Verified
- Date: 2026-07-04T12:43:33+0800
- Scope: workflow-runtime-v1 S3 core budget substrate: generalized
  `maxRevivalTurns` / `revivalTurnsUsed` into a per-source forced-continuation
  budget, migrated `revival`, registered `workflow` with no consumer, added
  `run.budget.exceeded` / FactLedger `budgetExceeded` facts, and preserved
  revival terminal metadata compatibility.
- Read: `packages/core/src/run.ts`,
  `packages/core/src/types.ts`,
  `packages/core/src/events.ts`,
  `packages/core/src/fact-ledger.ts`,
  `packages/core/src/fact-classifier.ts`,
  `packages/core/src/trace-codec.ts`,
  `packages/core/test/run.test.ts`,
  `packages/core/test/fact-ledger.test.ts`.
- Tests: `npm --workspace @sparkwright/core test --
test/fact-ledger.test.ts test/run.test.ts -t
"FactLedger|revival|forced-continuation|budget"`;
  `npm --workspace @sparkwright/core run typecheck`;
  `npm --workspace @sparkwright/core run build`.

- Status: Verified
- Date: 2026-07-04T10:10:34+0800
- Scope: workflow-runtime-v1 S2 FactLedger substrate: core now owns shared
  fact classifiers, live in-run FactLedger, hook facts read access, terminal
  ledger snapshots, conservative write-epoch invalidation, and ledger-backed
  command outcome projection.
- Read: `packages/core/src/fact-ledger.ts`,
  `packages/core/src/fact-classifier.ts`,
  `packages/core/src/run.ts`, `packages/core/src/run-outcome.ts`,
  `packages/core/src/run-health.ts`,
  `packages/core/src/trace-diagnostics.ts`,
  `packages/core/src/workflow-hooks.ts`,
  `packages/core/src/index.ts`,
  `packages/core/test/fact-ledger.test.ts`,
  `packages/core/test/run.test.ts`,
  `packages/core/test/run-outcome.test.ts`,
  `packages/core/test/trace.test.ts`.
- Tests: `npm --workspace @sparkwright/core test --
test/fact-ledger.test.ts test/run-outcome.test.ts test/run.test.ts
test/trace.test.ts`; `npm --workspace @sparkwright/core run typecheck`;
  `npm run build --workspace @sparkwright/core`.

- Status: Verified
- Date: 2026-07-04T08:16:19+0800
- Scope: reserved workflow trace event names in `events.ts` and
  `schemas/event.schema.json` only; no core emitters, run-loop state, workflow
  projections, or FactLedger behavior were added.
- Read: `packages/core/src/events.ts`, `schemas/event.schema.json`,
  `docs/reference/PROTOCOL.md`,
  `docs/_internal/project-map/modules/core.md`,
  `docs/_internal/project-map/maps/trace/raw-trace.md`.
- Tests: `npm --workspace @sparkwright/core run typecheck`;
  `npm run schema:check`.

- Status: Verified
- Date: 2026-07-03T18:18:00+0800
- Scope: trace report `LOW_NET_PROGRESS` now thresholds per run instead of
  summing parent and background child model/tool counts; multi-run evidence
  includes the offending run/agent scope, while existing single-run
  low-progress and delayed-verification behavior is preserved.
- Read: `packages/core/src/trace-diagnostics.ts`,
  `packages/core/src/run-health.ts`, `packages/core/test/trace.test.ts`,
  `docs/_internal/project-map/maps/trace/summary-timeline-verify.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/trace.test.ts -t
"low net progress|sequential paginated|delayed verification"`;
  `npm --workspace @sparkwright/core test -- test/trace.test.ts`;
  `npm --workspace @sparkwright/core run typecheck`;
  `npm run build --workspace @sparkwright/core`; `npm run check:dist-fresh`;
  replayed real mini background-agent trace
  `/tmp/sparkwright-real-mini-bg-current.9hEJTL/.sparkwright/sessions/session_mr4hdu7zh7hdjb8i/trace.jsonl`
  with `trace report` now `ok`.

- Status: Verified
- Date: 2026-07-03T09:33:55+0800
- Scope: added the workflow-agnostic `WorkflowHookResult.status: "advance"`
  substrate for healthy `ModelOutput` / `Stop` continuations, with run-loop
  continuation context and completed hook trace semantics distinct from blocked
  gate violations.
- Read: `packages/core/src/workflow-hooks.ts`, `packages/core/src/run.ts`,
  `packages/core/src/types.ts`, `packages/core/src/index.ts`,
  `packages/core/test/workflow-hooks.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/core test --
test/workflow-hooks.test.ts`; `npm --workspace @sparkwright/core run
typecheck`; `npm run build --workspace @sparkwright/core`; `npm run
check:dist-fresh`.

- Status: Verified
- Date: 2026-07-02T21:55:07+0800
- Scope: repeated-tool guard/outcome diagnostics preserve prior
  policy/approval denial semantics, so repeated expected denials stay
  non-failing in run outcomes and trace summaries while ordinary repeated
  calls keep their existing recovered/unresolved behavior.
- Read: `packages/core/src/run.ts`, `packages/core/src/run-outcome.ts`,
  `packages/core/src/trace-diagnostics.ts`, `packages/core/src/types.ts`,
  `packages/core/test/run.test.ts`,
  `packages/core/test/run-outcome.test.ts`,
  `packages/core/test/trace.test.ts`,
  `docs/_internal/project-map/modules/core.md`.
- Tests: `npm --workspace @sparkwright/core test --
test/run.test.ts test/run-outcome.test.ts test/trace.test.ts`;
  `npm --workspace @sparkwright/core run typecheck`;
  `npm run build --workspace @sparkwright/core`;
  `npm run check:dist-fresh`; replayed real mini trace
  `/tmp/sparkwright-real-mini-bg-agent-bash-20260702/session_mr3fuzyvo7nnw8o0/trace.jsonl`
  with `trace summary`, `trace report`, and `trace verify`.

- Status: Verified
- Date: 2026-07-02T16:47:56+0800
- Scope: patched tool outcome classification for empty task monitor
  placeholders followed by later concrete same-action monitoring, then
  rechecked trace/report behavior for the historical real mini background-task
  trace.
- Read: `packages/core/src/run-outcome.ts`,
  `packages/core/test/run-outcome.test.ts`,
  `packages/core/test/trace.test.ts`,
  `docs/_internal/test-map/failures/task-action-empty-id-recovery.md`.
- Tests: `npm --workspace @sparkwright/core test --
test/run-outcome.test.ts test/trace.test.ts`; `npm --workspace
@sparkwright/core run typecheck`; `npm run build --workspace
@sparkwright/core`.

- Status: Verified
- Date: 2026-07-02T09:30:00+0800
- Scope: reviewed and patched core awaited-task revival follow-ups:
  `maxRevivalTurns` is independent of `maxSteps`, final-step awaited
  notifications are injected instead of falling into budget wrap-up, race
  cleanup uses one per-wait abort signal, and revival pending-check failures
  emit `run.notification.source_failed` rather than escaping the loop.
- Read: `packages/core/src/run.ts`, `packages/core/src/types.ts`,
  `packages/core/test/run.test.ts`,
  `docs/_internal/proposals/background-task-lifecycle.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/run.test.ts -t
"awaited task|waiting_tasks|revival"`; `npm --workspace @sparkwright/core run
typecheck`.

- Status: Verified
- Date: 2026-07-02T01:15:00+0800
- Scope: core owns the shared notification contract
  (`PendingNotification`/`NotificationSource`/`TaskRevivalSource`),
  `RunState` includes internal `waiting_tasks`, the run loop drains
  notification sources through `run.notification.injected` at step start, and
  awaited task suspension races task readiness, `run.command.enqueued`, and
  abort without serializing `waiting_tasks` as a durable checkpoint state.
- Read: `packages/core/src/types.ts`, `packages/core/src/run.ts`,
  `packages/core/src/events.ts`, `packages/core/src/access-mode.ts`,
  `packages/core/test/run.test.ts`, `packages/core/test/access-mode.test.ts`.
- Tests: `npm --workspace @sparkwright/core test -- test/run.test.ts test/access-mode.test.ts`;
  `npm --workspace @sparkwright/core run typecheck`;
  `npm run build --workspace @sparkwright/core`.

- Status: Verified
- Date: 2026-07-01T20:51:06+0800
- Scope: result-presentation kind vocabulary includes `text_search`, and trace
  reports derive workspace-read scan/read attribution from existing tool spans.
- Read: `packages/core/src/tools.ts`,
  `packages/core/src/trace-diagnostics.ts`,
  `packages/core/test/trace.test.ts`,
  `docs/_internal/project-map/modules/core.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/trace.test.ts`;
  `npm --workspace @sparkwright/core run typecheck`;
  `npm --workspace @sparkwright/host run typecheck`;
  real DCI trace report check on
  `/tmp/sparkwright-dci-sessions/session_mr1m3xl6dk49i8yd/trace.jsonl`.

- Status: Verified
- Date: 2026-06-30T23:59:00+0800
- Scope: core tool-call recovery/timing/input-validation contracts and
  concurrent batch observation ordering.
- Read: `packages/core/src/tools.ts`, `packages/core/src/run.ts`,
  `packages/core/src/context.ts`, `packages/core/test/run.test.ts`,
  `docs/_internal/project-map/modules/core.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/run.test.ts`;
  `npm --workspace @sparkwright/core run typecheck`.

- Status: Verified
- Date: 2026-06-29T20:32:00+0800
- Scope: prompt capability delta is now gated on callable `tool_search`, trace
  reports suppress generic command-failure findings for fully recovered
  verification failures, and live run-health feedback includes the next unread
  offset when paginated reads move backwards into an unchanged window.
- Read: `packages/core/src/context.ts`,
  `packages/core/src/trace-diagnostics.ts`,
  `packages/core/src/run-health.ts`, `packages/core/src/run.ts`,
  `packages/core/test/context.test.ts`, `packages/core/test/trace.test.ts`,
  `packages/core/test/run.test.ts`.
- Tests: `npm --workspace @sparkwright/core test -- test/context.test.ts
test/run.test.ts test/trace.test.ts`; `npm --workspace @sparkwright/core run
typecheck`; `npm run build --workspace @sparkwright/core`.

- Status: Verified
- Date: 2026-06-29T09:28:39+0800
- Scope: core tool descriptors carry canonical/legacy/exposure metadata,
  `tool_search` expands required/related closures, and prompt capability delta
  describes advanced discovery without listing old model-facing names.
- Read: `packages/core/src/tools.ts`, `packages/core/src/tool-search.ts`,
  `packages/core/src/context.ts`, `packages/core/src/run.ts`,
  `packages/core/src/approval-policy.ts`, `packages/core/test/context.test.ts`,
  `packages/core/test/tool-search.test.ts`.
- Tests: `npm --workspace @sparkwright/core test -- test/tool-search.test.ts test/context.test.ts test/run.test.ts test/trace.test.ts`.

- Status: Verified
- Date: 2026-06-28T20:30:50+0800
- Scope: core plan-mode policy now treats explicit `risk:"safe"`
  `tool.execute` calls as read-only only when governance side effects are
  declared read-only/no-op, so `run.accessMode=read-only` can inspect files
  without approval while preserving approval for bare, metadata-incomplete,
  risky, or write-side-effect tools.
- Read: `packages/core/src/policy.ts`,
  `packages/core/test/policy.test.ts`,
  `packages/host/src/tools.ts`,
  `packages/core/src/access-mode.ts`,
  `packages/core/test/access-mode.test.ts`,
  `docs/_internal/project-map/modules/core.md`,
  `docs/_internal/project-map/maps/safety/approvals.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/policy.test.ts test/access-mode.test.ts test/trace.test.ts`;
  `npm --workspace @sparkwright/host test -- test/run-access.test.ts test/protocol.test.ts test/tools.test.ts`;
  real mini CLI/TUI read-only traces verified through downstream dist builds.

- Status: Verified
- Date: 2026-06-28T13:34:37+0800
- Scope: core event vocabulary stayed unchanged while trace filtering now keeps
  `progressDroppedSamples` debug-only on terminal `extension.process.*` events;
  standard folding still uses accepted progress counts/head/tail only.
- Read: `packages/core/src/trace-codec.ts`,
  `packages/core/src/trace-store.ts`, `packages/core/test/trace.test.ts`,
  `packages/host/src/traced-process-runner.ts`,
  `docs/reference/TRACE_EXTENSION_EVENTS.md`,
  `docs/reference/PROTOCOL.md`,
  `docs/_internal/project-map/modules/core.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/trace.test.ts`;
  `npm --workspace @sparkwright/core run typecheck`;
  `npm --workspace @sparkwright/host test --
test/traced-process-runner.test.ts test/external-command-agent.test.ts
test/skill-inline-shell.test.ts test/workflow-hooks.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`.
- Prior verification — Date: 2026-06-27T22:36:34+0800
- Scope: core workflow hooks use canonical lifecycle names only and emit
  `workflow_hook.*` payloads with one `hook` lifecycle field; user-hook triggers
  remain the non-blocking event lane for host-configured event subscribers.
- Prior verification — Date: 2026-06-27T21:06:53+0800
- Scope: refreshed hook-surface guidance after P2 docs. Core workflow hook
  lifecycle names and executor semantics remain unchanged; `RunHook` and
  `ValidationHook` stay supported lower-level surfaces.
- Tests: `npm --workspace @sparkwright/host test --
test/documented-command-check.test.ts test/protocol.test.ts -t "documented
command|documented-command|workflow rule"`; `npm --workspace @sparkwright/host
run typecheck`.
- Prior verification — Date: 2026-06-27T11:29:02+0800
- Scope: core event vocabulary now includes `agent.routing.evaluated`; host
  remains the payload owner and core persists it through the normal event path.
- Read: `packages/core/src/events.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/test/protocol.test.ts`,
  `docs/reference/RUN_EVENTS.md`,
  `docs/_internal/project-map/modules/core.md`.
- Tests: `npm --workspace @sparkwright/core run typecheck`;
  `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t "delegate routing"`;
  `npm run schema:check`.
- Prior verification — Date: 2026-06-25T20:30:25+0800
- Read: `packages/core/src/trace-diagnostics.ts`,
  `packages/core/test/trace.test.ts`, `packages/cli/src/cli.ts`,
  `packages/cli/test/fixtures/trace-diagnostics/expected/summary.text`,
  `packages/cli/test/fixtures/trace-diagnostics/expected/summary.json`.
- Tests: `npm --workspace @sparkwright/core test -- test/trace.test.ts -t "subagent|delegate|summary|trace"`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "delegates run|delegate|capabilities inspect|trace"`;
  `npm run typecheck`; `npm run typecheck:test`.
