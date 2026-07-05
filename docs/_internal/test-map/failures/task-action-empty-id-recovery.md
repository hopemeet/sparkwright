# Task Action Empty Id Recovery

## Record

- Pattern ID: `task-action-empty-id-recovery`
- Status: `fixed`
- First seen: 2026-07-02
- Last seen: 2026-07-02
- Recorded count: 1

| Cause | Count |
| --- | ---: |
| `product_bug` | 1 |
| `test_bug` | 0 |
| `prompt_underspecified` | 0 |
| `model_variance` | 1 |
| `environment` | 0 |
| `stale_dist` | 0 |
| `dirty_workspace` | 0 |
| `unknown` | 0 |

## Symptom

A real `openai/gpt-5.4-mini` background-task prompt explicitly told the model
to create one awaited background agent task, then wait for and read output from
the returned task id. The runtime successfully completed the background child,
and later valid `task wait` / `task output` calls succeeded, but the CLI exited
non-zero with unresolved `TASK_ARGUMENTS_INVALID` failures.

The first model turn after `tool_search select:task` batched:

- `task_create(kind:"agent", mode:"awaited", payload:{...})`
- `task(action:"wait", taskId:"", ids:[])`
- `task(action:"output", taskId:"")`

`task_create` returned `task_mr31lao7rmsc3cet`; the empty-id `task` calls
failed; a later model turn used the real id and succeeded. `trace verify` was
ok, while `trace report` failed with unresolved tool failures.

## Root Cause

The model-facing deferred `task` schema is too permissive for action-specific
arguments. `tool_search` exposes `taskId` as a plain string, `ids` as an array,
and only `action` as required. It does not express that:

- `action:"wait"` needs either a non-empty `ids` array or non-empty `taskId`;
- `action:"output"` / `action:"get"` need non-empty `taskId`;
- dependent `task` calls should not be batched with `task_create` before the
  returned task id exists.

The runtime correctly rejects the empty ids, but later successful wait/output
with the real task id does not recover the earlier empty-target failures. This
leaves a successful background-task communication run reported as failed.

## Diagnostic Move

For background-task monitor failures:

```bash
node packages/cli/dist/index.js trace events "$trace" --type tool.requested --jsonl
node packages/cli/dist/index.js trace events "$trace" --type tool.failed --jsonl
node packages/cli/dist/index.js trace events "$trace" --type subagent.completed --jsonl
node packages/cli/dist/index.js trace events "$trace" --type run.notification.injected --jsonl
node packages/cli/dist/index.js trace report "$trace" --format text
node packages/cli/dist/index.js trace verify "$trace" --format text
```

If `task_create` completed and a durable task record is terminal, inspect
whether failed `task` calls used empty placeholder ids before concluding that
the background task runner failed.

## Fix

Fixed on 2026-07-02 by tightening both the model-facing tool contract and the
diagnostic outcome classifier:

- `task` now exposes action-specific JSON Schema branches with non-empty
  `taskId` / `ids` constraints for `get`, `output`, `stop`, and `wait`.
- `task` now has semantic `validateInput()` coverage, because core's generic
  local schema validator does not enforce `minLength`, `minItems`, `oneOf`, or
  `anyOf`.
- `parseWaitArgs()` no longer silently ignores an explicitly empty `taskId`.
- Core tool-outcome analysis treats empty task monitor placeholders as
  recovered only after a later same-action concrete `task` monitor call
  completes successfully.
- Host catalog coverage asserts the action-specific deferred `task` schema is
  preserved when the main tool catalog is assembled.

Post-fix real `openai/gpt-5.4-mini` rerun:

- Trace:
  `/tmp/sparkwright-real-mini-bg-fixed-20260702/session_mr39dffk4zblw084/trace.jsonl`
- Result: CLI exit 0; `trace report` verdict `ok`; `trace summary` reported 0
  tool failures; `session check` was ok.
- The model waited for the concrete returned id `task_mr39dm012zmcqavi` before
  calling `task(action:"wait")` and `task(action:"output")`.

Old trace reclassification with the fixed core:

- `trace summary` reports 2 recovered and 0 unresolved tool failures for the
  original trace.
- `trace report` verdict is `passed_with_issues` with
  `RECOVERED_TOOL_FAILURES`, not a failing unresolved-tool report.

## Prevention

- Keep action-specific `task` schema and semantic validation in sync; schema is
  for provider/model guidance, while `validateInput()` is the runtime invariant.
- Keep deterministic regression coverage for same-turn placeholder calls so
  recovery semantics stay explicit.
- Keep real-model canaries prompt-shape tolerant: exact turn count and tool
  order are not invariants, but concrete task ids and clean trace/session
  diagnostics are.

## Evidence

- Run note:
  [../runs/2026-07-02-real-mini-background-code-qa.md](../runs/2026-07-02-real-mini-background-code-qa.md)
- Trace:
  `/tmp/sparkwright-real-mini-bg.zbXt46/session_mr31l4683b1wzxq8/trace.jsonl`
- Durable task:
  `.sparkwright/tasks/tasks/task_mr31lao7rmsc3cet/record.json`
- Task status: `completed`; child run `run_mr31laobkmjlpkys`; child agent
  `dynamic_package-inspector`; finality `complete`.

## Related

- Coverage: [../coverage/agents.md](../coverage/agents.md),
  [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md)
- Matrix: [../matrices/model-sensitivity.md](../matrices/model-sensitivity.md),
  [../matrices/prompt-sensitivity.md](../matrices/prompt-sensitivity.md),
  [../matrices/capability-sensitivity.md](../matrices/capability-sensitivity.md)
