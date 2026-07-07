# Task Create Agent Low Signal Result Feedback

## Record

- Pattern ID: `task-create-agent-low-signal-result-feedback`
- Status: `fixed`
- First seen: 2026-07-07
- Last seen: 2026-07-07
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

A real `openai/gpt-5.4-mini` Skill-guided awaited
`task_create(kind:"agent")` run created three equivalent background agent tasks
even though the prompt requested exactly one. Each child completed successfully,
but the parent kept spawning instead of waiting on or retrieving output for the
existing task id.

Trace:
`/tmp/sparkwright-agent-skill-bg.JCm3sJ/.sparkwright/sessions/session_mra7xnvxy6d8rxwi/trace.jsonl`.

## Root Cause

This is not only weak model behavior. SparkWright gave the parent low-signal
feedback:

- detached `task_create` returned only `{ taskId, mode, awaited }` with no
  model-visible next action;
- terminal task notifications had `result` in metadata, but the injected
  notification body said only that the task completed;
- if the child completed while the parent model turn was already in flight, the
  stale parent turn could request another equivalent `task_create` before the
  completion notification was injected.

The active per-kind `agent=1` concurrency cap was not violated because the
first child had completed before the second `task_create` executed.

## Fix

Fixed on 2026-07-07:

- detached/promoted `task_create` results now include `nextAction` with the
  concrete task id, recommended `task` action, output retrieval hint, and
  duplicate-avoidance guidance;
- host task notification injection now includes `Result summary: ...` in the
  model-visible notification body, not only in metadata.

## Diagnostic Move

When a parent repeats `task_create(kind:"agent")`:

1. Compare `tool.completed task_create` outputs for next-action guidance.
2. Inspect `run.notification.injected` and the next `prompt.built` selected
   context to see whether the child result was visible in body text.
3. Check child `run.completed` / `subagent.completed` before blaming task
   execution.
4. If child tasks completed and feedback was low-signal, classify as task
   surface/runtime feedback, not only model variance.

## Prevention

- Keep detached task tool outputs corrective: they should tell the model what
  to do with the returned task id.
- Keep terminal notifications useful as body text, because models do not
  reliably act on metadata-only facts.
- Trace report now includes `REPEATED_TASK_CREATE_LIFECYCLE` for repeated
  equivalent `task_create(kind:"agent")` after a completed same-payload child
  task, so future regressions point at task lifecycle reuse instead of only
  generic low progress.

## Related

- Coverage: [../coverage/agents.md](../coverage/agents.md),
  [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md)
- Run note:
  [../runs/2026-07-07-real-mini-agent-skill-multidirection-qa.md](../runs/2026-07-07-real-mini-agent-skill-multidirection-qa.md)
- Adjacent pattern:
  [prompt-induced-tool-loop.md](prompt-induced-tool-loop.md)
