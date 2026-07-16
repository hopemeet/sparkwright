# Design: Multi-Model (simple scope model defaults)

> **Status: Simplified MVP implemented.** This is a design catalog entry, not a
> routing map. Session compaction accepts task-specific raw model refs,
> dynamic `spawn_agent` children can use `capabilities.agents.spawnModel`,
> and configured in-process delegates select `profile.model` /
> `capabilities.agents.delegateModel` / parent model in that order. The MVP
> deliberately stays smaller than the earlier logical-binding design: raw refs
> only, commented starter-config examples, and unset users inheriting the main
> run model. Logical aliases, explicit allowlists, per-agent model budgets, and
> per-logical-model usage keying are deferred.
> Active contracts live in [../modules/host.md](../modules/host.md),
> [../maps/capabilities/agents.md](../maps/capabilities/agents.md),
> [../maps/runtime/context-compaction.md](../maps/runtime/context-compaction.md),
> `packages/host/src/model-factory.ts`, and
> `packages/host/src/config-zod-schema.ts`.

## 1. Background & Goals

Today the main run starts with one primary model, while selected auxiliary
contexts can already use a different raw model ref. The model factory is
multi-model-capable: `createModel({ modelRef, ... })`
([model-factory.ts](../../../../packages/host/src/model-factory.ts)) is
per-call and returns an independent adapter for any supported ref. Current host
construction sites are:

- main run - `runtime.ts` builds the primary adapter with `createModel`.
- session compaction - `sessionCompactionOptionsForTask()` resolves
  `tasks.compaction.model ?? defaultModel`.
- dynamic spawn - `createDynamicSpawnAgentTool()` lazily resolves
  `capabilities.agents.spawnModel` when set.
- configured in-process delegates - runtime lazily resolves `profile.model ??
capabilities.agents.delegateModel` on the delegate call.

The practical user need is simpler than the old alias/budget plan:

1. Use a cheaper model for compaction.
2. Use a cheaper/default model for dynamic `spawn_agent` children.
3. Use a different default model for configured delegate agents.
4. Let an individual Agent.md/profile override that delegate default.

Goals:

- **Zero-config unchanged**: if a user leaves the new fields commented out or
  absent, child scopes inherit the main run's effective model.
- **Discoverable starter config**: first-run YAML config can show commented
  `spawnModel` and `delegateModel` examples so users opt in by uncommenting.
- **Raw refs only**: support `provider/model` plus reserved refs
  (`deterministic`, `scripted`) in the same style as existing model fields.
- **Small protocol surface**: keep `capability.inspect.model` as the primary
  model summary; do not reshape usage, trace, or capability protocols for the
  MVP.
- **No silent post-failure fallback**: an unset scope inherits; a configured
  but unavailable model should fail or skip that scope explicitly.

Non-goals for the MVP:

- logical aliases such as `modelAliases.worker`
- explicit model allowlists
- sub-agent model budgets
- per-logical-model usage/trace keying
- runtime-native debate/ensemble orchestration

## 2. Current State

| Concern                       | Current reality                                                                                                               | Source                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Model factory                 | Per-call, any raw ref, returns its own adapter; `inspectResolvedModelConfig` resolves ref+pricing without building an adapter | `model-factory.ts`                                    |
| Active model                  | Single top-level `model` plus grouped `identity.model` flattening                                                             | `config-zod-schema.ts` / `config.ts`                  |
| Provider registry             | `providers.<name>` owns transport, credentials, provider options, physical model metadata, and pricing                        | `config-zod-schema.ts` / `config.ts`                  |
| Compaction model              | `tasks.compaction.model` + `tasks.compaction.budget`; already wired                                                           | `runtime.ts`                                          |
| Profile model                 | `profile.model` is carried from config/Agent.md and used by configured in-process delegates                                   | `agent-profiles.ts`, `runtime.ts`, `model-factory.ts` |
| Dynamic spawn model           | `spawn_agent` uses `capabilities.agents.spawnModel` when set, otherwise the parent adapter                                    | `runtime.ts`                                          |
| Delegate default model        | Configured in-process delegates use `profile.model`, then `capabilities.agents.delegateModel`, then the parent adapter        | `runtime.ts`                                          |
| ACP / external delegate model | Separate process boundary; parent host does not construct their adapter                                                       | `acp-child-agent.ts`, `external-command-agent.ts`     |
| Capability diagnostics        | `capability.inspect.model` is singular; delegate summaries can echo profile `model`                                           | `protocol/src/index.ts`, `delegate-capability.ts`     |

The substrate is ready for simple scope defaults. The remaining MVP work is
configuration schema/loader support plus runtime selection for dynamic spawn
and delegate defaults; it does not require alias machinery or usage reshaping.

## 3. MVP Decisions

| #   | Decision            | Choice                                                                                                                                                               |
| --- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Config fields       | Add optional `capabilities.agents.spawnModel` and `capabilities.agents.delegateModel`. Both are raw model refs.                                                      |
| 2   | Starter config      | Show both fields as commented YAML examples during first-run config generation. Users opt in by uncommenting; default runtime behavior is unchanged.                 |
| 3   | Compaction scope    | Keep `tasks.compaction.model` as the only compaction model knob.                                                                                                     |
| 4   | Dynamic spawn scope | `spawn_agent` uses `capabilities.agents.spawnModel` when set; otherwise it inherits the parent run's effective model.                                                |
| 5   | Delegate scope      | Configured in-process delegates use `profile.model` first, then `capabilities.agents.delegateModel`, then the parent run's effective model.                          |
| 6   | Agent.md override   | Agent.md frontmatter `model` and `capabilities.agents.profiles[].model` are the per-profile override. Prefer Agent.md for project-authored agents.                   |
| 7   | Process boundary    | ACP and external-command delegates remain out of scope; they resolve model/config in their own process or launch contract.                                           |
| 8   | Ref grammar         | Accept only existing raw refs and reserved refs for MVP. No alias lookup, no slash-free user aliases.                                                                |
| 9   | Failure semantics   | Missing field = inherit. Configured-but-invalid/unavailable field = explicit scope failure/warning; never silently fall back after attempting that configured model. |
| 10  | Diagnostics         | Keep the primary `capability.inspect.model` shape. Surface scope defaults through existing agents/delegate diagnostics where useful; avoid protocol reshapes.        |

The agents fields intentionally use flat camelCase (`spawnModel`,
`delegateModel`) rather than nested `spawn.model` / `delegate.model` to match
the existing `capabilities.agents` style (`pinnedDelegates`,
`enableParallelDelegates`, `exposeChildrenAsDelegates`). `tasks.compaction.model`
stays task-shaped because `tasks.<name>` is already a per-task namespace.

### Resolution Order

Compaction:

```txt
tasks.compaction.model
-> main run effective model / default model
-> deterministic
```

Dynamic `spawn_agent`:

```txt
capabilities.agents.spawnModel
-> parent run effective model
```

Configured in-process delegate:

```txt
Agent.md or profile.model
-> capabilities.agents.delegateModel
-> parent run effective model
```

The parent run's effective model matters because `--model X` should propagate
to child scopes unless a more specific scope field overrides it.

### Runtime Prerequisite

`delegateModel` is intentionally not wired onto the old eager delegate-model
preparation path. Runtime now uses an on-call resolver for configured
in-process delegates, and `createAgentTool` can await async spawn input before
calling `spawnSubAgent`. The resulting semantics are:

- unset `delegateModel` = inherit parent model, with no extra adapter work;
- configured but invalid/unavailable `delegateModel` = the delegate call fails
  clearly;
- a bad delegate default does not prevent unrelated parent runs from starting.

## 4. User Config Surface

| Layer                            | Config                                                                 | Job                                                 | Status      |
| -------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------- | ----------- |
| Transport                        | `providers.<name>`                                                     | How to reach a vendor                               | existing    |
| Physical provider model metadata | `providers.<name>.models.<modelId>`                                    | Provider-local cost/options for a physical model id | existing    |
| Default                          | `model` / `identity.model`                                             | Main run model                                      | existing    |
| Compaction                       | `tasks.compaction.model`                                               | Optional compaction model                           | existing    |
| Dynamic spawn default            | `capabilities.agents.spawnModel`                                       | Optional model for dynamic `spawn_agent` children   | implemented |
| Delegate default                 | `capabilities.agents.delegateModel`                                    | Optional model for configured in-process delegates  | implemented |
| Per-agent override               | Agent.md frontmatter `model` or `capabilities.agents.profiles[].model` | Override a specific configured delegate profile     | existing    |

First-run YAML starter should make the optional knobs visible without enabling
them:

```yaml
model: openai/gpt-5.4

tasks:
  compaction:
    # Optional: use a cheaper/lighter model for session compaction.
    # If unset, compaction uses the main run model.
    # model: openai/gpt-5.4-mini

capabilities:
  agents:
    # Optional: dynamic spawn_agent children.
    # If unset, dynamic children inherit the main run model.
    # spawnModel: openai/gpt-5.4-mini

    # Optional: configured in-process delegate agents.
    # If unset, delegates inherit the main run model unless their Agent.md
    # or profile config sets model.
    # delegateModel: anthropic/claude-opus-4-8
```

Agent-specific model selection stays with the agent profile:

```markdown
---
name: Critic
mode: child
model: anthropic/claude-opus-4-8
allowedTools: [read, grep]
maxSteps: 4
delegateTool: delegate_critic
---

Review changes for correctness, regressions, and missing tests.
```

JSON config can support the same fields, but comments belong in the YAML
starter. The starter should keep the fields commented so first install remains
behavior-preserving.

## 5. Implementation Sketch

The order is intentionally small and independently shippable.

- **P0 - Compaction model. Done.** `tasks.compaction.model` already exists and
  should remain the compaction-specific model knob.
- **P1 - Profile model. Mostly done.** `profile.model` already works for
  configured in-process delegates. Tighten validation so non-string values do
  not silently become inheritance, and keep ACP/external-command delegates out
  of parent-process adapter construction.
- **P2 - Add scope defaults. Done.** Add `capabilities.agents.spawnModel` and
  `capabilities.agents.delegateModel` to the Zod schema, host config loader,
  generated schema, and starter YAML. Both should validate as non-empty raw model
  refs using the same grammar as existing model fields.
- **P3 - Runtime selection. Done.** Teach dynamic `spawn_agent` to use `spawnModel`
  when set. Teach configured in-process delegates to use `profile.model ??
delegateModel ?? parentModel`. Lazy/on-call delegate adapter construction is
  a prerequisite for `delegateModel`, not a polish item: a bad delegate default
  must fail the delegate call instead of preventing the whole parent run from
  starting.
- **P4 - Diagnostics polish.** Keep `capability.inspect.model` as the primary
  model. Add lightweight reporting for configured `spawnModel`, `delegateModel`,
  and per-profile model in agents/delegate summaries if useful.

## 6. Change Checklist

- `packages/host/src/config-zod-schema.ts` - add
  `capabilities.agents.spawnModel` and `delegateModel`; regenerate
  `schemas/config.schema.json`.
- `packages/host/src/config.ts` - add fields to `SharedConfig`/agent config
  validation, source maps if needed, and merge behavior. Because `agents` is a
  sub-capability, avoid introducing security-like merge semantics in this MVP;
  these fields are ordinary optional defaults.
- YAML starter/config generation - show the fields as commented examples, not
  enabled defaults.
- `packages/host/src/runtime.ts` - apply `spawnModel` to dynamic `spawn_agent`
  and `delegateModel` to configured in-process delegates when no profile model
  is set. Do not add `delegateModel` to the existing eager
  `resolveInProcessDelegateModels()` path without first narrowing its failure
  radius.
- `packages/host/src/agent-profiles.ts` - keep Agent.md/profile `model`; reject
  or diagnose invalid non-string model values instead of silently inheriting.
- `packages/host/src/model-factory.ts` - reuse existing raw ref construction;
  do not add aliases or logical binding for the MVP.
- `capability.inspect` / CLI / TUI - preserve existing `model` shape; only add
  optional display of scope defaults if the protocol remains compatible.
- Tests - focused config schema/loader tests, runtime tests for spawn/delegate
  inheritance and overrides, and CLI/TUI starter or inspect tests if display
  changes.

## 7. Open Questions

These are intentionally not required for the simple MVP, but should be decided
before widening the model surface beyond config defaults.

1. **Per-call dynamic spawn model** - should `spawn_agent` accept an optional
   `model` argument in addition to `capabilities.agents.spawnModel`? It would
   let the parent model choose a stronger/cheaper model per temporary child, but
   it also lets a model-controlled tool call affect provider spend. If added,
   precedence would be `spawn_agent.model -> spawnModel -> parent model`.
2. **Project/user cost control** - should project config be able to constrain
   or clamp user-level `spawnModel` / `delegateModel` choices, similar in spirit
   to `run.accessMode` ceilings? The MVP treats these fields as ordinary
   optional defaults, but model selection has cost implications.

## 8. Deferred Ideas

The following are explicitly out of the MVP. They can be revisited after raw
scope defaults prove useful:

- `modelAliases.<alias>` / `identity.modelAliases.<alias>` for readable logical
  names and alias-local provider options.
- `allowedModels` / `identity.allowedModels` as an explicit model allowlist.
- `capabilities.agents.modelBudget` or any per-child model spend gate.
- `logicalModelId` and per-logical-model usage/trace keying.
- `capability.inspect.model` reshaping into primary plus child model lists.
- Adapter cache keys based on full logical execution bindings.

If these come back, treat them as a separate design. They require protocol,
usage, trace, config-merge, and diagnostic work that the simple MVP does not
need.

## 9. Active Maps

- Model construction / pricing contract: [../modules/host.md](../modules/host.md)
- Compaction model routing: [../maps/runtime/context-compaction.md](../maps/runtime/context-compaction.md)
- Sub-agent spawn/delegate: [../maps/capabilities/agents.md](../maps/capabilities/agents.md)
- Config schema source: `packages/host/src/config-zod-schema.ts`

## Last Verified

- Status: Verified
- Date: 2026-06-28T14:13:14+0800
- Scope: updated the design catalog after implementing the simplified raw-ref
  MVP: `spawnModel` / `delegateModel` config schema and loader support,
  commented starter fields, runtime selection, and lazy/on-call delegate model
  construction.
- Read: `packages/host/src/model-factory.ts`,
  `packages/host/src/model-builder.ts`,
  `packages/host/src/config-zod-schema.ts`,
  `packages/host/src/config.ts`, `packages/host/src/agent-profiles.ts`,
  `packages/host/src/runtime.ts`, `packages/host/src/delegate-capability.ts`,
  `packages/agent-runtime/src/index.ts`, `packages/core/src/usage.ts`,
  `packages/core/src/types.ts`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/modules/agent-runtime.md`,
  `docs/_internal/project-map/maps/capabilities/agents.md`,
  `docs/_internal/project-map/maps/runtime/context-compaction.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime run build`;
  `npm --workspace @sparkwright/agent-runtime test -- test/index.test.ts`;
  `npm --workspace @sparkwright/agent-runtime run typecheck`;
  `npm --workspace @sparkwright/host test --
test/config.test.ts test/tools.test.ts test/protocol.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "init"`;
  `npm run schema:check`.
- Prior revision 2026-06-28T13:50:03+0800: recorded implementation constraints
  for the simplified raw-ref MVP: `delegateModel` requires lazy/on-call adapter
  construction before runtime enablement; `spawnModel` / `delegateModel` keep
  flat `capabilities.agents` naming to match existing agent config; per-call
  `spawn_agent.model` and project/user model cost clamping remain open
  questions.
- Prior revision 2026-06-27T22:11:17+0800: simplified the future multi-model
  plan to raw scope model defaults: existing `tasks.compaction.model`, proposed
  commented starter fields `capabilities.agents.spawnModel` / `delegateModel`,
  and existing Agent.md/profile `model` overrides. Deferred logical aliases,
  explicit allowlists, model budgets, logical usage keying, and capability
  protocol reshaping.
- Prior revision 2026-06-27T19:28:21+0800: reconciled the future multi-model
  config surface with the upgraded config split while preserving implemented
  in-process delegate `profile.model` routing and keeping alias/model-budget/
  usage-key work as future design scope.
