# Summary Timeline Report Verify

## Purpose

These are diagnostic views derived from `trace.jsonl`. They help humans and
tools inspect volume, failures, safety posture, phase ordering, high-signal run
health, and structural validity without replacing the raw trace.

See [raw-trace.md](raw-trace.md) for source data and [export-diagnostics.md](export-diagnostics.md) for product-facing export distinctions.

## Main Files

- `packages/core/src/trace.ts`
- `packages/core/src/trace-diagnostics.ts`
- `packages/core/src/trace-session-consistency.ts`
- `packages/core/src/trace-codec.ts`
- `packages/cli/src/cli.ts`
- `packages/cli/src/commands/trace-session.ts`
- `packages/cli/test/fixtures/trace-diagnostics/*`
- `packages/host/src/runtime.ts`
- `docs/reference/STATE_AND_TRACE_MODEL.md`
- `docs/reference/RUN_EVENTS.md`

## Data Flow

```txt
trace.jsonl
  -> trace-diagnostics.ts parse/load helpers
  -> summarizeTraceFile()
  -> buildTraceTimelineFile()
  -> buildTraceReportFile()
  -> verifyTraceFile()
  -> CLI text/JSON or host session.inspect
```

## Contracts

- Summary counts event types, runs, sessions, agents, subagents, tools, usage,
  errors, approvals, safety, reads, and artifacts.
- Summary separates persisted actor ids from child/delegate identities:
  `agentIds` comes from event metadata `agentId`, while `subagentIds` is
  derived only from `subagent.*` events and prefers `metadata.childAgentId`,
  then configured profile or child-run fallbacks.
- Safety summary includes controlled workspace writes, capability mutations,
  shell mutation findings, confidential-read denials, and untracked
  write-capable process boundaries. MCP tools are summarized as normal
  tool calls; filesystem side effects outside managed workspace APIs are not
  counted as managed writes.
- Approval auto-approval counts prefer structured
  `approval.resolved.payload.autoApproved`; old traces without the field fall
  back to resolver message text for compatibility.
- Timeline projects events into phases and groups by event family.
- Timeline phase projection sorts by aggregate evidence
  (`timestamp`, scoped `monotonicUs` when both events share a trace/agent
  monotonic scope, then original line order). It does not use run-local
  `sequence` as a cross-run tiebreaker.
- Timeline groups `subagent.requested` / `subagent.started` /
  `subagent.completed` / `subagent.failed` by child run id before falling back
  to span id, so parent requests and child terminal states remain one phase even
  when adapters emit them under different spans.
- Timeline reconciles still-open phases for a run when that run has
  `run.completed`, `run.failed`, or `run.cancelled`. The run terminal event
  supplies the closing status, so `pending` means there is no terminal run
  evidence, such as a truncated trace.
- Timeline categorizes `extension.process.*` under `extension` and labels
  process phases from `{kind}:{name}` while treating progress as detail.
- Report turns summary/raw-event evidence into a concise verdict and findings
  for unresolved verification command failures, efficiency, run-scoped low net
  file progress across many model/tool cycles, repeated reads, repeated
  identical tool requests, repeated task-create lifecycle misuse,
  repeated command failures,
  recovered/unresolved failures, safety posture, and cost-reporting gaps.
- Completed-run verification profile summaries prefer terminal FactLedger
  verification-result snapshots, including `verificationSource:"profile"`;
  legacy `verification:<profile>:<id>` hookName parsing remains a fallback for
  old traces.
- Report workspace-read volume findings derive tool attribution from existing
  span correlation (`spanId` / `parentSpanId`) when available. This keeps the
  public summary `workspaceReads` total intact while report evidence can split
  grep/search scan reads from explicit read-like tool reads without adding raw
  `workspace.read` payload fields.
- Report findings are collected by analyzer functions over internal trace report
  facts, then sorted for output by severity rank (`high`, `medium`, `low`,
  `info`) and `code` ascending. Repeated-tool-request and low-net-progress
  thresholds live in `run-health.ts`; trace reports apply both thresholds per
  `runId` so parent and child/sub-agent runs are not summed into false repeated
  request or low-progress findings. CLI text/JSON output must not depend on
  analyzer declaration order.
- `REPEATED_TASK_CREATE_LIFECYCLE` is a report-only medium finding for same-run
  equivalent `task_create` calls after a prior same `kind` + payload task has
  completed and exposed a reusable task id. It intentionally ignores
  failed/cancelled/partial/truncated prior tasks and uses stable payload
  fingerprints rather than matching incidental scheduling fields.
- The internal `TraceReportFacts` aggregate is report-specific and private to
  `trace-diagnostics.ts`; it is not a public/general `TraceFacts` contract.
  `SessionTraceFacts` remains a separate session-compaction/oracle signal model.
- Report high-severity runtime errors are derived from a reportable failure
  ledger over the raw events, not directly from public `summary.errorCount`.
  Expected denials remain non-fatal, and companion `.failed` events with a
  `toolCallId` are joined back to the recovery-aware tool-failure ledger to
  avoid double-counting recovered failures.
- Expected-denial summary counts include classifier-derived denial derivatives.
  A `REPEATED_TOOL_CALL_SKIPPED` after a same-target policy/approval denial is
  counted under `expectedDenialCodes` and excluded from unresolved/recovered
  failure totals; ordinary repeated calls keep the existing recovered or
  unresolved classification.
- A runtime failure on a target that already completed a successful destructive
  mutation _earlier in the run_ (`output.changed === true`, mutation index before
  the failure index — `mutatedByTarget` tracks indexes, not just membership) is
  recovered, not unresolved, and is surfaced as the medium-severity
  `DESTRUCTIVE_MUTATION_THEN_NOT_FOUND` finding (carried by
  `toolOutcomeSnapshot().mutationFollowups`). This stops a "delete succeeded,
  then same target returned not-found" loop from showing as a `failed` verdict.
- Tool-failure classification (`collectClassifiedToolFailures`) recomputes from
  raw events via `toolOutcomeSnapshot` only when there is at least one failure
  and _every_ failed tool call still has a matching `tool.requested` carrying
  `arguments` (`everyFailedToolCallHasRequestArgs`). Then the current classifier
  (including the destructive-mutation diagnostic) applies even to traces whose
  persisted `run.completed.toolOutcome` predates the classifier. A loose "any
  request has args" gate is wrong for mixed multi-run traces: one args-bearing
  run would force a recompute that misclassifies an older/compacted run whose
  failed call lost its request args, flipping a persisted `recovered` failure to
  `unresolved`. When any failed call lacks request args, defer to the persisted
  snapshot.
- Trace report scores multi-agent auditability facts:
  `SUBAGENT_INCOMPLETE` for child `terminalState`/step-limit/truncation,
  `IN_FLIGHT_DUPLICATE_STORM` for repeated same-batch duplicate skips,
  `REPEATED_APPROVAL_DENIALS`, and
  `UNTRACKED_WRITE_CAPABLE_BOUNDARY`. These are report findings derived from
  raw trace facts; they do not alter raw trace semantics. Sandbox detail can be
  included as evidence, but a boundary remains medium severity while it can
  write ordinary workspace files outside managed `workspace.write.*`
  attribution.
- `SUBAGENT_INCOMPLETE` remains high unless the report can derive
  `verifiedAfterChildWrite` evidence from trace append order: a child
  `workspace.write.completed`, parent-visible `workspaceWrites > 0`, a later
  successful verification command or verification hook, and no later workspace
  write. In that case the derived finding is medium severity; raw child
  finality and raw events are unchanged.
- Unresolved verification command failures are high-severity report findings;
  they must outrank low-severity cost reporting gaps.
- `ModelUsage.costStatus` / `costUnavailableReason` must survive streaming
  accumulation: `mergeModelUsage` (run-trace-build.ts) carries them so the
  terminal `model.completed` usage and the usage tracker can record
  `unavailable`/`missing_pricing` instead of looking silent. The report's
  low-severity `COST_UNAVAILABLE` finding fires only when tokens were recorded
  with **no** cost status at all; a reported `costStatus:"unavailable"` is a
  known state, not a gap, so it does not downgrade the verdict to
  `passed_with_issues`.
- Host model resolution now surfaces the same `missing_pricing` reason before
  usage exists through `run.started.payload.resolvedModel.pricing` and
  `CapabilitySnapshot.model.pricing`; trace diagnostics should treat this as
  advisory startup evidence, not as a run failure.
- Persisted command-outcome snapshots keep legacy `verification.lastCommand`
  scoped to the last unresolved verification failure. Recovered verification
  failures are preserved separately as `lastFailure*` plus
  `lastSuccessfulVerificationCommand` so summaries can distinguish "failed
  then passed" from "still failing".
- When `run.completed.factLedger` is present, trace summary command-failure
  diagnostics prefer each run's ledger projection over legacy `commandOutcome`
  and raw-event recompute. Multi-run traces aggregate per-run projections so a
  clean later ledger cannot mask an earlier run's failures. The ledger projection
  includes non-stale model-initiated command facts plus verification-relevant
  verifier-launched command facts, so workflow command verifiers are visible in
  `commandFailures.verification` even when they did not originate from a model
  shell tool call. Older runs without a ledger keep the existing
  `commandOutcome`/offline recompute compatibility path.
- Completed-run outcome projection treats host-emitted `workflow.failed` events
  as failing workflow evidence for the enclosing P1 workflow run. Core does not
  synthesize those events; the projection is over raw trace facts emitted by
  host workflow code.
- Trace reports must not emit generic `COMMAND_FAILURES` when every shell
  failure is a recovered verification failure with a later successful
  verification command. Mixed traces with unrelated non-verification command
  failures should still report generic command-failure evidence.
- Verify checks JSONL validity, per-run sequence continuity, scoped monotonic
  timing, terminal event count, approval pairs, write pairs, and artifact
  duplication. It must not fail a trace merely because append order differs
  from aggregate timeline projection order; multi-agent flushes can append a
  child run block before the parent's later tail while preserving run-local
  invariants.
- Trace report also scores invalid terminal run counts as a high-severity
  `TRACE_TERMINAL_EVENT_COUNT_INVALID` finding, so a trace that verify rejects
  for missing/double terminal evidence cannot still report `ok`.
- Sequence continuity tolerates the gaps left by standard-level folding. Folded
  `model.stream.text` chunks advance the expected sequence via
  `observedSequenceEnd` (chunkCount), and folded `extension.process.progress`
  events advance it via `foldedSequenceSkipBefore` (the terminal
  `extension.process.completed`/`.failed` event's folded progress summary:
  `progressCount` plus `progressHead`/`progressTail` evidence). A gap not
  matching the declared fold count is still reported as `TRACE_SEQUENCE_INVALID`.
  Dropped stderr-token samples do not consume event sequences; debug-only
  `progressDroppedSamples` are diagnostic payload, not fold evidence.
  The same skip applies to session-consistency `RUN_EVENT_SEQUENCE_INVALID`.
  Stream folding may produce multiple `model.stream.text` markers for one
  model stream when same-run task or runtime events split the chunk sequence;
  each marker describes one contiguous sequence segment.
- Trace diagnostics operate over persisted raw `trace.jsonl`; valid trace
  levels are `standard` and `debug`.
- `trace-diagnostics.ts` owns summary/timeline/report/verify and their pure
  helpers. `trace-session-consistency.ts` owns session trace
  consistency/repair while reusing diagnostics parse/summary helpers. `trace.ts`
  re-exports those names as the stable facade.
- CLI live run output may suppress high-volume debug events through protocol
  `isLiveDebugNoiseEventType()` for readability; the CLI aggregates suppressed
  live events into `live.debug.suppressed` lines unless `--verbose` is set. This
  does not affect raw `trace.jsonl`, `trace events`, summary, timeline, report,
  or verify.
- CLI fixture snapshots lock text and JSON output for `trace summary`,
  `timeline`, `report`, and `verify` over a stable trace fixture.
- CLI text timelines prefix phase rows with a short run id only when the trace
  contains multiple run ids; JSON timelines keep full `runId` fields.
- `session.inspect` returns summary, consistency, and timeline together.

## Consumers

- `sparkwright trace summary|timeline|report|verify`.
- `sparkwright session summary|check`.
- TUI `/sessions` inspect view through host protocol.
- Maintainer debugging and QA workflows.

## Change Checklist

- Add summary counters for new event families that affect safety or costs.
- Add timeline categories for new long-running phases.
- Add report findings only for high-signal behavior that a maintainer can act on.
- Add verify findings only for stable invariants, not subjective quality issues.
- Keep CLI text output concise and JSON output structured.

## Known Debts

- Repeated unchanged read windows now feed live model feedback; repeated
  non-read tool/command findings are still diagnostics only. Default `maxSteps`
  should not be lowered for complex tasks without a separate task-shape-aware
  guard.

## Last Verified

- Status: Verified
- Date: 2026-07-15
- Scope: CLI trace/session diagnostic handlers and formatters moved intact to
  a domain module; summary, events, timeline, report, verify, consistency,
  repair, compact, inspect, and text/JSON output are unchanged.
- Read: trace-session command module, CLI facade, Core trace diagnostics.
- Tests: CLI trace/session focused slices and full CLI golden.

- Status: Verified
- Date: 2026-07-14
- Scope: reviewed CLI/Host assembly migration; trace summary, timeline, and
  verification derivation remain unchanged.

- Status: Read-only
- Date: 2026-07-13
- Scope: checked shared sandbox launch decisions; trace summary/timeline/report
  projection logic and sandbox summary fields did not change.
- Read: Host traced process sandbox summaries and MCP sandbox summaries.
- Tests: focused Host/MCP tests passed; trace projection code unchanged.

- Status: Read-only
- Date: 2026-07-13
- Scope: checked Host security-plan and CLI capability-inspect refactor;
  summary, timeline, report, and verify projections are unchanged.
- Read: CLI capability command boundary and Host capability snapshot assembly.
- Tests: CLI capability-inspect tests passed; trace diagnostic code was not
  changed.

- Status: Read-only
- Date: 2026-07-12T20:00:00+0800
- Scope: checked new Agent/Workflow stats CLI routing; it scans canonical trace
  and Workflow records without changing summary/timeline/verify contracts.
- Read: CLI stats handlers and host asset projection scanner.
- Tests: covered by the full release gate; no map contract change needed.

- Status: Read-only
- Date: 2026-07-12
- Scope: checked CLI reconciliation routing; trace summary/timeline/verify semantics need no update.
- Tests: focused CLI tests passed; release gate pending.

- Status: Verified
- Date: 2026-07-11T21:45:00+0800
- Scope: report emits an informational `FINITE_SERVICE_TASK` advisory when a
  service-classified shell task completes naturally with exit code zero; this
  does not change an otherwise-ok verdict.
- Read: `packages/core/src/trace-diagnostics.ts`,
  `packages/core/test/trace.test.ts`.
- Tests: `npm exec -- vitest run packages/core/test/trace.test.ts`.

- Status: Verified
- Date: 2026-07-11T19:53:00+0800
- Scope: verified sequence diagnostics accept multiple contiguous folded stream
  segments while still rejecting unexplained gaps or backwards append order.
- Read: `packages/core/src/trace-store.ts`,
  `packages/core/src/trace-diagnostics.ts`,
  `packages/core/src/trace-session-consistency.ts`,
  `packages/core/test/trace.test.ts`.
- Tests: `npm --workspace @sparkwright/core test -- test/trace.test.ts`.

- Status: Verified
- Date: 2026-07-07T15:21:23+0800
- Scope: trace report added `REPEATED_TASK_CREATE_LIFECYCLE` for completed
  same-payload repeated task creation and keeps failed prior tasks out of that
  finding.
- Read: `packages/core/src/trace-diagnostics.ts`,
  `packages/core/test/trace.test.ts`,
  `docs/_internal/project-map/maps/trace/summary-timeline-verify.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/trace.test.ts`;
  `npm --workspace @sparkwright/core run typecheck`.

- Status: Read-only
- Date: 2026-07-07T00:55:52+0800
- Scope: workflow distill/shadow now filters blocked tool attempts in
  `workflow-trace-observation.ts`; raw trace summary, timeline, report, verify,
  and host session inspection diagnostics remain unchanged. A real Sonnet trace
  still records the blocked `glob` request/failure, while offline workflow
  observation no longer promotes it into required coverage or distill tools.
- Read: `packages/host/src/workflow-trace-observation.ts`,
  `packages/host/src/workflow-distill.ts`,
  `packages/host/src/workflow-shadow.ts`,
  `docs/_internal/project-map/maps/trace/summary-timeline-verify.md`.
- Tests: `npm --workspace @sparkwright/host test --
test/workflow-shadow.test.ts test/workflow-distill.test.ts`; manual
  `workflow shadow` / `workflow distill` replay of
  `session_mr9fmua899dimnc2`.

- Status: Verified
- Date: 2026-07-06T23:31:01+0800
- Scope: workflow verifier trace summary fix: persisted FactLedger projection now
  counts verification-relevant `verifier-launched` command failures; workflow
  distill/shadow observation also normalizes bare `run.completed` events to
  `completed`.
- Read: `packages/core/src/run-outcome.ts`,
  `packages/core/test/trace.test.ts`,
  `packages/host/src/workflow-trace-observation.ts`,
  `packages/host/test/workflow-distill.test.ts`,
  `packages/host/test/workflow-shadow.test.ts`.
- Tests: `npm --workspace @sparkwright/core test -- test/trace.test.ts`;
  `npm --workspace @sparkwright/core run typecheck`; `npm --workspace
@sparkwright/host test -- test/workflows.test.ts
test/workflow-distill.test.ts test/workflow-shadow.test.ts`; `npm --workspace
@sparkwright/host run typecheck`.

- Status: Read-only
- Date: 2026-07-06T20:47:10+0800
- Scope: C13-② routed-page check: confidential read denials remain existing raw
  `workspace.read.denied` / `tool.failed` evidence. Trace summary, timeline,
  report, verify, and host session inspection derivations were not changed.
- Read: `packages/core/src/trace-diagnostics.ts`,
  `packages/core/src/workspace.ts`, `packages/core/src/policy.ts`,
  `packages/cli/test/cli.test.ts`.
- Tests: not run for trace diagnostic commands; C13 focused validation ran in
  core/host/CLI/protocol.

- Status: Read-only
- Date: 2026-07-05T22:20:59+0800
- Scope: workflow-runtime-v1 P8a routed-page check: `workflow shadow` reads
  existing trace events for an offline workflow coverage report but does not
  change `trace summary`, `trace timeline`, `trace report`, `trace verify`, or
  host session inspection diagnostics.
- Read: `packages/host/src/workflow-trace-observation.ts`,
  `packages/host/src/workflow-shadow.ts`,
  `packages/cli/src/cli.ts`,
  `packages/host/test/workflow-shadow.test.ts`.
- Tests: not run for trace diagnostic commands; P8a made no derived trace view
  semantic change. Focused shadow gates passed in host/CLI.

- Status: Read-only
- Date: 2026-07-05T16:03:27+0800
- Scope: workflow-runtime-v1 P5 routed-page check: bounded
  `parallel` / `join` does not change trace summary/timeline/report/verify
  derivation. Branch verdicts are workflow record state plus normal node
  completion evidence, not a new diagnostic event family.
- Read: `packages/host/src/workflow-projection.ts`,
  `packages/agent-runtime/src/workflows/types.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test --
test/workflow-hooks.test.ts`; `npm --workspace @sparkwright/host run
typecheck`.

- Status: Verified
- Date: 2026-07-05T00:42:02+0800
- Scope: workflow-runtime-v1 P2 check: durable workflow run list/resume does
  not change trace summary/timeline/report/verify derivation; completed-run
  workflow verdicts still come from raw `workflow.failed` / FactLedger facts,
  while `WorkflowRunRecord` is a separate session-state document.
- Read: `packages/core/src/trace-diagnostics.ts`,
  `packages/core/src/run-outcome.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/src/workflow-projection.ts`.
- Tests: `npm --workspace @sparkwright/host test --
test/workflows.test.ts test/workflow-hooks.test.ts -t "workflow"`.

- Status: Verified
- Date: 2026-07-04T16:47:47+0800
- Scope: workflow-runtime-v1 P1.5 outcome diagnostics: completed-run command
  and verification profile outcomes prefer terminal FactLedger snapshots with
  `verificationSource`, while old `verification:` hookName traces remain
  readable as fallback.
- Read: `packages/core/src/run-outcome.ts`,
  `packages/core/src/fact-ledger.ts`,
  `packages/core/test/run-outcome.test.ts`,
  `packages/cli/src/run-outcome.ts`,
  `packages/cli/test/run-outcome.test.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/host/src/verification.ts`.
- Tests: `npm --workspace @sparkwright/core test --
test/run-outcome.test.ts test/fact-ledger.test.ts`; `npm --workspace
@sparkwright/cli test -- test/run-outcome.test.ts
test/run-outcome-consistency.test.ts test/cli.test.ts -t "workflow|verification
profile|Verification:|experimental gate|--workflow"`;

- Status: Verified
- Date: 2026-07-04T10:10:34+0800
- Scope: workflow-runtime-v1 S2 diagnostics: trace summary now prefers
  per-run persisted FactLedger snapshots for command failures and keeps the
  offline recompute/legacy commandOutcome fallback for old traces.
- Read: `packages/core/src/trace-diagnostics.ts`,
  `packages/core/src/fact-ledger.ts`,
  `packages/core/src/run-outcome.ts`,
  `packages/core/test/trace.test.ts`,
  `packages/core/test/fact-ledger.test.ts`.
- Tests: `npm --workspace @sparkwright/core test --
test/fact-ledger.test.ts test/run-outcome.test.ts test/trace.test.ts`;
  `npm --workspace @sparkwright/core run typecheck`.

- Status: Verified
- Date: 2026-07-03T19:10:00+0800
- Scope: `LOW_NET_PROGRESS` and `REPEATED_TOOL_REQUESTS` report findings now
  use run-scoped inputs and include run/agent evidence for multi-run traces;
  successful parent+child background-agent traces no longer cross thresholds
  only because child work or independent repeated reads are summed with parent
  work.
- Read: `packages/core/src/trace-diagnostics.ts`,
  `packages/core/src/run-health.ts`, `packages/core/test/trace.test.ts`,
  `docs/_internal/project-map/modules/core.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/trace.test.ts -t
"low net progress|sequential paginated|delayed verification"`;
  `npm --workspace @sparkwright/core test -- test/trace.test.ts`;
  `npm --workspace @sparkwright/core run typecheck`;
  `npm run build --workspace @sparkwright/core`; `npm run check:dist-fresh`;
  replayed real mini background-agent trace
  `/tmp/sparkwright-real-mini-bg-current.9hEJTL/.sparkwright/sessions/session_mr4hdu7zh7hdjb8i/trace.jsonl`
  with `trace report` now `ok`.

- Status: Verified
- Date: 2026-07-02T21:55:07+0800
- Scope: trace summary/report now reflect repeated expected denials as
  non-failing expected-denial derivatives, including historical debug traces
  whose repeated-skip event lacks new metadata but still has same-target request
  arguments.
- Read: `packages/core/src/trace-diagnostics.ts`,
  `packages/core/src/run-outcome.ts`, `packages/core/test/trace.test.ts`,
  `packages/core/test/run-outcome.test.ts`,
  `docs/_internal/project-map/maps/trace/summary-timeline-verify.md`.
- Tests: `npm --workspace @sparkwright/core test --
test/run.test.ts test/run-outcome.test.ts test/trace.test.ts`;
  `npm --workspace @sparkwright/core run typecheck`;
  `npm run build --workspace @sparkwright/core`;
  `npm run check:dist-fresh`; replayed real mini trace
  `/tmp/sparkwright-real-mini-bg-agent-bash-20260702/session_mr3fuzyvo7nnw8o0/trace.jsonl`
  with `trace summary`, `trace report`, and `trace verify`.

- Status: Verified
- Date: 2026-07-01T20:51:06+0800
- Scope: trace report `WORKSPACE_READ_NOISE` and duplicate-read evidence now
  attribute scan-vs-explicit reads through existing tool spans while summary and
  raw trace contracts stay unchanged.
- Read: `packages/core/src/trace-diagnostics.ts`,
  `packages/core/test/trace.test.ts`,
  `docs/_internal/project-map/maps/trace/summary-timeline-verify.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/trace.test.ts`;
  `npm --workspace @sparkwright/core run typecheck`;
  real DCI trace report check on
  `/tmp/sparkwright-dci-sessions/session_mr1m3xl6dk49i8yd/trace.jsonl`.

- Status: Verified
- Date: 2026-06-29T17:40:00+0800
- Scope: recovered verification failures with a later successful command no
  longer downgrade report verdicts through generic `COMMAND_FAILURES`; mixed
  non-verification command failures remain reportable.
- Read: `packages/core/src/trace-diagnostics.ts`,
  `packages/core/test/trace.test.ts`,
  `docs/_internal/project-map/maps/trace/summary-timeline-verify.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/context.test.ts
test/run.test.ts test/trace.test.ts`; `npm --workspace @sparkwright/core run
typecheck`.

- Status: Verified
- Date: 2026-06-29T09:28:39+0800
- Scope: checked after built-in tool surface consolidation; trace summary,
  timeline, report, and verify contracts still parse legacy names while new
  traces use canonical `read`/`edit`/`bash` display names.
- Read: `packages/core/src/trace-diagnostics.ts`,
  `packages/core/src/run-outcome.ts`, `packages/cli/src/cli.ts`,
  `packages/tui/src/lib/tool-display.ts`,
  `docs/_internal/project-map/maps/trace/summary-timeline-verify.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/trace.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts test/config-schema.test.ts`;
  `npm --workspace @sparkwright/tui test -- test/format-event.test.ts`.

- Status: Verified
- Date: 2026-06-28T13:34:37+0800
- Scope: checked process-progress folding after stderr token telemetry:
  accepted progress still drives standard trace sequence skips through
  `progressCount`/head/tail evidence; dropped token samples are debug-only
  payload detail and do not affect summary/timeline/verify sequence math.
- Read: `packages/core/src/trace-diagnostics.ts`,
  `packages/core/src/trace-codec.ts`, `packages/core/src/trace-store.ts`,
  `packages/core/test/trace.test.ts`,
  `packages/host/src/traced-process-runner.ts`,
  `docs/_internal/project-map/maps/trace/summary-timeline-verify.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/trace.test.ts`;
  `npm --workspace @sparkwright/core run typecheck`;
  `npm --workspace @sparkwright/host run typecheck`.
- Prior verification — Date: 2026-06-26T23:59:00+0800
- Scope: checked `accessMode` metadata changes; summary/timeline/verify
  contracts did not require new fields.
