# TUI Todo Advisory Is Not Replayed

## Record

- Pattern ID: `tui-todo-advisory-not-replayed`
- Status: `fixed`
- First seen: 2026-07-19
- Last seen: 2026-07-19
- Recorded count: 2
- Cause: `product_bug`

## Symptom

A coding run ends once with unfinished advisory Todo items. The live TUI shows
the protocol `todoAdvisory` notice and correctly starts no continuation. After
session replay, the Todo band remains correct but the advisory notice has
disappeared.

## Root Cause

Host places `todoAdvisory` on the terminal protocol message. The live
`RunController` converts it to an in-memory `appendNotice()` row, but that row
is not a persisted trace event and replay does not reconstruct it from the
terminal event.

## Diagnostic Move

Capture the screen immediately after completion and after reopening the same
session. Compare the Todo band and advisory row separately; Todo state can be
correct even when the completion advisory is missing.

## Prevention

- Do not create a live-only advisory row. The canonical Todo band is the one
  TUI presentation of unfinished advisory state in both live and replay views.
- Add one live-then-replay test with unfinished Todo and assert no new run is
  scheduled in either view.

## Evidence

- Session `session_tui_qa_agent_deny2` under
  `/Applications/xgw/projects/AI-native/project/test/qa_tui_agent_20260719_tui_evidence/sessions`.
- Two live turns showed `3 todo item(s) remain open` and then
  `2 todo item(s) remain open`; two replays lost the notice while retaining the
  Todo band. This is a presentation/replay split, not a Todo scheduling
  recurrence.

## Fix

- 2026-07-19: RunController no longer converts the protocol-only
  `todoAdvisory` into an unpersisted `tui.notice`. Live and replay both use the
  Todo band projected from canonical `todo_write` events.
- Full TUI coverage passed (417 tests).

## Related

- Coverage: [../coverage/tui-rendering.md](../coverage/tui-rendering.md)
- Run note: [../runs/2026-07-19-real-terra-refactor-qa-follow-up.md](../runs/2026-07-19-real-terra-refactor-qa-follow-up.md)
