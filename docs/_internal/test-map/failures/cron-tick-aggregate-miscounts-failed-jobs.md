# Cron Tick Aggregate Miscounts Failed Jobs

## Record

- Pattern ID: `cron-tick-aggregate-miscounts-failed-jobs`
- Status: `fixed`
- First seen: 2026-06-29
- Last seen: 2026-06-29
- Recorded count: 1

| Cause | Count |
| --- | ---: |
| `product_bug` | 1 |
| `test_bug` | 0 |
| `prompt_underspecified` | 0 |
| `model_variance` | 0 |
| `environment` | 0 |
| `stale_dist` | 0 |
| `dirty_workspace` | 0 |
| `unknown` | 0 |

## Symptom

`sparkwright cron tick` can print `completed: 2` and exit 0 when one due job
finishes ok and another due job persists `lastStatus:"error"`.

The reproducer used two one-shot due jobs:

- `ok-read`: workspace had a normal `README.md`; with `--yes-edits`, status
  ended `lastStatus:"ok"`.
- `bad-read`: workspace had `README.md` as a directory; status ended
  `lastStatus:"error"` with unresolved tool failures.

The command still printed:

```json
{"attempted":2,"completed":2,"skippedBecauseLocked":false,"skippedBecauseJobLocked":0}
```

## Root Cause

Fixed 2026-06-29. `tickCron()` incremented `completed` for every due job that
was not skipped by the per-job lock. It ignored the cron-local
`runCronJob().ok` result, so jobs persisted as `lastStatus:"error"` still
counted as completed in the tick aggregate.

This is distinct from `cron-run-outcome-misclassified`: per-job status and
per-job trace classification are correct here; only the aggregate tick result
is misleading.

## Diagnostic Move

Compare the aggregate `cron tick` JSON against each job's persisted status and
trace report:

```bash
node packages/cli/dist/index.js cron tick --root-dir "$root" --workspace "$ok_ws" --model deterministic --yes-edits
node packages/cli/dist/index.js cron status ok-read --root-dir "$root"
node packages/cli/dist/index.js cron status bad-read --root-dir "$root"
node packages/cli/dist/index.js trace report "$bad_trace" --format text
```

If `cron status` shows any due job with `lastStatus:"error"` while tick reports
all attempted jobs as completed, this pattern reproduced.

## Prevention

`CronTickResult.completed` now counts successful cron-local results only, and
`CronTickResult.failed` counts due jobs that ran and returned `ok:false`.
Per-job lock skips remain separate as `skippedBecauseJobLocked`.

The CLI `cron tick` command now returns exit 1 when `failed > 0`.

Focused coverage:

```bash
npm --workspace @sparkwright/cron test -- test/schedule.test.ts
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "cron tick has a failed job"
```

## Related

- Coverage: [../coverage/cron.md](../coverage/cron.md)
- Run notes: [../runs/2026-06-29-mcp-cron-tui-agent-boundary-qa.md](../runs/2026-06-29-mcp-cron-tui-agent-boundary-qa.md)
- Related fixed pattern: [cron-run-outcome-misclassified.md](cron-run-outcome-misclassified.md)
