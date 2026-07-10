# Workflow Distill/Shadow Misread Real Terminal State

## Record

- Pattern ID: `workflow-distill-shadow-terminal-state`
- Status: `fixed`
- First seen: 2026-07-06
- Last seen: 2026-07-07
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

`sparkwright workflow distill <session>` and
`sparkwright workflow shadow <workflow> <session>` return a useful report but
exit 1 / `ok:false` for a normal completed real CLI trace. The report warns:

```text
source session terminal state is run.completed, not completed
```

The source trace has a terminal `run.completed` event without `payload.state`.

## Root Cause

`observeWorkflowTraceEvents()` derives `terminalState` from
`payload.state ?? event.type`. Synthetic P7/P8 fixtures used
`run.completed` events with `payload.state:"completed"`, but real CLI traces
use the event type plus payload reason/message/fact ledger and omit
`payload.state`. The fallback therefore returns `"run.completed"` instead of
normalizing to `"completed"`.

## Fix

Fixed 2026-07-07 by normalizing real terminal event types in workflow trace
observation: `run.completed` -> `completed`, `run.failed` -> `failed`, and
`run.cancelled` -> `cancelled` unless an explicit payload state is present.
Current-source real mini verification used
`/tmp/sparkwright-mini-workflow-qa.Gad4nH/.sparkwright/sessions/session_mra719q2gshzofl1/trace.jsonl`;
the trace had `run.completed` without `payload.state`, while `workflow shadow`
and `workflow distill` both reported `terminal: completed` and `status: ok`.

## Diagnostic Move

When P7/P8 offline workflow tools say a normal source session is not completed,
inspect the raw terminal event:

```bash
node packages/cli/dist/index.js trace events <trace.jsonl> --type run.completed --jsonl
```

If the event exists and lacks `payload.state`, classify the P7/P8 result as
this terminal-state projection bug rather than a bad source run.

## Prevention

- Normalize terminal event types in `workflow-trace-observation.ts`:
  `run.completed` -> `completed`, `run.failed` -> `failed` unless an explicit
  payload state says otherwise.
- Keep a regression test using a real-shaped `run.completed` payload without
  `state`.
- Keep synthetic trace fixtures aligned with current CLI/core trace payloads.

## Related

- Coverage: [trace-diagnostics](../coverage/trace-diagnostics.md)
- Run note:
  [2026-07-06-workflow-runtime-real-mini-code-qa.md](../runs/2026-07-06-workflow-runtime-real-mini-code-qa.md)
  and
  [2026-07-07-real-mini-broad-trace-qa.md](../runs/2026-07-07-real-mini-broad-trace-qa.md)
