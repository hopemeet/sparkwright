# Trace Recovered Verification Command Failure

## Record

- Pattern ID: `trace-recovered-verification-command-failure`
- Status: `fixed`
- First seen: 2026-06-29
- Last seen: 2026-06-29
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

A coding-fix run intentionally executes a failing verification command first,
edits the code, then reruns the same verification successfully. Trace summary
reports `verification failures: 1 total, 0 unresolved, last success npm test`,
but `trace report` still returns `passed_with_issues` with
`COMMAND_FAILURES`.

## Root Cause

The report-level generic shell command failure finding does not fully account
for verification recovery. It treats the initial failed shell command as a
medium issue even when the command is the expected pre-fix verification and a
later equivalent command succeeds after a managed workspace write.

## Diagnostic Move

Compare:

- `trace summary` verification totals and `last success`
- `trace report` findings
- ordered `workspace.write.completed` and later successful verification command

If the failure was before the fix and the same verification command succeeded
afterward, do not treat the report downgrade as proof the final workspace state
is unhealthy.

## Prevention

- Teach `trace report` to distinguish unresolved command failures from recovered
  verification failures when ordered write and later success evidence exists.
- Keep a separate finding for non-verification shell failures that remain useful
  operational evidence.

## Fix

- 2026-06-29: `packages/core/src/trace-diagnostics.ts` no longer emits generic
  `COMMAND_FAILURES` when every shell failure is a recovered verification
  failure with a later successful verification command.
- Added `packages/core/test/trace.test.ts` coverage for failed-then-passed
  verification.
- Verified with `npm --workspace @sparkwright/core test -- test/context.test.ts
test/run.test.ts test/trace.test.ts`, `npm --workspace @sparkwright/core run
typecheck`, and `npm run build --workspace @sparkwright/core`.

## Related

- Coverage: [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md)
- Run notes: [../runs/2026-06-29-real-mini-tool-surface-qa.md](../runs/2026-06-29-real-mini-tool-surface-qa.md)
