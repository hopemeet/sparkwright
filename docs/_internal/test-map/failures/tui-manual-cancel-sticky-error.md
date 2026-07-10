# TUI Manual Cancel Sticky Error

## Record

- Pattern ID: `tui-manual-cancel-sticky-error`
- Status: `fixed`
- First seen: 2026-06-30
- Last seen: 2026-06-30
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

After pressing Ctrl+C to interrupt a TUI run, the screen can show:

```text
✗ run failed (+3 queued)
manual_cancelled
```

The `manual_cancelled` error then remains visible across later turns, making a
user-initiated cancel look like a runtime failure and making queued prompts look
as if they are still attached to the failed run.

## Root Cause

TUI treated all `run.completed` events with `state: "cancelled"` as errors.
Sticky error toasts and `EventStore.lastError` were not cleared when a later
run moved back to `running` or `done`, and queued prompt draining continued
after manual cancellation.

Fixed 2026-06-30 by handling `manual_cancelled` / `user_cancelled` as non-error
terminal states in `RunController`, clearing stale errors when active status
changes, dismissing sticky error toasts before showing the cancel info toast,
and pausing queued prompt auto-drain after a manual cancel.

## Diagnostic Move

Inspect the TUI state transition around the terminal event:

```bash
node packages/cli/dist/index.js trace events "$trace" --type run.completed --jsonl
```

If `run.completed.payload.state` is `cancelled` with
`stopReason: "manual_cancelled"` or `"user_cancelled"`, the TUI should render a
cancel/info state, not a failed/error state.

## Prevention

Regression coverage:

```bash
npm --workspace @sparkwright/tui test -- test/event-store-active-phase.test.ts test/toast-store.test.ts
npm --workspace @sparkwright/tui run typecheck
```

## Related

- Coverage: [../coverage/tui-rendering.md](../coverage/tui-rendering.md)
