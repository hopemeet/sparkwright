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
- `packages/core/src/context.ts`
- `packages/core/src/pipeline.ts`
- `packages/core/src/session-compaction.ts`
- `packages/core/src/trace.ts`
- `packages/core/src/trace-codec.ts`
- `packages/core/src/trace-diagnostics.ts`
- `packages/core/src/trace-store.ts`
- `packages/core/src/path-display.ts`
- `packages/core/src/session.ts`
- `packages/core/src/events.ts`
- `packages/core/src/workflow-hooks.ts`
- `packages/core/src/policy.ts`
- `packages/core/src/workspace.ts`
- `packages/core/test/run.test.ts`
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

Does not own:

- product UI state
- provider selection and host config loading
- MCP process startup
- CLI/TUI command syntax
- long-term memory product behavior

## Contracts

- Facts enter append-only event streams before derived stores or views.
- `runId` routes kernel work; `sessionId` groups runs at the edge.
- `event.sequence` is per run, not per session.
- Trace levels are `standard` and `debug`; `minimal` is not a valid mode.
- `traceId`, `spanId`, and `parentSpanId` are correlation fields only.
- `trace.ts` is the stable named facade used by `index.ts` and `internal.ts`;
  storage lives in `trace-store.ts`, diagnostics live in
  `trace-diagnostics.ts`, and codec/filter/redaction primitives live in the
  leaf `trace-codec.ts`.
- `trace-store.ts` may import `trace-codec.ts` but not diagnostics; moved trace
  endpoint modules must not import the `trace.ts` facade.
- `ProcessInvocationBase`, `ProcessOutputSummary`, and `SandboxSummary` are
  shared process-observation shapes; host runners own execution and core owns
  the event vocabulary plus trace persistence behavior.
- `extension.process.progress` is high-volume host process detail: `debug`
  traces keep raw progress, while `standard` traces aggregate progress
  head/tail onto the terminal process event.
- `ContextItem.content` remains the text summary used by trace/UI surfaces;
  optional `ContextItem.parts` carries provider-neutral multimodal parts
  (`text`, `image`, `file`, `audio`) into prompt construction.
- Observation formatting lifts dynamic `spawn_agent` child-answer facts
  (`childRunId`, `role`/`agentName`, `stepLimitReached`, `truncated`, and
  `finality`) into `ContextItem.metadata`, so later context compaction can
  preserve whether a child tool result was complete or partial.
- Provider prompts must render context sources through the model-visible
  projection in `context.ts`; diagnostic provenance may keep host absolute
  paths in metadata, but prompt source labels must not expose them.
- Command outcome snapshots distinguish unresolved verification failures from
  recovered failures: legacy `verification.lastCommand` points only at the last
  unresolved failure, while `lastFailure*` and
  `lastSuccessfulVerificationCommand` preserve recovered evidence.
- Usage snapshots record `usage_not_reported` when a model call returns no
  usage block, while provider adapters can still report `missing_pricing` when
  token usage exists but no pricing is configured.
- Trace reports include a `LOW_NET_PROGRESS` advisory when many model/tool
  cycles produce little file-write progress, repeated unchanged reads, or
  delayed verification after the last write.
- Trace timelines use semantic phase keys before span fallback; `subagent.*`
  lifecycle rows are grouped by child run id so a parent request and child
  terminal event do not split into pending and completed phases when spans
  differ.
- Trace reports score multi-agent auditability facts from the raw trace:
  incomplete child terminal states (`SUBAGENT_INCOMPLETE`), in-flight duplicate
  storms, repeated approval denials, and untracked write-capable external
  process markers.
- Tool execution diagnostics distinguish same-batch `in_flight_duplicate`
  skips from completed-result duplicate repeats. In-flight duplicate skips get
  an accurate observation and do not mark the target as failed/no-op for
  next-turn bookkeeping; same-batch duplicate multiplicity still feeds the
  repeated-call / doom-loop guard.
- Trace safety summaries count `workspace.write.untracked_access_granted` as
  `untrackedWriteCapableProcesses`, separate from managed
  `workspace.write.completed` counts.
- Trace summary `errorCount` remains a raw public count; trace report derives
  high-severity `TRACE_ERRORS` from reportable failures after tool recovery and
  companion-event correlation.
- `path-display.ts` owns shared display-only path projection: workspace paths
  become relative, and external absolute paths collapse to non-host locators.
- Compaction stages return the shared `CompactionResult` protocol
  (`items`, `freedChars`, optional `skippedReason`/`warnings`/metadata) and are
  tagged by tier (`dedup`, `extract`, `evict`, `summarize`).
  `CompactionStageResult` is not a separate public alias.
- `session.ts` owns the `session-compact.v2` artifact parser/writer; artifacts
  require top-level `freedChars` and are ignored when the schema or
  `throughRunId` anchor is invalid.
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
- Report generation now surfaces high-signal symptoms, but root-cause prevention for repeated tool/read loops remains thin.

## Last Verified

- Status: Verified
- Date: 2026-06-21
- Read: `packages/core/src/trace.ts`, `packages/core/src/trace-codec.ts`,
  `packages/core/src/trace-diagnostics.ts`, `packages/core/src/trace-store.ts`,
  `packages/core/src/index.ts`, `packages/core/src/internal.ts`,
  `packages/core/test/trace.test.ts`, `packages/cli/test/cli.test.ts`,
  `docs/_internal/project-map/designs/trace-diagnostics-refactor.md`,
  `docs/_internal/project-map/maps/trace/raw-trace.md`,
  `docs/_internal/project-map/maps/trace/summary-timeline-verify.md`,
  `docs/_internal/project-map/maps/session/session-store.md`.
- Tests: `npx prettier --check packages/core/src/trace.ts packages/core/src/trace-codec.ts packages/core/src/trace-diagnostics.ts packages/core/src/trace-store.ts`;
  `npm run build`; `npm --workspace @sparkwright/streaming-runtime run build`;
  `npm --workspace @sparkwright/core test -- test/trace.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts`.
