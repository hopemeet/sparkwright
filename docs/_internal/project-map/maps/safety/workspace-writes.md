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
