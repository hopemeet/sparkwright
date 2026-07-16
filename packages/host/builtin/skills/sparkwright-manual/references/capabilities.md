# Capabilities

Use this reference for tools, skills, MCP, agent profiles, delegate tools,
policy, approval, and capability-runtime wiring.

## Rule

External capability sources must converge into Sparkwright runtime primitives:

- `ContextItem`
- `ToolDefinition`
- policy decision
- approval request
- artifact
- trace event

Do not bypass the run boundary because a capability came from a Skill, MCP
server, local script, hosted worker, or child agent.

## Tools

Use a tool when the model needs a typed action. A good tool has:

- narrow name and description
- input schema
- policy metadata
- bounded output
- explicit side-effect behavior
- traceable execution result

Reference implementation entry points:

- `packages/core/src/tools.ts`
- `docs/guides/CUSTOM_TOOL_EXAMPLE.md`
- `docs/reference/EXTENSION_INTERFACES.md`

Execution path:

```txt
schema validation -> policy -> approval -> execute -> validate -> trace
```

## Skills

Skills are prompt/context packages, not authority. Supported shape:

```txt
skill-name/
  SKILL.md
  scripts/
  references/
  assets/
```

`SKILL.md` is required. Scripts must become governed tools before execution.

Useful commands:

```bash
npm exec sparkwright -- skills list --workspace .
npm exec sparkwright -- skills validate --workspace .
npm exec sparkwright -- skills create <name> --description "what it does" --workspace .
```

Code and docs:

- `packages/skills/`
- `docs/reference/SKILLS.md`
- `schemas/skill-manifest.schema.json`

## MCP

MCP servers are external capability sources. Normalize MCP tools to
`ToolDefinition` and MCP resources to context items. Core should not depend on
MCP protocol details.

Config schema:

- `schemas/mcp-server-config.schema.json`

Server descriptors support:

- `stdio`: `type`, `name`, `command`, optional `args`, `cwd`, `env`,
  `timeoutMs`, `enabled`
- `http`: `type`, `name`, `url`, optional `headers`, `timeoutMs`, `enabled`

Default policy for MCP capabilities should be conservative. Record server name,
tool origin, policy decision, approval result, and execution result in trace.
Stdio MCP servers without an explicit `cwd` run from a neutral temporary
directory rather than the workspace; configure `cwd` only for trusted servers
that intentionally need project files.
Configured MCP servers default to `startup: "lazy"`: normal runs expose MCP
gateway tools but do not connect until the server is actually used. Use
`startup: "prepare"` when concrete MCP tool names must be discoverable through
`tool_search select:<tool-name>` at run startup, and `startup: "eager"` when
schemas should also default to eager loading. ACP sessions may add
session-scoped MCP servers; those are merged with configured servers for that
session and may be prepared immediately because the client explicitly supplied
them. ACP-over-ACP MCP transport is not implemented and should be rejected
rather than silently ignored.

## Agent Profiles

Agent profiles are reusable run templates for specific agent roles. They define
role guidance and capability boundaries for main or child runs; they do not own
credentials, sessions, installed skills, cron state, logs, or workspace storage.

Common fields:

- `id`
- `name`
- `description`
- `mode` (optional; non-`main` profiles default to child/delegate agents)
- `model`
- `prompt`
- `use`
- `allowedTools` (advanced concrete-name narrowing)
- `deniedTools`
- `hooks` (profile-scoped workflow hooks for in-process child runs)
- `delegateTool`
- `policy`
- `maxSteps`
- `runBudget`
- `metadata`

External ACP delegates use `metadata.acp` on a profile:

```json
{
  "id": "external_reviewer",
  "metadata": {
    "acp": {
      "transport": "stdio",
      "command": "codex",
      "args": ["acp"],
      "workspaceAccess": "read_write",
      "timeoutMs": 120000
    }
  }
}
```

Expose the profile with inline `delegateTool` or
`capabilities.agents.delegateTools` to create a risky, approval-gated delegate
tool. Explicit `delegateTools` entries win over inline profile `delegateTool`
when both target the same profile or tool name. Use the command and args for the
installed ACP-compatible agent process on the host machine. ACP delegates
default to `envMode: "explicit"`; they receive only a minimal process
environment plus configured `env` unless `envMode: "inherit"` is set.

Child agents inherit the parent run's permission mode, write guardrails, target
path, and confidential read scope before their own profile policy is applied.
Agent profiles can narrow behavior, but they do not grant authority outside the
parent run boundary.

Profile `hooks` are scoped guardrails for configured in-process child runs.
They apply when the profile is invoked through `delegate_agent`, a direct
delegate alias, or `delegate_parallel`; they do not apply to the main run,
dynamic `spawn_agent` children, ACP delegates, or external-command delegates.
Supported profile hook actions are `command`, `block`, `context`, and `http`;
`agent` hook actions belong to global workflow hooks. HTTP actions still follow
the trusted HTTP hook policy, and project config cannot define HTTP hook
actions.

For local assistants that run as regular CLI commands, use
`metadata.externalCommand` instead:

```json
{
  "id": "external_cli_reviewer",
  "metadata": {
    "externalCommand": {
      "command": "agent-cli",
      "args": ["run", "{{goal}}"],
      "envMode": "inherit",
      "input": "none",
      "workspaceAccess": "read_write",
      "timeoutMs": 120000,
      "maxStdoutBytes": 64000,
      "maxStderrBytes": 64000
    }
  }
}
```

The command is spawned directly. `args` can include `{{goal}}`,
`{{metadataJson}}`, and `{{workspaceRoot}}`. `envMode` controls whether the
child inherits the host environment or receives only configured `env` values.
`{{workspaceRoot}}` and `cwd` require `"workspaceAccess": "read_write"`;
without it, the external process runs away from the project directory. A
`read_write` delegate also requires the parent run or direct debug command to
enable workspace writes.

Useful commands:

```bash
npm exec sparkwright -- agents list --workspace .
npm exec sparkwright -- agents validate --workspace .
npm exec sparkwright -- agents create reviewer \
  --prompt "Review code changes" \
  --model openai/gpt-5.4-mini \
  --use workspace.read \
  --max-steps 4 \
  --workspace .
```

In-run, agent profile capabilities are split across two tools so read-only
inspection never triggers an approval prompt:

- `list_agents` — `list` / `validate`. Read-only, no approval.
- `create_agent` — `create` / `update` / `replace` / `remove`. Manages one
  `.sparkwright/agents/<name>.md` file through the normal workspace-write
  approval path. Create/update/replace require a prompt; replace also requires a
  reason. Remove deletes that exact Markdown Agent. Explicit config profiles
  remain human/CLI-owned governance and are not mutated by this model tool.

Skills follow the same split: `list_skills` (`list` / `validate`, read-only)
and `create_skill` (`create`, writes a SKILL.md, requires approval).

Reference files:

- `schemas/agent-profile.schema.json`
- `packages/agent-runtime/README.md`
- `packages/agent-runtime/src/`

Policy precedence is:

```txt
deny > requires_approval > allow
```

Child agents cannot override inherited denies.

## Delegate Tools

Configured non-`main` profiles default to child/delegate agents and are indexed
for delegation; `id: main` or `mode: primary` profiles are excluded. They can be
called with `delegate_agent` by `agentId` unless they set
`exposeAsDelegate: false`.
Direct `delegate_*` aliases are optional: use them when a task needs a stable
named tool for pinned or all direct exposure. The child run returns a result to
the parent; the parent does not automatically inherit the child's entire
context.

Agent profile `triggers` and `when.keywords` are routing hints. SparkWright can
sort and label delegates as `relevant` or `low` for the current goal, but the
first implementation keeps every delegate visible and leaves policy unchanged.

`capabilities.agents.enableParallelDelegates: true` exposes
`delegate_parallel`, a foreground fan-out tool for configured in-process
delegates. It targets agents by `agentId` (preferred) or legacy `toolName`,
starts multiple read-only delegates concurrently, and waits for all children to
finish. Version 1 rejects ACP delegates, external-command delegates,
workspace-writing delegates, and delegates with shell access.

Do not use delegation to avoid policy. Parent restrictions remain constraining.

## Capability Runtime Config

The capability runtime example composes:

```txt
@sparkwright/skills        -> ContextItem[] and optional tools
@sparkwright/mcp-adapter   -> ToolDefinition[]
@sparkwright/agent-runtime -> Policy
@sparkwright/core          -> run lifecycle, tools, policy, trace
```

Reference files:

- `examples/capability-runtime/capabilities.json`
- `schemas/capability-runtime-config.schema.json`
- `examples/capability-runtime/README.md`

## Design Checklist

Before adding or exposing a capability:

- Is it context, a tool, a policy rule, a scheduled run, or an artifact?
- What is the narrowest useful authority?
- What action/resource describes the policy decision?
- Does it require approval?
- What trace event proves what happened?
- Can it be disabled without forking the loop?
- Does it preserve prompt-cache stability?
