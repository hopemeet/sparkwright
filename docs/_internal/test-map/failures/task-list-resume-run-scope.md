# Task List Resume Run Scope

- Status: `fixed`
- Dominant cause: `product_bug`
- Owner layer: `@sparkwright/agent-runtime` task tools
- First observed: 2026-07-03 real `openai/gpt-5.4-mini` resume task QA
- Coverage: [../coverage/agents.md](../coverage/agents.md)

## Symptom

After `session resume`, model-side `task(action:"list")` returned
`{"tasks":[]}` even though durable completed tasks still existed and external
CLI `tasks list` could see them. Direct `task(action:"wait")` with old ids also
worked, proving the store had not lost records.

## Root Cause

`task_list` always filtered by the current `parentRunId`. A resumed run has a
new run id, while historical tasks keep the original parent run id. The model
had no schema-supported way to list older durable tasks when it did not already
know their ids.

## Fix

`task(action:"list")` and legacy `task_list` now accept `scope:"all"`.
Default `scope:"run"` preserves existing current-run behavior; `scope:"all"`
lists every durable task in the task store for resume recovery.

## Verification

- Deterministic agent-runtime test creates tasks under two run ids and verifies
  default list shows only the current run while `scope:"all"` shows both.
- Real resume canary:
  `/tmp/sparkwright-real-mini-task-scope.FUyGeX/.sparkwright/sessions/session_task_scope_qa/trace.jsonl`
  used `task(action:"list", scope:"all", kind:"agent", status:"completed")`
  and recovered task `task_mr4tyr00d2njwhc5`.
