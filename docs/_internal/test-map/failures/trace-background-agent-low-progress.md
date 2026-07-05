# Trace Background Agent Low Progress

## Record

- Pattern ID: `trace-background-agent-low-progress`
- Status: `fixed`
- First seen: 2026-07-03
- Last seen: 2026-07-03
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

A real `openai/gpt-5.4-mini` run successfully created an awaited background
`agent` task, waited on the concrete task id, injected a task notification, and
persisted durable task output. `trace verify` and `session check` were ok, there
were no tool failures, and the child finished with `finality:"complete"`.

`trace report` still returned `passed_with_issues` with medium
`LOW_NET_PROGRESS`:

- 8 model calls;
- 8 tool calls;
- 0 unique written files;
- 31 budget check events.

This is noisy for read-only background-agent workflows, where successful
sub-agent completion and task output are the intended progress signal.

## Root Cause

The low-progress heuristic is applied to aggregate trace counts across all
runs. In this multi-run background-agent trace, neither the parent run nor the
child run was independently low-progress:

- parent-only report: `ok`, 5 model calls, 5 tool calls;
- child-only report: `ok`, 3 model calls, 3 tool calls.

The merged trace crossed the hard low-mutation threshold only after the parent
and child counts were added together: 8 model calls, 8 tool calls, 0 writes.
`collectTraceReportFacts()` currently passes aggregate model/tool counts into
`analyzeLowNetProgress()` and does not pass any completed sub-agent/task
progress credit. The heuristic therefore treats normal task decomposition as
one long low-write loop.

## Diagnostic Move

When `LOW_NET_PROGRESS` appears on a read-only background-agent trace, inspect:

```bash
node packages/cli/dist/index.js trace summary <trace.jsonl> --format json
node packages/cli/dist/index.js trace events <trace.jsonl> --type tool.requested --jsonl
node packages/cli/dist/index.js trace events <trace.jsonl> --type subagent.completed --jsonl
node packages/cli/dist/index.js trace events <trace.jsonl> --type run.notification.injected --jsonl
node packages/cli/dist/index.js session check <session-id> --workspace <workspace> --format json
node packages/cli/dist/index.js tasks output <task-id> --workspace <workspace> --format json
```

If the task is terminal, the child has `finality:"complete"`, durable output is
available, and there are no unresolved tool failures, treat the background
runtime as healthy and classify the report as diagnostic noise.

## Prevention

- Add a deterministic trace fixture for a successful read-only background-agent
  task that has `task_create`, `task wait`, `subagent.completed`, and
  `run.notification.injected`.
- Apply `LOW_NET_PROGRESS` per run, or otherwise avoid summing parent and child
  model/tool counts before thresholding. Completed sub-agent/task terminal
  progress should also be credited when a read-only goal completes through a
  background child with no unresolved failures.

## Fix

Fixed on 2026-07-03 by changing `trace-diagnostics.ts` to build
`LOW_NET_PROGRESS` inputs per `runId`. The existing thresholds in
`run-health.ts` were preserved, but trace reports no longer sum parent and
child/sub-agent model/tool counts before thresholding. Multi-run low-progress
findings now include the offending run id and dominant agent id in evidence.

Regression coverage:

- parent 5 calls + child 3 calls, merged count crossing the old threshold, no
  `LOW_NET_PROGRESS`;
- child run independently crossing the threshold still reports
  `LOW_NET_PROGRESS` with child run/agent evidence;
- existing single-run low-progress, sequential pagination, and delayed
  verification tests still pass.

Post-fix replay:

- Trace:
  `/tmp/sparkwright-real-mini-bg-current.9hEJTL/.sparkwright/sessions/session_mr4hdu7zh7hdjb8i/trace.jsonl`
- Result: `trace report` verdict `ok`, findings none.

## Evidence

- Run note:
  [../runs/2026-07-03-real-mini-background-skill-agent-qa.md](../runs/2026-07-03-real-mini-background-skill-agent-qa.md)
- Trace:
  `/tmp/sparkwright-real-mini-bg-current.9hEJTL/.sparkwright/sessions/session_mr4hdu7zh7hdjb8i/trace.jsonl`
- Session: `session_mr4hdu7zh7hdjb8i`
- Task: `task_mr4he6sq5yvcsfsq`
- Child run: `run_mr4he6ssn6cqo4mq`

## Related

- Coverage: [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md),
  [../coverage/agents.md](../coverage/agents.md)
- Earlier adjacent fixed pattern:
  [trace-sequential-pagination-low-progress.md](trace-sequential-pagination-low-progress.md)
