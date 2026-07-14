# Workspace Writes

## Purpose

Workspace writes are controlled mutations to user project state. They must be
policy-checked, approval-gated when needed, trace-visible, and artifact-backed.

See [approvals.md](approvals.md) and [../runtime/tool-orchestration.md](../runtime/tool-orchestration.md).

## Main Files

- `packages/core/src/run.ts`
- `packages/core/src/workspace.ts`
- `packages/core/src/workspace-checkpoint.ts`
- `packages/core/src/anchored-edit.ts`
- `packages/host/src/tools.ts`
- `packages/host/src/shell.ts`
- `packages/host/src/workspace-snapshot.ts`
- `packages/host/src/workspace-agent-arbiter.ts`

## Data Flow

```txt
tool proposes write
  -> policy
  -> approval if required
  -> artifact/diff
  -> workspace.write.completed or workspace.write.denied/skipped
```

## Contracts

- Accepted anchored edits still flow through normal workspace write events.
- Large diffs should be artifacts, not only inline payloads.
- `workspace.write.denied` is a valid terminal write outcome.
- Runs with `shouldWrite: false` hard-deny workspace writes before approval.
  Interactive clients that need write approvals should send `shouldWrite: true`;
  managed coding tools then defer to the normal `workspace.write` diff approval
  path and guardrails.
- Host and internal direct-core start/resume construct this mutation layer from
  one Host factory. Every invocation is fresh: its `writtenPaths` file-budget
  state must never be cached or shared through the immutable security plan.
- Shell writes, managed capability mutations, and delegate child writes must
  still leave trace evidence. In-process delegate child writes are surfaced to
  the parent summary by rolling up the child run's own
  `workspace.write.completed` events onto `subagent.*` payloads.
- Dynamic `spawn_agent` and `task_create(kind:"agent")` children may receive
  managed workspace write tools only through a spawn-time workspace-write grant.
  That grant is approved at the parent tool boundary, then consumed by a
  child-local resolver that approves only `workspace.write` requests. The
  parent run policy is still layered into the child, so `shouldWrite:false`,
  target-path restrictions, file budgets, and diff budgets deny before the
  grant resolver can approve.
- Same-turn Agent tool batching treats a requested dynamic workspace-write grant
  or a configured child write/shell capability as serial. This prevents two
  independently policy-checked and approved child writers from being admitted
  to the same Core concurrent batch; this remains the early argument-level
  classifier rather than the workspace lock itself.
- Host additionally uses one process-local fair workspace lease coordinator
  keyed by the realpath-canonical workspace root. It wraps actual mutation
  windows for parent and child managed coding tools, Shell, Skill/Agent
  capability files, and holds write-capable in-process/ACP/external delegates
  for their full execution across HostRuntime connections. Background Shell
  transfers its lease to the returned Task until terminal state. Agent dispatch
  tools are not parent-locked; their admitted child owns the mutation window.
- Same-run write leases reenter with reference counting, and descendant waits
  on ancestor owners fail fast. Acquisitions auto-renew by default; involuntary
  loss is observable and starts child/process abort before the queue drains.
  This does not replace policy or approval, coordinate other Node processes or
  distributed hosts, or provide a fencing generation/termination
  acknowledgement. Managed writes still use normal Core policy/events;
  process delegates still emit the untracked write-capable marker after lease
  admission.
- Trace report may lower the severity of an incomplete child only at the
  report layer, and only when raw events prove the ordered chain: child
  `workspace.write.completed`, parent-visible `subagent.*.workspaceWrites > 0`,
  later successful verification, and no later workspace write. Raw write events
  and raw child finality are not rewritten.
- Untracked write-capable process boundaries are explicit audit boundaries:
  read/write ACP and external command delegates emit
  `workspace.write.untracked_access_granted` when direct access is granted, and
  background shell tasks emit the same marker with
  `protocol: "background_shell"`, `backgroundOrigin`, and sandbox status. The
  marker means access-granted /
  untracked-write-capable only; it does not assert that a write occurred, does
  not name files, and does not increment managed workspace write counts.
- CLI run-completion summaries count these markers separately from managed
  writes and avoid saying "no workspace changes" when an untracked
  write-capable boundary occurred; the summary still must not claim a specific
  file mutation from this marker alone.
- Read-confidentiality is adjacent but separate from workspace-write safety.
  `workspace.read.denied` is the audit event for denied confidential reads; it
  does not consume or imply the managed `workspace.write.*` path, and `--target`
  remains write-scoped rather than a read sandbox.
- MCP tools are normal external tools. If they write files without using
  managed `workspace.write.*`, those writes are not counted as managed
  workspace writes; stdio MCP servers default to neutral cwd to avoid accidental
  relative-path project writes. In Host read-only runs, local stdio MCP
  processes additionally receive a fail-closed no-write OS sandbox; this does
  not turn MCP writes in write-enabled runs into managed write attribution.
- Workflow Script processes require both write-enabled run access and a
  declared `write` capability before their sandbox receives write grants.
  Read-only command hooks are also forced into a fail-closed no-write sandbox
  when Host run metadata explicitly records `shouldWrite:false`.
- Managed `LocalWorkspace` writes use realpath containment and reject stable
  symlink segments in the caller's original workspace-relative path, even when
  the symlink target stays inside the workspace. Missing parent chains are
  checked again after creation and before the file write. Removal rejects
  symlink ancestors but can unlink a symlink leaf without following its target.
  Foreground Shell snapshot rollback detects symlink entries and restores
  captured binary content through this boundary. These checks narrow but cannot
  eliminate filesystem TOCTOU races; they are not an OS-level sandbox for
  arbitrary processes or a detector for writes outside the workspace.

## Consumers

- Core policy and run loop.
- CLI/TUI approval UX.
- Trace summary safety counts.
- CLI run summaries separate managed writes from untracked write-capable
  boundaries.
- Session consistency checks.

## Change Checklist

- Check write request/completed/denied/skipped event pairing.
- Check artifact creation and redaction.
- Check workspace escape detection.
- Check shell mutation rollback behavior if shell can write.
- Check static MCP workspace-cwd disclosures when configured MCP servers opt in
  to project cwd.

## Known Debts

- Human reports can add more boundary-specific guidance for promoted shell and
  external-command markers; summary counting already separates that boundary
  from managed workspace writes.

## Last Verified

- Status: Verified
- Date: 2026-07-14
- Scope: checked Host principal isolation and Workflow control attribution;
  workspace-write policy, approval, and lease behavior are unchanged.
- Tests: Host focused suites and typecheck passed.

- Status: Verified
- Date: 2026-07-14T14:35:00+0800
- Scope: P6 renamed the process-local workspace lease implementation without
  changing admission scope, fairness, or the non-fencing limitation.
- Tests: Workspace lease tests and Host 571/571 passed.

- Status: Verified (no write-admission change)
- Date: 2026-07-14
- Scope: reviewed IM principal/binding permissions; they authorize session
  control only and do not grant workspace mutation or replace existing leases.

- Status: Verified (no lease semantic change)
- Date: 2026-07-14
- Scope: reviewed WorkspaceContext and lane capacity; canonical workspace lease
  admission remains independent from execution scheduling capacity.

- Status: Verified
- Date: 2026-07-14
- Scope: extended Host workspace arbitration from child-only admission to
  actual parent/child mutation windows, including background lease transfer,
  reentrant ownership, run-chain fail-fast, and loss-triggered cancellation.
- Read: coordinator, Host catalog/runtime, coding/Shell tools, all Agent
  adapters, and workspace-write event boundaries.
- Tests: focused coordinator/Agent/process suites, all workspace tests, and
  release smokes passed. Touched files are format-clean; the global format scan
  is blocked only by pre-existing dirty proposal docs outside this change.

- Status: Verified
- Date: 2026-07-14
- Scope: added Host process-local Agent workspace RW admission without changing
  write authorization or managed/untracked write attribution.
- Read: arbiter, in-process/dynamic/process Agent entrypoints, Core write event
  contracts, and active supervision design.
- Tests: Host arbiter/Agent/process focused suites 162/162; agent-runtime
  Agent/invocation/supervisor/ledger 60/60; affected typechecks passed.

- Status: Verified
- Date: 2026-07-14
- Scope: added fail-closed same-turn Agent concurrency classification for
  workspace-write capability without changing write approval semantics.
- Read: Core concurrency classifier, Host Agent spawn/delegate capability, and
  workspace-write policy boundary.
- Tests: Core run 127/127; Host Agent/tool suites 155/155; affected typechecks
  passed.

- Status: Verified
- Date: 2026-07-13T22:42:00+0800
- Scope: aligned Host/direct-core start/resume target and write-budget policy
  construction while preserving fresh mutation state per run.
- Read: Host run policy/runtime, CLI direct-core/resume, Core mutation policy.
- Tests: Host focused 155/155; CLI 152/152; Core policy/environment 35/35;
  affected typechecks/builds passed.

- Status: Verified
- Date: 2026-07-13T22:30:00+0800
- Scope: foreground Shell audit now detects created/replacement symlinks and
  uses Core containment for rollback restoration; outside-workspace writes
  remain beyond snapshot coverage.
- Read: Core LocalWorkspace, Host workspace snapshot/Shell integration, and
  focused tests.
- Tests: Core workspace/checkpoint 31/31; Host snapshot/tools 102/102; affected
  typechecks/build passed.

- Status: Verified
- Date: 2026-07-13T22:21:00+0800
- Scope: read-only extension-process boundaries now compile fail-closed
  no-write sandbox inputs for local MCP, Workflow Script, and explicit
  run-bound command hooks; managed write event/counting semantics are unchanged.
- Read: Host security plan, Workflow node API/hooks, MCP assembly, and
  shell-sandbox no-write compiler.
- Tests: Host focused 263/263; MCP adapter 34/34; CLI capability inspect 11/11.

- Status: Verified
- Date: 2026-07-13
- Scope: ACP `workspaceAccess:read_write` now emits the same
  untracked-access-granted marker as external commands after the parent write
  gate; no managed write is inferred.
- Read: Host ACP/external delegate tools and workspace-write event contract.
- Tests: Host ACP/external/tool focused suites 122/122.

- Status: Read-only
- Date: 2026-07-13
- Scope: filesystem grant compilation moved to shell-sandbox; managed write
  events, untracked-access markers, snapshot ownership, and rollback semantics
  did not change.
- Read: external Delegate, Skill inline shell, MCP, and shell-sandbox boundaries.
- Tests: focused Host/MCP/shell-sandbox suites passed.

- Status: Read-only
- Date: 2026-07-13
- Scope: checked Host security-plan extraction. It freezes access/path inputs
  only; managed mutation policy instances and their `writtenPaths` state remain
  fresh per run, and workspace-write events/counting are unchanged.
- Read: Host runtime/security plan and Core mutation policy.
- Tests: Host focused suite 222/222; no workspace-write event contract changed.

- Status: Verified
- Date: 2026-07-13
- Scope: verified and hardened managed workspace symlink containment. Added
  regressions for directory and file symlinks targeting paths inside the same
  workspace; both are denied before mutation.
- Read: `packages/core/src/workspace.ts`, workspace checkpoint and mutation
  policy tests.
- Tests: Core workspace/checkpoint/policy tests 59/59 passed; Core typecheck
  passed.

- Status: Read-only
- Date: 2026-07-12T20:12:00+0800
- Scope: checked Workflow pin-layer and Skill import transaction follow-up;
  ordinary workspace-write approval semantics are unchanged.
- Read: host runtime, Skill registry/import, and workspace-write map.
- Tests: focused registry/Workflow tests passed; no workspace-write contract change.

- Status: Read-only
- Date: 2026-07-12
- Scope: checked Markdown Agent atomic workspace-write path; no workspace-write policy change.
- Tests: focused host tests passed; release gate pending.

- Status: Read-only
- Date: 2026-07-12T16:36:08+0800
- Scope: checked Workflow snapshot pinning; workspace-write policy is unchanged.
- Tests: not run for workspace-write-specific behavior; Phase 4 Workflow release gate passed.

- Status: Verified
- Date: 2026-07-08T23:46:48+0800
- Scope: post-review workspace-write grant hardening confirmed the parent
  `shouldWrite:false` gate denies spawn-time write grants before approval, while
  approved child grants remain layered under the parent workspace mutation
  envelope so target-path, file-count, and diff-budget limits deny at child
  `workspace.write` consumption time before the grant resolver can approve.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/agent-spawn-grants.ts`,
  `packages/core/src/policy.ts`,
  `packages/host/test/spawn-agent.test.ts`,
  `docs/_internal/proposals/spawn-time-capability-grant.md`.
- Tests: `npm --workspace @sparkwright/host test --
test/spawn-agent.test.ts`;
  `npm --workspace @sparkwright/host test -- test/tools.test.ts`.

- Status: Verified
- Date: 2026-07-08T14:42:08+0800
- Scope: spawn-time workspace-write grants let dynamic child agents use only
  managed workspace write tools, roll completed child writes up through
  `subagent.*.workspaceWrites`, and still respect parent `shouldWrite:false`
  and workspace mutation guardrails before child grant approval.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/agent-spawn-grants.ts`,
  `packages/host/src/tool-catalog.ts`,
  `packages/core/src/workspace.ts`,
  `packages/core/src/policy.ts`.
- Tests: `npm test -w @sparkwright/host -- spawn-agent.test.ts`;
  `npm test -w @sparkwright/host -- tools.test.ts`;
  typechecks for core, agent-runtime, and host.

- Status: Read-only
- Date: 2026-07-07T00:55:52+0800
- Scope: workflow nested help and offline observation filtering do not change
  workspace-write policy, managed write event pairing, untracked
  write-capable-boundary semantics, or MCP write attribution.
- Read: `packages/cli/src/cli.ts`,
  `packages/host/src/workflow-trace-observation.ts`,
  `docs/_internal/project-map/maps/safety/workspace-writes.md`.
- Tests: workspace-write-specific tests were not run; focused CLI/host workflow
  tests covered the changed paths.

- Status: Verified
- Date: 2026-07-06T21:18:25+0800
- Scope: C13-② post-acceptance routed-page check: host-loaded
  confidential read config now feeds the read-scope policy for protocol runs,
  while workspace-write policy, write event pairing, untracked write-capable
  markers, and `--target` write scope remain unchanged.
- Read: `packages/host/src/runtime.ts`,
  `packages/core/src/workspace.ts`,
  `packages/host/test/protocol.test.ts`,
  `docs/guides/CONFIGURATION.md`.
- Tests: `npm --workspace @sparkwright/host test --
test/protocol.test.ts -t "confidential"`.

- Status: Verified
- Date: 2026-07-06T20:47:10+0800
- Scope: C13-② routed-page check: read-confidentiality defaults changed the
  read-scope policy boundary only. Managed workspace-write policy, write event
  pairing, untracked write-capable markers, and `--target` write scope are
  unchanged.
- Read: `packages/core/src/policy.ts`, `packages/core/src/workspace.ts`,
  `packages/host/src/runtime.ts`, `packages/cli/src/cli.ts`,
  `packages/cli/test/cli.test.ts`,
  `docs/_internal/proposals/consolidation-agenda.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/policy.test.ts
test/workspace.test.ts`; `npm --workspace @sparkwright/cli test --
test/cli.test.ts -t "confidential"`.

- Status: Read-only
- Date: 2026-07-06T20:12:52+0800
- Scope: C10 route check for HostRuntime capability-inspection profile
  inventory. Workspace write policy, managed write event pairing, shell mutation
  audits, and workspace-read denial behavior are unchanged.
- Read: `packages/host/src/runtime.ts`, `packages/host/test/protocol.test.ts`,
  `packages/host/src/workspace-snapshot.ts`, `packages/host/src/tools.ts`.
- Tests: `npm --workspace @sparkwright/host test --
test/protocol.test.ts -t "inspect reports inline agent profiles"`;
  `npm --workspace @sparkwright/host run typecheck`; `npm --workspace
@sparkwright/host run build`; `npm run release:check`.

- Status: Verified
- Date: 2026-07-05T22:37:13+0800
- Scope: workflow-runtime-v1 P9a workspace-write boundary: workspace-level
  `.sparkwright/workflow-runs/` is SparkWright control-plane state and is
  excluded from foreground shell mutation audits alongside sessions/tasks.
  Managed capability package paths remain audited.
- Read: `packages/host/src/workspace-snapshot.ts`,
  `packages/host/test/tools.test.ts`,
  `packages/host/src/runtime.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/tools.test.ts -t
"runtime control-plane files"`.

- Status: Read-only
- Date: 2026-07-05T16:03:27+0800
- Scope: workflow-runtime-v1 P5 routed-page check: bounded
  `parallel` / `join` reuses existing governed primitives. Command/script
  branch writes still pass through normal run access/write gates and host node
  API governance; workspace-write policy and trace event pairing are unchanged.
- Read: `packages/host/src/workflow-projection.ts`,
  `packages/host/src/workflow-node-api.ts`,
  `packages/host/src/runtime.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test --
test/workflow-hooks.test.ts`; `npm --workspace @sparkwright/host run
typecheck`.

- Status: Read-only
- Date: 2026-07-05T11:36:37+0800
- Scope: workflow-runtime-v1 P3 Step 4a routing check for
  `packages/host/src/runtime.ts`: actor episode driver inversion keeps normal
  run access/write gates and does not change managed workspace-write policy,
  write event pairing, or untracked write-capable boundary semantics.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/workflow-projection.ts`,
  `docs/_internal/project-map/maps/safety/workspace-writes.md`.
- Tests: not run for workspace-write-specific behavior; Step 4a made no write
  policy semantic change.

- Status: Read-only
- Date: 2026-07-05T00:42:02+0800
- Scope: workflow-runtime-v1 P2 routing check for `packages/host/src/runtime.ts`:
  workflow resume reuses normal run access/write gates and verifier FactLedger
  evidence; it does not change managed workspace-write policy, write event
  pairing, or untracked write-capable boundary semantics.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/workflow-projection.ts`,
  `docs/_internal/project-map/maps/safety/workspace-writes.md`.
- Tests: not run for workspace-write-specific behavior; P2 made no write policy
  semantic change.

- Status: Verified
- Date: 2026-06-29T09:28:39+0800
- Scope: checked after public write-tool rename; managed workspace-write
  policy and artifact/write terminal event contracts did not change.
- Read: `packages/host/src/verification.ts`,
  `packages/host/src/tools.ts`, `packages/host/src/runtime.ts`,
  `packages/core/src/run.ts`,
  `docs/_internal/project-map/maps/safety/workspace-writes.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/tools.test.ts test/protocol.test.ts test/config.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts test/config-schema.test.ts`.

- Status: Verified
- Date: 2026-06-26T23:59:00+0800
- Scope: `accessMode` ceiling clamp before write-gate projection; no change to
  workspace mutation policy itself.
- Read: `packages/core/src/policy.ts`, `packages/core/src/workspace.ts`,
  `packages/core/src/run.ts`, `packages/coding-tools/src/index.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/src/run-access.ts`, `packages/tui/src/state/run-controller.ts`.
- Tests: `npm --workspace @sparkwright/core test -- test/access-mode.test.ts`;
  `npm --workspace @sparkwright/host test -- test/run-access.test.ts test/protocol.test.ts`;
  `npm --workspace @sparkwright/tui test -- test/permission.test.ts test/sdk-cutover.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts`;
  `npm run schema:check`; `npm run build`; `npm run check:dist-fresh`.

- Status: Verified
- Date: 2026-07-08T20:41:34+0800
- Scope: permission/access consolidation did not change managed workspace-write
  policy. `capability.inspect` now reports whether the inspected run view has
  effective `shouldWrite`, but actual mutations remain governed by the normal
  runtime policy and approval path.
- Read: `packages/host/src/run-access.ts`,
  `packages/host/src/runtime.ts`, `packages/host/src/server.ts`,
  `packages/cli/src/cli.ts`,
  `docs/_internal/project-map/maps/safety/workspace-writes.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/run-access.test.ts test/client-run.test.ts`;
  `npm --workspace @sparkwright/host test -- test/client-run.test.ts test/protocol.test.ts -t "capability inspect|capability inspection|capability inspect payloads"`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "capability inspect"`.
