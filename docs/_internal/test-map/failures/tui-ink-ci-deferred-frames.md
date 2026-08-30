# TUI Ink CI Deferred Frames

## Record

- Pattern ID: `tui-ink-ci-deferred-frames`
- Status: `fixed`
- First seen: 2026-08-08
- Last seen: 2026-08-30
- Recorded count: 2

| Cause                   | Count |
| ----------------------- | ----: |
| `product_bug`           |     0 |
| `test_bug`              |     2 |
| `prompt_underspecified` |     0 |
| `model_variance`        |     0 |
| `environment`           |     0 |
| `stale_dist`            |     0 |
| `dirty_workspace`       |     0 |
| `unknown`               |     0 |

## Symptom

Interactive Ink rendering tests pass in the default local environment but fail
across every CI OS and Node version. Assertions either receive an empty string
or see only the last visible page instead of an earlier interaction frame.

## Root Cause

The tests treated accumulated `stdout.write()` calls as a stable history of
every intermediate frame. Under `CI=true`, Ink may defer output until unmount
and guarantee only the final frame unless the test render opts into debug
output. The first occurrence mixed intermediate and final frames. The second
left interactive Connect and Project Trust tests on the deferred-output path,
then one current-screen assertion still inspected accumulated history.

## Diagnostic Move

Re-run the focused test with `CI=true`. If callbacks and state transitions are
correct but captured output is empty or contains only the final view, inspect
whether the harness unmounts before reading and whether one assertion depends
on multiple historical frames.

## Prevention

- Unmount Ink test instances before reading the final captured frame.
- Set `debug: true` on interactive harness renders that must inspect multiple
  frames before unmount.
- Use independent render instances when assertions need two distinct pages or
  interaction states.
- Use the latest write for current-screen assertions; do not treat concatenated
  terminal writes as semantic frame history.
- Run interactive render regressions with `CI=true` before relying on the
  GitHub Actions matrix.

## Current Evidence

The approval argument pager, InputBox reverse search/file suggestions, and
Skills detail/back tests pass 29/29 with `CI=true` after final-frame ownership
was made explicit. Connect and Project Trust dialog tests additionally pass
14/14 with `CI=true` after enabling interactive writes and asserting the latest
OAuth frame. No product component changed.

## Related

- Coverage: [../coverage/tui-rendering.md](../coverage/tui-rendering.md)
- Route: [../routes/release-gates.md](../routes/release-gates.md)
