# 2026-06-22 Real Mini Subagent Partial

## Summary

- Scenario: Real `mini` model canary for dynamic `spawn_agent`, parent
  verification, read-only safety, and trace diagnostics.
- Coverage: real-model delegation, repeated tool guard, trace report failure
  classification, session/trace integrity.
- Result: `partial`
- Reusable lesson: A real model can batch parent verification beside a child
  delegation unless the prompt explicitly constrains the first tool batch. When
  the prompt also asks for the same parent read later, the repeated-tool guard
  can correctly stop the run as a tool loop.

## Test Setup

- Task direction: Use the configured real `mini` model to re-check the residual
  real-provider/subagent risk from historical failure testing.
- Prompt shape: `strong`, then refined `strong`
- Prompt: First run asked mini to call `spawn_agent` once, then read
  `trace-subagent-finality.md` itself after the child returned. Second run
  explicitly constrained the first tool batch to `spawn_agent` only, then asked
  the parent to read `failures/index.md`.
- Model class: real provider/model `openai/gpt-5.4-mini`
- Capabilities: `spawn_agent`, `read_file`; no shell; no writes.
- Permission/approval posture: read-only; no approvals.
- Workspace/config isolation: temporary `/tmp` session roots.
- Trace level: `debug`
- Environment notes: provider credentials were available from merged
  `~/.config/sparkwright/config.yaml`; env provider key variables were absent.

## Commands Or Harness

```bash
node packages/cli/dist/index.js run "<subagent then parent read prompt>" --workspace . --session-root "$tmp" --model openai/gpt-5.4-mini --trace-level debug
node packages/cli/dist/index.js trace summary "$trace" --format text
node packages/cli/dist/index.js trace timeline "$trace" --format text
node packages/cli/dist/index.js trace report "$trace" --format text
node packages/cli/dist/index.js trace verify "$trace" --format text
node packages/cli/dist/index.js session check "$session" --workspace . --session-root "$tmp" --format text
```

## Stable Evidence

- First trace:
  `/tmp/sparkwright-real-mini.C1ntoM/session_mqpdh2zi1dtj6gbq/trace.jsonl`.
- First trace report verdict was `failed` with `TRACE_ERRORS` and
  `REPEATED_TOOL_REQUESTS`; the terminal error was `TOOL_DOOM_LOOP` after
  repeated `read_file` calls on the same target.
- First trace summary showed 2 runs, 1 `spawn_agent`, 3 `read_file` calls,
  1 recovered `REPEATED_TOOL_CALL_SKIPPED`, 0 approvals, and 0 workspace writes.
- First `trace verify` and `session check` were both `ok`, so the trace/session
  structure stayed valid while the run outcome failed.
- Second trace:
  `/tmp/sparkwright-real-mini-seq.mz19uA/session_mqpdicz8rsyvgu4r/trace.jsonl`.
- Second run completed with final answer, 0 errors, 0 tool failures, 0 approvals,
  0 workspace writes, `trace report` verdict `ok`, `trace verify` `ok`, and
  `session check` `ok`.

## Non-Invariants Observed

- The second run still called `spawn_agent` twice despite the prompt saying
  exactly once. This is a real-model route variance observation, not a trace
  invariant failure.
- Trace diagnostics do not evaluate arbitrary prompt adherence such as
  "exactly once"; they report runtime/trace invariants and repeated-request
  patterns.
- Cost was unavailable because configured pricing for `openai/gpt-5.4-mini`
  was missing.

## Failures

- Failure pattern: `prompt-induced-tool-loop`
- Cause bucket: `prompt_underspecified`
- Count update: increment recorded count from 0 to 1.

## Coverage Update

- Page: `coverage/agents.md`, `coverage/trace-diagnostics.md`
- Change: Real `mini` canary now covers read-only dynamic subagent trace
  structure and repeated-tool reporting, but exact delegate count remains a
  model/prompt-sensitive non-invariant.

## Follow-Up

- For future real-model subagent canaries, specify the first tool batch,
  permitted tools per step, and the stop condition after any repeated-tool
  warning.
