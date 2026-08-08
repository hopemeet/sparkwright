# Raw Trace

## Purpose

Raw trace is the durable append-only event log. It lets maintainers reconstruct
what happened without relying on product UI state.

See [summary-timeline-verify.md](summary-timeline-verify.md) for derived views
and [../session/session-store.md](../session/session-store.md) for session layout.

## Last Verified

- Status: Verified
- Date: 2026-07-19
- Scope: raw terminal events persist `RunAssessment` and fact-ledger evidence.
  Trace diagnostics consume that canonical assessment for complete runs, while
  incomplete observations may replay raw facts; unhealthy completed subagents
  emit a dedicated diagnostic without being relabeled incomplete.
- Read: terminal event assembly, trace diagnostics, Agent lifecycle emission,
  Workflow observation, and trace fixtures/tests.
- Tests: Core trace 130/130 plus affected Host/CLI fixtures passed.

- Status: Verified
- Date: 2026-07-19
- Scope: Host start/resume execution lifecycle wiring now has one explicit
  envelope and no inner fallback execution entrance. The same HostExecution,
  episode owner, EventLog, trace sink, approval/cancel paths, event payloads,
  and ordering remain in use; no trace vocabulary or persistence changed.
- Read: HostRuntime/HostExecution, episode/preparation/interaction owners, Core
  trace boundaries, and focused start/resume tests.
- Tests: focused Host composition/protocol and final repository gates are
  recorded with the commit.

- Status: Verified
- Date: 2026-07-19
- Scope: Host approval request delivery and active execution message/cancel
  routing moved behind `ExecutionInteractionOperations`. Core remains the raw
  `approval.*`, `run.command.*`, and cancellation event owner; event payloads,
  correlation ids, trace sinks, and ordering are unchanged.
- Read: Host interaction/execution/runtime paths, Core command and approval
  events, protocol projections, and focused tests.
- Tests: focused Host/protocol/client gates and the final repository gate are
  recorded with the commit.

- Status: Verified
- Date: 2026-07-18
- Scope: pre-run buffered Skill/MCP/Agent diagnostics, trace resources,
  capability snapshot metadata, and run/store metadata assembly now live in
  `RunPreparationOperations`. Event types, payloads, flush order, trace level,
  and storage layout are unchanged.
- Read: preparation owner, capability failure owner, episode flush path, and
  raw trace contracts.
- Tests: direct owner and focused trace/run gates are recorded with the commit.

- Status: Verified
- Date: 2026-07-18
- Scope: fatal Skill index-failure trace persistence moved intact to
  `CapabilityRuntimeOperations`. Canonical session storage, failure payload,
  live Host event envelope, and the `run.created`, `capability.index.failed`,
  `run.failed` ordering are unchanged.
- Read: capability owner test, Core EventLog/session store, Host preparation
  failure path, and protocol coverage.
- Tests: direct owner trace/event-order coverage and focused Host capability
  suites passed.

- Status: Verified
- Date: 2026-07-18
- Scope: Agent/Delegate lifecycle emitter wiring, child run-store construction,
  promotion attribution, and terminal result normalization moved within Host to
  `AgentRuntimeAssembly`. Raw `subagent.*`, task, workspace-write, and session
  trace payloads, ordering, and persistence remain unchanged.
- Read: Host Agent assembly/adapters, Agent Runtime invocation/result contracts,
  Core trace storage, and focused tests.
- Tests: focused Host Agent/Delegate/protocol and Agent Runtime suites passed.

- Status: Verified
- Date: 2026-07-18
- Scope: Workflow durable finalization and notification ownership moved within
  Host only. Raw `workflow.*` lifecycle payloads, ordering, package identity,
  evidence refs, and append-only trace ownership are unchanged.
- Read: Host Workflow owner/projection/finalization, Core raw trace contracts,
  and focused Workflow tests.
- Tests: focused Host Workflow and protocol suites passed.

- Status: Verified
- Date: 2026-07-18
- Scope: bounded Task output reading and terminal actor-to-notification
  projection moved behind the Host Task operations owner. No event type,
  payload, trace sink, or persistence path changed.
- Read: Host Task operations/projections, Agent Runtime Task actor contracts,
  Core notification injection, and protocol tests.
- Tests: Host Task revival/service/protocol 64/64 and Host typecheck passed.

- Status: Verified
- Date: 2026-07-17T23:37:17+0800
- Scope: EventLog/file trace reference implementations moved exclusively to
  Core `/internal`, and TraceSink ingestion is canonical `append`; raw event
  envelopes, filtering, redaction, and persistence layout are unchanged.
- Read: Core barrels/storage/trace store and Host/CLI/Perfetto consumers.
- Tests: Core interface 4/4, Perfetto 18/18, CLI 23/23, affected typechecks.

- Status: Verified
- Date: 2026-07-17T23:04:01+0800
- Scope: session conversation trace-fact projection moved intact from
  HostRuntime to `session-queries.ts`. It still reads the canonical session
  aggregate trace and does not add an event family, alternate trace file, or
  persistence path.
- Read: Host session replay projection, Core trace store/codec contracts, and
  resume/compaction protocol coverage.
- Tests: Host protocol 59/59 and full Host 577/577; Host typecheck; full release
  gate.

- Status: Verified
- Date: 2026-07-17T20:55:00+0800
- Scope: Skill indexed/resident-loaded lifecycle metadata now carries required
  v2 package identity and omits Markdown `contentHash`; stats ignore events
  without that canonical identity instead of inventing legacy/unknown buckets.
- Read: Skills emitter, Core on-demand companion events, Host stats reader,
  public trace references, and focused Skills/CLI tests.
- Tests: Skills 73/73; focused CLI Skill stats/catalog gates; Host protocol tests.

- Status: Verified
- Date: 2026-07-17T17:20:00+0800
- Scope: Workflow lifecycle events emitted by real Host execution attribute the
  pinned v2 `packageHash`/policy at event time and no longer publish the
  Markdown `contentHash` identity. Event names and trace storage are unchanged.
- Read: Host Workflow projection/runtime metadata, Core event vocabulary,
  distill/shadow observation, and focused Workflow tests.
- Tests: Host Workflow/hook/distill/shadow focused tests and repository test
  typecheck passed before the full release gate.

- Status: Verified
- Date: 2026-07-17T01:07:28+0800
- Scope: external-command terminal subagent results no longer persist the
  aggregate truncation compatibility alias; stream-specific flags and the
  canonical `ProcessOutputSummary` remain unchanged.
- Read: Host terminal result projection, Core event/trace consumers, CLI
  direct-run output, Agent trace coverage, and public trace references.
- Tests: Host external-command 20/20 and delegate protocol 8/8; CLI direct
  delegate 1/1; Core trace 4/4; repository test typecheck passed; project-map
  drift and full release gate passed.

- Status: Verified
- Date: 2026-07-16T21:02:00+0800
- Scope: Background Shell trace fixtures and TUI rendering use only the
  canonical `background_shell` untracked-access marker.
- Read: Host marker producer, Core trace/FactLedger diagnostics, CLI summary,
  TUI event renderer, and focused tests.
- Tests: focused Core trace/ledger, CLI summary, and TUI rendering suites;
  affected typechecks; project-map drift check.

- Status: Verified
- Date: 2026-07-16T18:30:00+0800
- Scope: Trace JSONL readers require the canonical event envelope; required top-level fields are no longer synthesized for older rows.
- Read: Core event schema, trace parser/consumers, trace tests, and protocol references.
- Tests: Core trace focused tests; Core typecheck; project-map drift check.

- Status: Verified
- Date: 2026-07-16T14:10:00+0800
- Scope: File-backed raw trace persistence is session-only; each event is appended to canonical session and agent aggregate traces, and run directories retain only state plus trace pointers.
- Read: Core trace store/codec/tests, session layout maps, protocol references, and trace sink examples.
- Tests: Core trace/interfaces focused tests; npm run build; npm run typecheck:test; npm run release:check.

- Date: 2026-07-16T13:36:30+0800
- Scope: Raw trace vocabulary dropped dead validation-hook start/completed events and result-validation timing; `validation.failed` remains for current run-input and extension failure evidence.
- Read: Core event/trace codecs, schema, CLI producer, TUI consumer, and trace tests.
- Tests: focused trace/schema tests; npm run build; npm run typecheck:test; npm run release:check.

- Date: 2026-07-16T12:45:00+0800
- Scope: Raw run metadata records canonical accessMode; approval and workspace-write events are unchanged.
- Read: routed production sources, focused tests, protocol/config schemas, and current user/reference documentation.
- Tests: focused access/policy/protocol/CLI/TUI/ACP/Workflow tests; npm run typecheck:test; npm run schema:check.

- Date: 2026-07-16T11:52:29+0800
- Scope: reviewed protocol 2.0 terminal failure envelope changes; Core raw trace
  events remain the durable source contract and do not persist the removed Host
  wire-level `run.failed.error` projection.

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
  -> append session and agent trace.jsonl
  -> materialize artifact files when needed
```

## Contracts

- JSONL: one serialized canonical `SparkwrightEvent` per line. Readers require
  `id`, `runId`, `type`, `timestamp`, positive `sequence`, `payload`, and object
  `metadata`; they do not synthesize omitted envelope fields.
- Events are ordered by run-local `sequence`.
- `trace.jsonl` is append-only.
- Durable file traces live only at session and agent scope. Per-run directories
  contain state/checkpoint files and a `trace-pointer.json`, not another trace.
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
  `policyDecisionMs`, `approvalWaitMs`, `executionMs`). These are diagnostics on existing terminal events;
  they do not change span closure or event-family semantics.
- `tool.failed` uses the canonical nested error envelope. Its failure code is
  read only from `payload.error.code`; root-level `errorCode` fields belong to
  other event-family contracts and are not a tool-failure alias.
- `workspace.read.denied` is the raw trace evidence for read-scope policy
  denial. It pairs with the enclosing read tool's `tool.failed`
  `READ_SCOPE_DENIED`; successful reads continue to use `workspace.read`.
- Workflow runtime lifecycle events are emitted by projection runs:
  `workflow.started`, `workflow.node.started`, `workflow.node.completed`,
  `workflow.waiting`, `workflow.interrupted`, `workflow.completed`,
  `workflow.failed`, and `workflow.cancelled`. P3 human nodes are the first
  `workflow.waiting` emitter; durable workflow waiting truth still lives in
  `WorkflowRunRecord.wait`, not in trace replay alone.
  Host-instantiated projections attach the pinned v2 package hash/policy to
  these lifecycle payloads; Markdown `contentHash` is not execution identity.
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
- External-command `subagent.completed.payload.result` reports truncation only
  through stream-specific `stdoutTruncated` and `stderrTruncated` fields; raw
  trace does not retain an aggregate compatibility alias.
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
  `run.*` outcome. Process adapters project `completed`/`failed` only from their
  native worker/process result.
- Parent-visible Agent lifecycle identity is projected from the portable
  `PreparedAgentInvocation` data contract. Its `admission_pending` state is not
  a raw event phase; `AgentSupervisor` requires admission before `started` and
  emits at most one terminal event. Metadata
  identifies `protocol` as `in_process`, `acp`, or `external_command`, with
  process workspace access included when known.
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
  `protocol: "background_shell"`, `backgroundOrigin`, and sandbox status. It
  records access granted / untracked-write-capable only and is not counted as a
  managed `workspace.write.completed` event.
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
- Prompt transcript rehydration resolves `systemRef` only through the owning
  session's `blobs/` directory; transcript rows do not carry an inline system
  prefix identity or alternate reader path.
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

- Status: Verified
- Date: 2026-07-16T10:44:25+0800
- Scope: Task terminal evidence now recognizes only canonical `task_create` and
  `task` tool events; raw event vocabulary is unchanged.
- Read: Core Task trace collector and canonical Task tool result shapes.
- Tests: Core trace 131/131 and repository test typecheck passed.

- Status: Verified
- Date: 2026-07-16T10:27:51+0800
- Scope: reviewed configured Agent-tool policy input consolidation; emitted
  tool/subagent event vocabulary and trace metadata are unchanged.
- Read: Agent-tool definition, Host delegate assembly, and raw trace contracts.
- Tests: agent-runtime index 45/45, Host tools 89/89, and affected typechecks passed.

- Status: Read-only
- Date: 2026-07-16T08:56:29+0800
- Scope: checked trace ownership after Host lease compatibility removal; lease
  lifecycle metadata and raw event contracts are unchanged.
- Tests: focused Host 70/70, Host typecheck, and the full release gate passed.

- Status: Verified
- Date: 2026-07-15T23:51:43+0800
- Scope: removed the redundant `run.started.toolPlan` projection; final
  authorization, availability, approval, and execution remain derivable from
  existing tool and approval events, with no new event or correlation id.
- Read: real alias/Profile/read-only/approval/resume/Workflow traces and trace
  summary/verify/session consistency consumers.
- Tests: Core/CLI/TUI trace suites, real trace verify/session checks, and
  schema/protocol consistency passed.

- Status: Verified
- Date: 2026-07-15
- Scope: checked Todo continuation, background service, and TUI fixes against
  existing trace events; no raw event family changed.
- Read: real session `session_mrlkn469h2ylznbk`, Core run-outcome, Host Todo
  assembly, and TUI task projection.
- Tests: trace verify/session check passed; Core/Host/TUI focused gates passed.

- Status: Verified
- Date: 2026-07-15T07:35:27+0800
- Scope: task snapshot/output/notification value conversion moved to a leaf;
  trace events, payloads, ordering, storage, and levels are unchanged.
- Read: concrete runtime task output path and task-projections.
- Tests: Host protocol/agent focused suites and repo-pilot trace smoke.

- Status: Read-only
- Date: 2026-07-15
- Scope: capability projection extraction does not change trace emitters,
  payloads, event order, storage, levels, or session trace facts.
- Read: capability-assembly and concrete runtime trace boundary.
- Tests: Host protocol/client focused suites and repo-pilot trace smoke.

- Status: Verified
- Date: 2026-07-15
- Scope: HostRuntime module relocation preserves trace emitters, payloads,
  ordering, storage, levels, and session trace facts.
- Read: runtime facade and concrete runtime event/trace boundaries.
- Tests: Host protocol/client focused suites and repo-pilot trace smoke.

- Status: Read-only
- Date: 2026-07-15
- Scope: runtime contract extraction does not change trace emitters, event
  payloads, ordering, storage, or trace-level behavior.
- Read: runtime contracts and Host runtime event boundary.
- Tests: Host protocol/client focused suites and repo-pilot trace smoke.

- Status: Verified
- Date: 2026-07-14
- Scope: checked Workflow API principal attribution; no Core trace event or file
  trace schema changed. Durable Workflow control envelopes now retain the real
  Host connection source.
- Tests: Host workflow/protocol focused suites passed.

- Status: Verified
- Date: 2026-07-14T14:35:00+0800
- Scope: P6 routed review; session trace inspection moved to a function module
  but raw trace remains canonical and no duplicate event store was introduced.
- Tests: Host session inspection/full suite passed.

- Status: Verified
- Date: 2026-07-14
- Scope: reviewed IM delivery replay; Host outbox entries are bounded delivery
  projections and do not replace or duplicate canonical trace storage.

- Status: Verified
- Date: 2026-07-14
- Scope: reviewed Host lanes; the coordinator neither subscribes to nor copies
  Core canonical events, and trace storage remains unchanged.

- Status: Verified
- Date: 2026-07-14
- Scope: workspace lease loss now surfaces bounded tool progress/cancellation
  diagnostics and `PROCESS_ABORTED` process failure evidence without changing
  event envelopes, lifecycle families, or managed-write attribution.
- Read: workspace lease wrapper, Agent supervisors, traced process runner, ACP
  worker, and raw event projections.
- Tests: focused coordinator/Agent/process suites, all workspace tests, and
  release smokes passed. Touched files are format-clean; the global format scan
  is blocked only by pre-existing dirty proposal docs outside this change.

- Status: Verified
- Date: 2026-07-14
- Scope: unified parent Agent lifecycle projection under `AgentSupervisor`;
  admission failures no longer emit `started`, process terminals have parity,
  and indexed calls expose their real entrypoint.
- Read: supervisor, all production subagent emitters, traced process start
  signal, protocol docs, and lifecycle tests.
- Tests: agent-runtime supervisor/Agent and Host Agent/process lifecycle suites
  passed.

- Status: Verified
- Date: 2026-07-14
- Scope: verified the prepared Agent invocation metadata projection; no event
  family, ordering, or terminal payload semantics changed.
- Read: agent-runtime invocation/spawn projection, Host process adapters, and
  raw trace Agent contracts.
- Tests: agent-runtime invocation/Agent tests and Host lifecycle suites passed.

- Status: Verified
- Date: 2026-07-13
- Scope: ACP read-write delegates now emit the existing
  `workspace.write.untracked_access_granted` event; no new event name or payload
  family was introduced.
- Read: Host ACP/external subagent lifecycle and workspace-write marker events.
- Tests: Host ACP/external/tool focused suites 122/122.

- Status: Read-only
- Date: 2026-07-13
- Scope: sandbox launch/grant ownership moved, but process/delegate/MCP event
  names, payloads, span nesting, and redaction are unchanged.
- Read: Host traced process/delegate adapters and MCP preparation boundary.
- Tests: Host process and MCP focused tests passed.

- Status: Read-only
- Date: 2026-07-13
- Scope: checked Host security-plan and CLI inspect refactor; raw event names,
  payloads, ordering, redaction, and trace storage did not change.
- Read: Host prepared environment metadata/capability snapshot and CLI inspect
  path.
- Tests: Host tools/protocol focused tests passed; no trace contract changed.

- Status: Read-only
- Date: 2026-07-12T20:12:00+0800
- Scope: Workflow statistics now count terminal state only on the run
  observation and use durable record layer; raw trace event contracts are unchanged.
- Read: asset stats, Workflow record types/store, and raw trace map.
- Tests: focused stats/Workflow tests passed; no raw trace schema change.

- Status: Read-only
- Date: 2026-07-12
- Scope: checked event-time Agent and Workflow package identity metadata; trace encoding contract is otherwise unchanged.
- Tests: focused host/agent-runtime tests and the 2026-07-15 release gate passed.

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
  `packages/core/src/trace-store.ts`, `docs/_internal/reviews/consolidation-agenda.md`.
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
  documented-command verifier results. Current projection events also carry
  explicit `profile`, `verifierId`, and `expect`; consumers do not infer these
  fields from `hookName`.
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
