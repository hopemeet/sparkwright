# Trace Cross-Run Repeated Tool Requests

- Status: `fixed`
- Dominant cause: `product_bug`
- Owner layer: `@sparkwright/core` trace diagnostics
- First observed: 2026-07-03 real `openai/gpt-5.4-mini` parent/child read
  follow-up
- Coverage: [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md),
  [../coverage/agents.md](../coverage/agents.md)

## Symptom

A valid parent + child trace was reported as `passed_with_issues` with
`REPEATED_TOOL_REQUESTS` because README was read three times across the whole
trace: parent read, child independent read, parent follow-up read.

## Root Cause

`collectRepeatedToolRequests(events)` was run over the whole trace before
report analysis. In multi-run traces this summed independent parent/child tool
requests into one repeated-request bucket.

## Fix

Trace report facts now collect repeated tool requests per run group. Multi-run
findings include `run` / `agent` evidence, and a single child run that actually
repeats the same request still reports normally.

## Verification

- Focused regression: parent + child calls no longer add together for
  `REPEATED_TOOL_REQUESTS`.
- Focused regression: child-only repeated requests still report with child
  run/agent evidence.
- Real trace replay:
  `/tmp/sparkwright-real-mini-spawn-read-repeat.FKfRMP/.sparkwright/sessions/session_mr4teseeiusb206j/trace.jsonl`
  now reports `verdict:"ok"`.
