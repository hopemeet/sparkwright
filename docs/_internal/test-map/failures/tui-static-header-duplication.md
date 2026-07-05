# TUI Static Header Duplication

## Record

- Pattern ID: `tui-static-header-duplication`
- Status: `active`
- First seen: 2026-06-22
- Last seen: 2026-06-22
- Recorded count: 1

| Cause | Count |
| --- | ---: |
| `product_bug` | 1 |
| `test_bug` | 0 |
| `prompt_underspecified` | 0 |
| `model_variance` | 0 |
| `environment` | 0 |
| `stale_dist` | 0 |
| `dirty_workspace` | 0 |
| `unknown` | 0 |

## Symptom

The TUI first screen repeats the SparkWright brand/header in both committed
scrollback and the pinned status line.

## Root Cause

Ownership between static first-screen context and live changing run state was
unclear. EventStream should own the committed header; StatusBar should own only
changing state.

## Diagnostic Move

Render the first screen and check for duplicate static labels. A status line may
show run state, but it should not repeat the committed brand header.

## Prevention

- Keep static header assertions in EventStream tests.
- Keep StatusBar tests focused on changing state.
- Add PTY capture when layout ownership changes across app shell, event stream,
  and status bar together.

## Related

- Scenario: [../scenarios/tui-first-screen-header.yaml](../scenarios/tui-first-screen-header.yaml)
- Coverage: [../coverage/tui-rendering.md](../coverage/tui-rendering.md)
