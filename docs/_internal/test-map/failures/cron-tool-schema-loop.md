# Cron Tool Schema Mismatch Causes Agent Loops

## Record

- Pattern ID: `cron-tool-schema-loop`
- Status: `watch`
- First seen: 2026-06-25
- Last seen: 2026-06-25
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

A real agent asked to create and inspect one cron job through the deferred
`cron` tool created five scheduled jobs and failed with
`TOOL_DOOM_LOOP`. The trace had 33 tool calls, including 32 `cron` calls, 21
tool failures, and five persisted jobs with auto-suffixed names.

The same run showed the model selecting payloads that the tool surface made
plausible but the runtime could not handle:

- `action: "inspect"` even though the enum only accepts `status`
- `job.schedule` as structured objects such as `{ kind: "cron", expr: ... }`,
  which later fails inside `parseSchedule` as `input.trim is not a function`
- top-level fields such as `repeat`, `workspace`, and `id`, rejected by the
  outer schema even though the job/patch descriptions mention related fields

## Root Cause

The cron tool description and JSON schema do not match the runtime contract.
`tool_search` advertises "inspect" in prose while the enum uses `status`, and
`job`/`patch` are loose objects with `additionalProperties: true` instead of
typed properties. The model receives too little structure to reliably provide
the string schedule accepted by `CronStore.createJob`/`updateJob`.

The store also makes repeated creates non-idempotent by silently uniquifying the
same name (`name`, `name 2`, ...), so recovery attempts can create extra jobs.

## Diagnostic Move

Inspect the `tool_search` result for the cron schema, then compare it to
`tool.requested` and `tool.failed` events:

```bash
node packages/cli/dist/index.js trace events <trace.jsonl> --type tool.requested --jsonl
node packages/cli/dist/index.js trace events <trace.jsonl> --type tool.failed --jsonl
XDG_STATE_HOME="$state" node packages/cli/dist/index.js cron list
```

If the trace contains repeated `cron.create` calls with schedule objects,
`inspect` actions, or extra top-level fields, and the cron state contains
auto-suffixed duplicates, this pattern reproduced.

## Prevention

- Make the cron tool schema strict and typed for create/update payloads,
  especially `schedule: string`, `prompt: string`, `name?: string`,
  `skills?: string[]`, `repeat?: { times?: integer|null }`, and
  `workspace?: string|null`.
- Either add `inspect` as an alias for `status` or remove it from the prose.
- Validate tool input before calling the store and return clear
  `TOOL_ARGUMENTS_INVALID` messages instead of runtime type errors.
- Consider idempotency or `force`/`create_if_absent` semantics for repeated
  creates with the same effective name, including default names derived from
  omitted `name`.

## Fix Verification

On 2026-06-25, current source moved in-session cron actions onto strict
create/update schemas and `CronCommandService`:

- `inspect` aliases to `status`.
- `job.schedule` must be a non-empty string; structured schedule objects fail
  as `TOOL_ARGUMENTS_INVALID` before reaching `parseSchedule`.
- Tool-level create uses idempotent effective-name/config matching. Repeating
  the exact create returns `changed: false`, including unnamed creates whose
  default name is derived from the prompt; same-effective-name/different-config
  create errors and leaves only the original job.
- Mutating actions are risky external side effects instead of workspace writes.

Evidence:

- Focused unit: `npm --workspace @sparkwright/cron test -- test/schedule.test.ts`
- Scripted host/tool smoke: `tool_search -> cron.create -> cron.create` with the
  same args produced one persisted job and one recovered repeated-call failure,
  not duplicate cron jobs.
- Independent sub-agent review found and reproduced an unnamed repeated-create
  gap; the follow-up fix reused cron's default job-name derivation in
  `CronCommandService` and added a regression test for omitted `name`.

## Related

- Coverage: [../coverage/cron.md](../coverage/cron.md)
- Run note: [../runs/2026-06-25-cron-real-tool-qa.md](../runs/2026-06-25-cron-real-tool-qa.md)
