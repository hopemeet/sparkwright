# Task Create Agent MaxSteps Underallocation

## Record

- Pattern ID: `task-create-agent-maxsteps-underallocation`
- Status: `fixed`
- First seen: 2026-07-03
- Last seen: 2026-07-04
- Recorded count: 1

| Cause                   | Count |
| ----------------------- | ----: |
| `product_bug`           |     1 |
| `test_bug`              |     0 |
| `prompt_underspecified` |     1 |
| `model_variance`        |     1 |
| `environment`           |     0 |
| `stale_dist`            |     0 |
| `dirty_workspace`       |     0 |
| `unknown`               |     0 |

## Symptom

A real `openai/gpt-5.4-mini` run successfully loaded a project Skill, created
one awaited `task_create(kind:"agent")`, waited with the concrete task id, and
returned both requested sentinels from durable task output. `trace verify` and
`session check` were ok, there were no tool failures, no workspace writes, and
the task record status was `completed`.

`trace report` still failed with high `SUBAGENT_INCOMPLETE` because the model
added `payload.maxSteps: 1` to the background agent task. The child read both
requested files and produced a final answer, but the child run payload was
literal and correct:

- `stepsUsed: 1`
- `maxSteps: 1`
- `stepLimitReached: true`
- `truncated: true`
- `finality: "partial"`

The paired control run with the same fixture and explicit `payload.maxSteps: 4`
completed with `finality:"complete"` and `trace report` verdict `ok`.

## Root Cause

This is not a background task, Skill loading, notification, or durable-output
runtime failure. The weak point is real-model allocation of the optional
`maxSteps` field for `task_create(kind:"agent")`.

The host `task_create` agent payload schema currently describes `maxSteps` as
an "Optional child model-turn limit" with `minimum: 1`. That is accurate, but
for a child that must call read tools and then synthesize a final answer,
`maxSteps:1` is usually underallocated. The model inferred a low limit even
though the prompt did not request one. Because raw child finality must stay
literal, trace diagnostics correctly reported the sub-agent result as partial.

## Fix

Fixed on 2026-07-04 by aligning the main and nested
`task_create(kind:"agent")` payload guidance with dynamic `spawn_agent`:

- `payload.maxSteps` now says omitted values inherit the parent run's effective
  maxSteps;
- the payload description tells models to omit `maxSteps` unless an explicit
  child turn cap is needed;
- the guidance calls out that read-and-answer tasks usually need 4+ turns and
  broader search/refine/conclude work usually needs 6+.

Post-fix real `openai/gpt-5.4-mini` rerun:

- trace:
  `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-mini-skill-bg-Z4Td8R/.sparkwright/sessions/session_mr55i1fn5symfckr/trace.jsonl`
- task: `task_mr55i8ajkeqxo6df`
- task_create args: `payload.maxSteps: 4`
- child finality: `finality:"complete"`, `stepLimitReached:false`
- durable output: `BG_SKILL_AGENT_SENTINEL` and `BG_SKILL_DOC_SENTINEL`
- diagnostics: `trace report` ok, `trace verify` ok, `session check` ok

## Diagnostic Move

When an awaited background agent task completes but `trace report` says
`SUBAGENT_INCOMPLETE`, inspect:

```bash
node packages/cli/dist/index.js trace events <trace.jsonl> --type tool.requested --jsonl
node packages/cli/dist/index.js trace events <trace.jsonl> --type subagent.completed --jsonl
node packages/cli/dist/index.js tasks get <task-id> --workspace <workspace> --format json
node packages/cli/dist/index.js tasks output <task-id> --workspace <workspace> --format json
```

If `task_create` supplied a very low `payload.maxSteps`, classify the failed
report as model/prompt underallocation before investigating task revival or
Skill loading. Confirm by rerunning with `maxSteps` omitted or raised.

## Prevention

- Real-model prompts that require background child file reads should either
  omit `maxSteps` so the parent/default budget applies, or explicitly set a
  small but sufficient value such as 4+.
- Keep stable assertions on concrete task ids, durable task output,
  `run.notification.injected`, trace verify, and session check. Do not require
  exact step count or exact extra `tool_search` calls.
- Keep descriptor tests that assert `task_create(kind:"agent")` carries the
  inherited-budget and read-and-answer budget hints; this guards against drift
  from the clearer `spawn_agent` guidance.

## Related

- Coverage: [../coverage/agents.md](../coverage/agents.md),
  [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md)
- Run note:
  [../runs/2026-07-03-real-mini-skill-background-agent-maxsteps.md](../runs/2026-07-03-real-mini-skill-background-agent-maxsteps.md)
- Adjacent patterns:
  [task-action-empty-id-recovery.md](task-action-empty-id-recovery.md),
  [trace-background-agent-low-progress.md](trace-background-agent-low-progress.md),
  [trace-subagent-finality.md](trace-subagent-finality.md)
