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
- Trace report may lower the severity of an incomplete child only at the
  report layer, and only when raw events prove the ordered chain: child
  `workspace.write.completed`, parent-visible `subagent.*.workspaceWrites > 0`,
  later successful verification, and no later workspace write. Raw write events
  and raw child finality are not rewritten.
- Untracked write-capable process boundaries are explicit audit boundaries:
  read/write external command delegates emit
  `workspace.write.untracked_access_granted` when direct access is granted, and
  promoted shell tasks emit the same marker with `protocol: "promoted_shell"`
  and sandbox status. The marker means access-granted /
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
  relative-path project writes.

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
