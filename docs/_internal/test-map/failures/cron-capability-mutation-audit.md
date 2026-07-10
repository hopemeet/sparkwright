# Cron Tool Mutations Are Not Audited As Capability Changes

## Record

- Pattern ID: `cron-capability-mutation-audit`
- Status: `watch`
- First seen: 2026-06-25
- Last seen: 2026-06-25
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

A strongly constrained real-agent run created one cron job through the `cron`
tool and exited successfully, but the run summary said `No workspace changes
were made (read-only run)` and trace summary reported
`capability mutations 0 completed`.

The cron state was mutated under the isolated state root:

```txt
<XDG_STATE_HOME>/sparkwright/cron/jobs.json
```

Trace evidence showed `tool_search`, `cron.create`, one recovered repeated
`cron.create`, and zero `capability.mutation.completed` events.

## Root Cause

`createCronTool` writes persistent cron state directly through `CronStore`, but
does not report a capability mutation or any other audited mutation summary to
the run context. Because the state is outside the workspace write path, the
normal workspace-write disclosure also stays at zero.

## Diagnostic Move

For an agent-created cron job, compare three facts:

```bash
XDG_STATE_HOME="$state" node packages/cli/dist/index.js cron list
node packages/cli/dist/index.js trace summary <trace.jsonl> --format text
node packages/cli/dist/index.js trace events <trace.jsonl> --type capability.mutation.completed --jsonl
```

If `cron list` shows new jobs but trace/run summary reports zero capability
mutations and a read-only outcome, this pattern reproduced.

## Prevention

Route cron create/update/pause/resume/remove through the same mutation reporting
contract used by managed capability tools, or add an explicit tool-reported
capability-change event that run outcomes and trace diagnostics display.

## Fix Verification

On 2026-06-25, current source reports cron state changes from the in-session
cron tool through `reportCapabilityMutationCompleted`. Cron mutations are
governed as risky external side effects, so `--yes` can approve them without
requiring workspace-write mode.

Evidence:

- Focused unit: `npm --workspace @sparkwright/cron test -- test/schedule.test.ts`
- Scripted host/tool smoke: one cron job persisted under isolated XDG state, one
  `capability.mutation.completed` event with action `cron.create`, and run
  output `Capability mutations: 1 completed; no managed workspace write was
applied.`

## Related

- Coverage: [../coverage/cron.md](../coverage/cron.md)
- Run note: [../runs/2026-06-25-cron-real-tool-qa.md](../runs/2026-06-25-cron-real-tool-qa.md)
