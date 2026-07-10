# TUI Sessions Custom Root Empty Label

## Record

- Pattern ID: `tui-sessions-custom-root-empty-label`
- Status: `fixed`
- First seen: 2026-06-29
- Last seen: 2026-06-29
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

When TUI is launched with a custom `--session-root`, `/sessions` correctly uses
that root for data, but the empty-state text still says
`none found in .sparkwright/sessions`.

## Root Cause

`SessionListDialog` hard-codes `.sparkwright/sessions` in its empty-state copy
instead of receiving the effective session root or using neutral wording.

## Diagnostic Move

Launch TUI with a custom session root and open `/sessions` in a PTY capture.
Compare the command-line `--session-root` with the empty-state path text.

## Prevention

- Pass the effective session root display path into `SessionListDialog`, using
  workspace-relative projection where appropriate.
- Or remove the path from the empty state and say no sessions were found in the
  configured session root.

## Fix

- 2026-06-29: `packages/tui/src/app.tsx` derives a `sessionRootLabel` and passes
  it through `LayerRenderer` to `SessionListDialog`; the default root keeps the
  short `.sparkwright/sessions` label and custom roots show the configured path.
- Added `packages/tui/test/session-list-dialog-render.test.tsx` coverage for a
  custom empty root.
- Verified with `npm --workspace @sparkwright/tui test --
test/session-list-dialog-render.test.tsx test/capabilities-panel-render.test.tsx`,
  `npm --workspace @sparkwright/tui run typecheck`, and
  `npm run build --workspace @sparkwright/tui`.

## Related

- Coverage: [../coverage/tui-rendering.md](../coverage/tui-rendering.md)
- Run notes: [../runs/2026-06-29-real-mini-tool-surface-followup.md](../runs/2026-06-29-real-mini-tool-surface-followup.md)
