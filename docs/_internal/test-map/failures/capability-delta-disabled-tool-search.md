# Capability Delta Mentions Disabled Tool Search

## Record

- Pattern ID: `capability-delta-disabled-tool-search`
- Status: `fixed`
- First seen: 2026-06-29
- Last seen: 2026-06-29
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

With project config `tools.disabled: [tool_search]`, model-visible
`tool_descriptors` correctly omit `tool_search`, but the `capability_delta`
prompt still says advanced and infrastructure tools may be available through
`tool_search` and tells the model to fetch deferred schemas before calling
deferred tools.

## Root Cause

Capability delta text is generated from deferred capability categories rather
than the final model-visible discovery mechanism. It does not check whether
`tool_search` survived tool filtering.

## Diagnostic Move

Inspect the first `prompt.built` event:

- `tool_descriptors` should show whether `tool_search` is callable.
- `capability_delta` should not reference `tool_search` when it is absent.
- `capabilities inspect` should show the active `tools.disabled` config.

## Prevention

- Make capability delta conditional on the actual final descriptor set.
- When deferred tools exist but discovery is disabled, say that on-demand
  loading is disabled by tool config instead of instructing the model to use a
  missing tool.

## Fix

- 2026-06-29: `packages/core/src/context.ts` now emits `capability_delta` only
  when `tool_search` is callable in the eager descriptor set. Added
  `packages/core/test/context.test.ts` coverage for deferred tools with and
  without discovery.
- Verified with `npm --workspace @sparkwright/core test -- test/context.test.ts
  test/run.test.ts test/trace.test.ts`, `npm --workspace @sparkwright/core run
  typecheck`, and `npm run build --workspace @sparkwright/core`.

## Related

- Coverage: [../coverage/config-schema.md](../coverage/config-schema.md)
- Run notes: [../runs/2026-06-29-real-mini-tool-surface-followup.md](../runs/2026-06-29-real-mini-tool-surface-followup.md)
