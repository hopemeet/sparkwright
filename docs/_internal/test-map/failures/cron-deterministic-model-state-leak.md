# Cron Deterministic Model State Leak

## Record

- Pattern ID: `cron-deterministic-model-state-leak`
- Status: `watch`
- First seen: 2026-06-23
- Last seen: 2026-06-23
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

`sparkwright cron tick --model deterministic` with two due jobs reports
`attempted: 2` and `completed: 2`, and both job statuses become `ok`, but the
second job trace has no `read_file` request while its output still says it read
`README.md`.

## Root Cause

The CLI creates one deterministic model adapter for the whole `tick` command.
That adapter tracks model-call step state in a closure, so the second cron job
continues from the first job's turn count instead of starting with a fresh
run-scoped deterministic model.

The same two-job `cron tick` scenario passed with `openai/gpt-5.4-nano`; this
appears isolated to stateful deterministic adapters rather than cron job state
or real-provider execution.

## Diagnostic Move

Do not trust aggregate tick counts alone. Inspect each job's `lastTracePath` and
confirm every due job has its own expected tool route:

```bash
node packages/cli/dist/index.js cron status <job> --root-dir "$root"
node packages/cli/dist/index.js trace summary <trace.jsonl> --format text
node packages/cli/dist/index.js trace events <trace.jsonl> --type tool.requested --jsonl
```

If later jobs skip the expected deterministic first-step tool call while still
complete successfully, classify as deterministic model state leakage.

## Prevention

- Instantiate a fresh model adapter per cron job when running `tick`, or make
  the deterministic adapter stateless/run-scoped.
- Add a CLI cron tick regression with two due deterministic jobs and assert that
  both traces contain the expected first-step `read_file`.

## Fix Verification

On 2026-06-23, current source passed a deterministic two-job `cron tick`
reproducer. Both due jobs completed, both traces contained the expected
`read_file` route, and both read the sentinel from the shared fixture.

Evidence:

- Job one trace:
  `/tmp/sparkwright-cron-tick-fixed.wh5C2N/ws/.sparkwright/sessions/cron-ac44e7c5e389/trace.jsonl`
- Job two trace:
  `/tmp/sparkwright-cron-tick-fixed.wh5C2N/ws/.sparkwright/sessions/cron-93734c2452db/trace.jsonl`
- Focused gate:
  `npm --workspace @sparkwright/cron test -- test/schedule.test.ts`
- Repository gate: `npm run check`

## Related

- Coverage: [../coverage/cron.md](../coverage/cron.md)
- Run notes:
  [../runs/2026-06-23-tui-cron-shell-followup.md](../runs/2026-06-23-tui-cron-shell-followup.md)
