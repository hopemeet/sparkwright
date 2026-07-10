# Anthropic Deferred Task Schema Top-Level OneOf

## Record

- Pattern ID: `anthropic-deferred-task-schema-oneof`
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

With `anthropic/claude-sonnet-4-6`, a run that first calls
`tool_search` to load the deferred `task` tool fails on the next model request
before any `task` call executes:

```text
Error from provider (Anthropic): tools.7.custom.input_schema: input_schema does not support oneOf, allOf, or anyOf at the top level
```

The failure is reproducible with a minimal prompt that selects only `task`.
Selecting `task_create` alone succeeds in the same workspace and model.

## Root Cause

`packages/agent-runtime/src/tasks/tools.ts` defines the deferred `task` wrapper
schema with a top-level `oneOf` and a nested `anyOf` to express
action-specific required fields. `tool_search` returns the descriptor's raw
`inputSchema`, and after the match is loaded the next provider request forwards
that shape to Anthropic. Anthropic rejects top-level `oneOf` / `anyOf` /
`allOf` in tool input schemas.

The existing `sanitizeToolSchema()` compatibility pass handles nullable-union
normalization and malformed schema fragments, but it intentionally preserves
real multi-branch unions. The `task` wrapper therefore still reaches Anthropic
with an unsupported top-level combinator.

## Fix

Fixed on 2026-07-07 by replacing the built-in deferred `task` model-facing
schema with a single object schema and keeping strict action-specific checks in
runtime validation. Focused tests assert no top-level `oneOf` / `anyOf` /
`allOf`, and a real Sonnet smoke run loaded `task`, called
`task(action:"list", scope:"all")`, and passed trace report with no findings.

## Diagnostic Move

Use a provider/model that enforces Anthropic's tool-schema restrictions and
compare these two prompts:

```bash
node packages/cli/dist/index.js run "Use tool_search to select only task_create, then answer loaded." --model anthropic/claude-sonnet-4-6 --trace-level debug
node packages/cli/dist/index.js run "Use tool_search to select only task, then answer loaded." --model anthropic/claude-sonnet-4-6 --trace-level debug
```

Then inspect:

```bash
node packages/cli/dist/index.js trace events <trace.jsonl> --type tool.completed --jsonl
node packages/cli/dist/index.js trace events <trace.jsonl> --type model.stream.failed --jsonl
node packages/cli/dist/index.js trace report <trace.jsonl> --format text
```

If `tool_search` returned `task.inputSchema.oneOf` and the next event is
`model.stream.failed` with the Anthropic schema error, classify it here.

## Prevention

- Avoid top-level `oneOf` / `anyOf` / `allOf` in model-facing deferred tool
  schemas sent to Anthropic.
- Keep runtime `validateTaskControlInput()` semantics strict even if the
  provider-facing `task` schema is flattened.
- Add a deterministic schema-shape test for the deferred `task` descriptor and
  a real Anthropic canary that selects `task` through `tool_search`.
- If a provider-aware schema adapter is added, verify it covers both eagerly
  loaded tools and deferred tool descriptors injected after `tool_search`.

## Related

- Coverage: [../coverage/agents.md](../coverage/agents.md),
  [../coverage/trace-diagnostics.md](../coverage/trace-diagnostics.md)
- Run notes: [../runs/2026-07-07-real-sonnet-skill-agent-qa.md](../runs/2026-07-07-real-sonnet-skill-agent-qa.md)
