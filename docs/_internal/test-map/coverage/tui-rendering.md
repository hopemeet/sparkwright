# TUI Rendering Coverage

- 2026-08-22 `/connect` model-stage coverage verifies an existing API connection
  can select a catalog row or type a provider-local model id. The nested
  `anthropic/claude-new` input becomes
  `openrouter/anthropic/claude-new`, while Tab/catalog Enter behavior remains.
  ConnectDialog passes 12/12, full TUI passes 568/568, and TUI typecheck passes.

- 2026-08-21 `/connect` coverage verifies the raw `chatgpt` and `openai`
  providers render as one OpenAI product group; aggregated connections retain
  distinct ChatGPT-account/OpenAI-key labels and exact-provider model routing.
  Browser account login and API key are primary, device code is nested under
  other sign-in options, and endpoint text appears only after choosing the API
  path. ConnectDialog passes 11/11, full TUI passes 567/567, a real PTY walk
  confirms the grouped screens, and the complete release gate passes.

- 2026-08-09 P6.2 `/connect` coverage walks provider, auth method, masked API
  key, and connected-provider model selection. The sentinel is supplied to the
  submit callback but never appears in Ink output. Focused ConnectDialog,
  ModelDialog, command-registry, and SDK cutover suites pass 28/28. The full TUI
  suite passes 553/553 and `npm run release:check` passes through the 16-case
  regression matrix and both install smokes.

- 2026-08-08 Project Trust coverage verifies `/trust` renders scope status and
  effects, requires a second explicit confirmation for grant/revoke, and does
  not auto-dispatch a command after grant. Project command discovery excludes
  untrusted project bodies. Focused dialog/registry/command tests passed 4/4;
  the full TUI suite passed 85 files / 552 tests. Host 578/578, the real
  no-process regression, 16/16 scenario matrix, and full release gates cover
  the boundary behind the presentation.

- 2026-08-08 P4 interaction-polish coverage verifies an asynchronously loaded
  provider catalog cannot move `/model` selection to the same numeric index in
  a reordered list, long catalogs open around the current model, provider auth
  actions are spelled out, and pending interactions retain enough structure to
  render `follow-up`, `command`, and `next` ownership. The shared list-window
  path now covers model, fork, session, and slash-command lists. Focused tests
  passed 44/44; the full 84-file / 550-test TUI suite, typecheck, build, and
  formatting passed. Real PTY checks at 80 and 110 columns verified the fixed
  model highlight and Host-owned follow-up label. A read-only real two-run
  session (`session_tui_msketbne`) completed with no tool failures and trace
  verification reported 0 findings. Full `npm run release:check` then passed,
  including the 16-case regression matrix and both install smokes.

- 2026-08-08 interaction coverage verifies plain active-run submission uses
  typed steering, `/followup` uses Host lane admission, Host-owned queue entries
  cannot be drained into duplicate `run.start` calls, and failed admission
  remains a TUI-owned fallback. Focused controller/queue/registry tests, TUI
  typecheck, the full 83-file / 547-test suite, and full `npm run release:check`
  passed.

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

- Status: `Verified`
- Last reviewed: 2026-08-08
- Latest evidence: P4 model/queue/list rendering coverage verifies stable model
  selection across asynchronous catalog reorder, bounded current-item
  visibility, explicit auth actions, and structured pending-interaction labels.
  The full TUI suite passed 550/550, and real-model trace verification reported
  zero findings for a Host-scheduled follow-up run.
- Additional recent evidence: child Agent approval coverage verifies ask-mode `approved`
  and bypass-mode `auto-approved` outcomes appear once under the Agent in both
  compact and detailed projections, never inline with actions and never as a
  second standalone child block. Raw replay events take precedence over the
  terminal-receipt fallback. Agent Runtime passed 251/251, TUI passed 547/547,
  the repository built, and retained real sessions `session_tui_ms7mmq7h` and
  `session_tui_ms88t03l` replayed with the expected 3 ask / 2 bypass rows.
- Additional recent evidence: usage information-hierarchy coverage verifies the idle line
  `usage  context 6.7k · session 50.2k · calls 10 model / 8 tool`, the Activity
  Run breakdown
  `session 48.6k input (25.8k cached) · 1.6k output`, zero-cache omission,
  fallback calculation when `totalTokens` is absent, and canonical
  `state.usage` routing. TUI typecheck and the full 81-file / 547-test suite
  passed.
- Additional recent evidence: focused `/skills` coverage verifies the panel
  omits generic model/tool/Cron/automation overview rows, renders current
  inventory with recent loads and drafts, opens associated diagnostics with
  Enter, and treats the first Esc as detail-back before close. Exact-identity
  projection and rendering tests passed; the full TUI suite passed 83 files /
  550 tests, and a real 80-column PTY showed the expected list and detail.
- Additional recent evidence: the approval argument pager, InputBox reverse
  search/file suggestions, and Skills detail/back render tests now assert
  deterministic final Ink frames. The focused suite passes 29/29 with
  `CI=true`; see
  [tui-ink-ci-deferred-frames.md](../failures/tui-ink-ci-deferred-frames.md).
- Additional recent evidence: focused live-stream coverage verifies the
  terminal-height answer budget resolves to 6–12 physical rows (with bounded
  tiny-screen degradation), reasoning shows only three one-row tails, long
  Markdown blocks display a generic temporary-fold hint without treating soft
  paragraph lines as hidden, and a character-cut code-fence tail renders as
  inert text instead of creating a phantom Markdown block. Focused rendering
  passed 11/11; the full TUI passed 84 files / 561 tests,
  followed by typecheck and build.
- Additional recent evidence: retained session `session_tui_msafgwsd` exposed a
  1.17-second gap between `model.stream.completed` and `model.completed` during
  which the live preview was previously cleared. EventStore coverage now keeps
  reasoning/answer text through the stream-complete marker and clears it only
  when the canonical assistant message is appended. Focused state/rendering
  tests passed 33/33, the full TUI passed 84 files / 561 tests, session check
  remained clean, and post-fix Terra PTY sampling emitted adjacent completion
  markers; the deterministic state regression covers the longer handoff gap.
- Evidence source: 2026-07-26 owned-viewport coverage preserves all 39 compact
  rendering characterization cases while routing both compact and detailed
  output through `TranscriptDocument` and physical layout. Focused tests cover
  strict concurrent/nested Agent identities, full-session replay, 10,000-row
  projection caps, CJK widths at 80/100/120 columns, semantic anchor recovery,
  unseen-row counting, mode-independent export, `/clear` export retention,
  terminal restore idempotence, SIGTERM/SIGHUP/crash restore, and no SIGINT
  restore.
  The final TUI suite passed 77 files / 520 tests. Deterministic PTY runs at 80
  and 100 columns verified Ctrl+T in-place details, PageUp during continued
  events with `↓ 13 new lines`, raw-sequence Ctrl+End tail
  recovery, resize after SIGWINCH, CJK wrapping, and `--no-alt-screen`. A Terra
  PTY run cancelled active work on the first Ctrl+C while retaining the screen;
  the second Ctrl+C exited. Supported Node 22 performance sampling at 80
  columns measured one 10,000-row detailed section at 10.20ms P95 and 10,000
  independent blocks at 14.22ms compact / 14.26ms detailed P95, with at most
  5,000 physical rows materialized. See
  [../runs/2026-07-26-tui-owned-viewport-pass.md](../runs/2026-07-26-tui-owned-viewport-pass.md).
  A same-day raw-byte follow-up found that the original decision gate missed
  Ink 5.2.1's exact-height full-clear branch. The fixed root reserves one row;
  unchanged Workflow polling is state-silent; exact tool spans own duplicate
  read/Skill effects; replayed no-progress actions render as skipped. Agent
  Runtime passed 259/259 and TUI passed 531/531. On retained session
  `session_tui_ms12fuf0`, 100x32 raw PTY capture recorded zero full-clear
  sequences over 12.5 idle seconds and Ctrl+T, while `--no-alt-screen`
  recorded zero scrollback clears. See
  [../failures/tui-full-height-periodic-clear.md](../failures/tui-full-height-periodic-clear.md).
  Earlier evidence: 2026-07-25 unified-details and first-batch action/replay
  coverage passed 482/482 TUI, 258/258 Agent Runtime, 583/583 Host, and 6/6
  Protocol tests. Full `npm run release:check` also passed the 16-case
  regression matrix and source/release install smoke. Focused SDK replay proves wildcard `model.stream.*`
  suppression, root-only usage totals (9 model / 10 tool), terminal Agent
  action receipts, zero-write evidence, and persisted redacted tool-search
  counts. Real 100-column replay of `session_tui_ms0d86wg` retained the same
  9/10 totals, showed two tool-search matches and five child actions, and leaked
  no stream event. An 80-column replay also verified the explicit
  `Agent · implement-timed-printer` compact/detail label without wrapping.
  Fresh read-only `session_tui_ms0enkyx` rendered one live
  `read README.md:1 +1` action plus zero-write evidence; trace summary had 0
  errors/failures/writes and session check had 0 findings.
  Earlier evidence: 2026-07-20 full-diff review passed 447/447 TUI and 594/594
  Host tests, including stale auto-approval cleanup and replayed terminal-task
  notification regressions. A test-only Host stdio adapter proved two approval
  waiters were installed before either request was resolved. Real 96x32 PTY
  session `session_tui_approval_queue_1ofn_v3` showed the first shell card as
  `1 of 2`, advanced to the workspace-write card as `1 of 1` after explicit
  denial, and returned to idle after the second denial. The fixture is
  `/tmp/sparkwright-tui-approval-queue.VOfIEt`.
  Earlier 2026-07-19 approval/notification/interaction refactor tests passed
  445/445 across the full TUI suite. Fresh PTY sessions at 80x24,
  96x24, and 120x32 covered long shell/cwd, pageable long diffs, persistent run
  failure, background failure, and clean read-only completion.
  TUI typecheck, test typecheck, lint, schema/boundary/reserved gates, every
  workspace test, 16/16 regression cases, and both install smokes also passed.
  After mechanically formatting the 59-file repository baseline, the exact
  `npm run release:check` passed end to end. Earlier evidence includes
  2026-06-22 TUI status-bar and event-stream
  render tests
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

- 2026-07-28 Agent action projection coverage verifies both bounded terminal
  receipts and replayed child tool events render non-zero process exits as
  `exit N ✗` even when the tool transport event is `completed`. The full TUI
  suite passed 79 files / 532 tests and typecheck passed.

- 2026-07-26 App-owned transcript viewport coverage removes `<Static>` and the
  details layer without replacing Ink. The immutable semantic document,
  compact/detailed projections, width layout, and visible-row renderer have
  separate regressions. PageUp/PageDown/Ctrl+Home/Ctrl+End routing uses the
  global key registry
  without stealing a non-empty draft; approval remains the top layer. Terminal
  lifecycle tests cover alternate-screen enter/leave, `--no-alt-screen`,
  private-mode restore, idempotence, hard-signal/crash restoration, and the
  intentional absence of a terminal-level SIGINT handler.

- 2026-07-26 real/deterministic PTY and supported-Node performance QA passed
  compact/detail anchoring, scroll/unseen/tail recovery, resize/CJK,
  first/second Ctrl+C and terminal restoration. The layout-volume measurements
  remain valid, but the original Ink decision gate did not inspect raw escape
  sequences and therefore missed periodic full clears at exact terminal
  height. The one-row renderer boundary now keeps Ink viable, with raw-byte
  regressions required for future app-shell changes. See
  [../runs/2026-07-26-tui-owned-viewport-pass.md](../runs/2026-07-26-tui-owned-viewport-pass.md).

- 2026-07-25 focused projection/render/replay coverage verifies the unified
  Ctrl+T details mode: successful Agent transport and intermediate lifecycle
  stay out of committed Static scrollback, one `Agent · <name>` terminal
  summary remains, abnormal outcomes preserve a visible failure/hint, child run
  goals/final answers do not replay as root turns, and detailed
  Agent/tool/Todo/approval blocks remain user-facing rather than diagnostic
  JSON. Approval has higher layer priority, legacy `todo.toggle` config maps to
  `details.toggle`, and the bounded details viewport supports tail follow plus
  navigation.

- 2026-07-21 conversation-projection coverage keeps successful batch,
  approval, Skill body/resource, tool-search/Todo, and MCP preparation plumbing
  out of live chat and export while preserving it in Activity/Trace. Failures,
  denials, and real subagent lifecycle remain visible. Terminal rendering owns
  one accepted final answer, unhealthy assessment codes, clear approval counts,
  and head/tail shell truncation. Typed session approvals have explicit `s`
  input, duplicate-delivery suppression, and manual fallback after automatic
  resolve failure. Focused/full TUI tests and a real 120x32 Terra rerun passed;
  trace verify and session check reported zero findings.

- 2026-07-20 focused committed-transcript coverage suppresses
  `agent.profile.derived` preparation noise while preserving requested,
  started, and completed subagent lifecycle rows. Activity Events coverage
  confirms the hidden conversation event remains inspectable, while transcript
  export coverage confirms it does not reappear in the raw-event tail. Protocol
  6/6, focused TUI live/export/Activity suites 44/44, full TUI 449/449,
  relevant typechecks, and a real Terra PTY/trace/session pass succeeded.

- 2026-07-20 concurrent approval queue verification added
  `packages/host/test/fixtures/approval-queue-host.mjs` and its Host regression.
  The adapter holds two independent deferred waiters, does not complete after
  resolving only the first, and completes after the second. A real Ink/SDK/PTY
  run at 96x32 captured `1 of 2` -> `1 of 1` -> idle with no unrelated startup
  diagnostic. Full-diff review also fixed cleanup of failed in-flight session
  auto-approval and suppressed fresh alerts for replayed historical task
  terminals.

- 2026-07-19 approval/notification/interaction refactor extracted immutable
  execution-scoped approval coordination, client-free decision view models,
  unified typed presentation signals, and handled/bubble input routing. Full
  TUI coverage passed 445/445. Real PTY evidence at 80/96/120 columns verified
  long effects, safe default focus, explicit Esc denial, persistent but
  non-duplicated run failure, quiet main-run completion around a failed
  background task, and clean trace/session checks. Sessions:
  `session_tui_refactor_smoke_120`,
  `session_tui_refactor_long_approval_96`,
  `session_tui_refactor_queued_diff_80`,
  `session_tui_refactor_run_failure_80_v2`, and
  `session_tui_refactor_background_failure_120` under the retained temporary
  fixture `/tmp/sparkwright-tui-refactor-qa.n0nEdz`.

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

- `TranscriptDocument` owns the epoch-frozen first-screen header; the runtime
  viewport owns its visible rows.
- Status bar owns changing run state and should not repeat the static brand
  header.
- Runtime model switches surface as semantic `tui.notice` blocks, and the live
  status line exposes the active model while idle as well as while running.
- The shared transcript document renders tool, shell, and Agent summaries;
  `EventStream` remains only a compatibility consumer of that same projection.
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

- BEL/OSC 9 blur/refocus and rate limiting are covered with a fake TTY. The
  appearance of a platform terminal's desktop notification is not a portable
  PTY invariant.

- PTY width/height can expose wrapping bugs that component string snapshots miss.
- Live rendering order can differ from static render tests when events arrive
  quickly.
- True last-row ownership remains unsupported on Ink 5.2.1: removing the
  reserved row re-enters Ink's full-terminal clear path. If product design
  requires the last row, patch/fork the renderer or replace only the renderer
  layer.
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
- Fixed 2026-07-26: `/export` appends a border-free
  `tui.export.completed` path row to the owned transcript document in addition
  to transient feedback. Alternate-screen selection ergonomics still vary by
  terminal, but the path is no longer toast-only. See the original run note
  [../runs/2026-06-24-tui-copy-paste-ergonomics.md](../runs/2026-06-24-tui-copy-paste-ergonomics.md).
- Fixed 2026-06-29: `/export` no longer omits the submitted user goal when
  `run.started` lacks `goal` but `run.created` or `model.requested` carries
  it. See
  [../failures/tui-export-missing-user-goal.md](../failures/tui-export-missing-user-goal.md).

## Focused Route

```bash
npm --workspace @sparkwright/tui test -- test/event-stream-render.test.ts test/transcript-presentation.test.ts test/transcript-document.test.ts test/transcript-layout.test.ts test/transcript-viewport-state.test.ts test/transcript-viewport-render.test.tsx
npm --workspace @sparkwright/tui test -- test/transcript.test.ts test/export-after-clear.test.ts test/terminal-restore.test.ts test/keybindings.test.ts test/layer-stack.test.ts
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
- `packages/tui/src/components/transcript-viewport.tsx`
- `packages/tui/src/components/todo-band.tsx`
- `packages/tui/src/components/status-bar.tsx`
- `packages/tui/src/lib/transcript-presentation.ts`
- `packages/tui/src/lib/transcript-document.ts`
- `packages/tui/src/lib/transcript-layout.ts`
- `packages/tui/src/state/transcript-viewport-state.ts`
- `packages/tui/src/lib/terminal-restore.ts`
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
