# Cron Run Denials Were Misclassified As Successful Jobs

## Record

- Pattern ID: `cron-run-outcome-misclassified`
- Status: `fixed`
- First seen: 2026-06-25
- Last seen: 2026-06-25
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

A cron job whose required workspace write was denied could still finish with
`result.ok: true` and persist `lastStatus: ok` when the model recovered with a
final explanatory answer. The trace contained `approval.requested`,
`workspace.write.denied`, and `tool.failed`, but the unattended cron status
looked successful.

## Root Cause

`packages/cron/src/runner.ts` treated `RunResult.state === "completed"` as job
success. That matched the core run-loop terminal state, but it was too weak for
unattended cron jobs because core deliberately lets interactive runs complete
after advisory approval/policy denials.

## Diagnostic Move

Compare cron status with the job trace:

```bash
node packages/cli/dist/index.js cron status <job> --root-dir "$root"
node packages/cli/dist/index.js trace events <trace.jsonl> --type workspace.write.denied --jsonl
node packages/cli/dist/index.js trace events <trace.jsonl> --type tool.failed --jsonl
```

If status reports `lastStatus: ok` while the trace contains denial or
unresolved failure evidence, this pattern reproduced.

## Prevention

Cron runner should derive job success from structured run evidence, not only
from terminal run state. Use core completed-run outcome classification for
failing tool/verification outcomes, and apply cron-local unattended semantics
for approval or policy denials.

## Fix Verification

On 2026-06-25, current source computes a cron-local verdict after `run.start()`
using `completedRunOutcomeFromEvents()` and `analyzeToolOutcomes()`.

Evidence:

- Focused unit: `npm --workspace @sparkwright/cron test -- test/schedule.test.ts`
  covers denied workspace writes and unresolved tool failures after a final
  model answer.
- CLI smoke: deterministic `cron run --write` without `--yes-edits` exited 1,
  left README unchanged, and persisted `lastStatus: error`.
- CLI smoke: deterministic `cron run --write --yes-edits` exited 0, wrote
  README, and persisted `lastStatus: ok`.

## Related

- Coverage: [../coverage/cron.md](../coverage/cron.md)
- Project map: [../../project-map/maps/capabilities/cron.md](../../project-map/maps/capabilities/cron.md)
