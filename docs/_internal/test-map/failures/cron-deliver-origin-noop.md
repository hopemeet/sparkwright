# Cron `deliver: origin` Is A Silent No-Op

## Record

- Pattern ID: cron-deliver-origin-noop
- Status: `retired` (fixed 2026-06-24 on branch `fix/cron-deliver-deadfield-workspace`)
- First seen: 2026-06-24
- Last seen: 2026-06-24
- Recorded count: 1

| Cause                   | Count |
| ----------------------- | ----: |
| `product_bug`           |     1 |
| `test_bug`              |     0 |
| `prompt_underspecified` |     0 |
| `model_variance`        |     0 |
| `environment`           |     0 |
| `stale_dist`            |     0 |
| `dirty_workspace`       |     0 |
| `unknown`               |     0 |

## Symptom

A cron job created with `deliver: "origin"` (via CLI `--deliver origin`, or via
the cron tool create/update payload) runs and writes its result to the same
local output file as `deliver: "local"`. There is no origin/remote delivery, no
warning, and no error. `origin` and `local` are behaviorally identical.

## Root Cause

`DeliveryTarget = "local" | "origin"` is accepted and persisted but never
consumed at run time. The field flows only through:

- `packages/cli/src/cli.ts` - `--deliver` parse -> create payload / update patch
- `packages/cron/src/store.ts:73,119` - persist (`input.deliver ?? "local"`) and patch

`packages/cron/src/runner.ts` unconditionally calls `writeJobOutput(...)` to the
local output path; it never reads `job.deliver`. `scheduler.ts`, `output.ts`,
and `index.ts` have no delivery dispatch either. A repo-wide grep for `.deliver`
reads finds zero runtime consumers (the `agent-runtime` `sink.deliver(...)` hits
are an unrelated task-notification surface). No test asserts origin behavior.

The cron tool description (`packages/cron/src/tool.ts:41,47`) advertises
`deliver` to the model in both create and update payloads, so the model can
select an option that does nothing.

## Diagnostic Move

Grep `\.deliver` across `packages/**/src` (excluding `dist`). If the only reads
are the CLI parse and the store persist/patch, the field is unimplemented. Then
reproduce: create a job with `--deliver origin`, `cron run` it with `--model
deterministic`, and confirm `result.outputPath` is the normal local output file
and no other delivery artifact exists.

## Prevention

Either implement an origin delivery path keyed on `job.deliver`, or stop
advertising `origin` until it exists (drop it from `DeliveryTarget`, the CLI
`--deliver` choices, and the cron tool payload description). If kept as a
forward-looking option, emit an explicit "origin delivery not implemented"
signal rather than silently writing locally.

## Fix (2026-06-24, branch `fix/cron-deliver-deadfield-workspace`, not yet PR'd)

Took option A — removed the dead field entirely rather than implementing origin
delivery. The `deliver` / `DeliveryTarget` surface is gone from:

- `packages/cron/src/model.ts` (type + `CronJob` / `CreateJobInput` / `UpdateJobPatch`)
- `packages/cron/src/store.ts` (create default + update patch)
- `packages/cron/src/tool.ts` (dropped from create/update payload descriptions)
- `packages/cron/src/index.ts` (export)
- `packages/cli/src/cli.ts` (`CronParsedArgs.deliver`, `--deliver` parse branch,
  create input, update patch)

`parseStoreData` is lenient (only checks `schemaVersion` + `jobs` is array), so
old `jobs.json` files carrying `deliver: "local"` load fine and drop the field
on next save. Behavioral check: `--deliver origin` now errors
(`Unknown cron option: --deliver`); a fresh `jobs.json` contains no `deliver`
field. Focused gates `@sparkwright/cron schedule.test.ts` and CLI `-t cron`
green; full `release:check` EXIT=0.

## Related

- Scenarios: deterministic two-job `cron tick`; single-job `cron run`.
- Coverage: [cron](../coverage/cron.md)
- Run notes: [2026-06-24-cron-deliver-origin-noop.md](../runs/2026-06-24-cron-deliver-origin-noop.md)
