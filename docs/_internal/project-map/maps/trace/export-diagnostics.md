# Export Diagnostics

## Purpose

Clarify the difference between trace diagnostics and TUI human transcript export.

This is a high-risk confusion point: `/export` is useful, but it is not the
canonical trace or a session consistency report.

## Last Verified

- Status: Read-only
- Date: 2026-08-02
- Scope: removed Skill proposal/learning presentation and pending human-action
  state from TUI. Canonical transcript export, Activity events, and raw trace
  diagnostics are unchanged.
- Read: TUI App/layer/EventStore/transcript cleanup and export ownership.
- Tests: focused TUI event/transcript rendering and typecheck passed.

- Status: Verified
- Date: 2026-07-30
- Scope: detailed transcripts no longer repeat a tool's compact result preview
  beside its full result section, or repeat a one-line parameter/command
  already present in the tool header. Child approval results appear through the
  parent action receipt in live mode and the raw approval block in replay,
  exactly once in either path.
- Read: TUI transcript presentation/document/layout and Agent action receipts.
- Tests: focused generic-tool, `skill_load`, and live/replay approval tests.

- Status: Verified
- Date: 2026-07-30
- Scope: live and exported product transcripts now correlate approval request
  and resolution events by exact run-scoped approval id. Each request row owns
  its final status and operation label; matched standalone resolution rows and
  the redundant terminal approval count were removed. Raw Trace remains
  append-only, the trace timeline keeps its existing approval phase
  correlation, and diagnostic approval counts in Activity Run and trace
  summary/report are unchanged.
- Read: conversation approval projection, live TranscriptDocument,
  `renderTranscript()`, Activity Events/Run/Trace views, and Core trace
  timeline/summary correlation.
- Tests: focused live/document/export regressions 79/79, full TUI 540/540,
  TUI typecheck and build, plus retained-session PTY compact/detailed replay
  passed.

- Status: Verified
- Date: 2026-07-26
- Scope: compact/detailed rendering now shares an epoch-scoped
  `TranscriptDocument`, but Markdown export deliberately remains outside that
  UI pipeline. `/export` reads `RunController.currentSessionEvents` and calls
  `renderTranscript()` without a viewport mode; `/clear` only resets the
  EventStore document epoch and visible rows. The exported path returns as a
  `tui.export.completed` semantic block in the owned viewport. Projection and
  layout caps never delete controller events or canonical trace data.
- Read: RunController export buffer, EventStore clear/reset, transcript
  document/layout, viewport compatibility renderer, and export tests.
- Tests: compact-vs-detailed export parity and export-after-`/clear`
  integration passed; compact rendering characterization remains 39/39.

- Status: Verified
- Date: 2026-07-25
- Scope: the Ctrl+T detailed transcript is an EventStore-backed TUI
  presentation only. Compact/detailed UI state is not passed to
  `renderTranscript()`; `/export` continues to use `currentSessionEvents` and
  the existing product-transcript projection regardless of the visible mode.
  Protocol and replay paths now suppress every `model.stream.*` variant, while
  Activity/Trace retain raw stream and child usage diagnostics.
- Read: TUI EventStream/detail projection/layer integration, RunController
  export path, and transcript renderer/tests.
- Tests: Protocol 6/6, TUI 482/482, focused projection/SDK replay coverage,
  real live/replay PTY checks, and session check with 0 findings.

- Status: Verified
- Date: 2026-07-24
- Scope: diagnostics now receive structured child status, ChangeSets,
  verification receipts, ToolEffects, approval principals, and immutable
  completion notices. Product export remains a projection and does not infer
  finality or verification from model prose.
- Read: Core trace/fact/completion paths, Protocol visibility, CLI/TUI
  projections.
- Tests: focused Core trace-adjacent and TUI projection tests, repository build,
  and repository test typecheck passed.

- Status: Verified
- Date: 2026-07-23
- Scope: TUI `task.updated` consumption feeds Activity and local
  NotificationStore only. It is not appended to EventStore, Trace, or Markdown
  export; `task.list` supplies reconnect truth and `task.output` supplies
  details.
- Read: RunController lifecycle listener, task action hook, EventStore/export
  boundaries, and notification history.
- Tests: controller isolation, task action/render regressions, full TUI
  464/464, and TUI typecheck passed.

- Status: Verified
- Date: 2026-07-21
- Scope: live conversation and `/export` share conditional quiet-success
  projection for batch wrappers, successful approvals, Skill body/resources,
  tool-search/Todo plumbing, and successful MCP preparation. Failures, denials,
  and real subagent lifecycle remain visible. Raw `model.completed` stays in
  Trace; only `run.completed.message` owns the accepted final answer.
- Read: TUI projection/EventStream/export, Protocol visibility, Activity/raw
  Trace consumers, and real PTY trace evidence.
- Tests: focused live/export/Activity tests and real 120x32 Terra trace/session
  verification passed.

- Status: Verified
- Date: 2026-07-20
- Scope: the shared product-transcript filter now omits
  `agent.profile.derived` preparation diagnostics from both live committed
  conversation and `/export`; Activity and raw trace retain the event, while
  real `subagent.*` lifecycle rows remain visible.
- Read: Protocol internal-transcript filter, TUI EventStream, transcript
  exporter, Activity event formatter, and focused regressions.
- Tests: Protocol 6/6; focused TUI live/export/Activity suites 44/44; full TUI
  449/449; Protocol/TUI typechecks; real Terra PTY and trace/session checks.

- Status: Verified
- Date: 2026-07-19
- Scope: `/notifications` is explicitly TUI-local presentation history and does
  not replace EventStream, `/events`, `trace.jsonl`, session diagnostics, or
  `/export`. Export still commits its copy-friendly path to append-only
  scrollback and reads the same current-session events.
- Read: TUI notification projection, EventStream/run diagnostics, export
  controller/renderer, and session/trace boundaries.
- Tests: full TUI 445/445 and real 80/96/120-column PTY trace/session checks;
  export and trace contracts are unchanged.

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
  -> TranscriptDocument notice block
  -> owned viewport copy-safe path row

session trace.jsonl
  -> summary/timeline/verify/consistency
  -> session diagnostics
```

## Contracts

- TUI `/export` writes Markdown under `.sparkwright/exports/`.
- TUI `/export` uses `currentSessionEvents` in the controller, not `trace.jsonl` directly.
- After a successful `/export`, the TUI appends the exported path as a
  `tui.export.completed` document row. This is a copy-safe UI confirmation;
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
- Compact and detailed viewport modes project the same stable structured Agent
  summary and bounded detail sections from `TranscriptDocument`. `/export`
  reads neither that UI mode nor the bounded layout cache and remains a
  transcript/export surface, not a replacement for `trace report`;
  auditability findings belong in trace diagnostics.
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
- Verify both UI modes produce the same `/export`, and verify `/clear` does not
  clear the controller export buffer.
- If a tool payload needs a special display rule, add it to `lib/tool-display.ts` and cover both live event stream and transcript export expectations.
- If export should include persisted history, confirm it loads from session trace first.
- Keep this separate from `trace verify` and `session check` semantics.

## Known Debts

- `/export` is still a transcript, not the trace report; users needing run health should use `trace report` or session diagnostics.
- Session metadata completion state is less prominent in current product views than raw diagnostics.
- Structured tool outputs are summarized for readability; use `/events`, trace commands, or session diagnostics for full payload inspection.

## Last Verified

- Status: Verified
- Date: 2026-07-19
- Scope: reviewed TUI/export consumers for the assessment migration. Committed
  run facts and Agent lifecycle rows render canonical health/issues; export
  storage, navigation, and raw event ownership are unchanged.
- Read: TUI event stream/store/controller and Core trace diagnostics.
- Tests: focused Ink rendering and Core trace coverage passed.

- Status: Verified
- Date: 2026-07-17T23:37:17+0800
- Scope: TUI removed the `/skill-create` layer wiring; event rendering,
  transcript export, trace diagnostics, and `/export` storage remain unchanged.
- Read: TUI App/layer changes and export/diagnostic ownership boundary.
- Tests: TUI focused 22/22 and TUI typecheck passed.

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
