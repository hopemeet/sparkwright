# TUI

## Purpose

`@sparkwright/tui` is the terminal product surface. It drives host runs,
renders live events, browses/resumes sessions, handles approvals, and exports a
human-readable transcript.

See also [../maps/trace/export-diagnostics.md](../maps/trace/export-diagnostics.md) and [../maps/session/resume-replay.md](../maps/session/resume-replay.md).

## Last Verified

- Status: Verified
- Date: 2026-07-30
- Scope: product transcripts now correlate `approval.requested` and
  `approval.resolved` by exact run-scoped approval id, retain the request
  block's position, and render its current `requested`, `approved`, or
  `denied` state with the operation label. The retired run-terminal approval
  count and standalone matched resolution rows were deleted. Markdown export
  uses the same approval outcome projection; Activity Events/Run, raw Trace,
  and Core trace diagnostics retain their independent diagnostic facts.
- Read: conversation projection, detailed/live transcript projection,
  immutable TranscriptDocument assembly, Markdown export, Activity inspector,
  and Core trace correlation/summary consumers.
- Tests: focused approval document/presentation/live/export regressions
  79/79, full TUI 540/540, TUI typecheck and build, plus retained-session PTY
  compact/detailed replay passed.

- Status: Verified
- Date: 2026-07-29
- Scope: detailed transcript mode is now an explicit browse focus mode. It
  unmounts the composer while preserving the App-owned draft, reserves a
  one-row navigation footer, gives plain Up/Down and Escape to line
  scrolling/close, retains Page and boundary shortcuts, and restores the
  composer on exit. Agent transport completion with assessment issues renders
  as `completed with issues`; semantic issue text precedes child prose while
  stable diagnostic codes remain secondary. Exact `tool_search select:`
  previews omit the ignored `maxResults` field.
- Read: App input-surface allocation, browse footer, viewport routing, Agent
  lifecycle presentation, tool request previews, and transcript render tests.
- Tests: focused TUI browse/presentation/document/render suites (66 tests) and
  TUI typecheck passed.

- Status: Verified
- Date: 2026-07-28
- Scope: Agent detail actions now distinguish tool transport completion from
  command success: a completed shell receipt with a non-zero `exitCode` renders
  `exit N ✗`, while exit zero and non-process tools retain their existing
  success presentation.
- Read: terminal Agent receipts, replayed child tool projection, and detailed
  transcript formatting.
- Tests: TUI 532/532 and TUI typecheck passed, including receipt and replay
  coverage for non-zero exits.

- Status: Verified
- Date: 2026-07-26
- Scope: Agent tool-result recognition now targets compact
  `ParentAgentResult`; compact rendering displays its child `report`. Detailed
  action, workspace-write, health, and lifecycle evidence continues to come
  from canonical `subagent.*` events, so removing those fields from parent
  model context does not reduce TUI trace detail.
- Read: tool-result classification/display, transcript presentation, Agent
  lifecycle grouping, and compact/full transcript tests.
- Tests: full TUI 531/531 passed.

- Status: Verified
- Date: 2026-07-26
- Scope: the Ink screen root reserves one physical terminal row because Ink
  5.2.1 clears the terminal and scrollback whenever rendered output height is
  greater than or equal to `stdout.rows`. Passive Workflow discovery no longer
  toggles foreground loading and unchanged snapshots retain their state
  identity; live/input frames report height only when the measurement changes.
  Transcript effect ownership now suppresses `workspace.read`,
  `workspace.anchored_read`, and `skill.loaded` only when an exact same-run
  tool span/call owns them. Successful child tool lifecycles stay inside the
  Agent block instead of leaking generic event rows; child failures and safety
  events remain primary. Replayed child tool truth can correct legacy action
  receipts, and idempotent no-progress completions render as `skipped`, never
  with a success check.
- Read: App screen allocation, Ink 5.2.1 renderer branch, Workflow refresh
  state, live/input measurement, TranscriptDocument second-pass projection,
  Agent action summaries, and the retained real session
  `session_tui_ms12fuf0`.
- Tests: Agent Runtime 259/259 and TUI 531/531 passed; Host and repository test
  typechecks passed. Raw 100x32 PTY capture of the retained session had zero
  `ESC[2J ESC[3J ESC[H` sequences during 12.5 idle seconds and during Ctrl+T;
  `--no-alt-screen` emitted zero `ESC[3J`. The detailed frame showed the legacy
  third bash action as `repeated_idempotent_noop · skipped` and no generic child
  tool lifecycle rows.

- Status: Verified
- Date: 2026-07-26
- Scope: the TUI now owns a full-screen transcript viewport while retaining
  Ink. Presentation events assemble into an immutable, epoch-scoped
  `TranscriptDocument`; compact and detailed modes project the same stable
  block summaries, then width-aware layout materializes at most 5,000 physical
  rows and Ink receives only the visible window. Ctrl+T is contextual state,
  not a layer; semantic block/logical-row anchors survive mode changes and
  resize. PageUp/PageDown stop tail follow, appended rows accumulate an unseen
  count, and Ctrl+End restores tail follow. Markdown, diffs, inline code, and
  syntax colors survive physical wrapping as immutable row spans. The
  transcript height is derived from the measured live/input frames rather than
  fixed reservations. Approval remains the highest layer and replaces the
  visible operation surface without destroying the
  transcript anchor. Agent/tool grouping accepts only structured run/call/
  invocation/event identities; names, adjacency, and arbitrary span ids are
  not grouping fallbacks. The default terminal lifecycle enters the alternate
  screen and restores alternate screen, paste, focus, mouse, and cursor modes
  idempotently on normal exit, hard signals, and crashes. SIGINT stays App-owned
  so the first Ctrl+C cancels/backs out without leaving the alternate screen;
  `--no-alt-screen` keeps the same owned viewport in the normal buffer.
- Read: App shell, TranscriptDocument assembler/presentation projection,
  physical layout, viewport state/rendering, key routing, terminal lifecycle,
  replay/export ownership, and focused/PTY regressions.
- Tests: compact characterization 39/39; document/layout/viewport/export/
  terminal focused suites passed. Deterministic 80/100-column PTY runs verified
  contextual Ctrl+T, `↓ 13 new lines`, Ctrl+End tail recovery, CJK wrapping,
  `--no-alt-screen`, and resize after SIGWINCH. A real Terra cancellation run
  verified first Ctrl+C retained the screen and emitted `manual_cancelled`;
  the second Ctrl+C exited.

- Status: Verified
- Date: 2026-07-25
- Scope: Ctrl+T now opens one unified, normal-buffer detailed transcript for
  the current or latest run. The append-only Static transcript stays compact:
  successful Agent request/start/tool transport is omitted, one structured
  terminal Agent summary is committed, and failures/blocked outcomes remain
  visible with a details hint. Compact and detailed summaries share the
  explicit `Agent · <name>` prefix, so a child run cannot be mistaken for a
  generic task row. New terminal Agent facts supply bounded live action
  receipts and a structured workspace-write evidence line; older replay falls
  back to child tool events. The overlay rebuilds user-facing Agent, tool, Todo,
  approval, and failure blocks, defaults to the bottom, stops following after
  upward navigation, and remains below approval in the typed layer order.
  Legacy `todo.toggle` maps to `details.toggle`. Replay also filters all
  `model.stream.*` variants and child usage snapshots; `/export` remains
  independent.
- Read: EventStream/LiveFrame/Todo presentation, detailed transcript
  projection/panel, keybindings, typed layers, event carrier, replay/export
  projections, and focused render/projection tests.
- Tests: full `npm run release:check` passed, including TUI 482/482, Agent
  Runtime 258/258, Host 583/583, Protocol 6/6, the 16-case regression matrix,
  and install smoke. Real 100-column PTY replay of `session_tui_ms0d86wg` showed
  root usage 9 model / 10 tool, no stream-event leak, and five reconstructed
  child actions. A fresh read-only Agent run (`session_tui_ms0enkyx`) showed
  one live action receipt and zero-write evidence; session check had 0 findings.
  An 80-column replay of `session_tui_ms0d86wg` verified the shared
  `Agent · implement-timed-printer` label without wrapping.

- Status: Verified
- Date: 2026-07-25
- Scope: approval prompts now render the runtime principal as origin, including
  dynamic-child scope, and show policy/tool/safety reasons independently.
  Shell session scope displays execution mode. Spawn promotion and Task async
  receipts render as lifecycle summaries instead of raw orchestration JSON;
  obsolete recovered-requirement completion notices are removed.
- Read: approval coordinator/view/prompt/session rules, run completion
  projection, tool-result summary/display, and render/controller tests.
- Tests: full `npm run release:check` passed, including TUI 468/468, the
  16-case regression matrix, and source/release install smoke.

- Status: Verified
- Date: 2026-07-24
- Scope: TUI approval reuse keys now include session, runtime principal, and
  producer subject; approval projections distinguish actor and automatic
  resolution. Terminal projection renders Host completion notices and derived
  recovery directly, without parsing answer text or installing a local
  finality policy.
- Read: approval view/session/coordinator, run controller completion handling,
  Protocol payloads, and focused render/controller tests.
- Tests: focused TUI approval/controller/layer suites, repository build, and
  repository test typecheck passed.

- Status: Verified
- Date: 2026-07-23
- Scope: RunController now forwards Host `task.updated` to the task activity
  owner. Live records update without opening Activity, Host event ids plus
  task/status/completedAt suppress duplicate terminals, and connection/session
  changes reconcile through `task.list` without replaying historical terminals
  as new notifications. Inline/awaited success stays quiet, detached success
  enters task status/history, and failed/cancelled terminals receive higher
  priority.
- Read: RunController SDK listeners, task action/reconciliation hook, Activity
  projection, NotificationStore policy, Host/Protocol lifecycle DTO, and tests.
- Tests: focused task/controller/render/notification suites (67 tests), full
  TUI 464/464, and TUI typecheck passed.

- Status: Verified
- Date: 2026-07-21
- Scope: live conversation and Markdown export share a quiet-success
  projection: batch wrappers, successful approval rows, successful Skill
  body/resource loads, tool discovery/Todo plumbing, and successful MCP prep
  stay in Activity/Trace but not chat. Internal failures, denied approvals, and
  real `subagent.*` rows remain visible. Shell summaries retain head and tail
  with an omission marker; terminal summaries expose unhealthy assessment
  codes and unambiguous approval counts without a duplicate tool-call count.
  Typed producer subjects own remembered rules; duplicate approval delivery is
  idempotent, failed automatic resolution falls back to the manual queue, and
  `s` explicitly selects a safe session rule. Only `run.completed.message`
  renders the accepted final answer.
- Read: EventStream/export projection, tool summaries, approval coordinator/
  prompt/session rules, Protocol events, Core finality, and Activity retention.
- Tests: focused and full TUI suites, affected typechecks, and a real 120x32
  Terra PTY/trace/session rerun passed; the raw Skill body/resource events
  remained in Trace while no JSON leaked into conversation scrollback.

- Status: Verified
- Date: 2026-07-21
- Scope: terminal Agent lifecycle rows now render semantic blocked/partial
  status and summary directly from structured payloads; blocked rows are red
  and partial rows yellow. Profile-derivation diagnostics remain Activity/Trace
  only.
- Read: shared event formatter, EventStream lifecycle rows, strict Agent result
  payloads, and render tests.
- Tests: TUI 449/449 and TUI typecheck passed.

- Status: Verified
- Date: 2026-07-20
- Scope: committed conversation scrollback suppresses
  `agent.profile.derived` run-preparation diagnostics while the EventStore,
  Activity Events view, and persisted trace retain the raw event. The shared
  Protocol product-transcript filter also keeps it out of `/export`. Actual
  `subagent.requested` / `started` / `completed` / `failed` lifecycle rows
  remain visible.
- Read: EventStream, ActivityPanel, transcript exporter, shared Protocol event
  filter, Agent profile event producer, and focused render regressions.
- Tests: Protocol 6/6; focused EventStream, ActivityPanel, and transcript
  suites 44/44; full TUI 449/449; TUI/Protocol typechecks; real Terra PTY and
  trace/session checks passed.

- Status: Verified
- Date: 2026-07-20
- Scope: approval coordination moved from `RunController` into an
  execution-scoped `ApprovalCoordinator`; Ink receives a client-free
  `ApprovalViewModel` and typed decision renderers. `NotificationStore` and a
  pure presentation policy now separate run/connection diagnostics from
  action/panel failures, drive blurred attention, and expose `/notifications`.
  InputBox and `InteractionRouter` own composer/global routing, action cards own
  their keys, and the layer stack uses typed payload routes without caller-
  supplied numeric priorities. Review follow-up prevents a failed in-flight
  session auto-approval from requeueing after its execution is cleaned up and
  seeds replayed terminal tasks without raising fresh historical alerts. Native
  scrollback and Host/Protocol runtime authority are unchanged.
- Read: TUI app/controller/store/layers, approval/session policy, notification
  producers, input/keybinding paths, Host/Protocol approval routes, and current
  render/controller/SDK tests.
- Tests: focused approval/notification/input and review regressions passed;
  full TUI 447/447 and Host 594/594;
  TUI typecheck, repository test typecheck, lint, schema/boundary/reserved
  checks, all workspace tests, 16/16 regression matrix, and both install smokes
  passed. Real 80/96/120-column PTY evidence passed, followed by a clean 96x32
  Host-adapter PTY showing `1 of 2`, queue advancement to `1 of 1`, and idle
  completion. After mechanically formatting the 59-file repository baseline,
  the exact `npm run release:check` passed end to end before this review
  follow-up; the final rerun is recorded with the change.

- Status: Verified
- Date: 2026-07-19
- Scope: EventStream renders a sole canonical `run.cancelled` terminal and its
  run facts. RunController no longer creates an unpersisted Todo advisory row;
  live and replay use the Todo band. Initial same-session restore skips the
  empty-store reset, so EventStream's static header is not remounted.
- Read: EventStream, RunController, EventStore reset/session flow, Todo band,
  protocol terminal shape, and Ink/SDK regressions.
- Tests: TUI 417/417; sole-cancel and initial-session regressions passed.

- Status: Verified
- Date: 2026-07-19
- Scope: TUI terminal facts read canonical assessments, Agent lifecycle rows
  expose child health/issues independently of terminal finality, and Todo no
  longer manufactures client-side continuation episodes.
- Read: event store/stream, run controller, Todo band, protocol DTOs, and Ink
  rendering regressions.
- Tests: focused assessment/Agent rendering passed; full TUI rerun is part of
  final repository verification.

- Status: Verified
- Date: 2026-07-18
- Scope: Host capability inspection ownership moved internally. TUI continues
  to consume the same protocol snapshot and owns no capability reconstruction;
  panel fields and rendering are unchanged.
- Read: Host capability owner, protocol snapshot, and TUI capability consumer.
- Tests: focused Host capability passed; TUI gates are recorded with the commit.

- Status: Verified
- Date: 2026-07-17T23:37:17+0800
- Scope: `/create skill` is the only TUI Skill creation route. Removed the
  `/skill-create` command, dedicated create layer/dialog branch, action/parser
  adapter, and compatibility guidance; `/skill-update` and review remain.
- Read: command registry, capability/Skill actions, layer renderer/stack,
  proposal helpers/dialog, tests, and Skill reference docs.
- Tests: TUI create/evolution/command focused suites 22/22 and TUI typecheck.

- Status: Verified
- Date: 2026-07-17T17:20:00+0800
- Scope: TUI Workflow state consumes required canonical run generation,
  revision, layer, and v2 package identity. Durable cancel uses the required
  generation directly and no Workflow snapshot fixture carries `contentHash`.
- Read: Workflow controller/actions/display/panel, SDK cutover fixture, and
  protocol Workflow snapshot contract.
- Tests: TUI Workflow display/action/panel/SDK focused tests and TUI typecheck
  passed before the full release gate.

- Status: Verified
- Date: 2026-07-17T13:00:00+0800
- Scope: the capability panel renders delegate approval from the required
  `approvalRequiredUnderCurrentRun` snapshot fact; it no longer reads a
  delegate-config echo.
- Read: TUI capability panel/test, protocol capability type/schema, Host
  descriptor producer, and TUI rendering coverage.
- Tests: TUI capability panel 8/8 and typecheck; Host protocol and CLI
  capability tests passed.

- Status: Verified
- Date: 2026-07-17T09:43:00+0800
- Scope: TUI config now projects the single Host loader result. The independent
  file re-read, flat-key allowlist, grouped normalizer call, and UI validator
  were removed; canonical ui.theme/mouse/keybindings/vim remain active.
- Read: TUI config loader/app consumers, Host config contracts and loader,
  config/capability/status tests, and generated schema.
- Tests: TUI config/capability/status consumers 17/17; TUI and Host typechecks;
  Host config/protocol 115/115; repository test typecheck; schema check;
  project-map drift; full release gate including TUI 415/415, regression matrix,
  and install smokes.

- Status: Verified
- Date: 2026-07-16T21:02:00+0800
- Scope: Background task fixtures and untracked-write rendering use only
  `shell.background` / `background_shell`; the promotion-named trace marker
  reader was removed.
- Read: TUI event stream, task activity/status renderers, focused tests, Host
  Shell producer, and trace maps.
- Tests: focused TUI event/activity/status rendering suites; TUI typecheck;
  project-map drift check.

- Status: Verified
- Date: 2026-07-16T18:50:00+0800
- Scope: Verification hook rendering reads explicit result metadata for
  enforced invariant verifiers. The current `verification:<profile>` suggest
  hook remains a display label, but packed
  `verification:<profile>:<verifierId>` identities are not decoded.
- Read: TUI event formatter/tests, Core FactLedger classifier/outcome, Host
  invariant projection, and trace/protocol maps.
- Tests: TUI event-format focused tests; Core/CLI outcome and FactLedger focused
  tests; Core/CLI/TUI typechecks; test typecheck; project-map drift check.

## Main Files

- `packages/tui/src/app.tsx`
- `packages/tui/src/components/input-box.tsx`
- `packages/tui/src/components/use-input-buffer.ts`
- `packages/tui/src/components/use-input-history.ts`
- `packages/tui/src/components/live-frame.tsx`
- `packages/tui/src/components/activity-panel.tsx`
- `packages/tui/src/components/event-stream.tsx`
- `packages/tui/src/components/transcript-viewport.tsx`
- `packages/tui/src/components/transcript-browse-footer.tsx`
- `packages/tui/src/components/help-panel.tsx`
- `packages/tui/src/components/status-bar.tsx`
- `packages/tui/src/components/todo-band.tsx`
- `packages/tui/src/state/run-controller.ts`
- `packages/tui/src/state/approval-coordinator.ts`
- `packages/tui/src/state/notification-store.ts`
- `packages/tui/src/state/event-store.ts`
- `packages/tui/src/state/layer-stack.ts`
- `packages/tui/src/state/transcript-viewport-state.ts`
- `packages/tui/src/lib/approval-view-model.ts`
- `packages/tui/src/lib/ui-signal.ts`
- `packages/tui/src/lib/interaction-router.ts`
- `packages/tui/src/lib/commands.ts`
- `packages/tui/src/lib/task-activity.ts`
- `packages/tui/src/lib/tool-display.ts`
- `packages/tui/src/lib/transcript-presentation.ts`
- `packages/tui/src/lib/transcript-document.ts`
- `packages/tui/src/lib/transcript-layout.ts`
- `packages/tui/src/lib/terminal-screen-layout.ts`
- `packages/tui/src/lib/terminal-restore.ts`
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
- in-memory presentation-event store used for the owned viewport
- session list, inspect, switch, fork, compact, and rename flows

Does not own:

- canonical trace persistence
- session store file layout
- trace diagnostic report generation
- core approval semantics

## Contracts

- Approval rules are keyed by session, `principalScope`, and typed effect
  subject. Approval rows retain actor/principal, operation, automatic vs
  interactive resolution, denial, and reuse scope as Host facts.
- `RunController` renders runtime `completionStatus`, notices, and
  requirement-level recovery from `run.completed`; it does not parse assistant
  prose to infer verified/completed/partial state.
- `/create skill` is the sole Skill creation entrypoint. It prepares a proposal
  through host `SkillCommandService` and never writes the current Skill
  directly. Review apply also calls the service so later-session approval uses
  the same effect-bound receipt as the in-run fast path.

- Skill proposal files are the persistent inbox. On startup, TUI restores the
  newest `draft` as a completion-card affordance; `esc` only dismisses that
  card, while `/skill-review` lists and recovers all durable proposals.
  Recovery first asks the host to reconcile legacy drafts against current Skill
  packages, so superseded/stale work remains auditable in review but is not
  restored as an actionable completion card.

- The prepared-change fast path uses the normal queued approval controller with
  action `skill.apply`. `ApprovalPrompt` renders the persisted final patch and
  target before the one-shot decision; it deliberately has a typed `one_shot`
  approval subject, so no remembered rule can authorize later effects. The
  post-run human-action band remains transitional for review-only/legacy drafts
  and is not canonical waiting state.

- `RunController` sends `run.start` with the current `sessionId`.
- Todo-supervisor continuation notices are transcript-native and label the
  preceding assistant answer as provisional before showing the continuation
  count; committed assistant blocks remain stable and are not rewritten.
- Model-authored Skill draft tool results project host-owned `humanAction`
  metadata into a short-lived live-frame action band after the run settles.
  Safe authored create drafts offer `a` then Enter confirmation; `r` opens
  `/skill-review <proposal-id>` directly; Esc dismisses. Review-required or
  dangerous drafts do not offer quick apply. Transcript rows remain
  non-interactive and TUI does not recompute the host risk projection.
- Default compact transcript suppresses per-file capability mutation rows
  under `.sparkwright/skill-evolution/proposals/`, counts them by their shared
  tool span, and appends `N internal mutations` to the terminal Skill proposal
  result. Raw events remain in the event store/Activity Events view for debug
  and audit; unrelated capability mutations keep their individual rows.
- Default compact transcript also suppresses `agent.profile.derived` because
  it reports run preparation rather than child execution. The raw event remains
  available in EventStore/Activity and persisted trace, while the shared
  product-transcript filter also omits it from `/export`; real `subagent.*`
  lifecycle events keep their conversation rows.
- TUI presents one runtime permission axis (`read-only`, `ask`, `accept-edits`,
  `bypass`) but no longer owns a persisted `ui.tuiPermissionMode` config field.
  File config uses shared `run.accessMode`; project `run.accessMode` becomes an
  access ceiling that clamps CLI/TUI runtime requests. Default `ask` runs send
  `accessMode: ask` at the host request boundary so writes use the normal
  approval path and write guardrails. `bypass` and `accept-edits` derive their
  auto-response policy from that same mode. `RunController` snapshots the
  access mode at run start, so runtime mode switches affect the
  next run without changing auto-approval behavior for the active run.
- In `ask` mode, the approval prompt can remember an exact workspace-write,
  shell command + cwd, or tool + arguments for the current TUI session. Rules
  are in-memory, scoped by session id, installed only after the host accepts the
  first resolution, inspectable/clearable with `/approvals [clear]`, and never
  offered for an unrecognized approval shape. Simultaneous requests queue
  instead of replacing the visible prompt.
- `ApprovalCoordinator` owns immutable per-client execution origins, active and
  queued approvals, resolving state, exact session rules, auto-resolution, and
  execution cleanup. Its UI projection contains no SDK `Client`. Resolve
  failures remain on the active card and do not advance the queue or set the
  main run terminal state. Approval auto-policy remains Host-authored and is
  evaluated through the Host client helper.
- Approval cards use explicit workspace-write, shell, tool, Skill-apply, and
  fail-closed unknown renderers. They show main/Workflow origin, run/session,
  `1 of N`, risk, reason, exact scope, and pageable effect details. High-risk
  and unknown effects default to Deny; unknown effects never offer a session
  rule; Esc/Ctrl+C is an explicit denial.
- `NotificationStore` owns TUI-only signal lifecycle (dedupe/update,
  unread/seen/resolved, toast projection, and history). Host events, session
  traces, and EventStream remain canonical facts. Run/connection failures use
  persistent inline diagnostics and `/notifications`; ordinary RPC/action
  failures stay local and cannot set the main run status. Background success
  and cancellation remain quiet status/history updates, while failure or
  waiting-for-action may alert only when the terminal is blurred.
- Attention subscribes to notification policy and rate-limits by signal key;
  App no longer rings BEL/OSC 9 from run-status branches. Queued prompts render
  only in the composer queue, config errors use a compact badge plus `/config`,
  and cancellation progress uses the status line rather than a toast.
- TUI consumes the shared grouped `policy.confidentialDefaults` config field but
  does not own a separate UI surface for read-confidentiality defaults; Host
  config/runtime own validation and enforcement.
- `shift+tab` (`cycle-permission-mode`) cycles the runtime permission mode in
  read-only -> ask -> accept-edits -> bypass order, skipping modes above the
  project access ceiling. The switch is runtime-local, updates the
  `RunController` for the next run, appends a transcript notice, and leaves
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
  the transcript so the exported path has a durable, border-free copy
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
- Compact tool history hides one-tool batch headers and removes their batch
  indentation/margin; multi-tool batches remain muted structural groups while
  ordinary tool markers are muted and names use normal foreground emphasis.
- Explicit background shell handoff results and `task.created` queue rows stay
  out of committed history; `task.started` plus terminal `task.*` rows carry the
  visible lifecycle. If a task becomes terminal after the final model request,
  the run footer appends a structured runtime update so stale model prose does
  not override the current task record. Completed terminals use success color,
  failures use error color, and user/requested cancellation uses warning color
  in both lifecycle rows and runtime updates.
- Run facts do not label an explicit/promoted background shell handoff as a
  completed command; task lifecycle rows remain the visible source for its
  later terminal state.
- Run facts use live shell events when available and the canonical
  `run.completed.outcome.commandFailures` projection as the terminal fallback;
  they do not parse a second command-outcome envelope.
- Ctrl+O uses the `activity.open` binding and opens the Activity Drawer on the
  Tasks tab by default. `events.open` remains a configurable action with no
  default binding; `/events` and `events.open` both open the Activity Drawer on
  the Events tab. There is no separate standalone events layer. In common PTYs
  Ctrl+I arrives as the Tab control byte, so it is not used as a default.
- Input ownership is blocking approval, active typed layer, composer overlay,
  composer editor, then global action. Only the mounted top layer owns Ink
  input. InputBox gives overlays first refusal and then calls the pure handled/
  bubble `InteractionRouter`; unmodified printable global bindings defer to a
  non-empty draft. Skill proposal `a`/`r`/Esc handling and confirmation state
  live in the action card rather than App. Dialog Esc/Ctrl+C consistently maps
  to Back, while approval maps both to Deny.
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
- The Activity Drawer derives background task state from Core `run.event`,
  live Host `task.updated`, and durable snapshots via `RunController`
  `task.list` / `task.output` requests. `lib/task-activity.ts` merges those
  presentation inputs; canonical task storage remains host-owned. Live
  lifecycle updates are consumed even when the drawer is closed. Session load,
  Host reconnection, and explicit refresh reconcile current-session run ids
  (`parentRunId` filters); historical terminal snapshots seed state quietly
  instead of becoming new notifications.
- Activity task presentation preserves `awaited` versus detached/background
  state from legacy live events and uses canonical `completionPolicy` when
  available so terminal inline/awaited tasks are not mislabeled after the
  mutable awaited bit clears. The panel can render on-demand join/promote
  actions for host-backed callers; these callbacks call host-facing
  `task.join` / `task.promote` controls, while task state remains
  host/protocol-owned.
- Todo event projection reads only canonical model/result item titles. It does
  not retain a `content` fallback; malformed title-less trace rows use the
  generic `(untitled)` diagnostic placeholder.
- The Activity Drawer task details view is a bounded output browser: task
  selection uses arrow keys / `j` / `k`, output mode uses `f` / `H` / `T`, and
  long head/tail output can be paged with PgUp/PgDn or nudged with `[` / `]`.
- Live `EventStream` renders `task.started` / terminal `task.*` events as
  compact lifecycle rows, suppresses raw `task.output` rows from committed
  scrollback, and leaves task output browsing to the Activity Drawer. The
  `task` tool result formatter summarizes task list/get/output/stop envelopes
  instead of dumping raw JSON.
- `StatusBar` surfaces currently running background tasks with a Ctrl+O hint
  and an "untracked writes possible" disclosure when the `background_shell`
  boundary marker is present.
- Unread terminal task state crosses `useTaskActions` -> `LiveFrame` ->
  `StatusBar` as one `UnreadTaskActivitySummary`; consumers do not reconstruct
  completed counts from parallel total/failed/cancelled props. Host lifecycle
  ids and task/status/completedAt form the live dedupe identity. Successful
  inline/awaited terminals update Activity without an extra completion signal;
  detached success enters status/history, while failures and cancellations can
  raise a toast.
- Workflow job status in `StatusBar` is derived from durable workflow snapshots
  plus current TUI-owned waiting jobs. `/workflow stop` is limited to TUI-owned
  live job connections and matches durable workflow ids, active run ids,
  historical run ids, and pre-adoption owned run ids. The workflow panel keeps a
  local keyboard cursor after attach/start focus so users can browse other jobs.
- Workflow start/resume jobs own separate host-client connections and immutable
  job execution handles. A fresh start uses a cryptographically random
  `session_workflow_*` storage id distinct from the selected control session;
  resume requires and reuses the record's persisted job session. Each
  connection forwards `approval.requested` into the same queued TUI approval
  controller with that job session id, so ask-mode workflow writes cannot hang
  behind an invisible prompt.
- Every main/workflow approval is evaluated from an immutable execution origin
  capturing its client, birth session, permission mode, execution kind, and
  optional workflow id; the pending approval additionally captures the exact
  emitting episode `runId`. Main/workflow concurrency and later permission-mode
  changes therefore cannot change an already-born approval policy. Run end,
  failure, disconnect, explicit handle close, and controller shutdown remove
  only approvals owned by that client and advance the next surviving prompt.
- While a main run is starting or active, `RunController` rejects new-session,
  session-switch, and fork-and-switch mutations at the controller boundary.
  Session list/inspect/export remain available. This guard remains until all
  live event projection is execution-handle based.
- Workflow job background refresh and TUI config watching only run when stdin
  supports raw mode. Non-TTY startup renders the initial frame and exits on the
  next tick, keeping startup smoke/regression probes finite without spawning
  workflow polling intervals.
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
- `RunController`, `TranscriptDocument`/compatibility `EventStream`, transcript
  export, and the run inspector use protocol `runFailureMessage()` for terminal
  failure text. A failed `run.completed` sets store error text from the same
  helper instead of only flipping status to `error`.
- `TranscriptDocument` owns full-session semantic blocks. The compact
  compatibility `EventStream` and runtime `TranscriptViewport` both consume
  the same document/layout pipeline; neither contains append-only `<Static>`
  presentation logic. `subagent.requested` / `subagent.started` and successful
  Agent transport stay out of compact mode, while detailed mode exposes their
  bounded task/action/result sections. Grouping uses child run, explicit Agent
  call/invocation/tool-call, tool-call, and event ids only; absent ids produce
  independent blocks instead of name/adjacency guesses.
- `details.toggle` (Ctrl+T by default) changes `TranscriptViewportState.mode`;
  the legacy `todo.toggle` config name is accepted only as an input alias.
  The state stores a semantic logical-row/source-offset anchor, tail-follow
  state, and unseen-row count, not per-Agent/tool/Todo expansion flags.
  Detailed mode unmounts the composer without clearing its App-owned draft,
  and its navigation footer owns plain Up/Down line scrolling plus Escape.
  PageUp/PageDown scroll the transcript, Ctrl+Home/Ctrl+End move to the
  document boundaries, Ctrl+T/Escape restore the composer, and
  resize/mode projection resolve the same semantic block. Approval remains the
  highest typed layer and temporarily replaces the visible operation surface;
  details is not a route in `LayerStack`.
- Session replay derives child-run ids before synthesizing user cards, so only
  root goals enter the compact transcript and `/retry` targets the latest root
  goal. It skips every `model.stream.*` event and child usage snapshot so
  preview machinery cannot leak and rolled-up root totals are not double
  counted. Replayed child tool actions and full terminal Markdown remain
  available under the matching Agent detail block.
- Completed Todo titles appear in the unified details projection. The live Todo
  band has no independent expansion state and shows active items plus a compact
  completed-count hint.
- Ctrl+C is guarded: one press cancels or backs out of the current surface, and
  an idle no-layer prompt requires a second press to exit. User/manual cancels
  (`manual_cancelled` / `user_cancelled`) are terminal non-error outcomes in
  TUI state, dismiss stale sticky error toasts, and pause queued prompt draining
  until the user submits again.
- Long `/sessions` lists keep the selected row visible while navigating; row
  windows are presentation state and do not affect session storage order.
- TUI config is a projection of the single Host loader result. Host validates
  and merges `ui.theme`, `ui.mouse`, `ui.keybindings`, and `ui.vim` from
  `config.json`, `config.yaml`, or `config.yml`; TUI does not re-read files or
  keep a second parser. Same-layer conflict, format precedence, unknown-key
  diagnostics, and keybinding layer merge therefore stay Host-owned.
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
- The SparkWright brand/cwd/session/model header is frozen once per
  `sessionId:clearGeneration` document epoch. Runtime `/model` and permission
  switches append TUI-local notice blocks and update the pinned `StatusBar`;
  they do not rewrite the epoch header.
- The live frame below `StatusBar` derives a single `activePhase` from open
  model/tool/subagent/validation lifecycle events. Streamed assistant text takes
  precedence over the phase hint; the phase projection is TUI state only and
  does not change transcript filtering or raw trace semantics.
- `components/live-frame.tsx` owns the pinned live surface below the transcript
  viewport: status bar, streaming answer, modified-file sidebar, todo band,
  usage/error/toast/config-error rows, and queued prompt display. `app.tsx`
  keeps run/session/layer orchestration and input ownership.
- `index.ts` enters a `TerminalSession` before Ink render and restores it in a
  `finally` block. The session does not subscribe to SIGINT; App owns the
  cancel/confirm contract. SIGTERM, SIGHUP, uncaught exceptions, and normal
  exit restore private modes and leave the alternate screen once.
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
- Workflow decision handling is still TUI/live-client centered. The staged
  route in workflow job session review section 8 moves it through a typed
  durable control inbox before adding daemon and multi-channel adapters.

## Last Verified

- Status: Verified
- Date: 2026-07-16T13:36:30+0800
- Scope: Removed the dead validation-hook active phase and its start/completed compatibility events; TUI still renders current `validation.failed` diagnostics.
- Read: TUI event store, active-phase tests, Core event vocabulary, and event schema.
- Tests: focused TUI tests; npm run build; npm run typecheck:test; npm run release:check.

- Date: 2026-07-16T12:45:00+0800
- Scope: TUI startup, runtime switching, Host requests, metadata, and capability views use canonical access modes without deprecated flag aliases.
- Read: routed production sources, focused tests, protocol/config schemas, and current user/reference documentation.
- Tests: focused access/policy/protocol/CLI/TUI/ACP/Workflow tests; npm run typecheck:test; npm run schema:check.

- Status: Verified
- Date: 2026-07-16
- Scope: live failure rows, transcript export, run controller, inspector, and
  workflow actions consume protocol `failure` only; the legacy root-error render
  test and fallback were removed.
- Read: protocol helper, TUI failure consumers, SDK integration, and focused
  renderer/controller tests.

- Status: Verified
- Date: 2026-07-16T10:44:25+0800
- Scope: Task request previews now format only canonical `task_create` and
  `task(action=...)` calls; parallel Task tool-name branches were removed.
- Read: TUI request preview formatter/tests and Host Task catalog.
- Tests: TUI request preview 4/4 and repository test typecheck passed.

- Status: Verified
- Date: 2026-07-15T23:53:45+0800
- Scope: background task notifications keep `cancelled` separate from `failed`
  in one end-to-end unread summary, and narrow StatusBar rendering uses
  deliberate identity/task rows instead of accidental Ink wrapping. Wide
  status ownership is unchanged.
- Read: task activity summarization, task-action unread projection, LiveFrame,
  StatusBar, focused render tests, and 80x24 PTY captures.
- Tests: task activity/status rendering 7/7, TUI 415/415, TUI typecheck/build,
  and full `npm run release:check` passed; prior real PTY verification remains
  `session_mrlkn469h2ylznbk`.

- Status: Verified
- Date: 2026-07-12T08:36:00+0800
- Scope: replaced the transient Skill action band with a persisted-inbox
  completion card and wired both TUI creation paths to refresh it.
- Read: `app.tsx`, completion card, event store, Skill evolution helpers, and
  capability/Skill action hooks.
- Tests: focused card/event-store/inbox/create/review tests; TUI typecheck.

- Status: Verified
- Date: 2026-07-12T08:25:00+0800
- Scope: converged generic and dedicated TUI Skill create/review adapters on
  the host command service and clarified canonical/shortcut UX.
- Read: `lib/create-capability.ts`, `lib/skill-evolution.ts`, command registry,
  capability and Skill action hooks.
- Tests: focused TUI create/evolution suites and TUI typecheck.

- Status: Verified
- Date: 2026-07-12T02:12:00+0800
- Scope: effect-bound `skill.apply` approval projection and final-diff render;
  canonical waiting/receipt state remains host-persisted.
- Read: `packages/tui/src/state/run-controller.ts`,
  `packages/tui/src/state/event-store.ts`,
  `packages/tui/src/components/approval-prompt.tsx`.
- Tests: TUI typecheck; approval prompt render and queued approval controller
  focused suites.

- Status: Verified
- Date: 2026-07-12T00:56:00+0800
- Scope: folded proposal-package mutation noise into the terminal Skill tool
  summary while retaining raw events and append-only Static rendering.
- Read: `packages/tui/src/components/event-stream.tsx`,
  `packages/tui/src/lib/tool-display.ts`, and
  `packages/tui/test/event-stream-render.test.ts`.
- Tests: `npm --workspace @sparkwright/tui test --
test/event-stream-render.test.ts test/tool-request-preview.test.ts`;
  `npm --workspace @sparkwright/tui run typecheck`.

- Status: Verified
- Date: 2026-07-11T23:20:00+0800
- Scope: proposal-id review routing plus a centralized, terminal-only Skill
  human-action band with explicit apply confirmation and duplicate-submit
  suppression.
- Read: `packages/tui/src/lib/skill-evolution.ts`,
  `packages/tui/src/state/event-store.ts`,
  `packages/tui/src/state/use-skill-actions.ts`, `packages/tui/src/app.tsx`,
  `packages/tui/src/components/live-frame.tsx`, and
  `packages/tui/src/components/human-action-band.tsx`.
- Tests: TUI Skill parser/review, event-store projection, action-band render,
  and review-dialog focused tests passed; PTY proposal-id review focused the
  requested proposal without model involvement.

- Status: Verified
- Date: 2026-07-11T22:55:00+0800
- Scope: cancelled background task lifecycle and runtime-update rows use warning
  tone while failed rows retain error tone.
- Read: `packages/tui/src/components/event-stream.tsx`,
  `packages/tui/test/event-stream-render.test.ts`.
- Tests: full `npm run release:check`.

- Status: Verified
- Date: 2026-07-11T22:17:00+0800
- Scope: todo-supervisor continuation dividers now mark the preceding assistant
  answer provisional while preserving append-only, scrollback-native rendering.
- Read: `packages/tui/src/state/run-controller.ts`,
  `packages/tui/src/state/event-store.ts`, and
  `packages/tui/src/components/event-stream.tsx`.
- Tests: `npm --workspace @sparkwright/tui test --
test/event-stream-render.test.ts`; `npm --workspace @sparkwright/tui run
typecheck`.

- Status: Verified
- Date: 2026-07-11T20:32:00+0800
- Scope: background shell handoffs no longer produce the misleading run-facts
  label `last command ... completed`.
- Read: `packages/tui/src/components/event-stream.tsx`,
  `packages/tui/test/event-stream-render.test.ts`.
- Tests: `npm --workspace @sparkwright/tui test --
test/event-stream-render.test.ts`; `npm --workspace @sparkwright/tui run
typecheck`.

- Status: Verified
- Date: 2026-07-11T19:53:00+0800
- Scope: reduced single-tool/background lifecycle noise, lowered tool-request
  accent intensity, and added terminal task updates for final-generation races.
- Read: `packages/tui/src/components/event-stream.tsx`,
  `packages/tui/test/event-stream-render.test.ts`.
- Tests: `npm --workspace @sparkwright/tui test --
test/event-stream-render.test.ts`; `npm --workspace @sparkwright/tui run
typecheck`.

- Status: Verified
- Date: 2026-07-11T15:30:00+0800
- Scope: Package G TUI workflow stop is a local authenticated, cancel-only
  durable binding adapter followed by `workflow.control.process`.
- Read: `packages/tui/src/state/run-controller.ts`,
  `packages/tui/test/sdk-cutover.test.ts`.
- Tests: TUI workflow/SDK 22 focused tests plus typecheck/build.

- Status: Read-only
- Date: 2026-07-11T15:00:00+0800
- Scope: Package G design makes TUI one binding-aware notification/control
  adapter; it may render live feedback but is no longer the unique durable
  workflow decision channel.
- Read: `packages/tui/src/state/use-workflow-actions.ts`,
  `packages/tui/src/state/run-controller.ts`,
  `packages/agent-runtime/src/workflows/control.ts`.
- Tests: not run; design-only source reconciliation.

- Status: Verified
- Date: 2026-07-11T13:00:00+0800
- Scope: workflow stop now submits durable `workflow.control cancel` through
  the primary Host client and no longer requires a locally owned child Host.
- Read: `packages/tui/src/state/run-controller.ts`,
  `packages/tui/src/state/use-workflow-actions.ts`,
  `packages/tui/test/workflow-actions.test.ts`, `packages/tui/test/sdk-cutover.test.ts`.
- Tests: TUI focused/full tests and typecheck recorded in the Package D gate.

- Status: Verified
- Date: 2026-07-11T00:00:00+0800
- Scope: Workflow Durable Job Session Package B. TUI fresh workflow jobs now
  use unique session storage, handles expose immutable job/run/workflow
  identity, and resume requires the persisted job session.
- Read: `packages/tui/src/state/run-controller.ts`,
  `packages/tui/src/state/use-workflow-actions.ts`, SDK integration tests.
- Tests: full TUI suite (60 files / 399 tests), TUI typecheck and build.

- Status: Verified
- Date: 2026-07-11T00:00:00+0800
- Scope: Workflow Durable Job Session Package A. Approval policy and pending
  prompts now bind immutable execution identity, per-client cleanup is
  idempotent, and active main execution blocks session mutation.
- Read: `packages/tui/src/state/run-controller.ts`,
  `packages/tui/src/state/build-command-registry.ts`,
  `packages/tui/src/state/use-session-actions.ts`, and focused tests.
- Tests: `npm --workspace @sparkwright/tui test` (60 files, 398 tests);
  `npm --workspace @sparkwright/tui run typecheck`.

- Status: Verified
- Date: 2026-07-11T01:04:00+0800
- Scope: session-scoped exact approval rules, queued approval prompts, workflow
  job client approval forwarding, and `/approvals` inspection/clear UX.
- Read: `packages/tui/src/lib/session-approval.ts`,
  `packages/tui/src/state/run-controller.ts`,
  `packages/tui/src/components/approval-prompt.tsx`, focused tests.
- Tests: TUI session/run-controller/prompt approval suites, TUI SDK cutover,
  TUI typecheck; full `npm run release:check` on the same source tree.

- Status: Verified
- Date: 2026-07-09T21:52:00+0800
- Scope: Workflow Job Session post-QA fix: workflow panel keyboard navigation
  now moves away from the attached row, `/workflow stop` resolves owned jobs by
  workflow id or run id including connecting jobs, and live workflow job clients
  are closed on hook unmount.
- Read: `packages/tui/src/state/use-workflow-actions.ts`,
  `packages/tui/src/components/workflow-panel.tsx`,
  `packages/tui/test/workflow-actions.test.ts`,
  `packages/tui/test/workflow-panel-render.test.tsx`.
- Tests: `npm --workspace @sparkwright/tui test --
test/workflow-actions.test.ts test/workflow-panel-render.test.tsx
test/workflow-display.test.ts`; `npm --workspace @sparkwright/tui run
typecheck`.

- Status: Verified
- Date: 2026-07-09T21:28:00+0800
- Scope: Workflow Job Session Stage D added `/workflow stop [id]` for
  TUI-owned live workflow jobs only. Stop uses that job connection's
  `run.cancel`, tells users stop is terminal/non-resumable, and returns clear
  notices for waiting/cross-process/non-owned records. No CLI workflow stop or
  SIGINT behavior was added.
- Read: `packages/tui/src/state/use-workflow-actions.ts`,
  `packages/tui/src/state/build-command-registry.ts`,
  `packages/tui/src/components/workflow-panel.tsx`.
- Tests: `npm --workspace @sparkwright/tui run typecheck`; PTY/pyte owned
  live stop probe with record `cancelled`; CLI resume-after-stop rejection;
  PTY/pyte non-owned waiting stop prompt.

- Status: Verified
- Date: 2026-07-09T21:22:00+0800
- Scope: Workflow Job Session Stage C added `/workflow resume <id>` as a
  TUI-owned job start path. TUI refuses records without authorization snapshots
  and sends `workflow.resume` through `createHostWorkflowResumeRequest` with
  explicit snapshot-prefilled target/confidential/write/access/background
  fields.
- Read: `packages/tui/src/state/run-controller.ts`,
  `packages/tui/src/state/use-workflow-actions.ts`,
  `packages/tui/src/state/build-command-registry.ts`.
- Tests: `npm --workspace @sparkwright/tui run typecheck`; PTY/pyte TUI resume
  probe from a CLI-created waiting workflow.

- Status: Verified
- Date: 2026-07-09T21:18:00+0800
- Scope: Workflow Job Session Stage B added TUI `/workflow start <name>
<goal...>` using one host client connection per TUI-owned job. Focus policy
  opens the workflow snapshot view by default; `--stay` / `--no-focus` only
  keep focus on the main prompt and do not promise daemon/background process
  survival. TUI-owned rows are distinguished from store-only/cross-process
  records.
- Read: `packages/tui/src/state/run-controller.ts`,
  `packages/tui/src/state/use-workflow-actions.ts`,
  `packages/tui/src/state/build-command-registry.ts`,
  `packages/tui/src/components/workflow-panel.tsx`,
  `packages/tui/src/app.tsx`.
- Tests: `npm --workspace @sparkwright/tui run typecheck`; PTY/pyte probes for
  `/workflow start` waiting, completed, and missing-workflow failure branches.

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
