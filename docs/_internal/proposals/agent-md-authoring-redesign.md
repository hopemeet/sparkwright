# Agent.md Authoring Redesign

Status: Implemented authoring/runtime contract; retained as implementation history
Date: 2026-07-18
Branch: feat/access-mode (builds on the Access-mode + agent-capability work)

> The neutral hook carrier, Markdown parser and validation, schema surface,
> in-process resolver, child-run forwarding, isolation, and rewrite-before-
> governance behavior are implemented. Current source and the Agent capability
> map are authoritative; the delivery split and open questions below preserve
> the design history. A richer inspect explanation for hooks ignored across
> process-agent boundaries remains optional UX, not an incomplete runtime
> contract.
>
> Relationship to other proposals: this is a focused, authoring-experience
> slice of `agent-access-config-redesign.md` (the "agent definition" layer) and
> sits next to `agent-capability-upgrade.md` (indexed exposure, generic
> `delegate_agent`). It does **not** re-open the access-mode / clamp work. Scope
> here is only: what a human types into `.sparkwright/agents/*.md`, and the
> minimal runtime wiring to honor it.

## Purpose

The current Agent.md surface leaks runtime-shaped fields, so authoring a simple
sub-agent forces the user to learn several overlapping knobs:

```yaml
mode: child
use: [workspace.read]
allowedTools: [read, glob, grep]
delegateTool:
  toolName: delegate_reviewer
```

Target authoring experience — short, declarative, capability-first:

```yaml
---
name: db-reader
description: Execute read-only database queries.
model: anthropic/claude-haiku-4-5 # optional: per-agent model
use: [workspace.read, bash] # the only recommended capability axis
hooks: # per-agent deterministic guardrails
  PreToolUse:
    - matcher: bash
      action:
        type: command
        command: ./scripts/validate-readonly-query.sh
        stdin: json
        blockOnFailure: true
        injectOutput: onFailure
---
You are a database analyst with read-only access. Execute SELECT queries only.
```

Core goals:

- `mode` is not required for the common case.
- `use` is the single recommended capability declaration.
- `allowedTools` / `tools` become a legacy precise-allowlist, documented as
  advanced/compat only.
- `model` is recommended and already supported (see D4).
- `hooks` can be authored in Agent.md and apply only to that agent's own child
  run.

## C7 Merge Boundary (Frozen 2026-07-06)

C7 merges this proposal with sub-proposal #4 in
[`agent-access-config-redesign.md`](agent-access-config-redesign.md). The split
is:

- `agent-access-config-redesign.md` owns the schema layer: where agent
  definitions live, which frontmatter fields exist, how `toolset`, `delegate`,
  and advanced `capabilities.agents.delegates[]` compile, and how those fields
  interact with access-mode and selector policy.
- This proposal owns the authoring and hook-carrier slice: examples, recommended
  writing style, the neutral `AgentProfile` hook carrier in `agent-runtime`, and
  host compilation of per-agent hooks into child-run workflow hooks.

Do not keep a second competing Agent.md schema here. When schema shape changes,
update the access-config proposal first and reference it from this document.

C7 source recheck on 2026-07-06 against current main: the neutral hook carrier,
markdown parser, `workflowHooks` forwarding, and in-process delegate resolver
baseline are already present. The remaining design requirement is convergence
of ownership plus an explicit P10a acceptance test for Agent.md-authored
`PreToolUse`: rewrite-stage hooks apply first, and governance/clamp hooks see
the rewritten arguments.

## Current code reality (verified)

These are the load-bearing facts the design depends on. The original facts were
confirmed against `feat/access-mode`; C7 hook facts below were refreshed against
current main on 2026-07-06.

- **`mode === undefined` is already treated as child in most places.**
  - `deriveConfiguredAgents` already accepts `undefined | child | all`
    (`packages/host/src/runtime.ts:3736`).
  - `createDelegateToolProfile`-style paths default `mode ?? "child"`
    (`packages/host/src/tools.ts:1397`).
  - Main detection is independent and robust: `id === MAIN_AGENT_ID ||
mode === "primary"` (`packages/host/src/runtime.ts:3393`).
  - **The only holdout** is `resolveAgentDelegateTools`
    (`packages/host/src/delegate-capability.ts:450`):
    `if (profile.mode !== "child" && profile.mode !== "all") continue;`

- **`use` and `allowedTools` already intersect (narrowing, never widening).**
  `applyAgentProfileToolUse` expands `use` to a selector allowlist, then
  `intersectToolNameAllowlists(profile.allowedTools, selectorAllowed)`
  (`packages/host/src/runtime.ts:3773`). So documenting "both together = the
  intersection" is accurate.

- **Workflow hooks are first-class on a run, and current main forwards them
  through in-process sub-agent spawns.** Core `CreateRunOptions` accepts
  `workflowHooks?: WorkflowHook[]` and the run loop executes them natively.
  `SpawnSubAgentInput.workflowHooks` is forwarded into child run creation in
  `packages/agent-runtime/src/index.ts`, and host compiles Agent.md hook
  carriers through `createInProcessDelegateHooksResolver()` in
  `packages/host/src/runtime.ts`. This closes the original P2-a plumbing gap.

- **Per-profile model is already done and is the architectural template for
  hooks.** `profile.model` parses (`packages/host/src/agent-profiles.ts:234`),
  resolves with precedence `profile.model > capabilities.agents.delegateModel >
parent` (`createInProcessDelegateModelResolver`,
  `packages/host/src/runtime.ts:3580`), is applied at every in-process spawn
  site via `modelForProfile` (delegate `:4023`, delegate_parallel `:4403`,
  delegate_agent index), and **excludes ACP / external-command** by building
  `inProcessProfileIds` (`:3596`).

## Design decisions

### D1 — `mode` defaults to child

- Markdown-discovered `.sparkwright/agents/*.md` is a child/delegate agent by
  default.
- `id: main` or `mode: primary` still marks the primary agent.
- `mode: child / all` stays accepted but is no longer documented as recommended.
- `exposeAsDelegate: false` remains the explicit opt-out from delegate exposure.

Implementation: flip the one holdout at `delegate-capability.ts:450` to treat
`undefined` as child-eligible — but the exclusion must be
`profile.id === MAIN_AGENT_ID || profile.mode === "primary"`, **not** only
`mode === "primary"`. Reason: `resolveAgentDelegateTools` is called with the full
`resolvedProfiles` list (`runtime.ts:925`), which still contains the main
profile (unlike `deriveConfiguredAgents` at `:3734`, which pre-filters
`profile.id !== parentAgent.id`). If we excluded only `mode === "primary"`, an
`id: main` profile that omits `mode` would leak into `delegate_agent` targets via
`includeAllChildProfiles: true`. Reuse the `MAIN_AGENT_ID` constant rather than a
literal. Add a regression test for the `id: main`-without-`mode` case.

Two things to keep nailed:

1. The rule applies to **config.json profiles too**, not only markdown. A config
   profile with no `mode` and `id !== main` becomes a child. This is intended,
   but call it out.
2. **Behavior change to record in the changelog:** under the now-default
   `exposure: "indexed"`, every existing markdown agent without `mode` becomes
   reachable via `delegate_agent`. Escape hatch is `exposeAsDelegate: false`;
   document it prominently.

### D2 — `use` is the recommended capability declaration

- Recommend only `use: [...]` with the existing high-level selectors:
  `workspace.read`, `workspace.write`, `bash`, `planning`, `skills`, `agents`,
  `tasks`, `cron`, `mcp`, `mcp:<server>`.
- Do **not** introduce `tool:<name>`; keep it simple.
- `allowedTools` / `tools` stay functional as a legacy precise allowlist. When
  combined with `use`, the effective set is the intersection (verified above), so
  authority can only narrow.
- Pure documentation convergence; no code change. Examples lead with `use`;
  `allowedTools` moves to an advanced/legacy section.

### D3 — Agent.md `hooks` (workflow hooks, this-agent-only)

Frontmatter sugar:

```yaml
hooks:
  PreToolUse:
    - matcher: bash
      action:
        type: command
        command: ./scripts/validate-readonly-query.sh
        stdin: json
        blockOnFailure: true
        injectOutput: onFailure
```

compiles to the existing `CapabilityWorkflowHookConfig` shape:

```ts
{
  name: "db-reader.PreToolUse.0",
  hook: "PreToolUse",
  matcher: { toolName: "bash" },
  action: { type: "command", command: "...", stdin: "json",
            blockOnFailure: true, injectOutput: "onFailure" },
}
```

Scope rules:

- Apply only to that agent's child run; never the main run or other agents.
- Workflow hooks only initially; no event hooks.
- Hook names use the existing enum (verified identical at
  `packages/core/src/workflow-hooks.ts:14`): `RunStart`, `TurnStart`,
  `ModelOutput`, `PreToolUse`, `PostToolUse`, `Stop`, `RunEnd`, `RuntimeSignal`.
- **Restrict the action subset.** Do not reuse the full
  `CapabilityWorkflowHookConfig` action union (`config-zod-schema.ts:490`:
  block/context/command/http/agent). The `agent` action requires an `agentTool`
  and can re-trigger a delegate from inside a child hook
  (`workflow-hooks.ts:954`), which contradicts the "this-agent guardrail" intent.
  Initial allowed actions: `command`, `block`, `context`, `http`. Exclude
  `agent`; if it is ever wanted, define the nested-delegate semantics explicitly
  first.

**Type boundary — where Agent.md hooks live.** `AgentProfile`
(`packages/agent-runtime/src/index.ts:78`) has no hooks field today, and
`CapabilityWorkflowHookConfig` is a host config type. agent-runtime must not take
a reverse dependency on host. Resolution: define a **neutral carrier** on the
profile in agent-runtime (a small structural type, not the host config type),
and have the host compile that carrier into `CapabilityWorkflowHookConfig[]` at
the spawn site. Do **not** smuggle hooks through `metadata` or a `cast`.

**Key correction vs the original sketch.** The sketch said "pass profile hooks
into `spawnSubAgent({ hooks })`". That is the wrong field/type: Agent.md hooks
are _workflow_ hooks (`WorkflowHook[]`), while `spawnSubAgent.hooks` is the
lower-level `RunHook[]`. Current main follows the corrected path:

1. **agent-runtime:** `AgentProfile` has a neutral hook carrier and
   `SpawnSubAgentInput.workflowHooks` forwards into child run creation. This
   keeps `agent-runtime` free of a reverse dependency on host config types.
2. **agent-profiles:** markdown frontmatter parses `hooks` sugar into the
   neutral carrier, with the restricted action subset and late-validation
   discipline.
3. **host:** `createInProcessDelegateHooksResolver()` compiles the carrier at
   the child spawn site, where child-run context (`workspaceRoot`, `sandbox`,
   `http`, and `getRun: () => childRun`) exists, and it reuses
   `inProcessProfileIds` so ACP / external-command delegates are excluded.

Consistency requirement: hooks must fire regardless of which in-process
entrypoint invoked the agent (named delegate, `delegate_parallel`, and the
indexed `delegate_agent`), exactly like `model` already does — otherwise a
`db-reader`'s `PreToolUse` would enforce when called one way and not another.

ACP / external-command delegates are process-boundary integrations and are not
SparkWright child runs, so Agent.md hooks do not apply to them. Surfacing
"ignored: agent hooks not supported for ACP/external-command" in capability
inspect is a nice-to-have.

### D4 — `model` (already supported; docs only)

No code change. Document `model:` as a recommended optional field in the lead
example, with precedence `agent.md model > capabilities.agents.delegateModel >
inherited parent model`. It already flows through every in-process delegate
entrypoint and is skipped for ACP / external-command.

## Delivery split

| Phase | Change                                                                                                                                                                                          | Notes                                                                             |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| P0    | `delegate-capability.ts:450` exclude `id===MAIN_AGENT_ID \|\| mode==="primary"` + regression tests + drop `mode: child` from docs                                                               | Default-child; smallest slice                                                     |
| P1    | Docs converge to `use`-only; add `model` to lead example; move `allowedTools` to advanced/legacy                                                                                                | No code change                                                                    |
| P2-a  | agent-runtime: `SpawnSubAgentInput.workflowHooks` → `createOptions.workflowHooks`, + neutral hooks carrier on `AgentProfile`                                                                    | Baseline landed on current main; keep as carrier owner                            |
| P2-b  | agent-profiles: parse `hooks` sugar (restricted action subset) + in-place validation                                                                                                            | Baseline landed on current main; mirror `runBudgetRecord` discipline              |
| P2-c  | host: `createInProcessDelegateHooksResolver` mirroring the model resolver; compile carrier → `CapabilityWorkflowHookConfig[]`; reuse `inProcessProfileIds`; apply at all in-process spawn sites | Baseline landed on current main; ACP/external excluded for free                   |
| P2-d  | schema (strict field on `agentProfileConfigSchema` + external JSON Schema ref) + tests                                                                                                          | `schema:check` will fail without the ref update                                   |
| P2-e  | C7/P10a acceptance: Agent.md `PreToolUse` rewrite runs before governance/clamp, and governance sees rewritten args                                                                              | Must exercise Agent.md/profile-authored hooks, not only configured workflow hooks |

## Test plan

```bash
npm --workspace @sparkwright/host test -- \
  test/agent-profiles.test.ts test/tools.test.ts test/workflow-hooks.test.ts
npm --workspace @sparkwright/host run typecheck
npm --workspace @sparkwright/agent-runtime run typecheck
# if schema/docs touched:
npm run schema:check
npx prettier --check docs/guides/AGENTS.md \
  packages/host/src/agent-profiles.ts packages/host/src/runtime.ts \
  packages/host/src/delegate-capability.ts packages/host/src/config-zod-schema.ts
```

Targeted cases:

- Default-child: a `mode`-less agent (and a `model`-only, `mode`-less agent) is
  discovered by `list_agents`, callable via `delegate_agent`, and runs on its
  declared model.
- Main not leaked: an `id: main` profile **without** `mode` is excluded from
  `delegate_agent` targets (regression for the P0 exclusion condition).
- Forward plumbing (P2-a): a `spawnSubAgent` unit test with a `createRun`
  override asserts `CreateRunOptions.workflowHooks` is populated — typecheck
  alone does not catch "field added but never forwarded".
- Hooks isolation: an Agent.md `PreToolUse` command blocks that agent's `bash`
  call; the same hook does not affect the main run or other agents.
- Entrypoint consistency: identical hook behavior whether the agent is reached
  via a named delegate or the indexed `delegate_agent`.
- ACP/external-command: Agent.md hooks are not applied; inspect ideally flags
  them as ignored.
- P10a two-stage `PreToolUse`: an Agent.md/profile-authored rewrite hook runs in
  the rewrite pass; a governance/block hook or workflow clamp then observes the
  rewritten arguments; `advance` / governance-only effects remain rejected in
  disallowed phases.

## Acceptance criteria

- `.sparkwright/agents/reviewer.md` without `mode` is still discoverable and
  callable.
- Doc lead examples use only `use: [...]` (+ optional `model`).
- `allowedTools` / `tools` still work but are not the recommended path.
- Agent.md `hooks.PreToolUse` runs the validation command before that agent's
  `bash` call, and never affects the main agent or other agents.
- Agent.md-authored `PreToolUse` obeys the P10a two-stage rule: rewrite-stage
  output is applied first, governance/clamp runs on rewritten arguments, and
  forbidden governance/rewrite effects still fail closed.

## Open questions

1. **Closed:** `matcher: bash` matches the exact concrete tool name. The `bash`
   selector selects catalog entries whose internal source is `shell`; the source
   classification is not a second callable identity.
2. **Closed by implementation:** P0-P2 landed as independently reviewable
   slices and now form one canonical authoring/runtime contract.
3. Optional follow-up: whether inspect should explain that Agent.md hooks do not
   cross ACP/external-command process boundaries.
