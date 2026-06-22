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

- Summary counts event types, runs, sessions, agents, tools, usage, errors, approvals, safety, reads, and artifacts.
- Safety summary includes controlled workspace writes, capability mutations,
  shell mutation findings, confidential-read denials, and untracked
  write-capable external command boundaries. MCP tools are summarized as normal
  tool calls; filesystem side effects outside managed workspace APIs are not
  counted as managed writes.
- Approval auto-approval counts prefer structured
  `approval.resolved.payload.autoApproved`; old traces without the field fall
  back to resolver message text for compatibility.
- Timeline projects events into phases and groups by event family.
- Timeline groups `subagent.requested` / `subagent.started` /
  `subagent.completed` / `subagent.failed` by child run id before falling back
  to span id, so parent requests and child terminal states remain one phase even
  when adapters emit them under different spans.
- Timeline categorizes `extension.process.*` under `extension` and labels
  process phases from `{kind}:{name}` while treating progress as detail.
- Report turns summary/raw-event evidence into a concise verdict and findings
  for unresolved verification command failures, efficiency, low net file
  progress across many model/tool cycles, repeated reads, repeated identical
  tool requests, repeated command failures,
  recovered/unresolved failures, safety posture, and cost-reporting gaps.
- Report high-severity runtime errors are derived from reportable failures over
  the raw events, not directly from public `summary.errorCount`; companion
  `.failed` events with a `toolCallId` are joined back to the recovery-aware
  tool-failure ledger to avoid double-counting recovered failures.
- Trace report scores multi-agent auditability facts:
  `SUBAGENT_INCOMPLETE` for child `terminalState`/step-limit/truncation,
  `IN_FLIGHT_DUPLICATE_STORM` for repeated same-batch duplicate skips,
  `REPEATED_APPROVAL_DENIALS`, and
  `UNTRACKED_WRITE_CAPABLE_EXTERNAL_PROCESS`. These are report findings derived
  from raw trace facts; they do not alter raw trace semantics.
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
- Persisted command-outcome snapshots keep legacy `verification.lastCommand`
  scoped to the last unresolved verification failure. Recovered verification
  failures are preserved separately as `lastFailure*` plus
  `lastSuccessfulVerificationCommand` so summaries can distinguish "failed
  then passed" from "still failing".
- Verify checks JSONL validity, sequence continuity, monotonic timing, terminal event count, approval pairs, write pairs, and artifact duplication.
- Sequence continuity tolerates the gaps left by standard-level folding. Folded
  `model.stream.text` chunks advance the expected sequence via
  `observedSequenceEnd` (chunkCount), and folded `extension.process.progress`
  events advance it via `foldedSequenceSkipBefore` (the terminal
  `extension.process.completed`/`.failed` event's folded progress summary:
  `progressCount` plus `progressHead`/`progressTail` evidence). A gap not
  matching the declared fold count is still reported as `TRACE_SEQUENCE_INVALID`.
  The same skip applies to session-consistency `RUN_EVENT_SEQUENCE_INVALID`.
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

- The first report layer identifies high-signal symptoms; runtime model-feedback and prevention paths for duplicate tool loops still need design.
- Repeated tool/command findings are diagnostics only; default `maxSteps` should not be lowered for complex tasks without a separate task-shape-aware guard.

## Last Verified

- Status: Verified
- Date: 2026-06-21
- Read: `packages/core/src/trace.ts`,
  `packages/core/src/trace-diagnostics.ts`,
  `packages/core/src/trace-session-consistency.ts`,
  `packages/core/src/trace-codec.ts`, `packages/core/src/trace-store.ts`,
  `packages/core/src/index.ts`, `packages/core/src/internal.ts`,
  `packages/core/test/trace.test.ts`, `packages/cli/test/cli.test.ts`,
  `docs/_internal/project-map/designs/trace-diagnostics-refactor.md`,
  `docs/_internal/project-map/maps/trace/raw-trace.md`,
  `docs/_internal/project-map/maps/session/session-store.md`.
- Tests: `npx prettier --check packages/core/src/trace.ts packages/core/src/trace-codec.ts packages/core/src/trace-diagnostics.ts packages/core/src/trace-session-consistency.ts packages/core/src/trace-store.ts`;
  `npm run build`; `npm --workspace @sparkwright/streaming-runtime run build`;
  `npm --workspace @sparkwright/core test -- test/trace.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts`.
