# Real Regression Write Denied Append File

## Record

- Pattern ID: `real-regression-write-denied-append-file`
- Status: `active`
- First seen: 2026-06-23
- Last seen: 2026-06-23
- Recorded count: 1

| Cause | Count |
| --- | ---: |
| `product_bug` | 0 |
| `test_bug` | 1 |
| `prompt_underspecified` | 0 |
| `model_variance` | 0 |
| `environment` | 0 |
| `stale_dist` | 0 |
| `dirty_workspace` | 0 |
| `unknown` | 0 |

## Symptom

`REAL_WRITE_DENIED` in `npm run regression:real-model` fails after a real-model
run leaves the workspace unchanged but records no denied write. The trace shows
18 `tool_search` calls for `append_file`, no `append_file` call, no
`tool.failed`, no approvals, and no workspace writes.

## Root Cause

The test prompt requires the model to call `append_file`, but the effective
SparkWright tool catalog does not expose an `append_file` tool. The model
searched for the schema and then answered that it could not perform the
requested call. The assertion expected an append failure, so the script reports
a failed case even though no write occurred.

## Diagnostic Move

Before classifying a missing write denial as a product bug, inspect the trace
for the requested tool name:

```bash
node packages/cli/dist/index.js trace summary <trace.jsonl> --format text
node packages/cli/dist/index.js trace events <trace.jsonl> --type model.completed --jsonl
node packages/cli/dist/index.js capabilities inspect --workspace <fixture> --format json
```

If the model repeatedly searches for a tool that is not in the catalog, fix the
regression prompt or harness fixture first.

## Prevention

- Use an actual write-capable tool such as `write_file` or `apply_patch`, or
  add a deterministic scripted case for the exact write-denial invariant.
- For real-model write-denial canaries, state the tool name that exists in the
  current capability snapshot and include a stop condition after one attempt.

## Related

- Coverage: [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md)
- Failure pattern: [prompt-induced-tool-loop.md](prompt-induced-tool-loop.md)
