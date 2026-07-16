# Agent Profiles

Agent profiles are reusable run templates for roles such as reviewer, planner,
triage agent, or implementation helper. They describe guidance and constraints;
they do not grant authority by themselves.

Use this guide when you want to answer:

- Where do I define an agent?
- How do I make it callable by the main agent?
- How do I restrict its tools?
- How do I check what the host actually loaded?

## Choose The Right Place

```txt
Project markdown profile
  <workspace>/.sparkwright/agents/<id>.md
  Best for role prompt, description, capability selectors, model hints,
  profile-scoped workflow hooks, maxSteps, runBudget, and optional inline
  delegate exposure.

Project config
  <workspace>/.sparkwright/config.{json,yaml,yml}
  Best for delegateTools, advanced policy, budgets, maxDepth, exact profile
  records, and profile hooks when JSON/YAML review is preferred.
```

Markdown profiles can be organized in subfolders; the profile id is the file
basename. If the same id exists in markdown and config, the config profile wins.

## Create A Reviewer

The fastest path is the CLI:

```bash
sparkwright agents create reviewer \
  --name "Reviewer" \
  --prompt "Inspect changes for correctness and risk." \
  --model openai/gpt-5.4-mini \
  --use workspace.read \
  --max-steps 4 \
  --workspace .
```

This writes a profile into the project config under
`capabilities.agents.profiles`. If a project YAML config already exists, the CLI
preserves it; otherwise it creates `.sparkwright/config.json`.

You can also commit a markdown profile:

```md
---
name: Reviewer
description: Inspect changes for correctness, risk, and missing tests.
model: openai/gpt-5.4-mini
use: [workspace.read]
maxSteps: 4
---

Review the proposed change. Focus on correctness, regressions, and missing
tests. Report findings with file references.
```

Save it as:

```txt
.sparkwright/agents/reviewer.md
```

Set `model: provider/model` to run an in-process delegate on its own model
(e.g. a cheap model for grunt work, a stronger one for review). Model selection
uses `profile.model`, then `capabilities.agents.delegateModel`, then the parent
run model. The child's cost rolls up into the parent run under that model's
pricing. ACP and external-command delegates run their own process, so their
model comes from `metadata.acp`/`metadata.externalCommand`, not this field.

Non-`main` markdown profiles default to child agents. A file named `main.md` or
`mode: primary` marks the primary profile and is excluded from delegate targets.
`mode: child` is accepted but no longer needed; use `mode: all` only when a
profile should be both primary and child-eligible.

Implementation delegates should usually combine read and write selectors:

```md
---
name: Implementer
description: Make scoped code changes.
use: [workspace.read, workspace.write]
maxSteps: 8
---

Make the requested change, then summarize exactly what changed.
```

Avoid `workspace.write` without `workspace.read` unless the delegate is driven
by a deterministic script. Most model-backed implementers need read tools to
find anchors before they can produce safe patches.

## Make It Callable

Non-`main` profiles that omit `mode` default to child/delegate agents. A
Markdown file named `main.md` and profiles with `mode: primary` are excluded.
Child/delegate profiles are indexed
for the main agent and callable through the generic `delegate_agent` tool by
`agentId`, unless the profile sets `exposeAsDelegate: false`. Add a
`delegateTool` / `delegateTools` entry only when you also want a stable legacy
tool name, such as
`delegate_reviewer`, for pinned or all direct exposure:

```bash
sparkwright agents create reviewer \
  --name "Reviewer" \
  --prompt "Inspect changes for correctness and risk." \
  --use workspace.read \
  --max-steps 4 \
  --delegate delegate_reviewer \
  --workspace .
```

The config shape is:

```json
{
  "capabilities": {
    "agents": {
      "maxDepth": 1,
      "profiles": [
        {
          "id": "reviewer",
          "name": "Reviewer",
          "prompt": "Inspect changes for correctness and risk.",
          "use": ["workspace.read"],
          "maxSteps": 4
        }
      ],
      "delegateTools": [
        {
          "profileId": "reviewer",
          "toolName": "delegate_reviewer",
          "requiresApproval": true,
          "forbidNesting": true,
          "maxSteps": 4
        }
      ]
    }
  }
}
```

`profiles` defines the agent. `delegateTools` defines an optional direct
delegate tool alias; the agent remains addressable by `agentId` through
`delegate_agent` even when that alias is not directly exposed. `use` is a broad
selector list shared with top-level `tools.use`. `maxDepth` caps nested
child/delegate spawning for this workspace.

Markdown profiles can expose the same callable surface inline:

```md
---
name: Reviewer
description: Inspect changes for correctness, risk, and missing tests.
use:
  - workspace.read
delegateTool:
  toolName: delegate_reviewer
  requiresApproval: true
  forbidNesting: true
maxSteps: 4
---

Review the proposed change. Start with the diff, then report findings with file
references.
```

Explicit `capabilities.agents.delegateTools` entries win over inline
`delegateTool` when they target the same profile or tool name.

## Advanced Precise Allowlists

Prefer `use` for normal profile authority. `allowedTools` is a legacy
concrete-name allowlist for unusual cases where a selector still exposes too
much. Markdown may spell the same field as `tools`; `disallowedTools` is an
alias for `deniedTools`.

```yaml
---
name: Narrow reader
use: [workspace.read]
allowedTools: [read, glob]
---
```

When both `use` and `allowedTools` are set, the child only receives tools that
pass both filters. The precise allowlist narrows authority; it does not widen it.

## Per-Agent Workflow Hooks

Profiles can attach workflow hooks that run only inside that profile's
in-process child run:

```md
---
name: DB Reader
description: Execute read-only database queries.
model: openai/gpt-5.4-mini
use: [workspace.read, bash]
hooks:
  PreToolUse:
    - matcher: bash
      action:
        type: command
        command: ./scripts/validate-readonly-query.sh
        stdin: json
        blockOnFailure: true
        injectOutput: onFailure
---

Answer database questions with read-only commands.
```

`matcher: bash` is shorthand for `{ toolName: "bash" }`; object matchers use
the same workflow matcher fields as project workflow hooks. Canonical lifecycle
names are `RunStart`, `TurnStart`, `ModelOutput`, `PreToolUse`, `PostToolUse`,
`Stop`, `RunEnd`, and `RuntimeSignal`.

Profile hooks are scoped guardrails, not global project hooks. They apply when
the profile runs through SparkWright's in-process child-agent path, including
`delegate_agent`, direct delegate aliases, and `delegate_parallel`. They do not
run on the main agent, dynamic `spawn_agent` children, ACP delegates, or
external-command delegates.

The profile hook action subset is intentionally smaller than global workflow
hooks: `command`, `block`, `context`, and `http` are accepted; `agent` actions
are not. HTTP actions still follow the trusted HTTP hook policy, and project
config cannot define HTTP hook actions. To author the same rule in config
instead of markdown, put the same `hooks` shape under
`capabilities.agents.profiles[].hooks`.

## Direct Delegate Exposure

By default SparkWright uses indexed exposure: the model sees `list_agents`,
`delegate_agent`, and any enabled generic agent tools, rather than one
`delegate_*` tool per profile. To keep a small set of direct named aliases,
pin profile ids or tool names:

```json
{
  "capabilities": {
    "agents": {
      "exposure": "indexed",
      "pinnedDelegates": ["reviewer", "delegate_auditor"]
    }
  }
}
```

To expose every resolved delegate alias as a direct tool, set:

```json
{ "capabilities": { "agents": { "exposure": "all" } } }
```

The older `exposeChildrenAsDelegates: true` setting is still treated as all
direct exposure. Per-profile `exposeAsDelegate` affects automatic delegation
targets and synthesized direct aliases:

- `exposeAsDelegate: true` — expose this child even when the global flag is off.
- `exposeAsDelegate: false` — keep this child out of the automatic delegation
  index and direct alias surface, even when on.
- omitted — follow the global flag.

An explicit `delegateTool` / `delegateTools` entry always defines the alias; the
`exposure` / `pinnedDelegates` settings decide whether that alias appears as a
top-level model tool.

## Routing Hints

Profiles can declare deterministic routing keywords:

```yaml
triggers: [review, diff, risk]
when:
  keywords: [登录, 认证]
```

These hints are opt-in and advisory. SparkWright uses them to sort and label
delegate tools for the current goal (`relevant` / `low`) and records the
decision in trace as `agent.routing.evaluated`. The first implementation does
not hide tools: the main agent still sees the full delegate set, and policy/tool
permissions are unchanged.

## Parallel Delegates (Opt-In)

For read-only fan-out, enable the built-in `delegate_parallel` tool:

```json
{ "capabilities": { "agents": { "enableParallelDelegates": true } } }
```

The tool runs multiple configured in-process delegates concurrently and returns
a combined result. Target delegates by `agentId` (preferred) or by legacy
`toolName`. It is deliberately narrow in the first version:

- ACP and external-command delegates are rejected
- delegates must have `workspaceAccess: "none"` and no shell access
- calls are foreground and block until every child finishes
- at most eight delegates run in one call

Each child still gets its own isolated goal, profile policy, model override,
budget, trace, and usage rollup. The parent trace shows the `delegate_parallel`
tool call plus child `subagent.*` events whose metadata has
`entrypoint: "delegate_parallel"`.

## Ids And Collisions

Markdown ids come only from the filename stem: a nested file `review/foo.md`
and `audit/foo.md` both resolve to id `foo`. Within one layer that is an
**ambiguous collision** — the
first file wins and the rest are dropped (fail-closed) and reported as
`agent id collisions` in `capabilities inspect`. The same id across different
layers (user vs project vs config) is legitimate shadowing, not a collision.

Frontmatter cannot override this identity. Use distinct basenames such as
`review-foo.md` and `audit-foo.md` when nested profiles must coexist.

If two delegate tools sanitize to the same tool name (e.g. `review:foo` and
`review/foo` both become `delegate_review_foo`), the collision is reported as
`delegate tool collisions` and the second is dropped rather than silently
overriding the first.
When `enableParallelDelegates` is on, `delegate_parallel` is reserved for the
built-in fan-out tool; if an existing delegate already owns that name, the
built-in tool is dropped fail-closed and a capability warning is emitted.

## Inspect And Validate

Use these before guessing:

```bash
sparkwright agents list --workspace .
sparkwright agents validate --workspace .
sparkwright capabilities inspect --workspace . --format text
```

Look for:

- the profile id in `agents list`
- `delegate_<name> -> <profileId>` if it should be callable, including its
  `model=` when the profile pins a model; otherwise it uses
  `capabilities.agents.delegateModel` or the run model
- `routing=` / `triggers=` when routing hints are configured
- agent shadows in `capabilities inspect` if the same id exists in multiple
  layers
- `agent id collisions` / `delegate tool collisions` in `capabilities inspect`
  if two profiles in one layer share an id or two delegates share a tool name
- validation errors for delegate tools pointing at missing profile ids
- profile hooks in the source profile if the child needs scoped guardrails

## Common Mistakes

- Expecting a direct `delegate_*` tool without `delegateTool`, `delegateTools`,
  `pinnedDelegates`, or `exposure: "all"`: the agent is still callable through
  `delegate_agent` by `agentId`, but it will not appear as its own top-level
  tool.
- Giving a child agent too many tools: prefer narrow `use` selectors first, then
  concrete `allowedTools` when needed.
- Expecting markdown to override config: config wins for the same id.
- Expecting profile hooks to affect the main run, dynamic spawned children, ACP
  delegates, or external-command delegates: they only attach to in-process
  configured child/delegate runs.
- Using an `agent` workflow-hook action inside a profile hook: profile hooks
  accept `command`, `block`, `context`, and `http`.
- Putting secrets in agent prompts or project config: keep credentials in user
  config or environment variables.
- Using delegation to bypass policy: parent restrictions and host policy still
  apply.
