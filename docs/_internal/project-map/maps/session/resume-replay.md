# Resume Replay

## Purpose

Resume and replay let SparkWright continue or seed future work from persisted
state without pretending all live process state is durable.

See [session-store.md](session-store.md) and [../runtime/context-compaction.md](../runtime/context-compaction.md).

## Last Verified

- Status: Verified
- Date: 2026-07-19
- Scope: checkpoint and Workflow resume now receive the already-admitted
  HostExecution explicitly from the single HostRuntime execution envelope.
  Canonical run lookup, checkpoint/from-trace behavior, pinned Workflow
  verification, writer claims, waiting compensation, job-session identity,
  and replay context are unchanged.
- Read: Host resume envelopes, session query owner, Workflow durable/episode
  owners, HostExecution/HostService lanes, and focused resume tests.
- Tests: focused Host Workflow/protocol and final repository gates are recorded
  with the commit.

- Status: Verified
- Date: 2026-07-18
- Scope: fresh, checkpoint-resume, and Workflow-resume envelopes now obtain the
  same prepared environment through `RunPreparationOperations`. Canonical run
  lookup, pinned Workflow verification/wait compensation, and live episode
  construction remain with their existing owners.
- Read: Host resume envelopes, preparation/episode/durable owners, and session
  contracts.
- Tests: direct owner and focused resume/Workflow gates are recorded with the
  commit.

- Status: Verified
- Date: 2026-07-18
- Scope: checkpoint episode construction and Workflow resume episode
  construction now route through `WorkflowEpisodeRuntime`; waiting input is
  consumed and compensated during its projection preparation. HostRuntime
  still resolves canonical run/workflow identity, authorization, and the
  caller-owned HostExecution before delegation.
- Read: Host resume envelopes, Workflow episode/durable owners, checkpoint and
  pinned-definition paths, job-session isolation, and focused resume tests.
- Tests: focused Host Workflow/protocol suites passed.

- Status: Verified
- Date: 2026-07-18
- Scope: Host Workflow record lookup, durable resume-command processing,
  claimed-writer validation, waiting-input compensation, and canonical store
  ownership moved to `WorkflowRuntimeOperations`. HostRuntime retains the live
  resume episode envelope and uses the same persisted job session and pinned
  definition.
- Read: Workflow owner/HostRuntime resume seam, Agent Runtime journal/control,
  job-session contracts, and focused resume tests.
- Tests: owner-level and focused Host/Agent Runtime Workflow suites passed.

- Status: Verified
- Date: 2026-07-18
- Scope: resume-time orphaned in-process Task detection/failure moved intact
  from `HostRuntime` into the Host Task operations owner. Resume still fails
  only pending/running records without a current-process live runner before
  rebuilding the Core episode; checkpoint and durable-wait semantics are
  unchanged.
- Read: Host resume assembly, Task operations, Agent Runtime manager/store, and
  focused protocol coverage.
- Tests: Host protocol 59/59, Task revival/service 5/5, and Host typecheck
  passed.

- Status: Verified
- Date: 2026-07-17T23:37:17+0800
- Scope: checkpoint/file-run reference helpers moved to Core `/internal`;
  resume identity, replay, compaction anchors, and Host/CLI behavior are
  unchanged.
- Read: Core barrels/trace store and Host/CLI resume consumers.
- Tests: Host/CLI typechecks and builds passed; final release gate covers resume.

- Status: Verified
- Date: 2026-07-17T23:04:01+0800
- Scope: run resume and session-context replay now call the single Host session
  owner for canonical run lookup, completed turns, trace facts, and compact
  anchoring. Checkpoint selection, force/from-trace behavior, identities, and
  Core resume execution remain unchanged.
- Read: Host resume/start paths, session query/compaction modules, Core
  checkpoint/session contracts, and focused protocol coverage.
- Tests: Host protocol 59/59 and full Host 577/577; Host typecheck; repository
  test typecheck; full release gate.

- Status: Verified
- Date: 2026-07-17T17:20:00+0800
- Scope: Workflow resume has one identity path: replay a canonical journal
  record, verify its required v2 executable snapshot, and execute its
  snapshot-backed definition. Live-folder or Markdown-hash fallback and missing
  layer/revision/generation defaults are absent.
- Read: Workflow journal/store, Host lookup/preparation/resume, CLI/TUI
  consumers, and focused resume tests.
- Tests: Agent Runtime/Host/CLI/TUI Workflow focused tests and affected
  typechecks passed before the full release gate.

- Status: Verified
- Date: 2026-07-16T22:26:54+0800
- Scope: Workflow resume, list, control, and restart recovery now resolve
  record/event truth only by replaying the canonical workspace journal.
- Read: Agent Runtime store/journal, Host resume/control paths, CLI/TUI
  consumers, protocol docs, and focused restart/recovery tests.
- Tests: Agent Runtime workflow focused suite/typecheck; Host workflow/protocol
  focused suites/typecheck; repository test typecheck; full release gate.

- Status: Verified
- Date: 2026-07-16T14:10:00+0800
- Scope: Checkpoint resume locates runs only under canonical session storage; best-effort trace reconstruction reads the session or agent aggregate trace, never a run-local trace.
- Read: Core checkpoint reconstruction, Host/CLI run lookup, focused resume tests, and protocol references.
- Tests: Core trace focused tests; Host/CLI run-resume focused tests; npm run build; npm run typecheck:test; npm run release:check.

- Date: 2026-07-16T13:50:10+0800
- Scope: Workflow resume is single-layout: only the workspace workflow store is searched and returned to the resumed projection.
- Read: Host lookup/resume paths, Agent Runtime workflow store, focused tests, and protocol docs.
- Tests: npm run build; npm run typecheck:test; Agent Runtime workflow tests (25); Host workflow/protocol tests (94).

- Date: 2026-07-16T12:45:00+0800
- Scope: Run and Workflow resume reapply canonical persisted/requested accessMode; compatibility reconstruction of permission/write inputs was removed.
- Read: routed production sources, focused tests, protocol/config schemas, and current user/reference documentation.
- Tests: focused access/policy/protocol/CLI/TUI/ACP/Workflow tests; npm run typecheck:test; npm run schema:check.

- Date: 2026-07-16T11:52:29+0800
- Scope: reviewed protocol 2.0 terminal failure envelope changes; persisted
  run/session resume semantics consume Core state and are unaffected by removal
  of the Host wire-level `run.failed.error` projection.

## Main Files

- `packages/core/src/run.ts`
- `packages/core/src/trace.ts`
- `packages/core/src/session.ts`
- `packages/host/src/runtime.ts`
- `packages/host/src/runtime/host-runtime.ts`
- `packages/cli/src/cli.ts`
- `packages/tui/src/state/run-controller.ts`

## Data Flow

```txt
Normal run
  -> session/agent trace.jsonl + per-run checkpoint/run/result files
  -> run resume uses checkpoint

Missing checkpoint
  -> loadCheckpointFromRunDir({ fallbackFromTrace: true })
  -> partial checkpoint
  -> force required

Session resume
  -> replay session run events
  -> summary/context items
  -> new run in same session

Workflow resume
  -> replay workspace .sparkwright/workflow-runs/<workflowRunId>.journal/
     to locate the canonical record and event history
  -> acquire single-writer lease
  -> verify packageHash/packageSnapshotRef and snapshot-backed sourceDir
  -> prepare host run environment
  -> consume input waits at the actor boundary when status is waiting
  -> start a transient worker run with the pinned workflow definition
  -> re-run verifier nodes whose latest verdict passed when verifyOnResume is true

Future run in compacted session
  -> load compact.json when throughRunId matches completed turns
  -> compact context item + later un-compacted turns
  -> warning context item if compact artifact cannot be anchored
```

## Contracts

- Skill prepared-change waiting is durable proposal state, not checkpoint or
  live TUI state. If the originating run cannot obtain approval, a later
  session can read the waiting proposal, recompute effect/base/guard facts, and
  continue through the host approval/apply functions. This does not make
  in-flight core tool execution generally resumable.

- Workflow-job resume uses the durable `WorkflowRunRecord.sessionId` as the
  execution/session-store identity. TUI/CLI callers may not substitute their
  current/control session, and records missing the required session or
  authorization snapshot fail diagnostically rather than falling back to
  mutable client defaults.

- Checkpoint resume is the normal path.
- Run lookup is session-only. Host and CLI search
  `<sessionRoot>/<sessionId>/agents/<agentId>/runs/<runId>`; there is no
  workspace-level per-run fallback.
- Run checkpoints optionally persist `budget.childTreeUsage` alongside the
  existing local `budget.usage`. Old checkpoints without the field remain
  valid; resumed parents seed descendant consumable counters so later children
  cannot regain model/tool/token/cost budget. Both local and tree elapsed
  duration restart for the resumed active execution segment, preserving the
  established duration-resume contract.
- From-trace resume is best-effort recovery; it restores counters/coarse step data, not full in-loop context.
- Reconstructed checkpoints are marked not fully resumable and require explicit force.
- Session replay projects persisted events into context; it is not live-process restoration.
- `sparkwright session resume` starts a new run in the existing session context.
  It does not infer the previous run's CLI/TUI model override from trace
  history; pass `--model provider/model` to choose an explicit resume model.
- `sparkwright workflow resume <workflowRunId>` is workflow-state adoption, not
  checkpoint replay. It resumes only non-terminal workflow records, uses the
  stored compiled definition snapshot rather than the live asset folder, and
  defaults `verifyOnResume` to true so completed verifier nodes whose latest
  verdict passed are rechecked before trusting the stored position.
- `workflow resume` must not consume a durable waiting input unless the resumed
  worker run can be prepared. If a pre-run failure happens after consuming the
  wait, host restores the previous waiting record before returning the error.
- Fresh workflow runs now persist their durable `WorkflowRunRecord` under the
  workspace-level `.sparkwright/workflow-runs/` root. Resume, list, control,
  notifications, and supervisor adoption resolve only this canonical store and
  pass it into the host projection.
- Session compact artifacts seed future context only when `throughRunId` can be
  matched to completed turns. A mismatch produces an explicit
  conversation-layer warning item and falls back to replaying completed turns.
- Core `waiting_tasks` is live in-process run state only. Checkpoints record
  that it is not durable; resume must not claim to reconstruct awaited task
  revival until a durable waiting-state/outbox design exists.
- TUI session switch replays persisted events for display and filters stream-only events.
- Ordinary IM reconnect replay is process-local and keyed by an exact binding.
  A configured single WS bearer credential maps to one stable non-secret Host
  principal, so reconnect can recover the existing binding/cursor without
  trusting handshake client name. Different credentials remain isolated;
  unauthenticated connection-scoped principals cannot self-bind. Reconnect may
  echo the existing exact binding's Host-issued session id, but a new binding
  cannot select a session or attach to another binding's replay state.

## Consumers

- CLI `run resume` and `session resume`.
- Host `run.resume`.
- TUI session switch, retry, and resume flows.

## Change Checklist

- Keep checkpoint schema changes backward aware.
- Update both CLI and host resume paths.
- Check TUI replay when new event families affect visible transcript.
- Do not silently treat from-trace reconstruction as full resume.

## Known Debts

- Reconstructed resume cannot restore pending summaries, in-flight tool/model work, or full context.
- Durable detach/resume for awaited background task revival remains deferred;
  CLI `--detach` should not be added without durable waiting-state/checkpoint
  reconstruction.
- Replay-derived context can become noisy for long sessions.
- Deterministic session compact and opt-in model-backed Tier 3 summarization
  reduce future context noise; background auto-trigger policy still needs a
  run-loop integration.

## Last Verified

- Status: Verified
- Date: 2026-07-16T10:27:51+0800
- Scope: reviewed Agent-tool policy input consolidation; no checkpoint, session,
  resume, or replay contract consumes the removed construction option.
- Read: Agent-tool and Host delegate assembly against resume/replay contracts.
- Tests: repository test typecheck passed; no resume/replay contract changed.

- Status: Read-only
- Date: 2026-07-15T07:35:27+0800
- Scope: doctor session-root path reporting moved to a domain module; resume,
  checkpoint, replay, identity, and session behavior are unchanged.
- Read: CLI config-doctor path report and trace-session module.
- Tests: doctor/session focused and full CLI golden.

- Status: Read-only
- Date: 2026-07-15
- Scope: capability/delegate command relocation preserves delegate session-id
  creation and trace routing; resume/replay behavior is unchanged.
- Read: CLI capability command and facade routing.
- Tests: full CLI golden.

- Status: Verified
- Date: 2026-07-15
- Scope: CLI session and run-resume handlers moved to one domain module;
  HostService reuse, session lookup, checkpoint reconstruction, direct-core
  diagnostic gate, replay order, identity, and output are unchanged.
- Read: CLI trace-session module, host/direct-core runners, CLI facade.
- Tests: CLI session/run-resume focused slices and full CLI golden.

- Status: Verified
- Date: 2026-07-15
- Scope: task notification/snapshot conversion moved to a leaf; task revival,
  persisted lookup, checkpoint replay, run identity, and ordering are unchanged.
- Read: concrete runtime revival path and task-projections.
- Tests: Host service/protocol/agent and CLI host-resume focused suites.

- Status: Read-only
- Date: 2026-07-15
- Scope: capability snapshot merge moved to a stateless collaborator; resume
  lookup, checkpoint reconstruction, run identity, and replay order are unchanged.
- Read: capability-assembly merge and concrete runtime resume path.
- Tests: Host protocol/client and CLI host-resume focused suites.

- Status: Verified
- Date: 2026-07-15
- Scope: concrete resume orchestration moved behind the runtime facade;
  session lookup, lane selection, checkpoint replay, and identities are unchanged.
- Read: runtime facade, concrete resume path, contracts, HostService.
- Tests: Host service/protocol/client and CLI host-resume focused suites.

- Status: Verified
- Date: 2026-07-15
- Scope: resume request/outcome ports are now neutral contracts; session lookup,
  lane selection, checkpoint replay, and identity behavior are unchanged.
- Read: runtime contracts, Host runtime resume path, and HostService coordinator.
- Tests: Host service/protocol/client focused suites.

- Status: Verified
- Date: 2026-07-15T23:53:45+0800
- Scope: fresh/session resume/Workflow continuation derive a new visibility
  snapshot from the same admitted definitions; old prompt/session context does
  not restore removed tools, and call-time gates remain authoritative.
- Read: Host session resume and Workflow episode chain, Todo continuation,
  trace/session stores, and real resumed session `session_mrlx0rjg30mzf6z4`.
- Tests: CLI resume/full suites, Host Workflow two-run integration, trace
  verify and session check passed.

- Status: Verified
- Date: 2026-07-15
- Scope: fresh, run-resume, and workflow-resume Todo continuation builders now
  align the reconciliation prompt with an immediately callable admitted
  `todo_write`. Session identity, replay context, and configured tool narrowing
  are unchanged.
- Read: Host run start/resume/workflow-resume episode builders, Todo supervisor,
  session trace `session_mrlkn469h2ylznbk`, and focused protocol tests.
- Tests: Host continuation loading 2/2, resumed-Todo protocol 1/1, Host
  typecheck, trace verify/session check, and real same-session background task
  resume.

- Status: Verified
- Date: 2026-07-14
- Scope: corrected IM reconnect identity to use stable authenticated credential
  context and Host-issued new-binding sessions while preserving bounded
  in-memory replay and restart loss.
- Tests: Host IM replay and WS stable-principal focused coverage passed.

- Status: Verified
- Date: 2026-07-14T14:35:00+0800
- Scope: P6 routed review; session query/compaction extraction preserves
  resume and replay contracts and adds no durable lane recovery claim.
- Tests: Host session/compaction coverage in the 571-test suite passed.

- Status: Verified
- Date: 2026-07-14
- Scope: reviewed IM reconnect replay; it replays bounded Host event
  projections only and does not add execution restart adoption.

- Status: Verified
- Date: 2026-07-14
- Scope: resume resolves its persisted session before lane admission; legacy
  run directories receive one new session identity shared by lane and execution.

- Status: Verified
- Date: 2026-07-14
- Scope: added backward-compatible descendant-tree budget usage to Core
  checkpoints and verified child refusal after parent resume.
- Read: checkpoint schema, create/resume seeds, trace reconstruction boundary,
  and Agent inheritance.
- Tests: Core run/resume/trace 272/272 plus budget account 3/3;
  agent-runtime checkpointed child-tree coverage passed.

- Status: Read-only
- Date: 2026-07-13
- Scope: ACP delegate sandbox/access assembly applies to fresh prepared tools;
  resume payload, checkpoint, Workflow authorization snapshot, and replay
  formats are unchanged.
- Read: Host runtime delegate assembly and resume preparation paths.
- Tests: Host focused suites passed.

- Status: Read-only
- Date: 2026-07-13
- Scope: checked all three Host preparation entrypoints after access-plan
  consolidation; start, checkpoint resume, and Workflow resume still resolve a
  fresh access plan and retain existing replay semantics.
- Read: Host start/resume/workflow-resume preparation call sites.
- Tests: Host protocol focused tests passed; replay/checkpoint formats did not
  change.

- Status: Verified
- Date: 2026-07-12T20:12:00+0800
- Scope: resumed Workflow records retain their event-time source layer while
  continuing to execute only from the verified package snapshot.
- Read: Workflow store parser, host resume preparation and focused tests.
- Tests: focused host Workflow resume suite passed.

- Status: Read-only
- Date: 2026-07-12
- Scope: checked snapshot-backed Workflow identity attribution; resume behavior is unchanged from Phase 4.
- Tests: focused Workflow tests and the 2026-07-15 release gate passed.

- Status: Verified
- Date: 2026-07-12T16:36:08+0800
- Scope: Workflow resume now fails closed unless its executable package snapshot
  exists, hashes to the persisted v2 identity, and backs definition `sourceDir`.
- Read: host Workflow resume/runtime paths and durable workflow record store.
- Tests: host/CLI Workflow resume suites and full `npm run release:check`.

- Status: Verified
- Date: 2026-07-12T02:12:00+0800
- Scope: documented proposal-backed Skill waiting/recovery without widening
  core checkpoint guarantees or coupling Skill records to workflows.
- Read: `packages/host/src/skill-evolution.ts`, `packages/core/src/run.ts`,
  and the managed-change design.
- Tests: host approval/revision/crash-reconciliation focused tests.

- Status: Verified
- Date: 2026-07-11T18:30:00+0800
- Scope: claim publication fencing loss now releases and returns through the
  documented null/busy acquisition path; resume layout is unchanged.
- Read: workflow store and Host/control/supervisor acquisition call sites.
- Tests: agent-runtime, Host, and server-runtime focused suites.

- Status: Verified
- Date: 2026-07-11T15:30:00+0800
- Scope: Package G notification delivery receipts/cursors rebuild after restart;
  adapter responses become Package D commands and Package E/F consumers resume
  or terminate through canonical generation/state fencing.
- Read: workflow channels/notification/control store, server-runtime channel
  coordinator, Host process-existing-command path, TUI/CLI/IM adapters.
- Tests: Package G focused fault matrix recorded in workflow durable-jobs.

- Status: Verified
- Date: 2026-07-11T14:30:00+0800
- Scope: Package F service restart scans durable handoffs and existing workflow
  records, recovers outcome by fixed handoff linkage, and delegates existing-run
  takeover to Package E supervisor/Package C claim fencing.
- Read: `packages/server-runtime/src/workflow-service.ts`,
  `packages/server-runtime/src/workflow-supervisor.ts`,
  `packages/host/src/runtime.ts`, `packages/cli/src/cli.ts`.
- Tests: server-runtime service/supervisor tests, Host workflow tests, and CLI
  detach focused tests.

- Status: Verified
- Date: 2026-07-11T13:30:00+0800
- Scope: Package E supervisor restart rebuilds non-terminal candidates from
  durable workflow records and resumes through an already claimed writer;
  in-memory owner maps are not recovery truth.
- Read: `packages/server-runtime/src/workflow-supervisor.ts`,
  `packages/agent-runtime/src/workflows/store.ts`,
  `packages/host/src/runtime.ts`, and focused tests.
- Tests: agent-runtime/server-runtime/Host Package E focused and release gates.

- Status: Verified
- Date: 2026-07-11T13:00:00+0800
- Scope: `workflow.resume` is now a compatibility adapter that durably enqueues
  `resume_request` before Host dispatch; applied controls recover from canonical
  workflow event metadata after mutation/outcome crash windows.
- Read: `packages/host/src/runtime.ts`,
  `packages/agent-runtime/src/workflows/control-processor.ts`,
  `packages/agent-runtime/test/workflow-control.test.ts`,
  `packages/host/test/workflows.test.ts`.
- Tests: Package D focused resume/control/recovery tests and release gate
  recorded in the workflow durable-jobs test map.

- Status: Verified
- Date: 2026-07-11T10:40:00+0800
- Scope: Package C workflow resume claims a higher journal generation, rereads
  canonical state, consumes waiting input through a fenced mutation, and uses
  an auditable compensating mutation on preparation/start failure.
- Read: Host resume/runtime paths, workflow store/journal, Host workflow tests.
- Tests: Host workflow/protocol 79 tests; agent-runtime workflow/doc-store 32
  tests; CLI workflow slice 13 tests.

- Status: Verified
- Date: 2026-07-11T00:00:00+0800
- Scope: Package B workflow resume preserves the original isolated job session
  and authorization snapshot.
- Read: Host workflow lookup/resume, TUI resume handle construction, CLI
  workflow resume integration tests.
- Tests: host workflow/protocol suites, CLI workflow slice, TUI full suite, and
  full `npm run release:check`.

- Status: Verified
- Date: 2026-07-09T21:52:00+0800
- Scope: Workflow Job Session post-QA fix: workflow resume now keeps waiting
  input durable until host preparation succeeds and restores the prior waiting
  record on pre-run failure; matching workspace records take precedence over
  legacy session-local copies during resume lookup.
- Read: `packages/host/src/runtime.ts`,
  `packages/agent-runtime/src/workflows/store.ts`,
  `packages/host/test/workflows.test.ts`,
  `docs/_internal/project-map/maps/session/resume-replay.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/workflows.test.ts -t
"waiting notifications|prepare a run|legacy session copies|terminal
workflow|unsafe workflow"`; `npm --workspace @sparkwright/host run
typecheck`.

- Status: Verified
- Date: 2026-07-09T21:28:00+0800
- Scope: Workflow Job Session Stage D confirmed stop is terminal cancellation:
  TUI-owned live stop drives host `run.cancel`, the workflow record becomes
  `cancelled`, and later workflow resume is rejected. Waiting/cross-process
  records are not stopped from the current TUI.
- Read: `packages/tui/src/state/use-workflow-actions.ts`,
  `packages/host/src/runtime.ts`,
  `docs/_internal/project-map/maps/session/resume-replay.md`.
- Tests: PTY/pyte owned stop probe; `sparkwright workflow resume
<cancelled-id>` returned `already cancelled`.

- Status: Verified
- Date: 2026-07-09T21:22:00+0800
- Scope: Workflow Job Session Stage C keeps workflow resume as adoption of a
  non-terminal durable record, adds record authorization snapshots for resume
  prefill, and verifies terminal workflow records remain rejected.
- Read: `packages/host/src/runtime.ts`,
  `packages/agent-runtime/src/workflows/store.ts`,
  `packages/tui/src/state/run-controller.ts`,
  `packages/host/test/workflows.test.ts`.
- Tests: `npm --workspace @sparkwright/host test -- test/workflows.test.ts -t
"verifyOnResume|resumes workflow records|pinned definition|terminal
workflow"`; TUI resume PTY probe.

- Status: Read-only
- Date: 2026-07-09T21:10:00+0800
- Scope: Workflow Job Session Stage A only reads durable workflow snapshots and
  adds a TUI attach view. Workflow resume/adoption semantics, terminal rejection,
  and checkpoint/session replay behavior are unchanged.
- Read: `packages/host/src/runtime.ts`,
  `packages/tui/src/state/use-workflow-actions.ts`,
  `packages/tui/src/components/workflow-panel.tsx`,
  `docs/_internal/project-map/maps/session/resume-replay.md`.
- Tests: no resume-specific tests were run for Stage A; focused TUI/host
  snapshot gates passed.

- Status: Read-only
- Date: 2026-07-09T10:08:47+0800
- Scope: route check for TUI input P0-P2 work. Prompt draft preservation,
  printable hotkey arbitration, Esc cancel dispatch, InputBox hook extraction,
  LiveFrame extraction, hidden help command discovery, slash command frecency,
  and standalone events layer deletion do not change session switch replay,
  persisted session traces, checkpoint resume, or workflow resume semantics.
- Read: `packages/tui/src/app.tsx`,
  `packages/tui/src/components/input-box.tsx`,
  `packages/tui/src/components/use-input-buffer.ts`,
  `packages/tui/src/components/use-input-history.ts`,
  `packages/tui/src/components/live-frame.tsx`,
  `packages/tui/src/components/help-panel.tsx`,
  `packages/tui/src/lib/commands.ts`,
  `packages/tui/src/lib/keybindings.ts`,
  `packages/tui/src/components/activity-panel.tsx`,
  `docs/_internal/project-map/maps/session/resume-replay.md`.
- Tests: `npm --workspace @sparkwright/tui test`;
  `npm --workspace @sparkwright/tui run typecheck`;
  `npm run typecheck:test`; final `npm run release:check`. No resume/replay
  contract change was made.

- Status: Read-only
- Date: 2026-07-07T00:55:52+0800
- Scope: workflow nested help exits before workflow resume adoption, host run
  setup, checkpoint lookup, or session replay. Resume/replay storage and
  workflow record adoption semantics are unchanged by this fix.
- Read: `packages/cli/src/cli.ts`, `packages/cli/test/cli.test.ts`,
  `docs/_internal/project-map/maps/session/resume-replay.md`.
- Tests: `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t
"workflow nested help|nested command help"`; manual
  `node packages/cli/dist/index.js workflow resume --help`.

- Status: Verified
- Date: 2026-07-06T21:18:25+0800
- Scope: C13-② post-acceptance resume policy fix: `run.resume` and
  `workflow.resume` continuation episodes now reuse the prepared environment's
  effective confidential read policy, including workspace config values when
  protocol payload fields are omitted. Checkpoint lookup, from-trace replay,
  and workflow adoption semantics are unchanged.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/client-run.ts`,
  `packages/host/test/client-run.test.ts`,
  `packages/host/test/protocol.test.ts`.
- Tests: `npm --workspace @sparkwright/host test --
test/client-run.test.ts`; `npm --workspace @sparkwright/host test --
test/protocol.test.ts -t "confidential"`.

- Status: Read-only
- Date: 2026-07-06T20:47:10+0800
- Scope: C13-② routed-page check: run resume and workflow resume now pass
  `confidentialDefaults` to host policy construction. Checkpoint replay,
  from-trace reconstruction, session replay projection, and workflow state
  adoption semantics are unchanged.
- Read: `packages/host/src/runtime.ts`,
  `packages/cli/src/runners/host-runner.ts`, `packages/cli/src/cli.ts`,
  `packages/protocol/src/index.ts`.
- Tests: not run for resume-specific behavior; C13 focused validation ran in
  core/host/CLI/protocol.

- Status: Read-only
- Date: 2026-07-06T19:24:51+0800
- Scope: C9 S1 migration touched only the atomic writer used for
  `FileSessionStore` `session.json` saves. Checkpoint resume, from-trace
  reconstruction, session replay projection, workflow resume discovery, and TUI
  replay semantics are unchanged.
- Read: `packages/core/src/session.ts`, `packages/core/src/file-atomic.ts`,
  `packages/agent-runtime/src/doc-store/index.ts`.
- Tests: storage-focused `npm --workspace @sparkwright/core test --
test/session.test.ts` and `npm --workspace @sparkwright/agent-runtime test --
test/doc-store.test.ts`; resume-specific tests not run for this storage-only
  change.

- Status: Verified
- Date: 2026-07-05T23:09:50+0800
- Scope: workflow-runtime-v1 P9a D5 store boundary: fresh workflow runs now
  write to workspace `.sparkwright/workflow-runs/`; workflow list/resume also
  read legacy session-local stores and resume uses the located store. Core
  checkpoint replay, session replay, trace fallback, and TUI replay semantics
  were not changed.
- Read: `packages/host/src/runtime.ts`,
  `packages/agent-runtime/src/workflows/store.ts`,
  `packages/host/test/workflows.test.ts`,
  `packages/cli/test/cli.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test --
test/workflows.test.ts -t "workflow"`; `npm --workspace @sparkwright/cli test
-- test/cli.test.ts -t "lists and inspects workflow assets|resumes workflow
runs"`; `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/cli run typecheck`.

- Status: Verified
- Date: 2026-07-05T16:03:27+0800
- Scope: workflow-runtime-v1 P5 resume check: workflow resume continues to
  load the pinned `WorkflowRunRecord`; `parallelBranches` is durable record
  state restored into host projection state so `join` can resume without
  re-running branches. No checkpoint/replay fallback shape changed.
- Read: `packages/host/src/runtime.ts`,
  `packages/agent-runtime/src/workflows/store.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `packages/agent-runtime/test/workflows.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
test/workflows.test.ts`; `npm --workspace @sparkwright/host test --
test/workflow-hooks.test.ts`; `npm --workspace @sparkwright/host run
typecheck`.

- Status: Verified
- Date: 2026-07-05T11:36:37+0800
- Scope: workflow-runtime-v1 P3 Step 4a resume boundary: host run resume and
  workflow resume now route through `startWorkflowActorEpisodeChain()` after
  `startSupervisedRunChain()` deletion. Workflow resume consumes input waits at
  the actor boundary before creating the next worker episode; protocol payloads
  and checkpoint schema are unchanged.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/test/protocol.test.ts`,
  `packages/host/test/workflows.test.ts`,
  `packages/cli/test/cli.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t
"resumes a session-scoped checkpoint|fails orphaned in-process awaited
tasks|legacy run directory|workflow"`; `npm --workspace @sparkwright/host
test -- test/workflows.test.ts`; `npm --workspace @sparkwright/cli test --
test/cli.test.ts -t "workflow|run resume through the host"`.

- Status: Verified
- Date: 2026-07-05T10:13:38+0800
- Scope: workflow-runtime-v1 P3 Step 1 resume boundary: `run.resume` and
  `workflow.resume` still start ordinary host/core runs, but any todo
  continuation in the supervised chain now runs through the workflow-owned
  `runWorkflowRunChain()` driver via `runTodoSupervised()`. No protocol resume
  payload or checkpoint semantics changed.
- Read: `packages/host/src/runtime.ts`,
  `packages/agent-runtime/src/todo/supervisor.ts`,
  `packages/agent-runtime/src/workflows/run-chain.ts`,
  `packages/host/test/protocol.test.ts`,
  `packages/host/test/workflows.test.ts`.
- Tests: `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t
"workflow|resume.*todo|unfinished todos|run.resume"`; `npm --workspace
@sparkwright/host test -- test/workflows.test.ts`; `npm --workspace
@sparkwright/host run typecheck`.

- Status: Verified
- Date: 2026-07-05T09:01:34+0800
- Scope: P2 post-review resume semantics: workflow resume still adopts under a
  single-writer lease and pinned definition snapshot, but resume
  re-verification is limited to verifier nodes whose latest stored verdict is
  passed so historical failed-onFail paths are not treated as completed nodes.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/test/workflows.test.ts`,
  `packages/host/test/workflow-hooks.test.ts`.
- Tests: `npm --workspace @sparkwright/host test --
test/workflows.test.ts -t "workflow"`; `npm --workspace @sparkwright/host
test -- test/workflow-hooks.test.ts -t "resume|workflow
projection|projection"`; `npm run typecheck:test`.

- Status: Verified
- Date: 2026-07-05T00:42:02+0800
- Scope: workflow-runtime-v1 P2 resume path: durable workflow resume is a
  separate host/CLI surface from core checkpoint resume and session replay; it
  adopts a `WorkflowRunRecord` under a single-writer lease, starts a new run in
  the same session, and re-verifies completed command-verifier nodes by default.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/cli/src/cli.ts`,
  `packages/host/test/workflows.test.ts`,
  `packages/host/test/workflow-hooks.test.ts`.
- Tests: `npm --workspace @sparkwright/host test --
test/workflows.test.ts test/workflow-hooks.test.ts -t "workflow"`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "workflow"`.

- Status: Verified
- Date: 2026-07-02T01:15:00+0800
- Scope: documented that background-task revival `waiting_tasks` is not durable
  checkpoint state yet, so P4+ CLI detach/resume remains deferred until awaited
  task revival can be reconstructed from durable state.
- Read: `packages/core/src/run.ts`,
  `docs/_internal/proposals/background-task-lifecycle.md`,
  `docs/_internal/project-map/maps/session/resume-replay.md`.
- Tests: core run-loop waiting-task focused tests; no resume behavior change
  was implemented.

- Status: Verified
- Date: 2026-06-29T17:40:00+0800
- Scope: CLI `run resume --help` is side-effect-free help output and does not
  enter checkpoint lookup, host resume validation, or session/trace creation.
  Resume storage semantics did not change.
- Read: `packages/cli/src/cli.ts`, `packages/cli/test/cli.test.ts`,
  `docs/_internal/project-map/maps/session/resume-replay.md`.
- Tests: `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t
"help|run resume"`; `node packages/cli/dist/index.js run resume --help`;
  `npm run check:dist-fresh`.

- Status: Verified
- Date: 2026-06-29T09:28:39+0800
- Scope: checked after tool display/name consolidation; resume/replay storage,
  checkpoint lookup, and session replay semantics did not change.
- Read: `packages/cli/src/cli.ts`,
  `packages/host/src/runtime.ts`,
  `packages/core/src/context.ts`,
  `docs/_internal/project-map/maps/session/resume-replay.md`.
- Tests: `npm --workspace @sparkwright/cli test -- test/cli.test.ts test/config-schema.test.ts`;
  `npm --workspace @sparkwright/core test -- test/context.test.ts test/run.test.ts test/trace.test.ts`.

- Status: Verified
- Date: 2026-06-26T23:59:00+0800
- Scope: `run.resume` accessMode/ceiling projection at the host boundary; no
  change to checkpoint replay semantics.
- Read: `packages/core/src/run.ts`, `packages/core/src/trace.ts`,
  `packages/core/src/session.ts`, `packages/core/src/session-compaction.ts`,
  `packages/host/src/runtime.ts`, `packages/host/src/run-access.ts`,
  `packages/cli/src/cli.ts`, `packages/tui/src/state/run-controller.ts`.
- Tests: `npm --workspace @sparkwright/host test -- test/run-access.test.ts test/protocol.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts`;
  `npm run build`; `npm run check:dist-fresh`.
