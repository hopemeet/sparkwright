# Task Create Agent Kind Payload Contract

## Record

- Pattern ID: `task-create-agent-kind-payload-contract`
- Status: `fixed`
- First seen: 2026-07-01
- Last seen: 2026-07-01
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

Before the schema fix, a real `openai/gpt-5.4-mini` background-task prompt
selected `task_create`, but could not create a usable background agent task:

- when the prompt asks for a `repo-inspector` role, the model sends
  `kind:"repo-inspector"` and receives `TASK_KIND_UNREGISTERED`;
- when the prompt explicitly requires `kind:"agent"`, the model sends
  `payload:{}` and the durable task fails with
  `TASK_RUNNER_FAILED: spawn_agent goal must be a non-empty string`;

After the schema fix, the same explicit `kind:"agent"` prompt produced a valid
payload and the durable background task completed. The parent model may still
repeat `task_create` instead of monitoring the returned task id, but that is a
separate prompt/model/tool-monitoring issue; do not classify it as the payload
contract bug.

## Root Cause

The model-facing `task_create` contract is too generic for host-registered
background agent tasks. Its schema exposes `kind: string` and `payload: object`
without naming the registered `agent` kind or the required payload fields
accepted by the dynamic spawn path (`goal`, `role`, `prompt`, optional
`allowedTools`, `maxSteps`). Because `task_create` is eager, `tool_search` does
not return its schema when the model searches for recovery guidance; it only
returns the deferred `task` control tool.

The repeated post-create call is model variance, but the contract weakness is a
product bug because a realistic prompt gives the model insufficient structured
guidance to form a valid call.

## Fix

Current source exposes registered task-create kinds to the model-facing schema
and description. Host now advertises the registered `agent` kind with an enum
and a required payload object matching the dynamic `spawn_agent` input
(`goal`, `role`, `prompt`, plus optional `allowedTools`, `maxSteps`, and
`metadata`). Unknown-kind failures now include the live registered kinds so the
model can correct `kind:"repo-inspector"` to `kind:"agent"`.

Post-fix real mini evidence:

- trace:
  `/tmp/sparkwright-mini-qa-20260701-task-agent-fixed/session_mr1lz0xua6sedleb/trace.jsonl`
- first `task_create` args included full `kind:"agent"` payload with
  `goal`, `role`, `prompt`, `allowedTools:["read"]`, and `maxSteps:4`
- durable task:
  `.sparkwright/tasks/tasks/task_mr1lz3bphpeg925k/record.json`
- task status: `completed`; child run:
  `run_mr1lz3br3b0iwps2`; child agent:
  `dynamic_repo-inspector`; `finality:"complete"`

## Diagnostic Move

For background-task failures, inspect:

- `tool.requested task_create` arguments, especially `kind` and nested
  `payload`;
- `tool.failed` codes (`TASK_KIND_UNREGISTERED`, `TASK_RUNNER_FAILED`,
  `REPEATED_TOOL_CALL_SKIPPED`);
- durable task records under `.sparkwright/tasks` for task-level failure
  messages that may not appear in the parent trace;
- `tool_search` results to see whether recovery guidance exposed the missing
  schema.
- if a valid task completes but the parent run still hits `TOOL_DOOM_LOOP`,
  move the diagnosis to `prompt-induced-tool-loop` / task-monitoring guidance
  instead of reopening this contract bug.

## Prevention

- Keep focused tests asserting that host exposes `task_create.kind` as
  `["agent"]`, requires top-level `payload`, and requires
  `payload.goal` / `payload.role` / `payload.prompt`.
- Keep a deterministic protocol test that starts a real background agent through
  `task_create`.
- Add a real mini regression that creates `task_create(kind:"agent")`, then
  reads the returned task via `task(action=get|output)` when the monitoring loop
  is hardened.

## Evidence

- Run note:
  [../runs/2026-07-01-real-mini-background-task-qa.md](../runs/2026-07-01-real-mini-background-task-qa.md)
- `TASK_KIND_UNREGISTERED` trace:
  `/tmp/sparkwright-mini-qa-20260701-task-yes/session_mr1lhtfq6t0qzzcp/trace.jsonl`
- `TOOL_DOOM_LOOP` after empty-payload agent task:
  `/tmp/sparkwright-mini-qa-20260701-task-agent/session_mr1ljb1xvbnmx16i/trace.jsonl`
- Post-fix valid-payload / completed-task trace:
  `/tmp/sparkwright-mini-qa-20260701-task-agent-fixed/session_mr1lz0xua6sedleb/trace.jsonl`

## Related

- Coverage: [../coverage/agents.md](../coverage/agents.md)
- Matrix: [../matrices/model-sensitivity.md](../matrices/model-sensitivity.md),
  [../matrices/capability-sensitivity.md](../matrices/capability-sensitivity.md)
