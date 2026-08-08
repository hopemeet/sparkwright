# TUI Full-Height Periodic Clear

## Record

- Pattern ID: `tui-full-height-periodic-clear`
- Status: `fixed`
- First seen: 2026-07-26
- Last seen: 2026-07-26
- Recorded count: 1

| Cause                   | Count |
| ----------------------- | ----: |
| `product_bug`           |     1 |
| `test_bug`              |     0 |
| `prompt_underspecified` |     0 |
| `model_variance`        |     0 |
| `environment`           |     0 |
| `stale_dist`            |     0 |
| `dirty_workspace`       |     0 |
| `unknown`               |     0 |

## Symptom

The full-screen TUI visibly flashed every five seconds while idle. In
`--no-alt-screen` mode the same path could also clear terminal scrollback.

## Root Cause

App rendered its root at exactly `stdout.rows`. Ink 5.2.1 handles any output
whose height is greater than or equal to the terminal height by writing
`ESC[2J ESC[3J ESC[H` plus the complete frame before its unchanged-output
check. Passive Workflow discovery ran every five seconds and always toggled
loading/replaced snapshot state, giving the renderer a deterministic trigger.
Spinner, elapsed time, input, and streaming could trigger the same branch.

## Diagnostic Move

Capture raw PTY bytes with timestamps; do not rely only on the final pyte
screen. Count full-clear sequences during an idle interval longer than the
background poll. Then repeat after a changed frame such as Ctrl+T and under
`--no-alt-screen`.

## Prevention

- Keep Ink's owned height strictly below `stdout.rows`.
- Keep passive background refresh state-silent when its semantic snapshot is
  unchanged.
- Report measured lower-frame heights only when the physical value changes.
- Preserve a focused fake-stdout Ink regression for the clear sequence and a
  real PTY byte check for app-shell changes.

## Current Evidence

Before the fix, retained session `session_tui_ms12fuf0` emitted complete
clear/rewrite bursts at startup, 5 seconds, and 10 seconds. After the fix, a
100x32 replay emitted zero `ESC[2J ESC[3J ESC[H` sequences during 12.5 idle
seconds and during Ctrl+T. A separate `--no-alt-screen` replay emitted zero
`ESC[3J`. The detailed frame also showed the legacy repeated bash action as
`repeated_idempotent_noop · skipped`, with no generic child tool lifecycle
rows.

Agent Runtime passed 259/259; TUI passed 531/531; Host and repository test
typechecks passed.

## Fix

- Reserve one physical terminal row outside Ink's root.
- Make passive Workflow refresh avoid foreground loading and retain identical
  snapshot identity.
- Deduplicate exact tool-owned read/Skill effects and successful child tool
  lifecycle projection.
- Preserve structured skipped Agent action results and correct legacy replay
  receipts from child tool truth.

## Related

- Coverage: [../coverage/tui-rendering.md](../coverage/tui-rendering.md)
- Run note:
  [../runs/2026-07-26-tui-owned-viewport-pass.md](../runs/2026-07-26-tui-owned-viewport-pass.md)
