# Safety Maps

## Purpose

Safety maps explain approvals, workspace writes, shell execution, and the trace
evidence that makes them auditable.

## Main Files

- `packages/core/src/run.ts`
- `packages/core/src/policy.ts`
- `packages/core/src/approval.ts`
- `packages/core/src/approval-policy.ts`
- `packages/core/src/workspace.ts`
- `packages/host/src/shell.ts`
- `packages/cli/src/cli-approval.ts`

## Data Flow

```txt
risky request
  -> policy decision
  -> approval if required
  -> execution or denial
  -> trace evidence
```

## Contracts

- Denial is not cancellation.
- Approval caches are product/runtime state; event stream is the audit record.
- Workspace escape attempts should surface in consistency diagnostics.

## Consumers

- CLI approval flags.
- TUI approval layer.
- Host pending approval map.
- Trace/session diagnostics.

## Change Checklist

- Read [approvals.md](approvals.md), [workspace-writes.md](workspace-writes.md), and [shell.md](shell.md) for related changes.

## Known Debts

- Safety reporting exists in trace summary but is not yet a complete human report.

## Last Verified

- Status: Read-only
- Date: 2026-06-18
- Read: `packages/core/src/run.ts`, `packages/core/src/trace.ts`, `packages/host/src/shell.ts`, `packages/cli/src/cli-approval.ts`.
- Tests: not run; documentation-only map pass.
