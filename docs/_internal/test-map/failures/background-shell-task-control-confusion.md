# Background Shell Task Control Confusion

## Record

- Pattern ID: `background-shell-task-control-confusion`
- Status: `model-sensitive`
- First seen: 2026-07-10
- Last seen: 2026-07-11
- Recorded count: 2

| Cause                   | Count |
| ----------------------- | ----: |
| `product_bug`           |     0 |
| `test_bug`              |     0 |
| `prompt_underspecified` |     0 |
| `model_variance`        |     2 |
| `environment`           |     0 |
| `stale_dist`            |     0 |
| `dirty_workspace`       |     0 |
| `unknown`               |     0 |

## Symptom

After bash returns a background task id, a small model repeatedly calls
`task_create(kind:"agent")` to inspect/stop it, or reports that it stopped the
task after only `task get`/`task output`. The durable record remains running.

## Root Cause

Small-model selection and latency can confuse eager task creation with deferred
task control or prevent completion inside a short PTY window. This is not a
runtime lifecycle failure when trace and durable state remain truthful. A
same-prompt `openai/gpt-5.6-terra` A/B run succeeded after restoring concise
shell guidance and deferred `task`, including `tool_search`, output inspection,
`action:"stop"`, and a durable cancelled record.

## Diagnostic Move

Compare `model.completed.toolCalls`, `tool_search`, `task` tool results, and the
durable TaskStore record. A final-answer stop claim is false unless trace shows
`task { action:"stop", taskId }` returning `cancelled:true`.

## Prevention

- Keep the runtime contract and trace evidence authoritative: successful stop
  requires `task(action:"stop") -> { cancelled:true }` and a terminal record.
- Keep shell handoff guidance concise and use the normal deferred discovery
  path; do not add eager schemas or repeated negative prose solely for a weak
  model canary.
- Do not classify a 45-second real-model cutoff alone as a runtime failure.

## Related

- Coverage: [../coverage/shell.md](../coverage/shell.md)
- Run notes: [../runs/2026-07-10-real-nano-background-service-tui.md](../runs/2026-07-10-real-nano-background-service-tui.md)
