# Summary Timeline Report Verify

## Purpose

These are diagnostic views derived from `trace.jsonl`. They help humans and
tools inspect volume, failures, safety posture, phase ordering, high-signal run
health, and structural validity without replacing the raw trace.

See [raw-trace.md](raw-trace.md) for source data and [export-diagnostics.md](export-diagnostics.md) for product-facing export distinctions.

## Main Files

- `packages/core/src/trace.ts`
- `packages/cli/src/cli.ts`
- `packages/host/src/runtime.ts`
- `docs/reference/STATE_AND_TRACE_MODEL.md`
- `docs/reference/RUN_EVENTS.md`

## Data Flow

```txt
trace.jsonl
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
- Persisted command-outcome snapshots keep legacy `verification.lastCommand`
  scoped to the last unresolved verification failure. Recovered verification
  failures are preserved separately as `lastFailure*` plus
  `lastSuccessfulVerificationCommand` so summaries can distinguish "failed
  then passed" from "still failing".
- Verify checks JSONL validity, sequence continuity, monotonic timing, terminal event count, approval pairs, write pairs, and artifact duplication.
- Trace diagnostics operate over persisted raw `trace.jsonl`; valid trace
  levels are `standard` and `debug`.
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
- Date: 2026-06-20
- Read: `packages/core/src/eval.ts`, `packages/core/src/run-outcome.ts`, `packages/core/src/run.ts`, `packages/core/src/trace.ts`, `packages/core/src/usage.ts`, `packages/cli/src/cli.ts`, `packages/cli/src/event-format.ts`, `packages/cli/src/runners/direct-core-runner.ts`, `packages/cli/src/runners/host-runner.ts`, `packages/protocol/src/index.ts`, `packages/core/test/run.test.ts`, `packages/core/test/trace.test.ts`, `packages/core/test/usage.test.ts`, `packages/cli/test/cli.test.ts`, `packages/cli/test/event-format.test.ts`.
- Tests: `npm --workspace @sparkwright/core test -- test/trace.test.ts`; `npm --workspace @sparkwright/core test -- test/run.test.ts -t "in-flight duplicates|same-batch"`; `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "external command delegate|read-write workspace access|capabilities inspect"`; `npm --workspace @sparkwright/core run build`; `npm --workspace @sparkwright/cli run build`.
