# Runtime Maps

## Purpose

Runtime maps explain the cross-package execution flow around core runs: run loop
phases, tool orchestration, context compaction, host composition, and product
surfaces.

## Main Files

- `packages/core/src/run.ts`
- `packages/core/src/tool-orchestration.ts`
- `packages/core/src/context*.ts`
- `packages/host/src/runtime.ts`
- `packages/host/src/toolset.ts`
- `packages/tui/src/state/run-controller.ts`

## Data Flow

```txt
CLI/TUI/SDK request
  -> host runtime
  -> core run loop
  -> model/tool/policy/approval/workspace phases
  -> events + stores + product UI
```

## Contracts

- Core owns lifecycle semantics.
- Host owns composition of providers, tools, context, and stores.
- Product surfaces own user interaction and display.

## Consumers

- CLI and TUI.
- SDK clients.
- Host server and future product shells.

## Change Checklist

- Read [run-loop.md](run-loop.md) before changing `run.ts`.
- Read [tool-orchestration.md](tool-orchestration.md) before adding/changing tools.
- Read [context-compaction.md](context-compaction.md) before changing session compaction or budget behavior.

## Known Debts

- Runtime flow is intentionally small, but host composition is already broad.

## Last Verified

- Status: Read-only
- Date: 2026-06-18
- Read: `packages/core/src/run.ts`, `packages/host/src/runtime.ts`, `docs/reference/RUN_EVENTS.md`, `docs/reference/STATE_AND_TRACE_MODEL.md`.
- Tests: not run; documentation-only map pass.
