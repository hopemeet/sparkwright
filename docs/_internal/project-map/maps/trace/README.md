# Trace Maps

## Purpose

Trace maps explain SparkWright's evidence and diagnostic layers.

Start here when changing event emission, trace filtering, trace file layout,
trace CLI commands, session diagnostics, or TUI export.

## Main Files

- `packages/core/src/trace.ts`
- `packages/core/src/run.ts`
- `packages/core/src/session.ts`
- `packages/cli/src/cli.ts`
- `packages/host/src/runtime.ts`
- `packages/tui/src/state/run-controller.ts`
- `packages/tui/src/lib/transcript.ts`

## Data Flow

```txt
core event stream
  -> FileRunStore trace.jsonl
  -> trace summary/timeline/verify diagnostics
  -> CLI output / host session.inspect / TUI session diagnostics

TUI live event buffer
  -> /export Markdown transcript
```

## Contracts

- `trace.jsonl` is canonical raw run/session evidence.
- Summary, timeline, and verify are derived diagnostic views.
- TUI `/export` is a human-readable transcript, not a diagnostic report.

## Consumers

- CLI `trace *` and `session *` commands.
- Host `session.inspect`.
- TUI session browser and export command.
- Tests under `packages/core/test/trace.test.ts` and product-surface tests.

## Change Checklist

- Read [raw-trace.md](raw-trace.md) before changing persistence.
- Read [summary-timeline-verify.md](summary-timeline-verify.md) before changing diagnostic helpers.
- Read [export-diagnostics.md](export-diagnostics.md) before changing TUI export or session inspect UX.

## Known Debts

- Raw trace size and noisy event families need retention and reporting strategy.
- Human report layer needs stronger diagnostics than Markdown export alone.

## Last Verified

- Status: Verified
- Date: 2026-06-19
- Read: `packages/core/src/trace.ts`, `packages/core/src/events.ts`, `packages/host/src/traced-process-runner.ts`, `packages/host/src/workflow-hooks.ts`.
- Tests: `npm --workspace @sparkwright/core test -- trace.test.ts`; `npm --workspace @sparkwright/host test -- traced-process-runner.test.ts workflow-hooks.test.ts`.
