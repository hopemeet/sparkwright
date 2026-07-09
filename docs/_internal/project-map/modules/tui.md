# TUI

## Purpose

`@sparkwright/tui` is the terminal product surface. It drives host runs,
renders live events, browses/resumes sessions, handles approvals, and exports a
human-readable transcript.

See also [../maps/trace/export-diagnostics.md](../maps/trace/export-diagnostics.md) and [../maps/session/resume-replay.md](../maps/session/resume-replay.md).

## Main Files

- `packages/tui/src/app.tsx`
- `packages/tui/src/components/input-box.tsx`
- `packages/tui/src/components/use-input-buffer.ts`
- `packages/tui/src/components/use-input-history.ts`
- `packages/tui/src/components/live-frame.tsx`
- `packages/tui/src/components/activity-panel.tsx`
- `packages/tui/src/components/event-stream.tsx`
- `packages/tui/src/components/help-panel.tsx`
- `packages/tui/src/components/status-bar.tsx`
- `packages/tui/src/state/run-controller.ts`
- `packages/tui/src/state/event-store.ts`
- `packages/tui/src/lib/commands.ts`
- `packages/tui/src/lib/task-activity.ts`
- `packages/tui/src/lib/tool-display.ts`
- `packages/tui/src/lib/event-type.ts`
- `packages/tui/src/lib/transcript.ts`
- `packages/tui/src/lib/session-events.ts`
- `packages/tui/src/lib/config.ts`
- `packages/tui/src/lib/permission.ts`
- `packages/tui/src/lib/keybindings.ts`
- `packages/tui/src/lib/create-capability.ts`
- `packages/tui/test/*`

## Owns / Does Not Own

Owns:

- terminal UI state and input handling
- live host client lifecycle through `RunController`
- in-memory event store used for rendering and `/export`
- session list, inspect, switch, fork, compact, and rename flows

Does not own:

- canonical trace persistence
- session store file layout
- trace diagnostic report generation
- core approval semantics

## Contracts

- `RunController` sends `run.start` with the current `sessionId`.
- TUI presents one runtime permission axis (`read-only`, `ask`, `accept-edits`,
  `bypass`) but no longer owns a persisted `ui.tuiPermissionMode` config field.
  File config uses shared `run.accessMode`; project `run.accessMode` becomes an
  access ceiling that clamps CLI/TUI runtime requests. Default `ask` runs send
  `accessMode: ask` at the host request boundary, and the host compiles it to
  `permissionMode: default`, `shouldWrite: true` so writes use the normal
  approval path and write guardrails.
- TUI no longer uses standalone `approveAll`/`approveEdits`/`approveShellSafe`
  or config `approvals.*` as independent approval scopes. Approval auto-response
  is still derived from the projected core `permissionMode` so `bypass` and
  `accept-edits` preserve their mode semantics. `RunController` snapshots this
  projected permission mode at run start, so runtime mode switches affect the
  next run without changing auto-approval behavior for the active run.
- TUI config compatibility accepts the shared `confidentialDefaults` config key
  but does not own a separate UI surface for read-confidentiality defaults; host
  config/runtime own validation and enforcement.
- `shift+tab` (`cycle-permission-mode`) cycles the runtime permission mode in
  read-only -> ask -> accept-edits -> bypass order, skipping modes above the
  project access ceiling. The switch is runtime-local, updates the
  `RunController` for the next run, appends a scrollback notice, and leaves
  config files untouched. `/config` shows the runtime source while the override
  is active.
- `/image <path>` attaches a local image to the next submitted goal through
  `run.start.input.parts`; `/clear-images` clears pending attachments before
  submission. TUI keeps async file IO and user-facing errors local, while host
  client input helpers own image MIME detection, size limits, base64 part
  construction, and attachment metadata shared with CLI.
- `switchSession()` reloads persisted events from session trace and replays them into TUI state.
- `/compact` calls host `session.compact`; success toasts use
  `compactedRunCount`/char savings, while skipped outcomes surface
  `skippedReason` and the first warning message instead of assuming zero runs
  always means "no completed turns".
- `/sessions` inspect requests host `session.inspect` with `compaction: true`
  and renders the returned compaction audit when present. This is a diagnostics
  view over session artifacts/events and does not affect `/export`.
- `/export` writes Markdown under `.sparkwright/exports/`.
- `/export` success also appends a TUI-local `tui.export.completed` row to
  committed scrollback so the exported path has a permanent, border-free copy
  target; the success toast remains only a transient status cue.
- `/export` does not mutate or replace `trace.jsonl`.
- `/export` recovers the submitted user goal per run from `run.created`,
  `model.requested`, or `run.started` payloads, in that order, and renders one
  user section per run. TUI traces may omit `run.started.payload.goal`.
- `/export` reconstructs trace-shaped tool sections from `tool.requested`/`tool.completed` pairs when needed.
- Live event rendering and `/export` share TUI tool request/result display
  summaries through `lib/tool-display.ts`. For tool requests they first consume
  `tool.requested.payload.preview` produced by the tool definition; the local
  name-based formatter is fallback for older traces.
- Ctrl+O uses the `activity.open` binding and opens the Activity Drawer on the
  Tasks tab by default. `events.open` remains a configurable action with no
  default binding; `/events` and `events.open` both open the Activity Drawer on
  the Events tab. There is no separate standalone events layer. In common PTYs
  Ctrl+I arrives as the Tab control byte, so it is not used as a default.
- App-level global hotkeys defer unmodified printable-character bindings to the
  input editor while a prompt draft is non-empty. This keeps `?` available as
  empty-prompt help while allowing normal questions ending in `?`; `/help`
  remains the command path.
- Prompt drafts are mirrored in App memory while `InputBox` is mounted, so
  opening and closing layers preserves short and fast-typed drafts without
  relying on the persisted stash debounce. The persisted stash remains the
  process-restart recovery path.
- `InputBox` keeps buffer/draft persistence in `use-input-buffer.ts` and
  prompt history plus Ctrl+R reverse-search in `use-input-history.ts`; the
  component body owns key routing and rendering, not stash/history storage.
- Slash command suggestions use `CommandRegistry.search(query, frecencyScores)`.
  Frecency only breaks ties within the same match class and uses
  `command:<name>` keys so command picks do not collide with @file picks. Empty
  slash suggestions still hide `hiddenByDefault` commands.
- The help panel lists visible commands by category and then exposes
  `hiddenByDefault` commands under a `more commands` section, so advanced
  capability entrypoints remain discoverable without crowding the empty slash
  picker.
- Plain Esc run cancellation is owned by the input editor when `cancel.run`
  includes an unmodified `esc`; App-level cancel handling covers non-Esc
  configured chords so the default Esc path does not double-dispatch.
- The Activity Drawer derives background task state from live TUI events and
  durable host snapshots via `RunController` `task.list` / `task.output`
  requests. `lib/task-activity.ts` merges those presentation inputs; canonical
  task storage remains host-owned. The Tasks tab defaults durable snapshot
  reads to the current session's run ids (`parentRunId` filters); it does not
  expose workspace-wide historical tasks in the session activity view.
- Activity task presentation preserves `awaited` versus detached/background
  state from live events and durable snapshots. The panel can render on-demand
  join/promote actions for host-backed callers; these callbacks call
  host-facing `task.join` / `task.promote` controls, while task state remains
  host/protocol-owned.
- The Activity Drawer task details view is a bounded output browser: task
  selection uses arrow keys / `j` / `k`, output mode uses `f` / `H` / `T`, and
  long head/tail output can be paged with PgUp/PgDn or nudged with `[` / `]`.
- Live `EventStream` renders `task.started` / terminal `task.*` events as
  compact lifecycle rows, suppresses raw `task.output` rows from committed
  scrollback, and leaves task output browsing to the Activity Drawer. The
  `task` tool result formatter summarizes task list/get/output/stop envelopes
  instead of dumping raw JSON.
- `StatusBar` surfaces currently running background tasks with a Ctrl+O hint
  and an "untracked writes possible" disclosure when the promoted-shell boundary
  marker is present.
- Live event rendering and `/export` also share `isInternalTranscriptEvent()`
  from `lib/event-type.ts`; that wrapper delegates to protocol
  `isInternalTranscriptEventType()` so low-signal runtime machinery stays
  filtered consistently across the TUI event stream, exported transcript raw
  tail, and other clients that use the shared protocol list. This includes both
  `run.budget.checked` and forced-continuation `run.budget.exceeded`.
- Live event formatting treats `capability.index.failed` payloads with
  `severity: "warning"` as yellow warning rows and includes kind/code/profile
  details, so run-time agent profile collision diagnostics are visible without
  opening a raw trace.
- Live event formatting treats `agent.routing.evaluated` as a compact
  sort-only routing diagnostic (`sort`, relevant count, low count). The
  capabilities panel displays delegate routing summaries as `relevant`, `low`,
  or `triggers` labels from the host snapshot without inferring tool hiding or
  permission changes.
- `RunController`, live `EventStream`, transcript export, and the run inspector
  use protocol `runFailureMessage()` for terminal failure text. A failed
  `run.completed` sets store error text from the same helper instead of only
  flipping status to `error`.
- Live `EventStream` renders `subagent.*` lifecycle rows from structured
  metadata/payload facts (`subagentDepth`, parent/child ids, `entrypoint`,
  `delegateTool`, and terminal state fields). It indents by depth but keeps the
  append-only `<Static>` row contract: each event renders once and is not
  mutated after later child events arrive. Display names prefer `agentName`,
  then `childAgentId` / `agentProfileId`, before falling back to parent
  `agentId`, so UI labels do not confuse the parent actor with the child.
- Ctrl+C is guarded: one press cancels or backs out of the current surface, and
  an idle no-layer prompt requires a second press to exit. User/manual cancels
  (`manual_cancelled` / `user_cancelled`) are terminal non-error outcomes in
  TUI state, dismiss stale sticky error toasts, and pause queued prompt draining
  until the user submits again.
- Long `/sessions` lists keep the selected row visible while navigating; row
  windows are presentation state and do not affect session storage order.
- TUI UI preferences are read from the same config files the host loaded
  (`config.json`, `config.yaml`, or `config.yml`), so same-layer conflict and
  format precedence stays host-owned.
- TUI capability creation flows use host config read/write helpers and preserve
  an existing project YAML file when adding MCP servers or agent profiles.
- TUI cron capability creation routes through `@sparkwright/cron`
  `CronCommandService`, preserving the shared cron validation and state command
  behavior used by CLI and model tools. If unique-name storage auto-suffixes a
  duplicate cron name, the create result message includes the actual created
  name and the originally requested name.
- TUI-created stdio MCP server configs omit `cwd` by default so the MCP adapter
  can apply neutral-cwd isolation; project cwd access requires an explicit
  later config edit.
- The capabilities panel treats the built-in primary `main` profile as the
  current run's root agent, not as a configured user agent; it is excluded from
  the displayed configured-agent count and list.
- The capabilities panel consumes `CapabilitySnapshot.model.pricing` from the
  host snapshot and surfaces `missing_pricing` as an overview warning; it does
  not infer model cost availability from trace usage events.
- The capabilities panel consumes host `CapabilitySnapshot.rules.workflow` and
  displays workflow rule source, lifecycle, active status, blocking potential,
  matcher/action summaries, and configuration hints. It does not infer workflow
  hooks from local config.
- `RunController.inspectCapabilities()` sends the current session id and
  request-sourced active model to host `capability.inspect`, so the
  `/capabilities` model line agrees with the runtime model indicator
  (`StatusBar` and model-switch notices) under `--model` or `/model`
  overrides. Config-sourced model values are omitted as request overrides
  because the spawned host already loads the same config.
- Header and config-panel workspace paths use middle ellipsis when terminal
  width is tight, preserving the basename so deep workspaces stay identifiable
  without wrapping the first screen.
- The static SparkWright brand/cwd/session/model header belongs to committed
  `EventStream` scrollback as one-time starting context. Runtime `/model`
  switches and permission-mode switches append a TUI-local notice row and
  update the pinned `StatusBar`; the status bar must not repeat the brand, cwd,
  or session and only shows changing run state, active-run details, model, and
  the TUI permission mode.
- The live frame below `StatusBar` derives a single `activePhase` from open
  model/tool/subagent/validation lifecycle events. Streamed assistant text takes
  precedence over the phase hint; the phase projection is TUI state only and
  does not change transcript filtering or raw trace semantics.
- `components/live-frame.tsx` owns the pinned live surface below committed
  scrollback: status bar, streaming answer, modified-file sidebar, todo band,
  usage/error/toast/config-error rows, and queued prompt display. `app.tsx`
  keeps run/session/layer orchestration and input ownership.
- Capability panels, Skill review metadata, and Skill learn toasts render host
  paths through the shared display-path projection: workspace paths become
  relative and external absolute paths collapse to non-host locators.
- TUI automatic `/skill-learn` drafts use the conservative notice evidence and
  active session id only; they no longer infer a target Skill name from prompt
  text before calling the proposal helper. Named Skill updates stay on explicit
  `/skill-update` / review flows.
- `ApprovalPrompt` displays the policy reason when the approval payload does
  not carry a separate human reason, so write-gate escalation explains why the
  user is being asked.

## Consumers

- End users running `sparkwright tui`.
- TUI rendering and state tests.
- Host protocol responses and event streams.

## Change Checklist

- Check `RunController` when changing host protocol requests/responses.
- Check `renderTranscript()` when changing event names or exported Markdown expectations.
- Check `lib/tool-display.ts` when changing tool request/result presentation in either live TUI or `/export`.
- Check session list/inspect/fork flows when changing session diagnostics.
- Avoid treating TUI state as canonical storage.

## Known Debts

- Human export is useful but not a full diagnostic report.
- Session completion metadata is not as prominent as trace/session inspection output.
- TUI display summaries are presentation-only; raw trace/session diagnostics remain the source of truth for complete payloads.

## Last Verified

- Status: Verified
- Date: 2026-07-09T21:10:00+0800
- Scope: Workflow Job Session Stage A added read-only `/workflow list` and
  `/workflow attach <id>` TUI surfaces through `useWorkflowActions`, command
  registry injection, a workflow snapshot panel, and a status-bar waiting badge.
  TUI remains a presentation client over host `workflow.list`; it does not own
  workflow durable state or stop/resume semantics.
- Read: `packages/tui/src/app.tsx`,
  `packages/tui/src/state/build-command-registry.ts`,
  `packages/tui/src/state/run-controller.ts`,
  `packages/tui/src/state/use-workflow-actions.ts`,
  `packages/tui/src/components/workflow-panel.tsx`,
  `packages/tui/src/components/status-bar.tsx`,
  `packages/tui/src/components/live-frame.tsx`,
  `packages/tui/src/components/layer-renderer.tsx`,
  `packages/tui/src/lib/workflow-display.ts`.
- Tests: `npm --workspace @sparkwright/tui test --
  test/workflow-display.test.ts`; `npm --workspace @sparkwright/tui run
  typecheck`; PTY/pyte probes for empty workflow list and CLI-created waiting
  workflow list/attach.

- Status: Verified
- Date: 2026-07-09T10:08:47+0800
- Scope: TUI input P0-P2 sequence: printable single-character global hotkeys
  yield to non-empty prompt drafts, short drafts survive layer unmount/remount,
  default Esc run cancellation no longer double-dispatches, the dead standalone
  `events` layer is gone, InputBox buffer/history logic moved into focused
  hooks, App live-frame rendering moved into `components/live-frame.tsx`, help
  exposes hidden commands, and slash suggestions use command frecency
  tie-breaking.
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
  `packages/tui/src/components/layer-renderer.tsx`,
  `packages/tui/src/state/layer-stack.ts`,
  `docs/_internal/project-map/maps/trace/export-diagnostics.md`,
  `docs/_internal/project-map/maps/session/resume-replay.md`.
- Tests: focused phase checks with `npm --workspace @sparkwright/tui test --
  test/input-box.test.ts test/keybindings.test.ts`; P2 focused checks with
  `npm --workspace @sparkwright/tui test -- test/input-box.test.ts
  test/keybindings.test.ts test/commands.test.ts
  test/help-panel-render.test.tsx test/frecency.test.ts
  test/files-frecency.test.ts`; `npm --workspace @sparkwright/tui run
  typecheck`; final `npm run release:check`.

- Status: Read-only
- Date: 2026-07-06T20:47:10+0800
- Scope: C13-② TUI routed-page check: `packages/tui/src/lib/config.ts` now
  tolerates the shared `confidentialDefaults` config key. No run-controller,
  approval, or UI contract changed.
- Read: `packages/tui/src/lib/config.ts`,
  `packages/host/src/config-zod-schema.ts`, `packages/host/src/config.ts`.
- Tests: not run for TUI; C13 focused validation ran in core/host/CLI/protocol.

- Status: Verified
- Date: 2026-07-06T19:48:49+0800
- Scope: C10 deleted the TUI `detectSkillLearnTarget` automatic target guesser;
  `/skill-learn` draft/apply automation now writes only the session-learning
  proposal path unless an explicit caller supplies a target.
- Read: `packages/tui/src/app.tsx`, `packages/tui/src/lib/skill-learn.ts`,
  `packages/tui/test/skill-evolution.test.ts`,
  `docs/_internal/project-map/modules/tui.md`.
- Tests: `npm --workspace @sparkwright/tui test --
  test/skill-evolution.test.ts`.

- Status: Read-only
- Date: 2026-07-06T19:24:51+0800
- Scope: C9 S1 cron persistence migration changed `CronStore.save()` only.
  TUI cron capability creation, session replay, activity rendering, and
  permission-mode UI behavior are unchanged.
- Read: `packages/cron/src/store.ts`,
  `docs/_internal/project-map/maps/capabilities/cron.md`,
  `docs/_internal/project-map/modules/tui.md`.
- Tests: cron storage/schedule-focused `npm --workspace @sparkwright/cron test
  -- test/schedule.test.ts`; TUI-specific tests not rerun for this persistence
  implementation-only change.

- Status: Verified
- Date: 2026-07-04T12:43:33+0800
- Scope: workflow-runtime-v1 S3 transcript filtering: TUI event stream and
  transcript export hide `run.budget.exceeded` using the shared protocol
  internal-event list.
- Read: `packages/protocol/src/index.ts`,
  `packages/tui/test/transcript.test.ts`,
  `packages/tui/test/event-stream-render.test.ts`,
  `packages/tui/src/lib/event-type.ts`.
- Tests: `npm --workspace @sparkwright/tui test -- test/transcript.test.ts
  test/event-stream-render.test.ts -t "budget|internal run machinery"`.

- Status: Verified
- Date: 2026-07-02T10:05:00+0800
- Scope: Activity Drawer join/promote callbacks now call host-facing
  `task.join`/`task.promote` through `RunController`, with refresh/toast
  feedback after each control.
- Read: `packages/tui/src/app.tsx`,
  `packages/tui/src/state/run-controller.ts`,
  `packages/tui/src/components/activity-panel.tsx`,
  `packages/tui/src/components/layer-renderer.tsx`.
- Tests: `npm --workspace @sparkwright/tui run typecheck`.

- Status: Verified
- Date: 2026-07-02T01:15:00+0800
- Scope: Activity Drawer task state now projects awaited/detached status and
  renders optional on-demand join/promote controls while keeping canonical task
  storage in host snapshots/events.
- Read: `packages/tui/src/components/activity-panel.tsx`,
  `packages/tui/src/components/layer-renderer.tsx`,
  `packages/tui/src/lib/task-activity.ts`,
  `packages/tui/test/activity-panel-render.test.tsx`.
- Tests: `npm --workspace @sparkwright/tui test --
  test/activity-panel-render.test.tsx`;
  `npm --workspace @sparkwright/tui run typecheck`;
  `npm run build --workspace @sparkwright/tui`.

- Status: Verified
- Date: 2026-06-30T09:30:00+0800
- Scope: Activity Drawer task redesign: Tasks tab durable snapshots are scoped
  to current-session run ids only, adds details output paging/nudging, and
  avoids misleading task get chunk previews.
- Read: `packages/tui/src/app.tsx`,
  `packages/tui/src/components/activity-panel.tsx`,
  `packages/tui/src/components/layer-renderer.tsx`,
  `packages/tui/src/lib/task-activity.ts`,
  `packages/tui/src/lib/tool-request-preview.ts`,
  `packages/tui/test/activity-panel-render.test.tsx`,
  `packages/tui/test/tool-request-preview.test.ts`.
- Tests: `npm --workspace @sparkwright/tui test --
  test/activity-panel-render.test.tsx test/tool-request-preview.test.ts`;
  `npm --workspace @sparkwright/tui run typecheck`.

- Status: Verified
- Date: 2026-06-30T01:07:00+0800
- Scope: Activity Drawer now uses Ctrl+O for background tasks, leaves direct
  event-inspector keys unbound by default, reads durable task snapshots through host `task.*`
  requests, suppresses noisy `task.output` scrollback, summarizes task tool
  envelopes, and treats manual/user run cancellation as non-error UI state.
- Read: `packages/tui/src/app.tsx`,
  `packages/tui/src/components/activity-panel.tsx`,
  `packages/tui/src/components/event-stream.tsx`,
  `packages/tui/src/components/status-bar.tsx`,
  `packages/tui/src/components/layer-renderer.tsx`,
  `packages/tui/src/state/layer-stack.ts`,
  `packages/tui/src/state/run-controller.ts`,
  `packages/tui/src/state/event-store.ts`,
  `packages/tui/src/lib/keybindings.ts`,
  `packages/tui/src/lib/task-activity.ts`,
  `packages/tui/src/lib/tool-display.ts`,
  `packages/tui/src/lib/tool-request-preview.ts`,
  `packages/tui/src/lib/tool-result-summary.ts`, and focused render tests.
- Tests: `npm --workspace @sparkwright/tui test --
  test/activity-panel-render.test.tsx test/status-bar-render.test.tsx
  test/toast-store.test.ts test/event-store-active-phase.test.ts
  test/keybindings.test.ts test/input-footer.test.ts`;
  `npm --workspace @sparkwright/tui run typecheck`; PTY smoke for Ctrl+O task
  browsing.

- Status: Verified
- Date: 2026-06-29T23:05:00+0800
- Scope: `/export` transcript rendering now recovers the submitted goal from
  `run.created`/`model.requested` when TUI `run.started` omits `goal`, while
  preserving one user section per run.
- Read: `packages/tui/src/lib/transcript.ts`,
  `packages/tui/test/transcript.test.ts`,
  `docs/_internal/project-map/modules/tui.md`,
  `docs/_internal/project-map/maps/trace/export-diagnostics.md`.
- Tests: `npm --workspace @sparkwright/tui test -- test/transcript.test.ts`;
  `npm --workspace @sparkwright/tui run typecheck`.

- Status: Verified
- Date: 2026-06-29T17:40:00+0800
- Scope: `/sessions` empty state receives the effective session-root display
  label, and `/capabilities` counts public tools by catalog exposure tier while
  keeping approval/high-risk as an overlay.
- Read: `packages/tui/src/app.tsx`,
  `packages/tui/src/components/layer-renderer.tsx`,
  `packages/tui/src/components/session-list-dialog.tsx`,
  `packages/tui/src/components/capabilities-panel.tsx`,
  `packages/tui/test/session-list-dialog-render.test.tsx`,
  `packages/tui/test/capabilities-panel-render.test.tsx`.
- Tests: `npm --workspace @sparkwright/tui test --
  test/session-list-dialog-render.test.tsx test/capabilities-panel-render.test.tsx`;
  `npm --workspace @sparkwright/tui run typecheck`;
  `npm run build --workspace @sparkwright/tui`.

- Status: Verified
- Date: 2026-06-29T09:28:39+0800
- Scope: TUI capability and tool-event rendering understands canonical
  `bash`/`read` names, displays exposure/loading metadata, and still parses
  legacy trace names for history.
- Read: `packages/tui/src/components/capabilities-panel.tsx`,
  `packages/tui/src/lib/tool-request-preview.ts`,
  `packages/tui/src/components/event-stream.tsx`,
  `packages/tui/src/components/event-detail.tsx`,
  `packages/tui/test/capabilities-panel-render.test.tsx`,
  `packages/tui/test/tool-request-preview.test.ts`.
- Tests: `npm --workspace @sparkwright/tui test -- test/capabilities-panel-render.test.tsx test/tool-request-preview.test.ts test/format-event.test.ts`.

- Status: Verified
- Date: 2026-06-28T20:30:50+0800
- Scope: TUI read-only mode now completes safe file reads without surfacing an
  approval prompt after core policy requires explicit read-only governance;
  approval rendering for risky/default shell and bypass auto-resolution stayed
  covered.
- Read: `packages/tui/test/sdk-cutover.test.ts`,
  `packages/tui/src/state/run-controller.ts`,
  `packages/core/src/policy.ts`,
  `packages/host/src/tools.ts`,
  `docs/_internal/project-map/modules/tui.md`,
  `docs/_internal/project-map/maps/safety/approvals.md`.
- Tests: `npm run build --workspace @sparkwright/core`;
  `npm run build --workspace @sparkwright/host`;
  `npm run build --workspace @sparkwright/tui`;
  `npm --workspace @sparkwright/tui test -- test/sdk-cutover.test.ts test/permission.test.ts`;
  real mini TUI PTY read-only trace `session_tui_mqxrn5zz` verified with 0
  approvals and 0 writes.

- Status: Verified
- Date: 2026-06-27T20:24:22+0800
- Scope: capabilities panel now renders host-provided workflow rule summaries
  from `CapabilitySnapshot.rules.workflow`.
- Read: `packages/tui/src/components/capabilities-panel.tsx`,
  `packages/tui/test/capabilities-panel-render.test.tsx`,
  `packages/protocol/src/index.ts`,
  `packages/host/src/active-rules.ts`,
  `packages/host/src/runtime.ts`,
  `docs/_internal/project-map/modules/tui.md`.
- Tests: `npm --workspace @sparkwright/tui test --
  test/capabilities-panel-render.test.tsx -t "workflow rule summaries"`;
  `npm --workspace @sparkwright/tui run typecheck`;
- Prior verification — Date: 2026-06-27T11:29:02+0800
- Scope: TUI event formatting and capabilities panel now surface sort-only
  delegate routing diagnostics from host events/snapshots.
- Read: `packages/tui/src/lib/format-event.ts`,
  `packages/tui/test/format-event.test.ts`,
  `packages/tui/src/components/capabilities-panel.tsx`,
  `packages/tui/test/capabilities-panel-render.test.tsx`,
  `packages/protocol/src/index.ts`,
  `docs/_internal/project-map/modules/tui.md`.
- Tests: `npm --workspace @sparkwright/tui test -- test/format-event.test.ts test/capabilities-panel-render.test.tsx`;
  `npm --workspace @sparkwright/tui run typecheck`;
- Prior verification (capability warning diagnostics) — Date: 2026-06-27T10:55:00+0800
- Read: `packages/tui/src/lib/format-event.ts`,
  `packages/tui/test/format-event.test.ts`,
  `packages/tui/src/state/run-controller.ts`,
  `packages/tui/test/sdk-cutover.test.ts`,
  `packages/host/src/client-input.ts`, `packages/host/src/index.ts`,
  `packages/host/test/client-run.test.ts`,
  `docs/_internal/project-map/modules/tui.md`.
- Tests: `npm --workspace @sparkwright/tui test -- test/format-event.test.ts`;
  `npm --workspace @sparkwright/tui run typecheck`;
  `npm --workspace @sparkwright/tui test -- test/sdk-cutover.test.ts -t "attaches local image"`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/host test -- test/client-run.test.ts`;
  `npm --workspace @sparkwright/host run build`;
  `npx prettier --check packages/host/src/client-input.ts packages/host/src/index.ts packages/host/test/client-run.test.ts packages/cli/src/cli.ts packages/tui/src/state/run-controller.ts packages/tui/test/sdk-cutover.test.ts`.
- Prior verification (runtime access mode) — Date: 2026-06-26T23:59:00+0800
- Read: `packages/tui/src/app.tsx`, `packages/tui/src/index.ts`,
  `packages/tui/src/lib/config.ts`, `packages/tui/src/lib/permission.ts`,
  `packages/tui/src/state/run-controller.ts`,
  `packages/tui/src/components/config-panel.tsx`.
- Tests: `npm --workspace @sparkwright/tui run typecheck`;
  `npm --workspace @sparkwright/tui test -- test/config.test.ts test/permission.test.ts test/sdk-cutover.test.ts`;
  `npm run build`; `npm run check:dist-fresh`.

- Status: Verified
- Date: 2026-07-08T20:41:34+0800
- Scope: TUI permission mode helpers now delegate access-mode ordering,
  clamping, and core-field projection to host client run-access helpers.
  Capability inspection sends the active TUI access mode to the host so the
  panel snapshot is scoped to the current run mode.
- Read: `packages/tui/src/lib/permission.ts`,
  `packages/tui/src/state/run-controller.ts`,
  `packages/tui/test/permission.test.ts`,
  `docs/_internal/project-map/modules/tui.md`.
- Tests: `npm --workspace @sparkwright/tui test -- test/permission.test.ts`;
  `npm --workspace @sparkwright/tui run typecheck`.
