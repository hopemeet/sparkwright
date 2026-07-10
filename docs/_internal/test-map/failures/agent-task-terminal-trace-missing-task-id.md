# Agent Task Terminal Trace Missing Task Id

## Record

- Pattern ID: `agent-task-terminal-trace-missing-task-id`
- Status: `fixed`
- First seen: 2026-07-07
- Last seen: 2026-07-07
- Fixed: 2026-07-07
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

A real `openai/gpt-5.4-mini` intentional repeated
`task_create(kind:"agent", mode:"awaited")` canary created a completed agent
task, then created equivalent agent tasks again. The trace had task ids in
`task_create` outputs and later prompt-injected task completion context, but
`trace report` emitted only high `UNRESOLVED_TOOL_FAILURES` for an earlier
`TASK_CONCURRENCY_LIMIT`. It did not emit the expected medium
`REPEATED_TASK_CREATE_LIFECYCLE`.

Trace:
`/tmp/sparkwright-mini-repeat-task.3FHsqD/.sparkwright/sessions/session_mraccb4iw0xgw0ha/trace.jsonl`.

## Root Cause

The repeated-task diagnostic joins `task_create` observations to terminal task
evidence through raw trace events. In this trace:

- `tool.completed task_create` outputs included concrete `taskId` and
  `nextAction`;
- `run.notification.injected` caused later prompt context to include
  `Task <taskId> ... completed` and `Result summary: ...`;
- the raw `subagent.completed` event for the agent task did not include
  `taskId` in payload or metadata;
- no raw `task.completed` event was present.

Because the terminal raw event lacked `taskId`, `trace report` could not prove
that a later equivalent `task_create` happened after a prior same-payload task
had completed.

## Fix

`runHostAgentTask()` now passes the owning task id into the dynamic spawn path,
and `spawnSubAgent()` projects that id onto parent-visible `subagent.*` payloads
and metadata. This gives raw trace diagnostics task-terminal evidence without
depending on prompt-injected notification text.

Post-fix real mini verification trace:
`/tmp/sparkwright-mini-taskid-fix.2SJFZr/.sparkwright/sessions/session_mradiara7baut36j/trace.jsonl`.

- `subagent.completed.payload.taskId`: `task_mradida98lwa2qmn`
- `subagent.completed.metadata.taskId`: `task_mradida98lwa2qmn`
- `trace report`: `passed_with_issues` with medium
  `REPEATED_TASK_CREATE_LIFECYCLE`
- `trace verify`: `ok`
- `session check`: `ok`

## Diagnostic Move

Inspect the task-create requests, terminal sub-agent events, task terminal
events, and report:

```bash
node packages/cli/dist/index.js trace events <trace.jsonl> --type tool.completed --contains task_create --jsonl
node packages/cli/dist/index.js trace events <trace.jsonl> --type subagent.completed --jsonl
node packages/cli/dist/index.js trace events <trace.jsonl> --type task.completed --jsonl
node packages/cli/dist/index.js trace report <trace.jsonl> --format text
```

If `task_create` has task ids but terminal agent-task events do not, classify
missing lifecycle findings as a trace/runtime metadata gap before blaming only
model variance or prompt shape.

## Prevention

- Keep `taskId` on raw `subagent.completed` / `subagent.failed` events for
  `entrypoint:"agent_task"`.
- Keep the trace diagnostic fixture asserting that completed same-payload
  agent tasks can be joined back to the originating `task_create`.
- Consider making `task_create.nextAction` mention `tool_search select:task`
  when the `task` tool is deferred and not currently loaded.

## Related

- Scenarios: real mini intentional repeated agent-task lifecycle canary
- Coverage: [../coverage/agents.md](../coverage/agents.md),
  [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md)
- Run notes:
  [../runs/2026-07-07-real-mini-trace-followup-qa.md](../runs/2026-07-07-real-mini-trace-followup-qa.md)
