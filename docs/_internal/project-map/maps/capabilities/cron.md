# Cron Capability

## Purpose

Cron capability stores scheduled background jobs and exposes automation status
and creation/update flows through CLI/TUI/host tooling.

See [../../modules/agent-runtime.md](../../modules/agent-runtime.md) for related task execution concepts.

## Main Files

- `packages/cron/src/*`
- `packages/cli/src/cli.ts`
- `packages/cli/src/runners/direct-core-runner.ts`
- `packages/host/src/tool-catalog.ts`
- `packages/host/src/runtime.ts`
- `packages/host/src/tools.ts`
- `packages/tui/src/app.tsx`

## Data Flow

```txt
cron config/state
  -> CLI/TUI/host create/update/list
  -> CLI diagnostic tool catalog for scheduled run tool setup
  -> scheduler/runner
  -> task/run output and capability inspect summary
```

## Contracts

- Cron state uses the `sparkwright-cron.v1` store schema.
- Cron state root is XDG state (`$XDG_STATE_HOME/sparkwright/cron` or
  `~/.local/state/sparkwright/cron`) with no legacy config-root migration.
- Cron jobs can reference skills and run goals on a schedule.
- `approvals.cronMode` supplies the default permission mode for unattended cron
  commands; explicit CLI flags still override it.
- CLI cron run/tick paths use `createConfiguredCliTools`, which flattens the
  host CLI diagnostic catalog profile, applies configured tool selectors, and
  filters recursive `cron` execution in `@sparkwright/cron`.
- Capability inspection reports cron state root and job summary.

## Consumers

- CLI `cron` commands.
- TUI capabilities panel and `/create cron`.
- Host capability snapshot.
- Agent-runtime task infrastructure where jobs produce durable work.

## Change Checklist

- Check store schema and corrupt-file backup behavior.
- Check CLI and TUI create/update flows.
- Check capability inspect output.
- Check task/run trace evidence for executed jobs.

## Known Debts

- Cron execution, task state, and run trace are adjacent but not fully mapped in this first pass.

## Last Verified

- Status: Verified
- Date: 2026-06-19
- Read: `packages/cron/src/*` index, `packages/cli/src/cli.ts`, `packages/cli/src/runners/direct-core-runner.ts`, `packages/host/src/config.ts`, `packages/host/src/tool-catalog.ts`, `packages/host/src/runtime.ts`, `packages/tui/src/app.tsx`, `packages/tui/src/lib/config.ts`, `packages/tui/src/lib/create-capability.ts`.
- Tests: `npm --workspace @sparkwright/cron test -- schedule.test.ts`; `npm --workspace @sparkwright/host test -- config.test.ts tools.test.ts`; `npm --workspace @sparkwright/cli test -- cli.test.ts config-schema.test.ts`; `npm --workspace @sparkwright/tui test -- config.test.ts`.
