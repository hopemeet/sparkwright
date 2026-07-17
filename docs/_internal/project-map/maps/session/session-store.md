# Session Store

## Purpose

The session store groups related runs and records session-local facts. It gives
CLI, TUI, host, and diagnostics a stable place to find a conversation/work unit.

See [../trace/raw-trace.md](../trace/raw-trace.md) for raw event evidence.

## Last Verified

- Status: Verified
- Date: 2026-07-17T17:20:00+0800
- Scope: canonical Workflow journal records now require generation/revision,
  source layer, package hash policy 2, package hash, executable snapshot
  reference, and a matching snapshot-backed definition. No baseline record or
  Markdown-hash durable identity is imported during replay.
- Read: Workflow store/journal/types, Host list/resume, durable-job coverage,
  and package-identity designs.
- Tests: Agent Runtime Workflow focused tests, Host Workflow/protocol tests,
  and repository test typecheck passed before the full release gate.

- Status: Verified
- Date: 2026-07-16T22:26:54+0800
- Scope: Workflow durable state now has one workspace journal layout; record
  JSON/event JSONL sidecars, mirrors, readers, and lazy import are gone.
- Read: workflow store/journal, Host/CLI/TUI consumers, restart/list/event tests,
  and current protocol/design docs.
- Tests: Agent Runtime workflow focused suite/typecheck; Host workflow/protocol
  focused suites/typecheck; repository test typecheck; full release gate.

- Status: Verified
- Date: 2026-07-16T14:10:00+0800
- Scope: Run persistence is single-layout: `FileRunStore`, Host lookup, CLI lookup, examples, and tests now use only the canonical session/agent/run tree.
- Read: Core trace store/tests, Host and CLI resume lookup, coding-tools state exclusion, protocol references, and subprocess examples.
- Tests: Core trace/interfaces focused tests; Host/CLI/coding-tools focused tests; npm run build; npm run typecheck:test; npm run release:check.

- Date: 2026-07-16T13:50:10+0800
- Scope: Workflow state is no longer a session-directory child; canonical records live only under workspace `.sparkwright/workflow-runs/` and retain `sessionId` as record attribution.
- Read: workflow store helpers, Host list/resume consumers, focused tests, and current layout docs.
- Tests: npm run build; npm run typecheck:test; Agent Runtime workflow tests (25); Host workflow/protocol tests (94).

- Date: 2026-07-16T13:36:30+0800
- Scope: Session traces no longer contain validation-hook lifecycle spans; current `validation.failed` diagnostics remain persisted without layout changes.
- Read: Core event/trace codecs, session storage, schemas, and trace tests.
- Tests: focused trace/session tests; npm run build; npm run typecheck:test; npm run release:check.

- Date: 2026-07-16T12:45:00+0800
- Scope: Run metadata and Workflow authorization snapshots persist canonical accessMode rather than duplicate permission/write fields.
- Read: routed production sources, focused tests, protocol/config schemas, and current user/reference documentation.
- Tests: focused access/policy/protocol/CLI/TUI/ACP/Workflow tests; npm run typecheck:test; npm run schema:check.

- Date: 2026-07-16T11:52:29+0800
- Scope: reviewed protocol 2.0 terminal failure envelope changes; session
  persistence remains owned by Core event and trace contracts and does not read
  the removed Host wire-level `run.failed.error` projection.

## Main Files

- `packages/core/src/session.ts`
- `packages/core/src/session-compaction.ts`
- `packages/core/src/trace.ts`
- `packages/core/src/trace-store.ts`
- `packages/core/src/trace-diagnostics.ts`
- `packages/core/src/trace-session-consistency.ts`
- `packages/host/src/runtime.ts`
- `packages/host/src/runtime/host-runtime.ts`
- `docs/reference/STATE_AND_TRACE_MODEL.md`

## Data Flow

```txt
Host chooses/validates sessionId
  -> FileSessionStore.create/append/appendEvent
  -> session.json + events.jsonl
  -> FileRunStore (trace-store.ts) writes session trace/transcript and agent run files

Fresh workflow run state
  -> FileWorkflowStore publishes checksummed entries under
     <workspace>/.sparkwright/workflow-runs/<workflowRunId>.journal/
  -> journal replay derives the current record, canonical events, generation,
     revision, and quarantine diagnostics
  -> <workspace>/.sparkwright/workflow-runs/<workflowRunId>.lease/

Fresh workflow job execution
  -> unique <sessionRoot>/session_workflow_*/ session + run/trace/checkpoint files
  -> WorkflowRunRecord.sessionId is the job storage identity
  -> WorkflowRunRecord.metadata.controlSessionId is attribution only

Manual compact
  -> compactSessionTurns()
  -> compact.json
  -> later runs seed compact context when throughRunId is anchored
```

## Contracts

- Default root: `<workspace>/.sparkwright/sessions`.
- `session.json` contains id, timestamps, ordered `runIds`, metadata, and event count.
- `events.jsonl` contains append-only `SessionEvent` rows with session-local sequence.
- `session.compaction.completed` / `session.compaction.skipped` are
  session-local durable audit events for host `session.compact`; they record
  counts, `freedChars`, `measurement`, `artifactPath`, optional
  `skippedReason`, warning codes, and host/reason metadata, but not compacted
  summary content.
- `session inspect --compaction` reads `compact.json` plus `events.jsonl`
  session compaction events and reports artifact/event consistency without
  returning `compact.json.content`.
- TUI `/sessions` inspect requests the same compaction audit report and renders
  it as diagnostics; it does not make TUI state canonical storage.
- TUI keeps the selected session immutable while its main run is starting or
  active. New-session, switch, and fork-and-switch entrypoints fail at the
  controller boundary; read-only list/inspect/export flows remain available.
- `FileRunStore` always writes session `trace.jsonl` /
  `transcript.jsonl`, `agents/<agent-id>/trace.jsonl`, per-run `run.json` /
  `result.json`, and `trace-pointer.json` files that point from each run
  directory back to the aggregate session and agent traces. It requires a
  session identity and has no standalone `.sparkwright/runs/` layout.
- Transcript prompt entries store leading system messages only in the canonical
  session `blobs/<systemRef>.json` store. `restoreTranscriptPrompts()` requires
  that blobs directory and does not read inline system-prefix/hash variants.
- Session list previews extract the goal from canonical prompt `messages` only;
  top-level transcript `content` is not an alternate preview format.
- `FileSessionStore` writes `session.json` through core `file-atomic`, the same
  lower-level atomic text writer wrapped by `agent-runtime` doc-store, because
  core cannot depend upward on runtime packages.
- Workflow records live under workspace-level
  `.sparkwright/workflow-runs/`; each record retains `sessionId` so session
  filters and resume context remain available. Each workflow run has one
  immutable checksummed journal plus a token lease path. `FileWorkflowStore`
  derives records, events, generation/revision, and invalid-entry diagnostics
  from journal replay; quarantined entries do not wedge list/resume or advance
  canonical state. Mutation records without the required v2 executable package
  pin are quarantined rather than defaulted or migrated.
- TUI and CLI fresh workflow-job entrypoints allocate a unique safe job session
  instead of writing into a selected/control session. The job session does not
  inherit control-session scrollback. Resume requires and reuses the persisted
  `WorkflowRunRecord.sessionId`; missing identity is a diagnostic failure, not a
  fallback to the caller's current session.
- Manual session compact writes `compact.json` as a `session-compact.v2`
  artifact only when there is net savings. The artifact stores source run ids,
  `throughRunId`, original/summary char counts, top-level `freedChars`, and
  host metadata such as applied/skipped stages and measurement. If explicit Tier
  3 summarization is requested, provider/scripted refs can write model-backed
  summaries with `summaryFingerprint`; deterministic refs record preview output
  plus a warning.
- `trace-session-consistency.ts` owns `validateSessionTraceConsistency` and
  checks agreement between session files, trace metadata, run files, and
  safety-relevant failures while reusing diagnostics parse/summary helpers;
  `trace.ts` re-exports it through the stable facade.
- `repairSessionTraceConsistency` only repairs derived session metadata; it does not invent missing run/result files.

## Consumers

- Host `session.list`, `session.inspect`, `session.compact`, `session.fork`.
- CLI `session summary|inspect|check|repair|compact|resume`.
- TUI session list, switch, inspect, fork, compact, export.

## Change Checklist

- Keep `sessionId`, `runId`, and `SessionEvent.sequence` semantics separate.
- Update trace consistency checks when layout or metadata changes.
- Preserve unknown `session.json` metadata when file stores reopen existing sessions.
- Check multi-agent paths under `agents/<agent-id>/`.
- Keep compact artifacts additive; do not rewrite `trace.jsonl`,
  `transcript.jsonl`, or run `result.json` during compaction.

## Known Debts

- File-backed session updates are best-effort and not a full database transaction model.
- Session metadata should make terminal run state easier to inspect.
- Ordinary IM bindings, subscriptions, outbox cursors, and lane commands remain
  in-memory Host control state; they are not part of the session store and are
  not restart-recovered in this phase. New IM self-bindings receive Host-issued
  session ids rather than selecting arbitrary existing session-store records.

## Last Verified

- Status: Verified
- Date: 2026-07-16T10:44:25+0800
- Scope: reviewed Task model-surface consolidation; durable Task storage and
  Host task protocol reads are unchanged.
- Read: Task action handlers, Task stores, Host protocol, and session boundaries.
- Tests: agent-runtime Task 69/69 and Host protocol/Agent-task 61/61 passed.

- Status: Verified
- Date: 2026-07-15T07:35:27+0800
- Scope: doctor session/task path reporting now uses a shared resolution leaf;
  store roots, persistence, cleanup, and Host ownership are unchanged.
- Read: CLI config-doctor/config-paths and facade callers.
- Tests: doctor/config focused and full CLI golden.

- Status: Read-only
- Date: 2026-07-15
- Scope: capability/delegate command relocation reuses the composition-root
  HostService and preserves session roots, stores, persistence, and cleanup.
- Read: CLI facade and capability command HostService parameter.
- Tests: full CLI golden.

- Status: Verified
- Date: 2026-07-15
- Scope: CLI session diagnostics moved to a domain module while reusing the
  single composition-root HostService; store paths, compact/inspect behavior,
  persistence, and cleanup are unchanged.
- Read: CLI trace-session module, CLI facade, Host session APIs.
- Tests: CLI session focused slice and full CLI golden.

- Status: Verified
- Date: 2026-07-15
- Scope: HostRuntime relocation leaves session-root resolution, stores,
  WorkspaceContext ownership, and persistence unchanged.
- Read: runtime facade, concrete runtime constructor, WorkspaceContext.
- Tests: Host execution/service/protocol focused suites.

- Status: Read-only
- Date: 2026-07-15
- Scope: runtime construction types moved to a leaf; session root resolution,
  WorkspaceContext ownership, stores, and persistence are unchanged.
- Read: runtime contracts, Host runtime constructor, WorkspaceContext.
- Tests: Host execution/service/protocol focused suites.

- Status: Verified
- Date: 2026-07-14
- Scope: Host principal/auth isolation changes only process-memory ordinary IM
  bindings and replay authorization; new bindings cannot select arbitrary
  session-store records, and session/Workflow storage formats are unchanged.
- Tests: Host focused suites passed; no session-store migration required.

- Status: Verified
- Date: 2026-07-14T14:35:00+0800
- Scope: P6 routed review; FileSessionStore remains canonical session truth and
  extracted query/compaction functions use the same store and artifact format.
- Tests: Host session/compaction coverage passed.

- Status: Verified
- Date: 2026-07-14
- Scope: reviewed Host-owned IM retention/replay; ordinary IM control state is
  explicitly process-local while existing session and Workflow stores remain
  unchanged.

- Status: Verified
- Date: 2026-07-14
- Scope: reviewed Host workspace contexts and session lane keys; session stores
  remain per execution and in-memory lane queues are not durable state.

- Status: Read-only
- Date: 2026-07-13
- Scope: checked ACP prepared invocation cleanup; session ids, run persistence,
  trace paths, and stored formats are unchanged.
- Read: ACP worker/Host delegate runner and session persistence boundary.
- Tests: ACP/Host focused tests and CLI delegate tests passed.

- Status: Read-only
- Date: 2026-07-13
- Scope: checked Host security-plan and CLI inspect refactor; session roots,
  records, trace paths, and storage formats did not change.
- Read: Host prepared environment/session-store assembly and CLI inspect path.
- Tests: Host protocol focused tests passed; no session schema changed.

- Status: Read-only
- Date: 2026-07-12T20:00:00+0800
- Scope: checked read-only asset statistics session scanning; session storage
  layout and ownership are unchanged.
- Read: CLI stats handlers, host asset scanner, `FileSessionStore` usage.
- Tests: covered by the full release gate; no map contract change needed.

- Status: Read-only
- Date: 2026-07-12
- Scope: checked CLI reconciliation routing; session-store contract is unchanged.
- Tests: focused CLI tests and the 2026-07-15 release gate passed.

- Status: Read-only
- Date: 2026-07-12T16:36:08+0800
- Scope: checked Workflow durable package snapshot fields; session-store contracts are unchanged.
- Tests: not run for session-store-specific behavior; Phase 4 Workflow release gate passed.

- Status: Verified
- Date: 2026-07-11T18:30:00+0800
- Scope: async/sync journal replay now shares one transition function and each
  publisher verifies its own physical sequence supplied the canonical record;
  storage layout is unchanged.
- Read: workflow journal/store implementation and concurrency tests.
- Tests: focused tests and 20 combined stress runs.

- Status: Verified
- Date: 2026-07-11T15:30:00+0800
- Scope: Package G adds sibling `<workflowRunId>.channels/` binding,
  revocation, per-attempt delivery receipt, and rebuildable cursor projections;
  workflow journal/outbox remain canonical state/message truth.
- Read: `packages/agent-runtime/src/workflows/channels.ts`,
  `packages/agent-runtime/src/workflows/notifications.ts`,
  `packages/server-runtime/src/workflow-channel-coordinator.ts`.
- Tests: Package G channel store/coordinator focused tests and affected builds.

- Status: Verified
- Date: 2026-07-11T14:30:00+0800
- Scope: Package F stores service carrier state and handoff/outcome under
  workspace `.sparkwright/workflow-service/`; detached workflow sessions remain
  unique `session_workflow_*` roots and keep control-session attribution only.
- Read: `packages/server-runtime/src/workflow-service.ts`,
  `packages/cli/src/cli.ts`, `packages/host/src/runtime.ts`.
- Tests: server-runtime service tests, Host fixed-id workflow test, CLI detach
  focused tests.

- Status: Verified
- Date: 2026-07-11T13:00:00+0800
- Scope: each workflow now has a sibling `<workflowRunId>.control/` durable
  command directory with immutable commands/outcomes and a rebuildable cursor;
  the Package C workflow journal remains canonical apply truth.
- Read: `packages/agent-runtime/src/workflows/control.ts`,
  `packages/agent-runtime/src/workflows/control-processor.ts`,
  `packages/agent-runtime/src/workflows/store.ts`,
  `packages/host/src/runtime.ts`.
- Tests: Package D persistence/restart/corruption focused tests and release gate
  recorded in the workflow durable-jobs test map.

- Status: Verified
- Date: 2026-07-11T10:40:00+0800
- Scope: Package C makes `.sparkwright/workflow-runs/<id>.journal/` the
  canonical workflow mutation history. `<id>.json` and `<id>.events.jsonl`
  remain compatibility/inspection projections rebuilt from the journal.
- Read: workflow store/journal/doc-store implementation and focused tests.
- Tests: agent-runtime workflow/doc-store 32 tests; Host workflow/protocol 79
  tests; affected typecheck/build.

- Status: Verified
- Date: 2026-07-11T00:00:00+0800
- Scope: Package B independent workflow job session layout and control-session
  attribution; no FileSessionStore locking rewrite.
- Read: TUI/CLI job start paths, host workflow record creation/resume, session
  integration tests.
- Tests: TUI two-job isolation test, CLI explicit-control-session test, host
  workflow/protocol suites, affected typechecks/builds.

- Status: Verified
- Date: 2026-07-11T00:00:00+0800
- Scope: Package A TUI active-execution session mutation guard; session file
  layout and persistence semantics are unchanged.
- Read: `packages/tui/src/state/run-controller.ts`,
  `packages/tui/src/state/use-session-actions.ts`, focused tests.
- Tests: TUI session-mutation focused tests, full TUI suite, and TUI typecheck.

- Status: Read-only
- Date: 2026-07-07T00:55:52+0800
- Scope: workflow nested help now exits before workflow subcommand execution;
  `workflow resume --help` and other workflow help paths do not create session
  roots, traces, workflow-run records, or compaction artifacts.
- Read: `packages/cli/src/cli.ts`, `packages/cli/test/cli.test.ts`,
  `docs/_internal/project-map/maps/session/session-store.md`.
- Tests: `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t
"workflow nested help|nested command help"`; manual
  `node packages/cli/dist/index.js workflow
list|inspect|resume|distill|shadow --help`.

- Status: Read-only
- Date: 2026-07-06T20:47:10+0800
- Scope: C13-② routed-page check: protocol and CLI resume payloads gained a
  read-policy override, but session file layout, session events, compaction
  artifacts, and replay consumers are unchanged.
- Read: `packages/protocol/src/index.ts`, `packages/cli/src/cli.ts`,
  `packages/host/src/runtime.ts`, `packages/core/src/session.ts`.
- Tests: not run for session-store-specific behavior; C13 focused validation
  ran in core/host/CLI/protocol.

- Status: Verified
- Date: 2026-07-06T19:24:51+0800
- Scope: C9 S1 migration: `FileSessionStore.writeSession()` now composes core
  `file-atomic` for `session.json` writes, retiring the private
  `packages/core/src/session.ts` tmp+retry+rename copy. Session layout,
  `SessionEvent.sequence`, compaction artifacts, and replay consumers are
  unchanged.
- Read: `packages/core/src/session.ts`, `packages/core/src/file-atomic.ts`,
  `packages/core/src/internal.ts`,
  `packages/agent-runtime/src/doc-store/index.ts`,
  `docs/_internal/proposals/consolidation-agenda.md`,
  `docs/_internal/proposals/substrate-sequencing.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/session.test.ts`;
  `npm --workspace @sparkwright/agent-runtime test -- test/doc-store.test.ts`;
  `npm --workspace @sparkwright/core run typecheck`; `npm --workspace
@sparkwright/agent-runtime run typecheck`.

- Status: Verified
- Date: 2026-07-05T22:37:13+0800
- Scope: workflow-runtime-v1 P9a session/workspace storage boundary: fresh
  workflow records moved to workspace-level `.sparkwright/workflow-runs/` while
  legacy session-root workflow records remain readable/resumable. Session
  traces, session events, todo ledgers, and compaction artifacts stay under the
  session root.
- Read: `packages/agent-runtime/src/workflows/store.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/test/workflows.test.ts`,
  `docs/reference/HOST_PROTOCOL.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/workflows.test.ts -t
"workflow"`; `npm --workspace @sparkwright/agent-runtime test --
test/workflows.test.ts -t "FileWorkflowStore|workflow-run roots"`.

- Status: Read-only
- Date: 2026-07-05T22:20:59+0800
- Scope: workflow-runtime-v1 P8a routed-page check: `workflow shadow` reads an
  existing `<sessionRoot>/<sessionId>/trace.jsonl` through host trace helpers
  and does not write `session.json`, `events.jsonl`, workflow-run records, or
  compaction artifacts.
- Read: `packages/host/src/workflow-shadow.ts`,
  `packages/cli/src/cli.ts`,
  `packages/host/test/workflow-shadow.test.ts`,
  `packages/cli/test/cli.test.ts`.
- Tests: `npm --workspace @sparkwright/host test --
test/workflow-shadow.test.ts test/workflow-distill.test.ts`; `npm
--workspace @sparkwright/cli test -- test/cli.test.ts -t "shadows a workflow
asset|distills a session trace|lists and inspects workflow assets"`.

- Status: Verified
- Date: 2026-07-05T00:42:02+0800
- Scope: workflow-runtime-v1 P2 session layout: `workflow-runs/` is now the
  session-local durable workflow state directory beside trace/run artifacts,
  with record JSON, event JSONL, and single-writer lease paths composed from
  agent-runtime doc-store primitives.
- Read: `packages/agent-runtime/src/workflows/store.ts`,
  `packages/host/src/runtime.ts`,
  `packages/agent-runtime/test/workflows.test.ts`,
  `packages/host/test/workflows.test.ts`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
test/workflows.test.ts test/doc-store.test.ts`; `npm --workspace
@sparkwright/host test -- test/workflows.test.ts`.

- Status: Verified
- Date: 2026-06-29T09:28:39+0800
- Scope: checked after tool surface consolidation; session storage layout,
  identifiers, and append-only event semantics did not change.
- Read: `packages/protocol/src/index.ts`,
  `packages/core/src/run-health.ts`,
  `packages/cli/src/cli.ts`,
  `docs/_internal/project-map/maps/session/session-store.md`.
- Tests: `npm --workspace @sparkwright/cli test -- test/cli.test.ts test/config-schema.test.ts`;
  `npm --workspace @sparkwright/core test -- test/context.test.ts test/run.test.ts test/trace.test.ts`.

- Status: Verified
- Date: 2026-06-26T23:59:00+0800
- Scope: checked run metadata/session artifact impact from `accessMode` ceiling;
  session store layout is unchanged.
- Read: `packages/core/src/session.ts`, `packages/core/src/trace.ts`,
  `packages/core/src/trace-store.ts`,
  `packages/core/src/trace-diagnostics.ts`,
  `packages/core/src/trace-session-consistency.ts`,
  `packages/core/src/trace-codec.ts`, `packages/core/src/index.ts`,
  `packages/core/src/internal.ts`, `packages/host/src/runtime.ts`,
  `packages/host/src/server.ts`, `packages/protocol/src/index.ts`,
  `packages/cli/src/cli.ts`, `packages/tui/src/state/run-controller.ts`,
  `packages/tui/src/components/session-list-dialog.tsx`,
  `packages/host/src/run-access.ts`,
  `packages/core/test/trace.test.ts`, `packages/host/test/protocol.test.ts`,
  `packages/cli/test/cli.test.ts`,
  `packages/tui/test/session-list-dialog-render.test.tsx`,
  `packages/tui/test/sdk-cutover.test.ts`,
  `docs/_internal/project-map/designs/trace-diagnostics-refactor.md`,
  `docs/_internal/project-map/maps/trace/raw-trace.md`,
  `docs/_internal/project-map/maps/trace/summary-timeline-verify.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/run-access.test.ts test/protocol.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts`;
  `npm --workspace @sparkwright/tui test -- test/sdk-cutover.test.ts`;
  `npm run build`; `npm run check:dist-fresh`.
