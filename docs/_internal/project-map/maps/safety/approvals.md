# Approvals

## Purpose

Approvals gate risky actions while preserving an audit trail of what was asked,
how it was resolved, and what happened afterward.

See [workspace-writes.md](workspace-writes.md) and [shell.md](shell.md).

## Main Files

- `packages/core/src/run.ts`
- `packages/core/src/approval.ts`
- `packages/core/src/approval-policy.ts`
- `packages/host/src/runtime.ts`
- `packages/host/src/client-approval.ts`
- `packages/cli/src/cli-approval.ts`
- `packages/tui/src/app.tsx`
- `packages/tui/src/state/run-controller.ts`

## Data Flow

```txt
policy requires approval
  -> approval.requested / interaction.requested
  -> CLI/TUI/host resolver
  -> approval.resolved / interaction.resolved
  -> action continues or denial path
```

## Contracts

- `approval.requested` carries an id used by protocol `approval.resolve`.
- `approval.resolved` preserves optional resolver `message` and structured
  `autoApproved` state; trace summary/report diagnostics should not rely on
  message prose for new traces.
- Approval denial does not automatically mean run cancellation.
- Pending approval UI should key by approval/request identity.
- Trace verification checks that resolutions do not exceed requests.
- `approvals.cronMode` is a config default for cron command permission mode;
  named approval behavior remains owned by the normal core/host approval path,
  and explicit CLI flags still override the default.
- Configured in-process delegate child runs share the host approval resolver
  with the parent run, so child workspace-write and shell gates still resolve
  through the same CLI/TUI approval and trace path. They do not receive an
  interaction channel for arbitrary user questions.

## Consumers

- Host pending approval map.
- CLI flags such as `--yes`, `--yes-edits`, and `--yes-shell-safe`.
- TUI approval layer via host-client approval helpers.
- Trace safety summary and verification.

## Change Checklist

- Check host protocol payloads and TUI controller calls.
- Check non-interactive CLI behavior.
- Check duplicate rendering between `approval.*` and `interaction.*`.
- Keep approval payloads free of secrets.

## Known Debts

- Approval UX and diagnostic reporting are split across CLI, TUI, host, and core trace.

## Last Verified

- Status: Verified
- Date: 2026-06-20
- Read: `packages/core/src/run.ts`, `packages/agent-runtime/src/index.ts`, `packages/host/src/runtime.ts`, `packages/host/src/server.ts`, `packages/host/src/client-approval.ts`, `packages/cli/src/cli-approval.ts`, `packages/tui/src/app.tsx`, `packages/host/test/protocol.test.ts`.
- Tests: `npm --workspace @sparkwright/agent-runtime test -- index.test.ts`; `npm --workspace @sparkwright/host test -- protocol.test.ts`; `npm --workspace @sparkwright/cli run typecheck`; `npm --workspace @sparkwright/tui run typecheck`.
