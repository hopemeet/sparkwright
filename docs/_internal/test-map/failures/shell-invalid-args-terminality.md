# Shell Invalid Args Terminality

## Record

- Pattern ID: `shell-invalid-args-terminality`
- Status: `watch`
- First seen: 2026-06-23
- Last seen: 2026-06-23
- Recorded count: 2

| Cause                   | Count |
| ----------------------- | ----: |
| `product_bug`           |     2 |
| `test_bug`              |     0 |
| `prompt_underspecified` |     0 |
| `model_variance`        |     0 |
| `environment`           |     0 |
| `stale_dist`            |     0 |
| `dirty_workspace`       |     0 |
| `unknown`               |     0 |

## Symptom

A real-model shell call supplied `foregroundTimeoutMs: 20` and
`timeoutMs: 0`. The CLI printed `Run failed: timeoutMs must be a positive
integer`, but the trace had a pending `tool.requested` span, no `tool.failed`,
and no run terminal event. `trace verify` failed with
`TRACE_TERMINAL_EVENT_COUNT_INVALID`, while `trace report` still returned
`verdict: ok`.

On 2026-06-23 the same terminality gap was reproduced deterministically with
`--model scripted` and a fixed `shell` tool call containing `timeoutMs: 0`; the
trace again had `tool.requested shell`, no `tool.failed`, no run terminal event,
`trace verify` failed, and `trace report` returned `verdict: ok`.

## Root Cause

The shell tool input normalization rejected `timeoutMs: 0` synchronously before
the tool failure and run terminal paths were recorded. The trace verifier caught
the missing terminal event; the report view did not classify the incomplete
trace as a finding.

## Diagnostic Move

When CLI output shows an internal tool-argument error, inspect both
`tool.requested` payloads and `trace verify`; do not trust `trace report` alone
until terminality is known.

## Prevention

Capture tool input normalization failures as structured `tool.failed` evidence
and ensure the run records a terminal `run.failed` event. Trace reports should
also surface pending tool/run spans or invalid terminal-event counts as
diagnostic findings.

## Fix Verification

On 2026-06-23, current source converted `policyForArgs` validation failures
into structured tool results. A scripted shell run with `timeoutMs: 0` now
records one `tool.failed` with `TOOL_ARGUMENTS_INVALID` and metadata
`phase: policyForArgs`, records exactly one terminal `run.completed`, emits no
`tool.started`, and passes `trace verify`.

The CLI exits non-zero because the tool failure remains unresolved; that is the
expected user-facing outcome. `trace report` now returns `verdict: failed` with
`UNRESOLVED_TOOL_FAILURES` instead of silently reporting `ok`.

Evidence:

- Trace:
  `/tmp/sparkwright-shell-invalid-fixed.bMoxpz/.sparkwright/sessions/session_mqqfcjmiw6qq3h6o/trace.jsonl`
- Focused gates:
  `npm --workspace @sparkwright/core test -- test/run.test.ts test/trace.test.ts`
- Repository gate: `npm run check`

## Related

- Scenarios: [../scenarios/shell-foreground-timeout.yaml](../scenarios/shell-foreground-timeout.yaml)
- Coverage: [../coverage/shell.md](../coverage/shell.md),
  [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md)
- Run notes: [../runs/2026-06-23-broad-real-cli-tui-partial.md](../runs/2026-06-23-broad-real-cli-tui-partial.md)
  [../runs/2026-06-23-tui-cron-shell-followup.md](../runs/2026-06-23-tui-cron-shell-followup.md)
