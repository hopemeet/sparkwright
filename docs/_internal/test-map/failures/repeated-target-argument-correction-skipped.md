# Repeated Target Guard Skips Argument Correction

## Record

- Pattern ID: `repeated-target-argument-correction-skipped`
- Status: `fixed`
- First seen: 2026-07-22
- Last seen: 2026-07-23
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

A file/tool call fails with a correctable argument such as `offset:-1`. The
model retries the same path with corrected arguments, but Core returns
`REPEATED_TOOL_CALL_SKIPPED` without executing the corrected call.

## Root Cause

The loop guard keyed failures by semantic target only. It did not distinguish a
failure that applies to the target from one that applies only to the attempted
arguments, while its model-visible nudge incorrectly generalized from
directory failures to every offset/limit change.

## Diagnostic Move

Compare `tool.requested` arguments with actual tool execution count and the
ordered failure codes. A correctable first failure followed by changed
arguments must execute twice; EISDIR/not-found, expected denial, failed same
Shell command, and exact repeats must still stay guarded.

## Prevention

- Carry a machine-readable retry scope with remembered failure context.
- Keep positive and negative tests paired: corrected offset succeeds while a
  target-invariant directory failure remains blocked.
- Do not encode one failure example as a universal nudge.

## Fix

- 2026-07-23: Core records `retryScope:"arguments"|"target"`, admits changed
  arguments only for the former, preserves the scope through synthetic repeat
  metadata, and replaces the offset/limit claim with scope-specific recovery.
- Focused Core run coverage proves corrected arguments execute twice while
  EISDIR and failed Shell-command guards remain intact.

## Related

- Coverage: [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md)
- Run notes: none; deterministic reproduction and regression coverage.
