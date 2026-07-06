# Session Store

## Purpose

The session store groups related runs and records session-local facts. It gives
CLI, TUI, host, and diagnostics a stable place to find a conversation/work unit.

See [../trace/raw-trace.md](../trace/raw-trace.md) for raw event evidence.

## Main Files

- `packages/core/src/session.ts`
- `packages/core/src/session-compaction.ts`
- `packages/core/src/trace.ts`
- `packages/core/src/trace-store.ts`
- `packages/core/src/trace-diagnostics.ts`
- `packages/core/src/trace-session-consistency.ts`
- `packages/host/src/runtime.ts`
- `docs/reference/STATE_AND_TRACE_MODEL.md`

## Data Flow

```txt
Host chooses/validates sessionId
  -> FileSessionStore.create/append/appendEvent
  -> session.json + events.jsonl
  -> FileRunStore (trace-store.ts) writes session trace/transcript and agent run files

Fresh workflow run state
  -> FileWorkflowStore writes <workspace>/.sparkwright/workflow-runs/<workflowRunId>.json
  -> <workspace>/.sparkwright/workflow-runs/<workflowRunId>.events.jsonl
  -> <workspace>/.sparkwright/workflow-runs/<workflowRunId>.lease/

Legacy workflow run state
  -> <sessionRoot>/<sessionId>/workflow-runs/ remains list/resume compatible

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
- Session-scoped `FileRunStore` writes session `trace.jsonl` /
  `transcript.jsonl`, `agents/<agent-id>/trace.jsonl`, per-run `run.json` /
  `result.json`, and `trace-pointer.json` files that point from each run
  directory back to the aggregate session and agent traces.
- `FileSessionStore` writes `session.json` through core `file-atomic`, the same
  lower-level atomic text writer wrapped by `agent-runtime` doc-store, because
  core cannot depend upward on runtime packages.
- Fresh workflow records live under workspace-level
  `.sparkwright/workflow-runs/`; each record retains `sessionId` so session
  filters and resume context remain available. Legacy
  `<sessionRoot>/<sessionId>/workflow-runs/` records remain list/resume
  compatible. Each workflow run has a JSON record, a JSONL event log, and a
  token lease path; corrupt record/log entries are skipped with diagnostics by
  `FileWorkflowStore` rather than wedging workflow list/resume.
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

## Last Verified

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
