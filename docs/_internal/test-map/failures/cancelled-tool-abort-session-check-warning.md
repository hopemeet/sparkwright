# Cancelled Tool Abort Is Warned As Unresolved By Session Check

## Record

- Pattern ID: `cancelled-tool-abort-session-check-warning`
- Status: `fixed`
- First seen: 2026-07-19
- Last seen: 2026-07-19
- Recorded count: 2
- Cause: `product_bug`

## Symptom

A correctly cancelled run has one canonical `run.cancelled` terminal followed
by the in-flight tool's `tool.failed` event with `TOOL_ABORTED`. `trace report`
returns `ok` and counts zero unresolved tool failures, while `session check`
returns `ok:true` with an `UNRESOLVED_TOOL_FAILURE` warning for that same abort.

## Root Cause

`summarizeTraceJsonl()` reconciles tool outcomes with run terminal state, so a
tool aborted as a consequence of cancellation is not unresolved work.
`validateToolFailureSafety()` calls `analyzeToolOutcomes(traceEvents)` directly
and reports every remaining failure except path-escape failures; it does not
exclude `TOOL_ABORTED` owned by a cancelled run.

## Diagnostic Move

For a cancellation trace, compare all three projections:

1. raw terminal order (`run.cancelled`, then `TOOL_ABORTED`);
2. `trace report` unresolved failure count;
3. `session check` findings.

If report and raw terminal ownership are clean but session check warns only on
the cancellation abort, classify it as diagnostic divergence rather than an
unhandled runtime failure.

## Prevention

- Share the terminal-aware tool-outcome reconciliation between trace summary
  and session consistency.
- Add a session-consistency fixture with a sole `run.cancelled` terminal and a
  later `TOOL_ABORTED` tool event.
- Retain a separate warning test for genuinely unresolved failures after a
  completed run.

## Fix

`validateToolFailureSafety()` now groups raw events by `runId`, runs the
existing tool-outcome classifier inside each run, and excludes only
`TOOL_ABORTED` owned by an unambiguous logical cancellation. It accepts the
canonical sole `run.cancelled`, legacy cancelled `run.completed`, and their
compatible pair independent of physical order. Conflicting terminals,
cross-run failures, and workspace escapes remain findings.

Verification on 2026-07-19:

- 8 focused session-consistency regressions passed, including multi-run and
  path-escape controls;
- the fresh real Terra cancellation session now returns `ok:true` with
  `findings:[]`;
- the historical real Terra cancellation session also returns no findings.

## Evidence

- Fresh real Terra session:
  `/Applications/xgw/projects/AI-native/project/test/qa_fix_verify_20260719_182027/tui/.sparkwright/sessions/session_qa_fix_tui_cancel_v2_20260719/trace.jsonl`.
- Historical real Terra session:
  `/Applications/xgw/projects/AI-native/project/test/qa_tui_agent_20260719_tui_evidence/sessions/session_tui_qa_agent_cancel/trace.jsonl`.
- Both reports are `ok`; both session checks return the same warning.

## Related

- Coverage: [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md),
  [../coverage/tui-rendering.md](../coverage/tui-rendering.md)
- Run note:
  [../runs/2026-07-19-real-model-fix-verification.md](../runs/2026-07-19-real-model-fix-verification.md)
- Render fix pattern:
  [tui-cancel-terminal-not-rendered.md](tui-cancel-terminal-not-rendered.md)
