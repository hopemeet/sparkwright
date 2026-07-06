# Protocol

## Purpose

`@sparkwright/protocol` defines host/client wire contracts: requests,
responses, errors, host events, permission modes, trace levels, and capability
inspection shapes.

See also [../maps/safety/approvals.md](../maps/safety/approvals.md) and [../maps/session/session-store.md](../maps/session/session-store.md).

## Main Files

- `packages/protocol/src/index.ts`
- `packages/protocol/test/index.test.ts`
- `schemas/host-message.schema.json`
- `docs/reference/HOST_PROTOCOL.md`
- `docs/reference/PROTOCOL.md`

## Owns / Does Not Own

Owns:

- host request and response TypeScript shapes
- stable host event payload shapes
- protocol-level error codes
- capability snapshot types
- shared file-trace event visibility vocabulary for product filters
- shared client-side run-event visibility constants that must stay consistent
  across CLI/TUI products

Does not own:

- implementation of host runtime behavior
- file trace JSONL event schema
- CLI/TUI rendering layout or product-specific event formatting

## Contracts

- Request kinds include `run.start`, `run.resume`, `run.inject_message`,
  `run.cancel`, `approval.resolve`, `session.list`, `session.inspect`,
  `session.fork`, `session.compact`, `capability.inspect`, and durable
  background-task inspection requests `task.list`, `task.get`, `task.output`,
  `task.stop`, plus host-facing task controls `task.join` and `task.promote`,
  and durable workflow requests `workflow.list` / `workflow.resume`.
- Task inspection responses use snapshot/poll contracts: `TaskRecordSnapshot`
  for durable task records, `TaskOutputChunkSnapshot` for buffered stdout/stderr
  chunks, and `task_not_found` as the protocol error code for missing task ids.
  `task.list` reads the host's workspace task store by default; clients pass
  `parentRunId` when they need a run-local view.
- `TaskRecordSnapshot` includes `awaited` so clients can distinguish tasks that
  still participate in run revival from detached/background history.
- `session.compact` response results include `freedChars`, optional
  `skippedReason`, optional `warnings`, and `measurement` alongside the session
  id, compacted run count, through run id, char counts, and artifact path.
- `session.compact` payloads may include optional `llm: true` to request the
  Tier 3 session summarizer path. Provider/scripted model refs can run the
  model-backed summarizer; deterministic refs use the preview path and return a
  deterministic-preview warning in `warnings`.
- `session.inspect` payloads may include optional `compaction: true` to include
  a `SessionCompactionInspectReport` derived from `compact.json` and
  session-local compaction events. The report includes audit metadata and
  event/artifact consistency, not compacted summary content.
- `capability.inspect` payloads may include optional `model` to ask the host to
  resolve capability/model diagnostics for an active runtime model override.
  Omitted means the host default/config model.
- `CapabilitySnapshot.workflows` is an optional diagnostic inventory of
  host-discovered workflow assets and parse errors. It is not a workflow run
  state channel and does not imply execution support.
- `workflow.list` returns durable `WorkflowRunSnapshot` entries from the
  session root, optionally scoped by `sessionId`, `status`, and `limit`; corrupt
  workflow record entries are reported as invalid entries instead of aborting
  the whole list. `workflow.resume` adopts a non-terminal workflow run by
  `workflowRunId` plus optional `sessionId`; it has no `force` field because
  terminal workflow records are not resurrected in P2. In P3 Step 3,
  `WorkflowRunSnapshot.status:"waiting"` is active for human nodes and includes
  the durable `wait` payload; `workflow.resume` consumes `input` waits as the
  actor input event without adding a new wire request kind. P3 Step 4a changes
  only the host driver behind `workflow.resume`, not the protocol payload.
- `run.start` and `run.inject_message` keep their text fields (`goal` and
  `content`) as required user-turn summaries and may add `input.parts` for
  extensible text/image/file/audio content.
- `run.start` may include optional `workflow`, the workflow asset name to
  instantiate for that run. The field is additive and ignored when absent; P1.5
  removes the former experimental host gate.
- `run.start` and `run.resume` may include `backgroundTasks`
  (`disabled`, `foreground-only`, `enabled`). Host validates and clamps it; the
  protocol only carries the requested run policy.
- `traceLevel` is a protocol field on run start/resume. Valid values are
  `standard` and `debug`.
- `RunAccessMode` is the shared high-level run access preset
  (`read-only`, `ask`, `accept-edits`, `bypass`). `compileRunAccessMode()`
  maps it to the legacy execution fields `permissionMode` and `shouldWrite`;
  `dont_ask` remains only a legacy `PermissionMode` and is not a run access
  mode because it denies approval-required actions instead of auto-approving
  them.
- `shouldWrite` is the run start/resume write-capability gate. When it is
  `false`, write-capable requests are denied by policy rather than represented
  as a separate read-only approval-escalation protocol field.
- `INTERNAL_TRANSCRIPT_EVENT_TYPES` / `isInternalTranscriptEventType()` are the
  shared low-signal event filter used by TUI live transcript rendering and
  `/export`; this is product transcript visibility, not raw trace semantics.
  `run.budget.exceeded` is filtered here as runtime machinery even though it is
  kept visible in live CLI output.
- `LIVE_DEBUG_NOISE_EVENT_TYPES` / `isLiveDebugNoiseEventType()` are the shared
  high-volume event filter for CLI live run output; raw trace diagnostics still
  expose those events. The list currently includes `model.stream.chunk` and
  `run.budget.checked`.
- `RunFailureEnvelope` is the shared terminal failure shape. `run.completed` may
  carry optional `failure` for `failed`/`cancelled` states; `run.failed` carries
  canonical `failure` plus deprecated compatibility `error`. Consumers should use
  `getRunFailure()` / `runFailureMessage()` instead of hand-reading event payload
  variants. `runFailureMessage()` also falls back to legacy root
  `message`/`reason`/`stopReason` fields for display, without broadening
  `getRunFailure()` enough to treat clean completed answers as failures.
- `approvalId` from `approval.requested` is resolved by `approval.resolve`.
- `CapabilityDelegateToolSummary.protocol` covers `acp`,
  `external_command`, and configured in-process delegates as `in_process`.
  `command`/`args` are optional because in-process delegates do not spawn a
  separate process.
- `CapabilityDelegateToolSummary.risk` reflects the delegate tool's effective
  spawn policy (`safe`/`risky`/`denied`); in-process spawn is safe by default
  while child-run tools retain their own policy gates.
- `CapabilityDelegateToolSummary.model` is optional and reports the delegate
  profile's preferred model when one is declared; omitted means the delegate
  inherits the parent run model.
- `CapabilityDelegateToolSummary.routing` is optional and reports delegate
  routing hints/evaluation (`keywords`, and after a run-goal evaluation:
  `mode: "sort"`, `relevance`, `score`, `matchedKeywords`, `reason`). This is
  diagnostic/capability metadata only; clients must not infer hidden tools or
  permission changes from it.
- `CapabilityDelegateToolSummary.requiresApproval` is a legacy config echo.
  Diagnostics should prefer conditional approval facts:
  `approvalRequiredUnderCurrentRun`, `approvalReasons`, and
  `approvalRunOptions`.
- `CapabilitySnapshot.model` is optional startup/capability diagnostic data.
  Its `pricing` object reports `configured`/`builtin`/`unavailable`/
  `not_applicable`; `missing_pricing` is warning-only and means cost estimates
  are unavailable until config or built-in pricing is added.
- `CapabilityToolSummary.deferred` is optional and marks tools whose full schema
  loads on demand through `tool_search`.
- `CapabilitySnapshot.shell` includes the effective shell
  `foregroundTimeoutMs`, whether promotion is available for that runtime
  surface, and sandbox status.
- `CapabilitySnapshot.automation` is optional and carries bounded cron job and
  durable task summaries for capability inspection.
- `CapabilitySnapshot.rules.workflow` and `rules.events` are optional and carry
  host-owned active-rule inspection summaries. Workflow descriptors use
  canonical lifecycle strings; event descriptors use configured event triggers.
  Both report source, matcher/action summaries, blocking potential,
  enabled/active status, and hints; they are diagnostics and do not change run
  behavior. Verification/documented-command descriptors may summarize
  host-owned run-level invariants rather than user-authored workflow assets.
- Built-in verification/documented-command invariant events reuse
  `workflow.started` / terminal `workflow.*` names with
  `projectionKind:"invariant"` and `verificationSource:"profile" |
  "documented_command"`; they do not emit `workflow.node.*`.
- Config schema accepts canonical workflow lifecycle names only and separates
  non-blocking subscribers into `capabilities.hooks.events`. Workflow actions
  can be `block`, `context`, `command`, `http`, or `agent`; event actions can be
  `command`, `http`, or `agent`.
- Clients must tolerate unknown metadata.

## Consumers

- `@sparkwright/host`
- `@sparkwright/sdk-*`
- CLI and TUI host clients
- ACP adapter and IM gateway host-event bridges
- Docs in `docs/reference/`

## Change Checklist

- Update `docs/reference/HOST_PROTOCOL.md`.
- Update SDK tests.
- Check CLI/TUI request construction.
- Keep error code handling backward compatible where possible.

## Known Debts

- Protocol and file trace contracts are related but separate; avoid documenting one as the other.

## Last Verified

- Status: Read-only
- Date: 2026-07-05T22:37:13+0800
- Scope: workflow-runtime-v1 P9a protocol/docs boundary: workflow records now
  describe workspace-root fresh storage plus legacy session-root compatibility
  in `HOST_PROTOCOL.md`, but `workflow.list` / `workflow.resume` request and
  response payload shapes, host-event vocabulary, and capability advertisement
  remain unchanged.
- Read: `packages/protocol/src/index.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/test/protocol.test.ts`,
  `docs/reference/HOST_PROTOCOL.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t
  "workflow"`; `npm --workspace @sparkwright/cli run typecheck`.

- Status: Read-only
- Date: 2026-07-05T22:20:59+0800
- Scope: workflow-runtime-v1 P8a routed-page check: `workflow shadow` is a CLI
  and host-helper-only offline report. Host protocol request/response shapes,
  workflow list/resume payloads, capability snapshot schema, host-event
  vocabulary, and raw trace event vocabulary remain unchanged.
- Read: `packages/host/src/workflow-shadow.ts`,
  `packages/cli/src/cli.ts`,
  `packages/protocol/src/index.ts`,
  `packages/cli/test/cli.test.ts`.
- Tests: not run for protocol behavior; P8a made no protocol semantic change.
  Focused shadow gates passed in host/CLI.

- Status: Read-only
- Date: 2026-07-05T20:18:29+0800
- Scope: workflow-runtime-v1 P5 post-review routed-page check: explicit
  `parallel.onPass`, branch-verifier rejection, delegate_parallel infra-error
  fail-closed behavior, and workflow-store lease event cleanup are host/store
  internals. Host protocol requests/responses, workflow list/resume payloads,
  capability snapshot schema, and host-event vocabulary remain unchanged.
- Read: `packages/host/src/workflow-projection.ts`,
  `packages/agent-runtime/src/workflows/store.ts`,
  `packages/protocol/src/index.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test --
  test/workflow-hooks.test.ts -t "parallel|join|delegate_parallel|branch
  diagnostics"`; `npm --workspace @sparkwright/agent-runtime test --
  test/workflows.test.ts -t "lease"`.

- Status: Read-only
- Date: 2026-07-05T18:02:15+0800
- Scope: workflow-runtime-v1 P5 routed-page check: bounded
  `parallel` / `join` changes are host asset/projection and
  `WorkflowRunRecord` store internals. Host protocol request/response shapes,
  workflow list/resume payloads, and capability snapshot schema remain
  unchanged by the P5 fail-closed/join-source hardening.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/workflows.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/host/test/workflows.test.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/workflow-hooks.test.ts
  -t "parallel|join|delegate_parallel"`; `npm --workspace @sparkwright/host
  test -- test/workflows.test.ts test/workflow-hooks.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`.

- Status: Read-only
- Date: 2026-07-05T11:36:37+0800
- Scope: workflow-runtime-v1 P3 Step 4a protocol check: actor episode driver
  inversion and `startSupervisedRunChain()` deletion require no new request,
  response, schema, or host-event fields. Existing `run.resume`,
  `workflow.resume`, and `workflow.list` payloads remain valid.
- Read: `packages/protocol/src/index.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/test/protocol.test.ts`,
  `packages/cli/test/cli.test.ts`.
- Tests: `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t
  "resumes a session-scoped checkpoint|fails orphaned in-process awaited
  tasks|legacy run directory|workflow"`; `npm --workspace @sparkwright/cli
  test -- test/cli.test.ts -t "workflow|run resume through the host"`.

- Status: Verified
- Date: 2026-07-05T11:21:09+0800
- Scope: workflow-runtime-v1 P3 Step 3 protocol/reference surface:
  `workflow.waiting` is now emitted by human nodes, `workflow.list` waiting
  snapshots carry `wait.kind`, and `workflow.resume` consumes input waits
  through existing payload metadata rather than a new request kind or schema
  branch.
- Read: `packages/protocol/src/index.ts`,
  `packages/host/src/server.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/test/protocol.test.ts`,
  `packages/host/test/workflows.test.ts`,
  `schemas/host-message.schema.json`,
  `docs/reference/HOST_PROTOCOL.md`,
  `docs/reference/PROTOCOL.md`,
  `docs/reference/PROTOCOL_CHANGELOG.md`.
- Tests: `npm --workspace @sparkwright/protocol run typecheck`;
  `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t
  "workflow|waiting|resume|list"`; `npm --workspace @sparkwright/host test --
  test/workflows.test.ts`; `npm run schema:check`.

- Status: Verified
- Date: 2026-07-05T00:42:02+0800
- Scope: workflow-runtime-v1 P2 protocol surface: added host requests
  `workflow.list` / `workflow.resume`, `WorkflowRunSnapshot` response shape,
  JSON schema branches and fixtures, SDK-core client helpers, and reference
  protocol docs/changelogs while keeping workflow asset capability snapshots
  distinct from durable workflow run state.
- Read: `packages/protocol/src/index.ts`,
  `packages/sdk-core/src/client.ts`,
  `packages/sdk-core/test/client.test.ts`,
  `packages/host/src/server.ts`,
  `packages/host/test/protocol.test.ts`,
  `schemas/host-message.schema.json`,
  `schemas/fixtures/host-message.request.workflow-list.json`,
  `schemas/fixtures/host-message.request.workflow-resume.json`,
  `docs/reference/HOST_PROTOCOL.md`,
  `docs/reference/PROTOCOL.md`.
- Tests: `npm --workspace @sparkwright/protocol run build`;
  `npm --workspace @sparkwright/sdk-core test -- test/client.test.ts`;
  `npm --workspace @sparkwright/sdk-core run build`; `npm run schema:check`.

- Status: Verified
- Date: 2026-07-04T22:20:04+0800
- Scope: workflow-runtime-v1 D25 protocol/docs surface: RUN_EVENTS and
  PROTOCOL document `projectionKind:"invariant"` workflow terminal events,
  HOST_PROTOCOL and capability snapshot fixtures use invariant verification
  rule descriptors, and generated config schema no longer accepts
  `afterWrites.frequency`.
- Read: `packages/protocol/src/index.ts`,
  `docs/reference/HOST_PROTOCOL.md`,
  `docs/reference/PROTOCOL.md`,
  `docs/reference/RUN_EVENTS.md`,
  `schemas/config.schema.json`,
  `schemas/fixtures/host-message.capability-snapshot.json`.
- Tests: `npm run schema:check`; `npm --workspace @sparkwright/protocol run
  typecheck`; `npm run check`; `npm run release:check`.

- Status: Verified
- Date: 2026-07-04T16:47:47+0800
- Scope: workflow-runtime-v1 P1.5 protocol docs: `run.start.workflow` remains
  an additive optional workflow asset selector without the former experimental
  host gate, and capability snapshot fixtures reflect projection-backed
  verification/documented-command rule descriptors.
- Read: `packages/protocol/src/index.ts`,
  `schemas/host-message.schema.json`,
  `docs/reference/HOST_PROTOCOL.md`,
  `docs/reference/PROTOCOL.md`,
  `docs/reference/RUN_EVENTS.md`,
  `docs/reference/PROTOCOL_CHANGELOG.md`,
  `schemas/fixtures/host-message.capability-snapshot.json`.
- Tests: `npm --workspace @sparkwright/protocol run typecheck`;
  `npm run schema:check`.

- Status: Verified
- Date: 2026-07-04T12:43:33+0800
- Scope: workflow-runtime-v1 S3 protocol event addition:
  `run.budget.exceeded` is reserved in `EventType` / event schema and
  reference docs, hidden from transcript surfaces, but not classified as live
  debug noise.
- Read: `packages/protocol/src/index.ts`,
  `packages/core/src/events.ts`,
  `schemas/event.schema.json`,
  `schemas/config.schema.json`,
  `docs/reference/PROTOCOL.md`,
  `docs/reference/PROTOCOL_CHANGELOG.md`,
  `packages/cli/test/event-format.test.ts`,
  `packages/tui/test/transcript.test.ts`,
  `packages/tui/test/event-stream-render.test.ts`.
- Tests: `npm --workspace @sparkwright/protocol run build`;
  `npm --workspace @sparkwright/cli test -- test/event-format.test.ts`;
  `npm --workspace @sparkwright/tui test -- test/transcript.test.ts
  test/event-stream-render.test.ts -t "budget|internal run machinery"`.

- Status: Verified
- Date: 2026-07-04T08:16:19+0800
- Scope: protocol/schema now carry `CapabilitySnapshot.workflows` summaries
  and reserve workflow trace event names in shared visibility constants while
  keeping host protocol messages separate from file trace events.
- Read: `packages/protocol/src/index.ts`,
  `schemas/host-message.schema.json`,
  `schemas/fixtures/host-message.capability-snapshot.json`,
  `docs/reference/PROTOCOL.md`,
  `docs/reference/PROTOCOL_CHANGELOG.md`,
  `docs/reference/HOST_PROTOCOL_CHANGELOG.md`,
  `docs/_internal/project-map/modules/protocol.md`.
- Tests: `npm --workspace @sparkwright/protocol run typecheck`;
  `npm run schema:check`.

- Status: Verified
- Date: 2026-07-02T10:05:00+0800
- Scope: protocol, schema, and SDK now expose host-facing `task.join` and
  `task.promote` requests for TUI task controls.
- Read: `packages/protocol/src/index.ts`,
  `schemas/host-message.schema.json`, `packages/sdk-core/src/client.ts`,
  `packages/sdk-core/test/client.test.ts`,
  `docs/reference/HOST_PROTOCOL.md`.
- Tests: `npm --workspace @sparkwright/protocol run typecheck`;
  `npm run build --workspace @sparkwright/protocol`;
  `npm --workspace @sparkwright/sdk-core test -- test/client.test.ts -t
  "task inspection requests"`; `npm --workspace @sparkwright/sdk-core run
  typecheck`.

- Status: Verified
- Date: 2026-07-02T01:15:00+0800
- Scope: protocol and schemas now carry task `awaited` snapshots and
  run-level `backgroundTasks` policy on start/resume, with generated host/config
  schemas and capability fixtures refreshed.
- Read: `packages/protocol/src/index.ts`,
  `schemas/host-message.schema.json`,
  `schemas/config.schema.json`,
  `schemas/fixtures/host-message.capability-snapshot.json`,
  `packages/host/src/server.ts`,
  `packages/host/test/protocol.test.ts`.
- Tests: `npm --workspace @sparkwright/protocol run typecheck`;
  `npm run build --workspace @sparkwright/protocol`;
  `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t
  "task|background agent|capability inspection|accessMode|backgroundTasks|spawn_agent"`;
  `npm run schema:check`.

- Status: Verified
- Date: 2026-06-30T09:30:00+0800
- Scope: clarified durable task inspection scoping: `task.list` reads the
  workspace task store by default and clients pass `parentRunId` for run-local
  views; TUI now applies that filter for session-scoped Activity browsing.
- Read: `packages/protocol/src/index.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/src/server.ts`,
  `packages/tui/src/app.tsx`,
  `docs/reference/HOST_PROTOCOL.md`,
  `docs/_internal/project-map/modules/protocol.md`.
- Tests: `npm --workspace @sparkwright/tui test --
  test/activity-panel-render.test.tsx test/tool-request-preview.test.ts`;
  `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t
  "task"`;
  `npm --workspace @sparkwright/tui run typecheck`.

- Status: Verified
- Date: 2026-06-30T01:07:00+0800
- Scope: added host protocol task inspection requests/responses
  (`task.list`, `task.get`, `task.output`, `task.stop`) plus
  `task_not_found`, and kept schema/reference docs aligned with SDK helpers and
  TUI Activity Drawer usage.
- Read: `packages/protocol/src/index.ts`,
  `schemas/host-message.schema.json`,
  `docs/reference/HOST_PROTOCOL.md`,
  `docs/reference/HOST_PROTOCOL_CHANGELOG.md`,
  `docs/reference/PROTOCOL_CHANGELOG.md`,
  `packages/sdk-core/src/client.ts`,
  `packages/sdk-core/test/client.test.ts`,
  `packages/host/src/server.ts`,
  `packages/host/test/protocol.test.ts`.
- Tests: `npm run schema:check`;
  `npm --workspace @sparkwright/protocol run typecheck`;
  `npm --workspace @sparkwright/sdk-core test -- test/client.test.ts`;
  `npm --workspace @sparkwright/host test -- test/protocol.test.ts`.

- Prior verification — Date: 2026-06-29T09:28:39+0800
- Scope: capability tool summaries now include canonical identity,
  legacy names, default exposure tier, mechanism source/governance/loading, and
  related/required tool links for host protocol clients.
- Read: `packages/protocol/src/index.ts`,
  `schemas/host-message.schema.json`,
  `schemas/fixtures/host-message.capability-snapshot.json`,
  `docs/reference/HOST_PROTOCOL.md`, `docs/reference/PROTOCOL.md`.
- Tests: `npm run schema:check`;
  `npm --workspace @sparkwright/host test -- test/protocol.test.ts`.

- Status: Verified
- Date: 2026-06-27T22:36:34+0800
- Scope: refreshed protocol/reference guidance and generated schemas for
  canonical-only workflow lifecycle values, single-field workflow hook trace
  payloads, `CapabilitySnapshot.rules.events`, `capabilities.hooks.events`, and
  command/http/agent hook action configs.
- Read: `packages/protocol/src/index.ts`,
  `packages/host/src/config-zod-schema.ts`,
  `packages/host/src/config.ts`,
  `packages/host/src/active-rules.ts`,
  `packages/host/src/runtime.ts`,
  `schemas/host-message.schema.json`,
  `schemas/config.schema.json`,
  `schemas/fixtures/host-message.capability-snapshot.json`,
  `scripts/validate-schemas.mjs`, `docs/reference/HOST_PROTOCOL.md`,
  `docs/reference/PROTOCOL.md`, `docs/reference/EXTENSION_INTERFACES.md`,
  `docs/_internal/project-map/modules/protocol.md`.
- Tests: `npm run schema:check`;
  `npm --workspace @sparkwright/protocol run build`;
  `npm --workspace @sparkwright/host test --
test/workflow-hooks.test.ts test/config.test.ts test/protocol.test.ts -t
"workflow|event|http|agent|stdoutJson|configured workflow hooks|active
workflow rule"`.
- Prior verification — Date: 2026-06-27T21:06:53+0800
- Scope: refreshed protocol/reference guidance for workflow-rule inspection and
  low-level validation hook boundaries; no wire, schema, or fixture shape
  changed in this slice.
- Tests: `npm --workspace @sparkwright/protocol run typecheck`;
  `npm --workspace @sparkwright/host test --
test/documented-command-check.test.ts test/protocol.test.ts -t "documented
command|documented-command|workflow rule"`.
- Prior verification — Date: 2026-06-27T20:24:22+0800
- Scope: added optional `CapabilitySnapshot.rules.workflow` TypeScript/schema
  contract and fixture/reference coverage for workflow rule inspection
  summaries.
- Read: `packages/protocol/src/index.ts`,
  `packages/host/src/active-rules.ts`,
  `packages/host/src/runtime.ts`,
  `schemas/host-message.schema.json`,
  `schemas/fixtures/host-message.capability-snapshot.json`,
  `scripts/validate-schemas.mjs`, `docs/reference/HOST_PROTOCOL.md`,
  `docs/reference/HOST_PROTOCOL_CHANGELOG.md`,
  `docs/reference/PROTOCOL_CHANGELOG.md`,
  `docs/_internal/project-map/modules/protocol.md`.
- Tests: `npm run schema:check`;
  `npm --workspace @sparkwright/protocol run typecheck`.
- Prior verification — Date: 2026-06-27T11:29:02+0800
- Scope: aligned capability snapshot TypeScript, host-message schema, schema
  fixture coverage, and docs for optional delegate routing summaries.
- Read: `packages/protocol/src/index.ts`,
  `packages/host/src/delegate-capability.ts`,
  `schemas/host-message.schema.json`,
  `schemas/fixtures/host-message.capability-snapshot.json`,
  `scripts/validate-schemas.mjs`, `docs/reference/HOST_PROTOCOL.md`,
  `docs/reference/PROTOCOL_CHANGELOG.md`,
  `docs/_internal/project-map/modules/protocol.md`.
- Tests: `npm run schema:check`;
  `npm --workspace @sparkwright/protocol run typecheck`.
- Prior verification (delegate model / risk / automation snapshot fields) — Date: 2026-06-27T10:22:22+0800
- Read: `packages/protocol/src/index.ts`,
  `packages/host/src/delegate-capability.ts`,
  `schemas/host-message.schema.json`,
  `schemas/fixtures/host-message.capability-snapshot.json`,
  `scripts/validate-schemas.mjs`, `docs/reference/HOST_PROTOCOL.md`,
  `docs/reference/HOST_PROTOCOL_CHANGELOG.md`.
- Tests: `npm run schema:check`;
  `npx prettier --check schemas/host-message.schema.json schemas/fixtures/host-message.capability-snapshot.json scripts/validate-schemas.mjs docs/reference/HOST_PROTOCOL.md docs/reference/HOST_PROTOCOL_CHANGELOG.md`.
- Prior verification (access mode) — Date: 2026-06-26T23:59:00+0800
- Read: `packages/protocol/src/index.ts`,
  `schemas/host-message.schema.json`,
  `packages/host/src/runtime.ts`, `packages/host/src/server.ts`,
  `packages/host/src/client-run.ts`,
  `packages/tui/src/state/run-controller.ts`,
  `docs/reference/HOST_PROTOCOL.md`,
  `docs/reference/HOST_PROTOCOL_CHANGELOG.md`.
- Tests: `npm run schema:check`;
  `npm --workspace @sparkwright/protocol run typecheck`;
  `npm --workspace @sparkwright/host test -- test/client-run.test.ts`;
  `npm --workspace @sparkwright/tui test -- test/permission.test.ts test/sdk-cutover.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts`;
  `npm run build`; `npm run check:dist-fresh`.
