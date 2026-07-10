# Workflow Script-To-Model Transition Keeps Parent Tool Catalog

## Record

- Pattern ID: `workflow-script-transition-tool-clamp`
- Status: `fixed`
- First seen: 2026-07-06
- Last seen: 2026-07-06
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

A workflow whose first node is a non-model `script` and whose next model node
declares `tools: [read]` can still expose and execute parent-catalog tools in
the model turn after the script completes. In the observed real-mini run,
`workflow-runtime-p4-smoke` completed its `p4-smoke` script node, transitioned
to `summarize`, and then the model successfully called `tool_search`, `task`,
`glob`, and `grep` even though the `summarize` node declares only `read`.

The workflow record completed, but the CLI exited 1 because the model also made
an invalid `read` call. The record metadata lacked `episodeAllowedTools` and
kept `workflowEpisode.nodeId:"p4-smoke"` for the whole run.

## Root Cause

Likely boundary bug in the P3/P4 actor episode shape: worker-entry physical
catalog narrowing happens when the worker starts on a model node. When the
worker starts by draining a non-model script node and then reaches a later
model node in the same core run, the parent catalog remains available and the
fallback workflow `PreToolUse` clamp does not enforce the later model node's
`tools` declaration.

## Diagnostic Move

For workflow runs that transition from non-model nodes to model nodes, inspect
all three facts together:

```bash
node packages/cli/dist/index.js workflow list --workspace <workspace> --format json
node packages/cli/dist/index.js trace events <trace.jsonl> --type tool.requested --jsonl
node packages/cli/dist/index.js trace events <trace.jsonl> --type workflow.node.completed --jsonl
```

If the active model node has a narrow `tools` list but requested tools include
unlisted parent-catalog tools, classify it as this runtime clamp/catalog bug.

## Prevention

- Add an end-to-end workflow fixture that starts with `script` or another
  non-model node, then transitions to a model node with `tools: [read]`, and
  scripts the model to request a disallowed tool.
- Assert either a fresh worker episode with `episodeAllowedTools` for the model
  node or a `TOOL_NOT_FOUND` / workflow clamp failure before the disallowed
  tool executes.
- Keep the test distinct from the existing model-entry catalog narrowing case,
  which starts directly on a model node and can pass while this transition path
  is broken.

## Fix

- 2026-07-07: Current-source real Sonnet workflow smoke verified that a
  script/non-model -> model transition now enforces the later model node's
  declared tool clamp. The temp `sonnet-workflow-smoke` asset transitioned from
  script node `test` to model node `summarize` (`tools: [read]`); Sonnet
  requested `glob`, and runtime emitted `TOOL_BLOCKED_BY_WORKFLOW_HOOK` as an
  expected denial. The disallowed tool did not execute, `trace report` stayed
  `ok`, `trace verify` passed, and session check passed.
- Verification trace:
  `/var/folders/xt/8k1ng8016flcnrd91z7pc9800000gn/T/sparkwright-sonnet-write-qa-WWChqu/.sparkwright/sessions/session_mr9fmua899dimnc2/trace.jsonl`.

## Related

- Coverage: [trace-diagnostics](../coverage/trace-diagnostics.md)
- Run note:
  [2026-07-06-workflow-runtime-real-mini-code-qa.md](../runs/2026-07-06-workflow-runtime-real-mini-code-qa.md)
  and [2026-07-07-real-sonnet-broad-qa.md](../runs/2026-07-07-real-sonnet-broad-qa.md)
