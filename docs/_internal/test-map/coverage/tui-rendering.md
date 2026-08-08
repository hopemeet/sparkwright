# TUI Rendering Coverage

- Todo projection coverage uses canonical `title` items from `todo_write`
  request/result events. The TUI no longer accepts `content` as an alternate
  model DTO field; title-less malformed rows retain only the generic diagnostic
  placeholder.

- 2026-07-11 Package A deterministically verified immutable per-execution
  approval policy, exact run/workflow attribution, two-workflow permission
  isolation, active/queued client cleanup, idempotent cleanup, and controller-
  level new/switch/fork guards. Full TUI suite (398 tests) and typecheck passed.
- 2026-07-11 Package B integration verified one main session plus two concurrent
  workflow jobs produce three distinct session ids, handles expose stable
  run/workflow/session identity, records retain control-session attribution,
  and job traces do not contain the main chat sentinel. Full TUI suite now
  passes 399 tests.

## Current Confidence

- Status: `Partially Verified`
- Last reviewed: 2026-07-19
- Evidence source: 2026-06-22 TUI status-bar and event-stream render tests
  passed; PTY first-screen capture at 24x100 showed a single static
  `SparkWright` header and no duplicate brand text in live status/input areas.
  Real mini PTY runs covered `/capabilities`, read-only completion, and write
  approval denial. 2026-06-23 focused host/TUI/CLI tests covered active-model
  capability inspect routing. 2026-06-23 PTY follow-up covered `/help`,
  `/capabilities`, `/sessions`, and deterministic `/retry` at wide and narrow
  terminal sizes. A later 2026-06-23 CLI/TUI QA pass confirmed TUI read-only
  trace/session health; raw PTY capture also confirmed idle input borders align
  at 80 and 120 columns despite a misleading `pyte.display` reconstruction.
  2026-06-24 focused render tests covered `/model` switch feedback: a
  committed `tui.notice` row in `EventStream` and an idle `StatusBar` model
  indicator without repeating the static brand.

## Covered

- 2026-07-19 real Terra PTY fix verification passed fresh 80/100/120-column
  single-header frames, sole-terminal Esc cancellation live/replay, canonical
  Todo 1/3 live/replay without another Core run, Agent partial/unhealthy replay,
  ask-mode approval accept/deny, and `/capabilities`. The cancellation screen
  is fixed; the adjacent session-consistency warning is also fixed by run-local
  cancellation ownership, with both retained real cancel sessions now clean. See
  [../runs/2026-07-19-real-model-fix-verification.md](../runs/2026-07-19-real-model-fix-verification.md).

- 2026-07-19 deterministic fix verification renders a sole `run.cancelled`
  terminal with exactly one footer, removes the live-only Todo advisory notice
  in favor of the canonical Todo band, and keeps `clearGeneration` stable while
  restoring the already-selected initial session so EventStream's static header
  is not remounted. Full TUI coverage passed (417/417). A real multi-width PTY
  rerun remains useful visual confirmation.

- 2026-07-19 Terra full-App PTY follow-up covered approval accept/deny,
  pending-Todo completion without continuation, fresh-user resume, Esc cancel,
  live/replay, and first frames at 80/100/120 columns. It found a sole
  `run.cancelled` terminal has no run footer, Todo advisory notices disappear
  on replay 2/2, and the existing static-header duplication remained visible
  at 3/3 widths before the deterministic fixes above. See
  [../runs/2026-07-19-real-terra-refactor-qa-follow-up.md](../runs/2026-07-19-real-terra-refactor-qa-follow-up.md).

- Post-refactor real Terra PTY session
  `session_tui_assessment_refactor_20260719` rendered a clean two-bullet code
  review and `/capabilities` at 120x32. Trace/session checks reported zero
  failures, approvals, writes, or findings; the terminal assessment was clean,
  and no raw assessment/protocol payload leaked into the screen.

- 2026-07-19 assessment-consolidation coverage renders canonical terminal
  health/verification facts and shows subagent health/issues independently of
  completion finality. Todo UI remains advisory and no longer synthesizes a
  continuation run. Focused Ink tests cover unhealthy completed children and
  terminal assessment fallback behavior.

- 2026-07-19 real `openai/gpt-5.6-terra` PTY QA rechecked read-only streaming,
  `/capabilities`, `/help`, `/sessions`, and ask-mode shell approval at 96/120
  columns. The approval card accepted `y`, the command completed, no writes
  occurred, and trace report/verify plus session check passed. The fenced-code
  language row (`│ text`) was confirmed as intentional renderer behavior.

- 2026-07-17 capability-panel tests render configured delegates from the
  required current-run approval fact after removal of the config echo.
- 2026-07-15 real 80x24 PTY QA on a resumed coding/background-task session
  exposed two related presentation defects: a normal `task.cancelled` was
  labelled `failed unread`, and the one-line compact StatusBar split status,
  model, and permission fragments across rows. Unread terminal counts now keep
  cancelled separate from failed, while narrow mode owns deliberate identity
  and task rows. Post-fix PTY showed `● idle ... claude-sonnet-4-6 · read-only`
  and `tasks: 1 cancelled unread ...` as stable rows. See
  [../failures/tui-cancelled-task-failed-unread.md](../failures/tui-cancelled-task-failed-unread.md)
  and
  [../failures/tui-narrow-status-bar-wrap.md](../failures/tui-narrow-status-bar-wrap.md).

- Event stream owns the committed first-screen header.
- Status bar owns changing run state and should not repeat the static brand
  header.
- Runtime model switches surface as committed `tui.notice` rows, and the live
  status line exposes the active model while idle as well as while running.
- Event stream renders tool, shell, and sub-agent event summaries.
- Capability panels render configured delegate information.
- Approval prompt rendering keeps shell command details readable.
- Slash command panels render cleanly at 120x32 and 80x24 without raw JSON,
  duplicate headers, or obvious overflow.
- `/retry` can rerun the latest completed goal in the same TUI session; trace
  verify and session check passed with two completed runs.
- Real `openai/gpt-5.4-nano` TUI read-only completion produced a passing trace
  report/verify and session check.
- Raw PTY capture showed idle and non-empty input box border columns align at
  80 and 120 columns.
- 2026-06-24: real nano read-only run usage line matched the final
  `usage.updated` payload exactly (input/cached/output/model+tool calls; cost
  hidden when pricing unavailable); `/help` rendered cleanly at 60 cols with a
  scroll affordance and aligned border.
- 2026-06-28: real mini PTY `/capabilities` rendered cleanly at 100 columns
  with the active mini model and no raw JSON/obvious overlap. A separate
  read-only PTY prompt exposed a runtime access-mode bug: safe `read_file`
  requests showed approval prompts with `reason: Plan mode requires approval.`
  Track this under
  [../failures/access-mode-read-only-safe-read-approval.md](../failures/access-mode-read-only-safe-read-approval.md)
  rather than as a layout defect.
- 2026-06-28 fix verification: after the core plan-mode policy fix, the same
  real mini read-only PTY prompt completed naturally with two `read_file` calls,
  zero approvals, and passing trace verify/session check (`session_tui_mqxrn5zz`).
- 2026-06-28 P0/P1 follow-up covered TUI ask-mode shell denial, ask-mode
  workspace-write approval, and bypass shell auto-approval through PTY. All
  traces passed verify; bypass auto-approved shell but mutation audit still
  rolled back an unmanaged redirect write.
- 2026-06-29 real mini PTY `/capabilities` rendered the active mini model and
  missing-pricing warning cleanly; a separate read-loop prompt displayed
  repeated `read` previews and the final `MAX_STEPS_EXCEEDED` failure clearly.
- 2026-06-29 follow-up PTY at 60 columns covered `/help`, `/sessions`, and
  `/capabilities`; layout was readable, but `/sessions` empty-state copy used a
  hard-coded default path under a custom session root.
- 2026-06-29 focused render tests fixed `/sessions` empty-state path display
  for custom session roots and aligned `/capabilities` public counts with
  catalog exposure tier while keeping high-risk as an overlay.
- 2026-06-29 real PTY rerun confirmed `/sessions` at 60 columns shows the
  custom session root path and `/capabilities` shows `6 public` with
  `bash · risky · public` in the detail list.
- 2026-06-29 deterministic PTY `/export` check confirmed the export path is no
  longer toast-only: the screen showed a border-free `transcript exported`
  scrollback row plus the saved path, while the toast remained as a transient
  status cue.
- 2026-06-29 fix verification covered `/export` Markdown goal recovery:
  `renderTranscript()` now uses `run.created`/`model.requested`/`run.started`
  goal evidence once per run, and `npm --workspace @sparkwright/tui test --
  test/transcript.test.ts` plus TUI typecheck passed.
- 2026-06-29 TUI background-task smoke (`session_tui_mqzcyu61`) verified the
  runtime path: promoted shell task completed, trace verify and session check
  passed. It exposed a TUI rendering defect where 20 `task.output` events were
  shown as repeated generic fallback rows and `task` tool results were raw JSON.
- 2026-06-30 fix verification covered background-task presentation:
  `EventStream` now renders compact task lifecycle rows, suppresses raw
  `task.output` committed rows, summarizes promoted shell handoff text and task
  tool results, and `StatusBar`/Activity Drawer expose running background task
  awareness. Full TUI tests and typecheck passed.

## Weak Or Untested

- PTY width/height can expose wrapping bugs that component string snapshots miss.
- Live rendering order can differ from static render tests when events arrive
  quickly.
- Real user workflows with long-running tasks should still be checked with a PTY
  capture when the layout contract changes.
- Status and header ownership can regress when adding first-screen affordances.
- `/config` still shows resolved configuration, not the runtime `/model`
  override; treat active-model config-panel wording as a separate product
  decision.
- `/capabilities` active-model routing is covered by controller/host tests, but
  a real PTY visual check is still useful when changing the panel layout.
- Re-run real PTY checks for `/sessions` custom roots and `/capabilities`
  public/high-risk overlays after large panel layout changes; current coverage
  is focused render tests plus prior PTY layout checks.
- `pyte.display` can misplace right borders on SGR-padded rows; use raw PTY
  capture or a cell-aware harness before classifying bordered-row width issues
  as product bugs.
- Unresolved `/`-prefixed input is submitted to the model as a goal. This is
  **intentional** (it supports `/path`-style goals) and prefix typos are caught
  by the suggestion panel; only non-prefix typos / invented commands fall
  through, which is ambiguous with a one-token slash goal. Do not classify as a
  bug — see
  [../failures/tui-unknown-slash-command-to-model.md](../failures/tui-unknown-slash-command-to-model.md).
- Copy-paste ergonomics are untested. Border *alignment* is verified, but no
  test covers whether a path/value the user needs to copy lands inside a
  `borderStyle` box (toast, `DialogFrame`, input box). Terminal mouse selection
  is line-based, so any path inside a border is selected together with the `│`
  glyphs and `paddingX` space. Worst offender: `/export` pushes the full export
  path as a **toast message only** (`app.tsx` export command → `toast.tsx`
  round border), un-shortened, so it can wrap across multiple bordered lines and
  there is no plain/scrollback copy of that path anywhere. See run note
  [../runs/2026-06-24-tui-copy-paste-ergonomics.md](../runs/2026-06-24-tui-copy-paste-ergonomics.md).
- Fixed 2026-06-29: `/export` no longer omits the submitted user goal when
  `run.started` lacks `goal` but `run.created` or `model.requested` carries
  it. See
  [../failures/tui-export-missing-user-goal.md](../failures/tui-export-missing-user-goal.md).

## Focused Route

```bash
npm --workspace @sparkwright/tui test -- test/activity-panel-render.test.tsx test/status-bar-render.test.tsx test/event-stream-render.test.ts
npm --workspace @sparkwright/tui test -- test/capabilities-panel-render.test.tsx test/approval-prompt-render.test.tsx
```

Use a real PTY QA pass when changing the app shell or interactive layout.

## Scenario Links

- [../scenarios/tui-first-screen-header.yaml](../scenarios/tui-first-screen-header.yaml)

## Sensitivity Links

- [../matrices/capability-sensitivity.md](../matrices/capability-sensitivity.md)
- [../matrices/environment-sensitivity.md](../matrices/environment-sensitivity.md)

## Stale Triggers

- `packages/tui/src/app.tsx`
- `packages/tui/src/components/activity-panel.tsx`
- `packages/tui/src/components/event-stream.tsx`
- `packages/tui/src/components/status-bar.tsx`
- `packages/tui/src/lib/task-activity.ts`
- `packages/tui/src/components/capabilities-panel.tsx`
- `packages/tui/src/components/approval-prompt.tsx`
- protocol event or capability snapshot shape changes

## Failure Links

- [../failures/tui-static-header-duplication.md](../failures/tui-static-header-duplication.md)
- [../failures/tui-static-header-stale-model.md](../failures/tui-static-header-stale-model.md)
- [../failures/tui-capabilities-model-mismatch.md](../failures/tui-capabilities-model-mismatch.md)
- [../failures/tui-sessions-custom-root-empty-label.md](../failures/tui-sessions-custom-root-empty-label.md)
- [../failures/tui-export-missing-user-goal.md](../failures/tui-export-missing-user-goal.md)
- [../failures/tui-task-output-event-spam.md](../failures/tui-task-output-event-spam.md)
- [../failures/cancelled-tool-abort-session-check-warning.md](../failures/cancelled-tool-abort-session-check-warning.md)
