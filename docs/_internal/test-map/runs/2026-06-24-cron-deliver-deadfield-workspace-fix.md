# 2026-06-24 Cron Deliver Dead-Field + Workspace Fix

## Summary

- Scenario: Fix the issues confirmed in
  [2026-06-24-cron-deliver-origin-noop.md](2026-06-24-cron-deliver-origin-noop.md)
  on a branch, no PR, with test-map records.
- Coverage: cron deliver surface removal; cron runner workspace resolution;
  cron CLI usage docs.
- Result: `pass` (all three fixes verified; full `release:check` EXIT=0).
- Branch: `fix/cron-deliver-deadfield-workspace` (not PR'd per workflow).

## Changes

1. **Problem 1 (option A) — remove the dead `deliver` field.** Dropped
   `DeliveryTarget` / `deliver` from `packages/cron/src/{model,store,tool,index}.ts`
   and `packages/cli/src/cli.ts` (`CronParsedArgs`, `--deliver` parse, create
   input, update patch). `parseStoreData` is lenient, so legacy `jobs.json` with
   `deliver: "local"` still loads and drops the field on next save.
2. **Problem 2 — `--workspace` ignored / trace leaked to cwd.** `runner.ts` now
   uses `job.workspace ?? options.workspaceRoot ?? process.cwd()`; added
   `workspaceRoot?` to `RunCronJobOptions` (flows through `CronSchedulerOptions`).
   CLI threads `parsed.workspaceRoot` into `runCronJobByRef` and `tickCron`.
   Job-level `job.workspace` still wins (precedence test unaffected).
3. **Problem 3 — undocumented flags.** `cronUsage()` now documents
   `--job-workspace` / `--clear-job-workspace` on create/update.

## Commands Or Harness

```bash
npm run build
npm --workspace @sparkwright/cron test -- test/schedule.test.ts          # 10 pass
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t cron        # 1 pass / 116 skip
npm run release:check                                                     # EXIT=0
# Behavioral repro (deterministic model, temp root + ws):
node packages/cli/dist/index.js cron create --schedule "* * * * *" --prompt x --deliver origin ...   # -> "Unknown cron option: --deliver"
node packages/cli/dist/index.js cron run j1 --model deterministic --root-dir "$root" --workspace "$ws"
```

## Evidence

- `--deliver origin` now rejected (`Unknown cron option: --deliver`); fresh
  `jobs.json` has zero `deliver` occurrences.
- `cron run --workspace "$ws"` (job without `job.workspace`): `tracePath` under
  `$ws/.sparkwright/sessions/cron-<id>/`; repo `.sparkwright/sessions` got 0 new
  cron sessions.
- `release:check` EXIT=0 (vitest, build, typecheck, typecheck:test, lint,
  format:check, check:reserved:strict, write-smoke all clean). One prettier nit
  on `runner.ts` was auto-fixed before the green run.

## Findings / Residual Risk

- Cron output is now local-only by contract; no delivery-target knob remains to
  test. If remote/origin delivery is ever wanted, it is a new feature, not a
  bug-fix.
- Branch is unmerged and un-PR'd by request; changes are not on `main`.
