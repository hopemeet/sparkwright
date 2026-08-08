# TUI Static Header Duplication

## Record

- Pattern ID: `tui-static-header-duplication`
- Status: `fixed`
- First seen: 2026-06-22
- Last seen: 2026-07-19
- Recorded count: 2

| Cause                   | Count |
| ----------------------- | ----: |
| `product_bug`           |     2 |
| `test_bug`              |     0 |
| `prompt_underspecified` |     0 |
| `model_variance`        |     0 |
| `environment`           |     0 |
| `stale_dist`            |     0 |
| `dirty_workspace`       |     0 |
| `unknown`               |     0 |

## Symptom

The TUI first screen commits the full SparkWright brand/cwd/model/session header
twice when an initial session is restored.

## Root Cause

With an initial session id, `RunController` set that id in its constructor and
the App effect immediately called `switchSession()` for the same id.
`switchSession()` unconditionally reset the store, incrementing
`clearGeneration` and remounting EventStream after its first static header had
already been committed.

## Diagnostic Move

Render the first screen and check for duplicate static labels. A status line may
show run state, but it should not repeat the committed brand header.

## Prevention

- Keep static header assertions in EventStream tests.
- Keep StatusBar tests focused on changing state.
- Add PTY capture when layout ownership changes across app shell, event stream,
  and status bar together.

## Current Evidence

The pre-fix post-refactor real PTY first screen repeated the static brand/header
at 80, 100, and 120 columns (3/3 widths). This is the same ownership pattern,
not a new failure family: `EventStream` commits the static header while the
initial same-session restore remounts that stream.

Evidence root:
`/Applications/xgw/projects/AI-native/project/test/qa_tui_agent_20260719_tui_evidence`.

## Fix

- 2026-07-19: initial same-session restore skips the empty-store reset, so
  `clearGeneration` remains stable and the committed header is not remounted.
- Added a controller regression for initial-session restoration. Full TUI
  coverage passed (417 tests); a real PTY rerun remains useful layout evidence,
  but is no longer required to establish the deterministic remount cause.

## Related

- Scenario: [../scenarios/tui-first-screen-header.yaml](../scenarios/tui-first-screen-header.yaml)
- Coverage: [../coverage/tui-rendering.md](../coverage/tui-rendering.md)
