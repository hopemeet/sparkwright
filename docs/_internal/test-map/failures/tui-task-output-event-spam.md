# TUI Task Output Event Spam

## Record

- Pattern ID: `tui-task-output-event-spam`
- Status: `fixed`
- First seen: 2026-06-29
- Last seen: 2026-06-30
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

When a foreground shell is promoted into a background task, TUI committed
scrollback can render one raw fallback row per `task.output` event:

```text
[ 34] task.output
[ 35] task.output
...
[ 53] task.output
```

This consumes a large part of the viewport while hiding the actual output text.
The later `task(action="get")` / `task(action="output")` results also render as
wide raw JSON summaries instead of concise task status/output summaries.

Observed in `session_tui_mqzcyu61` with promoted task
`task_mqzd1c1b30yc24hj`: the runtime produced 20 `task.output` chunks and
completed successfully, but the TUI transcript was noisy and hard to scan.

## Root Cause

`packages/tui/src/components/event-stream.tsx` has no typed rendering path for
`task.started`, `task.output`, or `task.completed`, so `task.output` falls
through to the generic lossless event row. `packages/tui/src/lib/tool-display.ts`
also lacks a task-specific result summary, so `task` tool results fall back to
generic one-line JSON.

This is distinct from background-task runtime correctness: trace verify and
session check passed.

Fixed 2026-06-30 by adding typed TUI task lifecycle rendering, suppressing raw
`task.output` committed rows, adding an Activity Drawer Tasks view backed by
`lib/task-activity.ts`, summarizing `task` tool outputs in `tool-display.ts`,
and changing promoted shell summaries from `shell exit null` to
`shell promoted -> <taskId>`.

## Diagnostic Move

For a TUI session with a promoted shell task:

```bash
node packages/cli/dist/index.js trace summary "$trace" --format text
node packages/cli/dist/index.js trace verify "$trace" --format text
node packages/cli/dist/index.js session check "$session" --workspace "$workspace" --format text
rg -n '"type":"task.output"' "$trace"
```

If the trace has many successful `task.output` events and the screenshot shows
one generic row per chunk, this pattern reproduced.

## Prevention

Add typed TUI presentation for background task lifecycle:

- render `task.started` as a compact "task started" row with task id/title;
- suppress raw `task.output` rows from committed scrollback and browse output
  head/tail in the Activity Drawer instead of one row per chunk;
- render `task.completed` / `task.failed` as terminal task rows with exit/status
  and output count;
- add task-specific `task get` / `task output` result summaries in
  `tool-display.ts`.

Regression coverage:

```bash
npm --workspace @sparkwright/tui test -- test/event-stream-render.test.ts test/status-bar-render.test.tsx test/input-footer.test.ts test/tool-request-preview.test.ts test/activity-panel-render.test.tsx
npm --workspace @sparkwright/tui test
npm --workspace @sparkwright/tui run typecheck
```

## Related

- Coverage: [../coverage/tui-rendering.md](../coverage/tui-rendering.md)
- Run/session: `session_tui_mqzcyu61`
