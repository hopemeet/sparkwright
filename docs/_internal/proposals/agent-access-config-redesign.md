# Agent Access Config Redesign

Status: Draft for discussion (v2)
Date: 2026-06-26

> v2 changes vs v1: configured agents use explicit allowlists (no
> `inherit`/`except`); `capabilities.agents.configured.toolset` is a *default*,
> not a hard ceiling — reviewed agent definition files may self-declare authority
> up to a child-safe hard cap; SparkWright has no released users yet, so all
> legacy/compat/migration machinery is dropped rather than preserved;
> `project > user` is the authoritative layer ordering; silent no-ops are
> replaced by hard config errors or explicit diagnostics. This proposal is also
> meant to land as four independent sub-proposals (see "Delivery Split").

## Purpose

This proposal captures the user-facing configuration shape before
implementation details are decided. The immediate goal is to make agent
autonomy, tool visibility, hard policy boundaries, and reusable configured
agents readable without forcing users to learn several overlapping permission
axes.

Implementation details and exact schema names should be reviewed separately
after this config shape is agreed. Because there is no released user base, there
is no migration story to preserve: legacy fields are removed outright, not
aliased.

## Consolidation Ownership Boundary

C2 ratified a three-layer split on 2026-07-06. This proposal owns only the
selector/toolset compilation vocabulary: the names users write in toolsets, the
no-alias selector grammar, and how those selectors expand into concrete tool
visibility.

Built-in tool identity is a separate layer. Canonical tool names, legacy tool
aliases, and default exposure tiers are sourced from
`packages/host/src/tool-identities.ts` and recorded in
[`builtin-tool-surface-consolidation.md`](builtin-tool-surface-consolidation.md).
This proposal may reference that layer when explaining examples, but it must not
redefine the alias or tier table.

The product default public/advanced/infrastructure surface is also owned by
[`builtin-tool-surface-consolidation.md`](builtin-tool-surface-consolidation.md).
Access config consumes that surface through selectors and policy; it does not
own which built-in tools are public by default.

## Design Direction

- Keep generated config files short. Generated files should contain chosen
  values, not every possible setting.
- Provide a separate reference template, for example through
  `config init --show-defaults`, for the full commented shape.
- Keep the runtime layers distinct:
  - User config (`~/.config/sparkwright/config.yaml`) stores personal model,
    provider, UI, and personal agent defaults.
  - Project config (`.sparkwright/config.yaml`) stores team-safe policy, tool
    visibility, MCP servers, and default agent capability defaults. **Project is
    the authoritative layer: it sets hard caps that user config cannot exceed.**
  - Agent definitions (`.sparkwright/agents/<id>.md` or
    `.sparkwright/agents/<id>/AGENT.md`) store reusable agent identity, prompt,
    model hints, and an explicit per-agent toolset.
  - Reference template is documentation only and is not itself a merge layer.
- Prefer grouped config over flat root fields:
  - `identity` for model/provider settings.
  - `run` for run autonomy and budgets.
  - `policy` for hard safety boundaries.
  - `tools` for main-agent tool visibility.
  - `capabilities.agents` for spawned/configured agent defaults and depth limits.
  - `tasks` for system/helper model-backed tasks such as compaction.
  - `ui` for product preferences.
- `run.accessMode` is the only user-facing run autonomy knob. There is no legacy
  `permissionMode` surface; `permissionMode` exists only as an internal compile
  target.
- Do not expose separate `defaultToolset`, `maxToolset`, or `preset` fields.
  Every toolset is a single explicit selector allowlist. There is no
  `inherit`/`except` syntax — see "Toolset Shape".
- Use user-facing agent terms:
  - `spawned`: temporary agents created on the fly with `spawn_agent`. Not
    reviewed by a human, so their authority is hard-capped and the model cannot
    expand it at runtime.
  - `configured`: named reusable agents defined by
    `.sparkwright/agents/<id>.md` or `.sparkwright/agents/<id>/AGENT.md`. These
    are checked-in, human-reviewed artifacts, so a definition file may declare
    its own authority up to the child-safe hard cap.
  - `agent definition`: the markdown/frontmatter source of profile identity and
    its explicit toolset. A simple definition may be one markdown file; a package
    definition may use an `AGENT.md` manifest plus sidecar files.
  - `delegate`: a callable tool exposure for an agent. Simple in-process
    delegates live in agent frontmatter; advanced multi-binding, external-command,
    or ACP delegates use explicit config entries.

## Capability Selectors

Selectors are the single toolset compilation vocabulary. There are no broad
aliases at this layer. Legacy built-in tool aliases such as `read_file` ->
`read` are tool-identity facts, not selector syntax; see the consolidation
ownership boundary above.

```txt
workspace.read
workspace.write
shell
planning
skills.load
skills.manage
agents.delegate
agents.manage
tasks.run
cron
mcp
mcp:<server-name>
```

Semantics:

- `workspace.read` / `workspace.write`: read and write tools over the project
  workspace. Visibility only; `policy.write` and access mode still govern
  whether writes are actually allowed.
- `shell`: run shell/command tools.
- `planning`: the todo/plan tools (plan drafting and todo-ledger updates). It
  does not by itself change `permissionMode`; the `read-only` access mode
  controls plan-mode behavior.
- `skills.load`: load Skill instructions/resources.
- `skills.manage`: create, update, replace, or otherwise mutate Skills.
- `agents.delegate`: call `spawn_agent` or configured delegate tools.
- `agents.manage`: create, update, replace, or otherwise mutate agent profiles
  or delegate definitions.
- `tasks.run`: spawn background/helper model-backed tasks. Named `tasks.run`
  (not `tasks`) to avoid colliding with the top-level `tasks` config group,
  which configures system/helper models such as compaction.
- `cron`: schedule and manage cron jobs.
- `mcp`: all configured MCP tools. This is external configured capability, not
  built-in local surface.
- `mcp:<server-name>`: one named MCP server's tools.

## Access Mode

`run.accessMode` is the user-facing autonomy knob. It compiles to the lower
level fields used by existing runtime components:

```txt
read-only
  permissionMode: plan
  shouldWrite: false
  Write tools are pruned from the catalog presented to the model rather than
  exposed-and-failing, so the model is not offered tools that can only deny.

ask
  permissionMode: default
  shouldWrite: true
  approval defaults: ask.

accept-edits
  permissionMode: accept_edits
  shouldWrite: true
  approval defaults: auto-accept workspace edit approvals when emitted.

bypass
  permissionMode: bypass_permissions
  shouldWrite: true
  approval defaults: bypass human approvals.
```

`bypass` does not bypass explicit deny rules, target scope, write budgets,
confidential read policy, sub-agent depth limits, or external/ACP delegate
launch approval. External-delegate approval is a hard trust boundary modeled as
a deny-like gate in the policy layer, distinct from the approval-resolver path,
so `bypass` does not silently launch external commands.

### Layer ordering and merge

`project > user`. Project config is authoritative.

- Project may set `run.accessMode` as a **ceiling** (the maximum autonomy
  allowed). User config and runtime CLI/TUI overrides may request any mode but
  are clamped down to the project ceiling; they can never exceed it.
- Autonomy rank is `read-only < ask < accept-edits < bypass`. "Clamp" means: if
  the project ceiling is `ask`, a user-requested `bypass` resolves to `ask`.
- If project does not set a ceiling, the most specific value set by a lower layer
  applies.
- Whenever a requested mode is clamped, config explain / startup diagnostics must
  report it (no silent downgrade).

## Toolset Shape

A toolset is always an explicit selector allowlist. There is no `inherit`, no
`except`, and no class-to-class reference.

```yaml
toolset:
  - workspace.read
  - workspace.write
  - shell
  - skills.load
```

Rationale for dropping `inherit: main`: inheriting the main surface makes the
child capability set a denylist (`main minus except`), which fails open — a new
tool added to main silently propagates into child agents. An explicit allowlist
fails closed: a child only ever gets what it names.

### What `capabilities.agents.configured.toolset` means

It is a **default**, applied only to a configured agent whose definition file
omits `toolset`. It is **not** a hard ceiling intersected against the definition.

- A configured agent definition that declares its own `toolset` gets exactly that
  set (subject only to the child-safe hard cap, global `tools.*`, and policy).
- This is safe because configured agent definitions live under
  `.sparkwright/agents/`, are checked into the repo, and are human-reviewed. The
  file is trusted to declare its own authority.
- This resolves the v1 problem where one configured agent needing
  `agents.delegate` forced the whole class default to widen: that agent now grants
  itself `agents.delegate` in its own file without touching the class default.

### Child-safe hard cap

Even a reviewed definition file cannot cross the child-safe hard cap. This is an
internal compiler cap, not user config:

- `spawned`: hard-capped to `workspace.read`, `workspace.write`, `shell`,
  `skills.load`. The model cannot expand a spawned agent beyond this at runtime;
  `spawn_agent` arguments may only narrow.
- `configured`: may self-grant any selector **except** `agents.manage` and
  `mcp` / `mcp:<server>`, which stay blocked until an explicit product decision
  (`agents.manage`) and child-run MCP attribution/approval infrastructure
  (`mcp`) exist. `agents.delegate`, `skills.manage`, `cron`, and `tasks.run` are
  grantable by a definition file but are not in the recommended default.

A selector that a definition requests above the child-safe cap is a config error
with diagnostics, not a silent drop and not a reason to widen the run.

## Personal Config Template

Generated personal config should stay short and should not use `${ENV_VAR}`
strings as active API keys. The current loader treats those as literal strings;
users can either set real keys in private user config or rely on provider
environment variable overrides.

```yaml
# Personal SparkWright config.
# ~/.config/sparkwright/config.yaml

identity:
  model: openai/gpt-5.4-mini
  providers:
    openai:
      baseURL: https://api.openai.com/v1
      apiKey: REPLACE_WITH_YOUR_API_KEY
      models:
        gpt-5.4-mini: {}
        gpt-5.4: {}

run:
  accessMode: ask
  budget:
    maxModelCalls: 80
    maxCostUsd: 2

ui:
  theme: dark
  mouse: true

capabilities:
  agents:
    # maxDepth counts sub-agent depth, not the main agent.
    # 0: no sub-agents
    # 1: main -> child
    # 2: main -> child -> grandchild
    maxDepth: 1

    spawned:
      # Temporary agents created on the fly with spawn_agent.
      # Hard-capped to this set; the model cannot expand it.
      toolset:
        - workspace.read
        - workspace.write
        - shell
        - skills.load

    configured:
      # Default for configured agents whose definition file omits `toolset`.
      # A definition file may declare its own explicit toolset instead.
      toolset:
        - workspace.read
        - workspace.write
        - shell
        - skills.load
        - planning
```

## Project Config Template

Project config focuses on team-safe constraints, main-agent visibility, and the
default toolset for configured agents. Leave `tools.use` unset to expose the
default main-agent surface; set it only to narrow the surface. Do not include
`mcp` unless the project explicitly configures and wants MCP tools visible.

```yaml
# Project SparkWright config.
# .sparkwright/config.yaml

# tools:
#   use:
#     - workspace.read
#     - workspace.write
#     - shell
#     - planning
#     - skills.load
#     - agents.delegate
#     # - mcp:<server-name>

run:
  # Optional autonomy ceiling. User config / runtime overrides clamp down to it.
  accessMode: accept-edits

policy:
  write:
    maxFiles: 5
    maxDiffLines: 200
    allowDeletions: true
  confidentialPaths:
    - ".env"
    - ".env.*"
    - "secrets/**"

capabilities:
  agents:
    maxDepth: 1

    spawned:
      toolset:
        - workspace.read
        - workspace.write
        - shell
        - skills.load

    configured:
      # Default for configured agents that omit `toolset`. An individual
      # definition file may declare a different explicit toolset, up to the
      # child-safe hard cap.
      toolset:
        - workspace.read
        - workspace.write
        - shell
        - skills.load
        - planning
```

A configured agent lives in an agent definition, not duplicated in project
config. The lightest shape is a single markdown file with an explicit toolset:

```markdown
---
# .sparkwright/agents/reviewer.md
name: Reviewer
maxSteps: 30
toolset:
  - workspace.read
  - skills.load
delegate:
  enabled: true
  toolName: delegate_reviewer
---

Review code for correctness, risk, and missing tests.
```

A definition may self-grant authority above the class default, up to the
child-safe cap. For example a planner agent that legitimately delegates:

```markdown
---
# .sparkwright/agents/planner.md
name: Planner
toolset:
  - workspace.read
  - planning
  - agents.delegate
---

Break the task down and delegate implementation to sub-agents.
```

For agents that need sidecar files, use a directory package:

```txt
.sparkwright/agents/reviewer/
  AGENT.md
  examples.md
  rubrics/security.md
```

In that shape, `AGENT.md` uses the same frontmatter and markdown body as the
single-file form. The profile id comes from `<id>` in either
`.sparkwright/agents/<id>.md` or `.sparkwright/agents/<id>/AGENT.md`. If both
forms define the same id in the same layer, that is a configuration error with
diagnostics; implementations must not silently pick one.

The effective configured-agent toolset is:

```txt
(definition toolset, if present; else capabilities.agents.configured.toolset)
  ∩ child-safe hard cap
  ∩ tools.use / tools.allowed / tools.disabled
  ∩ policy deny rules and runtime hard caps
```

Note there is no separate class-ceiling intersection: the definition file *is*
the authoritative declaration, bounded only by the child-safe cap and global
tool/policy constraints.

## Reference Template

The reference template can show the complete shape in one file for discovery,
but it should be clearly labeled as documentation rather than generated runtime
config. It may include provider examples, project examples, MCP examples, and
advanced bindings in commented form.

## Runtime Invariants

- Toolset controls positive tool visibility only.
- Parent/child deny rules, run policy, write guardrails, confidential read
  policy, and sub-agent depth limits remain separate hard constraints.
- Risky tool calls and workspace writes still flow through the normal approval
  path unless the compiled access mode explicitly auto-approves or bypasses
  approval.
- `workspace.write` access does not imply unlimited writes. `policy.write` still
  controls target scope, file count, diff budget, and deletion behavior.
- Spawned agents are hard-capped to `workspace.read`, `workspace.write`,
  `shell`, `skills.load`. `spawn_agent` arguments may only narrow this; they
  cannot add a selector.
- Configured agent definition files may self-declare authority up to the
  child-safe hard cap. A requested selector above that cap is a config error with
  diagnostics, never a silent widen of the run.
- `agents.manage` and `mcp` / `mcp:<server>` are blocked for both spawned and
  configured agents regardless of selector, until the relevant infrastructure
  exists. **Writing such a selector into a child toolset is a config error, not a
  silent no-op.**
- No selector that a user explicitly wrote may be dropped silently. If global
  `tools.*` or policy removes it from the effective set, config explain / startup
  diagnostics must report which layer removed it and why.
- `run.accessMode` merges by `project > user`: project sets the ceiling, lower
  layers clamp down, and any clamp is reported.
- `maxDepth` and delegate selectors are independent knobs that must agree.
  Raising `maxDepth` above 1 does not by itself let a child re-delegate; the
  relevant child must also be granted `agents.delegate` in its toolset.

## Resolved Decisions

- Toolsets are explicit allowlists only. `inherit`/`except` is removed.
- `capabilities.agents.configured.toolset` is a default for definition files that
  omit `toolset`, not a hard ceiling intersected against them. The real bound is
  the child-safe hard cap.
- `spawned` is hard-capped and not model-expandable; `configured` definition
  files are trusted to self-declare up to the child-safe cap.
- `agents.manage` and `mcp` are hard-blocked for child agents until their
  infrastructure exists; requesting them is a config error.
- `run.accessMode` is the only autonomy surface; `project > user`; legacy
  `permissionMode` exists only as an internal compile target.
- Config-level `delegates[]` is retained as the advanced escape hatch for
  multi-binding and external/ACP transports; simple in-process delegates stay in
  agent frontmatter. `toolName` is unique across both sources; a collision is a
  hard error with diagnostics.
- C7 merge boundary: this proposal owns the Agent definition schema and
  delegate fields; [`agent-md-authoring-redesign.md`](agent-md-authoring-redesign.md)
  owns the authoring examples plus the hooks carrier/slice plan. Agent.md hooks
  acceptance must cover the P10a two-stage `PreToolUse` rule: rewrite first,
  governance/clamp after rewritten arguments.
- The `tasks` capability selector is `tasks.run`, disambiguated from the
  top-level `tasks` config group.
- No legacy/compat/migration layer: there are no released users, so legacy
  fields (`permissionMode`, broad `skills`/`agents` aliases,
  `capabilities.agents.profiles[]`, `delegateTools`, `AgentProfile.use`,
  `allowedTools`, `deniedTools`, `mode`, `metadata.acp`,
  `metadata.externalCommand`) are removed, not aliased or migrated.

## Open Implementation Questions

- How the external-delegate approval gate is best modeled in the policy layer (a
  distinct deny-like boundary vs. a non-bypassable approval flag); either way
  `bypass` must not auto-launch external commands.
- The exact selector→tool mapping table for `compileToolset`, validated against
  the live catalog and tests.

## Delivery Split

This redesign should land as four independent sub-proposals, each with its own
invariants and regression tests, rather than one atomic change:

1. **Access mode** — `RunAccessMode` + `compileRunAccessMode()`, the
   `project > user` clamp, and removal of the legacy `permissionMode` surface.
2. **Selectors** — the single split-selector vocabulary (no aliases) and its
   `compileToolset` mapping.
3. **Toolset** — explicit-allowlist parsing/compilation, the spawned hard cap,
   the configured default-vs-self-declared model, and the child-safe cap.
4. **Agent definitions + delegates** — `.sparkwright/agents/<id>.md` /
   `AGENT.md` as the profile source of truth, frontmatter `delegate`, and the
   advanced `capabilities.agents.delegates[]` escape hatch.

   C7 consolidation note (2026-07-06): sub-proposal #4 owns the schema contract
   for definition files and delegates only. It does not duplicate the
   authoring/hook-carrier design from
   [`agent-md-authoring-redesign.md`](agent-md-authoring-redesign.md). The
   merged acceptance bar includes an Agent.md/profile-authored `PreToolUse`
   regression for the P10a rule: rewrite-stage hooks apply first, then
   governance/clamp sees the rewritten arguments.

## Companion Implementation Analysis

This section records the current implementation direction. It is not a final
schema contract; it keeps the redesign grounded while the proposal is refined.

### Accepted Product Constraints

- `spawned` agents are useful development agents by default (`workspace.read`,
  `workspace.write`, `shell`, `skills.load`) but hard-capped to that set.
- `configured` agents default to a useful set and may self-declare more in their
  definition file, up to the child-safe cap. They are not capped by an
  intersected class ceiling.
- User-facing config uses `.sparkwright/agents/<id>.md` for light reusable agent
  identity and `.sparkwright/agents/<id>/AGENT.md` when the agent needs sidecar
  files. There is no config-defined `profiles` path.
- User-facing schema uses `delegate` / `delegates`; implementation types may use
  `DelegateBinding` where that precision is useful.
- The user-facing surface does not expose `defaultToolset`, `maxToolset`,
  `preset`, `inherit`, or `except`.

### Core Refactor Shape

```txt
RunAccessMode
  -> compileRunAccessMode()
  -> permissionMode + shouldWrite + approval defaults

Toolset (explicit allowlist)
  -> compileToolset()
  -> concrete tools + capability facts

agent definitions + optional delegates
  -> resolved agent identities + callable delegate tools
```

Keep these responsibilities separate:

- Toolset compilation controls positive tool visibility only.
- Parent/child deny rules, run policy, write guardrails, confidential read scope,
  sandbox policy, and sub-agent depth limits remain separate hard constraints.
- Approval behavior is derived from access mode but still follows the runtime
  policy decision. If policy allows a workspace write outright, no approval
  request is emitted.

### RunAccessMode Merge Rules

```txt
read-only    -> permissionMode: plan, shouldWrite: false
ask          -> permissionMode: default, shouldWrite: true
accept-edits -> permissionMode: accept_edits, shouldWrite: true
bypass       -> permissionMode: bypass_permissions, shouldWrite: true
```

Approval defaults:

- `read-only`: writes are hard-denied; no write approval applies.
- `ask`: approval resolver asks when policy requires approval.
- `accept-edits`: auto-accept workspace edit approvals when emitted.
- `bypass`: bypass human approval prompts, while explicit deny rules, scope,
  guardrails, confidential read policy, sandbox policy, and depth limits still
  win.

Merge:

- `project > user`. Project's `run.accessMode` is the autonomy ceiling.
- User config and runtime CLI/TUI overrides may request any mode but are clamped
  down to the project ceiling by rank `read-only < ask < accept-edits < bypass`.
- Any clamp is surfaced in config explain / startup diagnostics.
- Runtime overrides still cannot bypass hard `policy.*`, tool-disabled rules,
  write guardrails, sandbox policy, or depth limits.

### ToolsetCompiler Rules

`compileToolset()` runs in this order:

```txt
explicit selector allowlist
  -> apply child-safe hard cap (spawned/configured)
  -> expand selectors against catalog sources
  -> apply global tools.use / tools.allowed / tools.disabled / tools.defer
  -> append derived tool_search only when deferred tools survive
```

`tool_search` remains derived infrastructure. It is never selected directly by a
user selector.

Hard caps:

- `main`: full configured runtime surface after global tool config.
- `spawned`: capped to `workspace.read`, `workspace.write`, `shell`,
  `skills.load`. `spawn_agent` arguments may only narrow.
- `configured`: any selector except `agents.manage` and `mcp` / `mcp:<server>`,
  which are config errors until their infrastructure exists.

A selector that a definition requests above its cap is a config error with
diagnostics. A user-written selector removed by global `tools.*` or policy must
be reported, not silently erased.

### Agents And Delegates Schema

Profile source of truth is an agent definition under `.sparkwright/agents/`. A
definition may be `.sparkwright/agents/<id>.md` or
`.sparkwright/agents/<id>/AGENT.md`; the directory form is for agents that need
sidecar files. A definition converges toward:

```txt
id-from-path, name, description, prompt/body, model, maxSteps, runBudget,
toolset, delegate
```

`toolset` is the agent's explicit authority declaration, bounded by the
child-safe cap and global tool/policy constraints. Policy-like deny boundaries
remain policy-specific config and are not swallowed by positive toolset
compilation.

Advanced explicit delegate entries are still useful for multi-binding or
external transport cases:

```yaml
capabilities:
  agents:
    delegates:
      - profileId: reviewer
        toolName: delegate_external_auditor
        transport: external_command
        command: ./scripts/audit.sh
        workspaceAccess: none
```

`delegate` in agent frontmatter is the simple in-process self-exposure of that
agent; config-level `delegates[]` is the escape hatch for multi-binding and
external/ACP transports. `toolName` must be unique across both sources; a
collision is a hard configuration error with diagnostics, never silent
last-wins.

### External Delegate Defaults

External and ACP delegates keep one simple safety story:

```txt
default = approval-gated, non-nesting, no project workspace access,
          neutral cwd, no secret-bearing environment by default.
read_write = explicit trust boundary that requires a write-enabled parent run.
```

Concrete defaults:

- `risk`: `risky`.
- `requiresApproval`: default `true`.
- `workspaceAccess`: default `none`.
- `forbidNesting`: default `true`.
- `cwd`: neutral/throwaway cwd unless `workspaceAccess: read_write` explicitly
  allows a project cwd.
- ACP delegates default to a minimal environment plus configured `env`; set
  `envMode: inherit` only when the worker must see the parent environment.
- External-command delegates may keep an `envMode: inherit` default, but
  `workspaceAccess: none` must redact credential-looking variables before
  launching. Explicit `env` overlays the redacted base.
- `workspaceAccess: read_write` requires the parent run to be write-enabled,
  allows full inherited env, and emits an untracked write-capable marker rather
  than pretending managed workspace write events exist.
- Preserve timeout, output-limit, success-exit-code, and input-mode behavior
  from the existing external command implementation.

### Project Map Drift

The project map currently describes `RunAccessMode`/`accessMode` as an
implemented protocol/host contract, but the source still exposes only the legacy
`PermissionMode` and `shouldWrite` fields. Before code work lands, either mark
those map assertions stale/proposed or implement the protocol/compiler first and
refresh the map with verified source and tests.

### Suggested Implementation Order

1. Add regression tests for current safety invariants: parent/child deny
   inheritance, write guardrails, depth limits, external delegate
   approval/env/workspace defaults, and `tool_search` derivation.
2. Add protocol `RunAccessMode` and `compileRunAccessMode()` in a shared layer
   consumed by host, CLI, and TUI, with the `project > user` clamp.
3. Land the single split-selector vocabulary and its catalog mapping.
4. Introduce the explicit-allowlist toolset parser/compiler with the spawned
   hard cap and configured child-safe cap.
5. Switch main, spawned, and configured child catalogs to the compiler; enable
   the spawned default and ensure `spawn_agent.allowedTools` only narrows.
6. Move configured-agent identity to `.sparkwright/agents/<id>.md` and
   `.sparkwright/agents/<id>/AGENT.md` as the sole source of truth.
7. Add frontmatter `delegate` and the advanced `capabilities.agents.delegates[]`
   for multi-binding/external transport cases.
8. Update capability inspect, CLI config validate/explain, TUI capability panels,
   protocol docs, and generated schemas.
9. Update project map pages in the same change set as behavior changes.
