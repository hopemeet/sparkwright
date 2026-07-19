# TUI Cancel Terminal Is Not Rendered

## Record

- Pattern ID: `tui-cancel-terminal-not-rendered`
- Status: `fixed`
- First seen: 2026-07-19
- Last seen: 2026-07-19
- Recorded count: 1
- Cause: `product_bug`

## Symptom

Pressing Escape during a long real-model shell call persists a canonical
`run.cancelled` assessment with `RUN_CANCELLED`, followed by the aborted tool.
The live TUI scrollback shows only `Tool aborted: bash`; it has no run-level
cancelled footer.

## Root Cause

The event stream renders its run footer from `run.completed` only. The focused
render test supplies a synthetic `run.cancelled` plus `run.completed` pair, but
the real Core cancel path emits `run.cancelled` as the sole run terminal.

## Diagnostic Move

After a live Escape cancel, compare the final screen with raw terminal events.
If `run.cancelled` is the sole run terminal, the screen must still render the
run cancellation separately from the active tool's `TOOL_ABORTED` result.

## Prevention

- Render a run-level footer for a sole `run.cancelled` event.
- Replace the synthetic paired-event regression with a real protocol shape and
  retain a separate compatibility test for traces that contain both events.

## Evidence

- Session `session_tui_qa_agent_cancel`, run `run_mrri8y65yxy0s1qx`.
- Trace:
  `/Applications/xgw/projects/AI-native/project/test/qa_tui_agent_20260719_tui_evidence/sessions/session_tui_qa_agent_cancel/trace.jsonl`.
- Terminal events: sequence 94 `run.cancelled`, sequence 95 cancelled
  `tool.failed`; no later `run.completed`.

## Fix

- 2026-07-19: EventStream snapshots run facts and renders the footer directly
  from a sole `run.cancelled` terminal.
- The render regression now uses the real single-terminal shape and requires
  exactly one cancellation footer. Full TUI coverage passed (417 tests).

## Related

- Coverage: [../coverage/tui-rendering.md](../coverage/tui-rendering.md)
- Run note: [../runs/2026-07-19-real-terra-refactor-qa-follow-up.md](../runs/2026-07-19-real-terra-refactor-qa-follow-up.md)
