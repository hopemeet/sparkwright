# Workflow Observation Counts Blocked Tool Requests

## Record

- Pattern ID: `workflow-observation-blocked-tool-requests`
- Status: `fixed`
- First seen: 2026-07-07
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

`workflow shadow` and `workflow distill` treat a tool request blocked by a
workflow model-node tool clamp as an observed useful tool. In the real Sonnet
workflow smoke, the active node allowed only `read`; Sonnet requested `glob`,
runtime emitted `TOOL_BLOCKED_BY_WORKFLOW_HOOK`, trace summary counted it as an
expected denial, and trace report stayed `ok`. Offline workflow observation
still reported `glob` as missing coverage and distilled a draft with `glob` in
the model node tool list.

## Root Cause

`observeWorkflowTraceEvents()` builds `tools` from every `tool.requested` event
without checking the terminal `tool.completed` / `tool.failed` result for that
tool call. Expected-denied or blocked attempts therefore look like productive
behavior to P7/P8 offline workflow tools.

## Fix

Fixed 2026-07-07 by filtering failed/blocked tool-call ids out of workflow
trace observation before deriving observed tools or `todo_write` evidence, and
by removing the distill draft's default `grep`/`glob` inspection seed. Regression
coverage now asserts that a `TOOL_BLOCKED_BY_WORKFLOW_HOOK` `glob` request does
not become `workflow shadow` missing coverage and does not appear in a
`workflow distill` draft.

## Diagnostic Move

For a suspect workflow shadow/distill mismatch, inspect the terminal tool event
for each observed tool:

```bash
node packages/cli/dist/index.js trace events <trace.jsonl> --type tool.requested --jsonl
node packages/cli/dist/index.js trace events <trace.jsonl> --type tool.failed --jsonl
node packages/cli/dist/index.js trace summary <trace.jsonl> --format text
```

If the only evidence for a missing/distilled tool is
`TOOL_BLOCKED_BY_WORKFLOW_HOOK` or another expected denial, classify the
shadow/distill result as this observation bug rather than a workflow runtime
clamp failure.

## Prevention

- Keep denied/blocked tool attempts out of productive workflow observation; if
  they need to be exposed later, surface them as separate diagnostics.
- Add a regression fixture where a model node with `tools: [read]` requests
  `glob`, receives `TOOL_BLOCKED_BY_WORKFLOW_HOOK`, then completes. `workflow
shadow` should not fail solely because of the blocked request, and `workflow
distill` should not include `glob` in the draft tool set.

## Related

- Coverage: [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md)
- Run notes: [../runs/2026-07-07-real-sonnet-broad-qa.md](../runs/2026-07-07-real-sonnet-broad-qa.md)
