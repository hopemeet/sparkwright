# 2026-06-30 TUI Background Task Activity Drawer

## Direction

Continue from real TUI background-task smoke `session_tui_mqzcyu61`, where the
runtime correctly promoted a shell to a durable task but the TUI rendered many
generic `task.output` rows and raw task-tool JSON.

## Findings

- Root cause for the noisy screen was TUI presentation, not runtime task
  correctness: `EventStream` lacked typed `task.*` rendering and
  `tool-display.ts` lacked task-specific result summaries.
- Root cause for the first Activity Drawer durable-task smoke failure was an App
  layer prop wiring bug: the normal `LayerRenderer` path did not pass
  `taskRecords`, `taskOutputs`, `loadingTasks`, or task callbacks, so the panel
  always saw an empty task list even though spawned host `task.list` worked.
- `Ctrl+O` is the configurable `activity.open` binding and opens an Activity
  Drawer with `Tasks | Events | Trace | Run` tabs. `events.open` remains
  configurable, but has no default key because Ctrl+I aliases the Tab control
  byte in common PTYs and felt redundant next to the drawer tabs.
- `/events` opens the drawer on Events, `/tasks` opens it on Tasks.
- TUI task browsing now uses host `task.list`/`task.output` snapshot requests,
  not just live trace events.
- Promoted shell results now read `shell promoted -> <taskId>` instead of
  `shell exit null`.
- `task.output` no longer prints one committed scrollback row per chunk.
- Running tasks surface in `StatusBar` with a `ctrl+o` hint and untracked-write
  disclosure when the promoted-shell boundary marker is present.
- `manual_cancelled` / `user_cancelled` are treated as non-error terminal UI
  outcomes; stale sticky error toasts are dismissed and queued prompt draining
  pauses after a manual cancel.

## Files

- `packages/tui/src/components/activity-panel.tsx`
- `packages/tui/src/components/event-stream.tsx`
- `packages/tui/src/components/status-bar.tsx`
- `packages/tui/src/lib/task-activity.ts`
- `packages/tui/src/lib/tool-display.ts`
- `packages/tui/src/lib/tool-request-preview.ts`
- `packages/tui/src/lib/tool-result-summary.ts`
- `packages/tui/src/app.tsx`
- `packages/tui/src/state/layer-stack.ts`
- `packages/tui/src/state/run-controller.ts`
- `packages/tui/src/state/event-store.ts`
- `packages/tui/src/lib/keybindings.ts`
- `packages/protocol/src/index.ts`
- `packages/host/src/runtime.ts`
- `packages/host/src/server.ts`
- `packages/sdk-core/src/client.ts`
- `schemas/host-message.schema.json`

## Verification

```bash
npm --workspace @sparkwright/tui test -- test/activity-panel-render.test.tsx test/status-bar-render.test.tsx test/toast-store.test.ts test/event-store-active-phase.test.ts test/keybindings.test.ts test/input-footer.test.ts
npm --workspace @sparkwright/tui run typecheck
npm --workspace @sparkwright/tui run build
npm --workspace @sparkwright/host test -- test/protocol.test.ts
npm --workspace @sparkwright/host run typecheck
npm --workspace @sparkwright/sdk-core test -- test/client.test.ts
npm run schema:check
```

PTY smoke:

- `Ctrl+O` opened the Activity Drawer on `[tasks]` and displayed durable task
  `task_smoke123456789`, status `completed`, command `node smoke-bg.js`, and
  three tail output lines.
- `/events` remains the direct Events-tab command for users who do not want to
  enter through the Tasks tab.

Result: passed for focused unit/render tests, typecheck/build, protocol
snapshot tests, schema validation, and PTY smoke.

## Follow-up

Run a real model long-running promoted shell after merge to validate the
interactive feel with live output and task stop (`s`) on both narrow and wide
terminal sizes.
