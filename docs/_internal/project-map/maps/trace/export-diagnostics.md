# Export Diagnostics

## Purpose

Clarify the difference between trace diagnostics and TUI human transcript export.

This is a high-risk confusion point: `/export` is useful, but it is not the
canonical trace or a session consistency report.

## Main Files

- `packages/tui/src/state/run-controller.ts`
- `packages/tui/src/lib/tool-display.ts`
- `packages/tui/src/lib/transcript.ts`
- `packages/tui/src/app.tsx`
- `packages/host/src/runtime.ts`
- `packages/core/src/trace.ts`

## Data Flow

```txt
TUI currentSessionEvents
  -> renderTranscript()
  -> .sparkwright/exports/session-<id>-<timestamp>.md

exported path returned to TUI
  -> app appends tui.export.completed
  -> EventStream committed scrollback path line

session trace.jsonl
  -> summary/timeline/verify/consistency
  -> session diagnostics
```

## Contracts

- TUI `/export` writes Markdown under `.sparkwright/exports/`.
- TUI `/export` uses `currentSessionEvents` in the controller, not `trace.jsonl` directly.
- After a successful `/export`, the TUI commits the exported path as a
  `tui.export.completed` scrollback row. This is a copy-safe UI confirmation;
  it is not part of the exported Markdown body and does not mutate
  `trace.jsonl`.
- `/sessions` inspect can render compaction audit diagnostics; `/export` does
  not include those diagnostic claims unless a future exporter explicitly reads
  session inspection data.
- The export renderer groups user goal, assistant stream text, tools, writes, approvals, terminal events, and a compact raw-events tail.
- Exported user goals are recovered per run from `run.created`,
  `model.requested`, or `run.started` payloads, in that order, and rendered
  once per run. TUI traces may omit `run.started.payload.goal`.
- Tool result sections may reconstruct the tool name from the earlier `tool.requested` event when terminal tool events only carry `toolCallId`.
- Tool request/result presentation uses the same summary rules as live TUI
  rendering. Tool requests prefer `tool.requested.payload.preview` emitted by
  core from `ToolDefinition.previewArgs()`, then fall back to legacy name-based
  formatting for older traces; export mode still summarizes structured result
  envelopes instead of dumping raw JSON.
- Background task tool envelopes (`task list/get/output/stop`) are summarized by
  the shared TUI tool-display path, so live rendering and `/export` avoid raw
  task JSON for common task inspection output. Raw task lifecycle/output events
  remain trace facts; the Activity Drawer is the live browsing surface.
- Live `EventStream` renders `subagent.*` rows as a depth-aware tree from
  structured facts. `/export` remains a transcript/export surface, not a
  replacement for `trace report`; auditability findings belong in trace
  diagnostics.
- Unknown events are listed compactly so the export is not fully silent about unsupported events.
- Internal/low-signal runtime machinery is filtered through
  `isInternalTranscriptEvent()` shared with live event rendering. The TUI
  wrapper delegates to protocol `isInternalTranscriptEventType()`; add new
  internal event names there instead of duplicating switch cases in transcript
  or live rendering.
- Trace diagnostics remain source-of-truth for structural checks.

## Consumers

- TUI users sharing or reviewing a conversation.
- Maintainers comparing product transcript UX against trace diagnostics.

## Change Checklist

- Do not add diagnostic claims to `/export` unless backed by trace/session inspection.
- If `renderTranscript()` supports a new event family, check event-store replay and session switch behavior.
- If a tool payload needs a special display rule, add it to `lib/tool-display.ts` and cover both live event stream and transcript export expectations.
- If export should include persisted history, confirm it loads from session trace first.
- Keep this separate from `trace verify` and `session check` semantics.

## Known Debts

- `/export` is still a transcript, not the trace report; users needing run health should use `trace report` or session diagnostics.
- Session metadata completion state is less prominent in current product views than raw diagnostics.
- Structured tool outputs are summarized for readability; use `/events`, trace commands, or session diagnostics for full payload inspection.

## Last Verified

- Status: Verified
- Date: 2026-07-16T13:36:30+0800
- Scope: TUI/export no longer projects a validation-hook active phase; durable `validation.failed` evidence remains available in raw trace and diagnostics.
- Read: TUI event store/export paths, Core trace vocabulary, and current trace documentation.
- Tests: focused TUI/trace tests; npm run build; npm run typecheck:test; npm run release:check.

- Date: 2026-07-16T12:45:00+0800
- Scope: TUI diagnostics display canonical access mode and no longer expose compiled permission/write fields.
- Read: routed production sources, focused tests, protocol/config schemas, and current user/reference documentation.
- Tests: focused access/policy/protocol/CLI/TUI/ACP/Workflow tests; npm run typecheck:test; npm run schema:check.

- Status: Verified
- Date: 2026-07-16T11:49:00+0800
- Scope: TUI transcript export renders terminal failures through the canonical
  protocol `failure` envelope; the root-error fallback was removed. Raw Core
  trace remains a separate diagnostic contract.

- Status: Read-only
- Date: 2026-07-15T23:53:45+0800
- Scope: route check for TUI input P0-P2 work. App/input/keybinding changes,
  InputBox hook extraction, LiveFrame extraction, hidden help command discovery,
  slash command frecency, and removal of the dead standalone events layer do
  not change `/export`, transcript rendering, TUI event replay, or trace
  diagnostic boundaries.
- Read: `packages/tui/src/app.tsx`,
  `packages/tui/src/components/input-box.tsx`,
  `packages/tui/src/components/use-input-buffer.ts`,
  `packages/tui/src/components/use-input-history.ts`,
  `packages/tui/src/components/live-frame.tsx`,
  `packages/tui/src/components/help-panel.tsx`,
  `packages/tui/src/lib/commands.ts`,
  `packages/tui/src/lib/keybindings.ts`,
  `packages/tui/src/lib/event-inspector.ts`,
  `packages/tui/src/components/activity-panel.tsx`,
  `docs/_internal/project-map/maps/trace/export-diagnostics.md`.
- Tests: `npm --workspace @sparkwright/tui test`;
  `npm --workspace @sparkwright/tui run typecheck`;
  `npm run typecheck:test`; final `npm run release:check`. No export contract
  change was made.

- Status: Read-only
- Date: 2026-07-06T20:12:52+0800
- Scope: C10 route check for TUI `/skill-learn` target-detector deletion.
  Transcript export rendering, event-store replay, tool display, and trace
  diagnostic boundaries are unchanged.
- Read: `packages/tui/src/app.tsx`,
  `packages/tui/test/skill-evolution.test.tsx`,
  `packages/tui/src/lib/transcript.ts`, `docs/reference/SKILLS.md`.
- Tests: `npm --workspace @sparkwright/tui test --
test/skill-evolution.test.tsx`; `npm --workspace @sparkwright/tui run
typecheck`; `npm --workspace @sparkwright/tui run build`; `npm run
release:check`.

- Status: Verified
- Date: 2026-06-30T01:07:00+0800
- Scope: checked after durable task browsing moved behind host `task.*`
  snapshot requests and Activity Drawer presentation; `/export` remains a
  human transcript over TUI events, not a trace diagnostic source of truth or a
  full task-output browser.
- Read: `packages/tui/src/components/activity-panel.tsx`,
  `packages/tui/src/components/event-stream.tsx`,
  `packages/tui/src/state/run-controller.ts`,
  `packages/tui/src/lib/task-activity.ts`,
  `packages/tui/src/lib/tool-display.ts`,
  `packages/tui/src/lib/tool-request-preview.ts`,
  `packages/tui/src/lib/tool-result-summary.ts`,
  `packages/tui/src/lib/transcript.ts`,
  `docs/_internal/project-map/maps/trace/export-diagnostics.md`.
- Tests: `npm --workspace @sparkwright/tui test --
test/activity-panel-render.test.tsx`; `npm --workspace @sparkwright/tui run
typecheck`.

- Status: Verified
- Date: 2026-06-29T23:05:00+0800
- Scope: checked transcript export goal recovery after a TUI PTY export showed
  `run.started` without `goal`; renderer now uses run creation/current-request
  goal evidence and avoids duplicate user sections.
- Read: `packages/tui/src/lib/transcript.ts`,
  `packages/tui/test/transcript.test.ts`,
  `docs/_internal/project-map/maps/trace/export-diagnostics.md`.
- Tests: `npm --workspace @sparkwright/tui test -- test/transcript.test.ts`;
  `npm --workspace @sparkwright/tui run typecheck`.

- Status: Verified
- Date: 2026-06-29T09:28:39+0800
- Scope: checked after TUI event/capability display updates; export remains a
  human transcript and not a trace diagnostic source of truth.
- Read: `packages/tui/src/components/event-stream.tsx`,
  `packages/tui/src/lib/tool-display.ts`,
  `packages/tui/src/components/capabilities-panel.tsx`,
  `docs/_internal/project-map/maps/trace/export-diagnostics.md`.
- Tests: `npm --workspace @sparkwright/tui test -- test/capabilities-panel-render.test.tsx test/tool-request-preview.test.ts test/format-event.test.ts`.

- Status: Verified
- Date: 2026-06-26T23:59:00+0800
- Scope: checked TUI access-mode/config-panel changes; export diagnostics flow
  is unchanged.
- Read: `packages/tui/src/components/event-stream.tsx`,
  `packages/tui/src/app.tsx`,
  `packages/tui/src/state/event-store.ts`,
  `packages/tui/src/state/run-controller.ts`,
  `packages/tui/src/components/config-panel.tsx`,
  `packages/tui/src/lib/transcript.ts`,
  `packages/tui/test/event-stream-render.test.ts`,
  `packages/tui/test/transcript.test.ts`, `packages/core/src/tools.ts`,
  `packages/core/src/run.ts`.
- Tests: `npm --workspace @sparkwright/tui test -- test/config.test.ts test/permission.test.ts test/sdk-cutover.test.ts`;
  `npm --workspace @sparkwright/tui run typecheck`; `npm run build`;
  `npm run check:dist-fresh`.
