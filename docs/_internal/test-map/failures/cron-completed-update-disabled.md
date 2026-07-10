# Cron Completed Job Update Leaves Job Disabled

## Record

- Pattern ID: `cron-completed-update-disabled`
- Status: `watch`
- First seen: 2026-06-25
- Last seen: 2026-06-25
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

A completed one-shot/repeat-limited cron job updated with a new schedule reports
`state: scheduled` but stays `enabled: false`. Even when the new schedule is
already due, `cron tick` attempts zero jobs. A later `cron resume` enables the
job, but the repeat counter remains exhausted and can exceed `repeat.times`
after another run.

## Root Cause

`CronStore.updateJob` resets `state` from `completed` or `error` to `scheduled`
when `patch.schedule` is present, but it does not restore `enabled` or define
what should happen to `repeat.completed`. The store can therefore publish an
internally inconsistent state: scheduled and due, but disabled.

## Diagnostic Move

After updating a completed cron job, inspect both `state` and `enabled`, then run
`cron tick` with the new schedule due:

```bash
node packages/cli/dist/index.js cron update <completed-job> --root-dir "$root" --schedule "$past_iso"
node packages/cli/dist/index.js cron status <completed-job> --root-dir "$root"
node packages/cli/dist/index.js cron tick --root-dir "$root" --workspace "$ws" --model deterministic
```

If status shows `state: scheduled`, `enabled: false`, and tick reports
`attempted: 0`, this pattern reproduced.

## Prevention

Choose and test one explicit lifecycle contract:

- updating a completed/error job reactivates it (`enabled: true`) and resets or
  documents repeat accounting, or
- updating preserves disabled/completed status until explicit `resume`, but does
  not report `state: scheduled` prematurely.

Add a store or CLI regression that covers completed -> update schedule -> due
tick.

## Fix Verification

On 2026-06-25, current source reactivates terminal jobs when schedule changes:
`state` becomes `scheduled`, `enabled` becomes `true`, `runningSince` is
cleared, and `repeat.completed` resets to zero for the new cycle.

Evidence:

- Focused unit: `npm --workspace @sparkwright/cron test -- test/schedule.test.ts`
- Manual CLI smoke: completed repeat-limited job updated to a due timestamp;
  status showed `enabled: true`, `repeat.completed: 0`, and subsequent
  deterministic `cron tick` reported `attempted: 1`, `completed: 1`.

## Related

- Coverage: [../coverage/cron.md](../coverage/cron.md)
- Run note: [../runs/2026-06-25-cron-real-tool-qa.md](../runs/2026-06-25-cron-real-tool-qa.md)
