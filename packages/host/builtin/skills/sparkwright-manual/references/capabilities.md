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
- `mode`
- `prompt`
- `allowedTools`
- `deniedTools`
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

Expose the profile with `capabilities.agents.delegateTools` to create a
risky, approval-gated delegate tool. Use the command and args for the installed
ACP-compatible agent process on the host machine. ACP delegates default to
`envMode: "explicit"`; they receive only a minimal process environment plus
configured `env` unless `envMode: "inherit"` is set.

Child agents inherit the parent run's permission mode, write guardrails, target
path, and confidential read scope before their own profile policy is applied.
Agent profiles can narrow behavior, but they do not grant authority outside the
parent run boundary.

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
npm exec sparkwright -- agents create reviewer --prompt "Review code changes" --allow inspect_diff --max-steps 4 --workspace .
```

In-run, agent profile capabilities are split across two tools so read-only
inspection never triggers an approval prompt:

- `list_agents` — `list` / `validate`. Read-only, no approval.
- `create_agent` — `create` / `remove`. Writes `.sparkwright/config.json`, so
  it requires approval. `create` needs an `id` and a `prompt`.

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

Delegate tools expose an agent profile as a callable tool. Use them when a task
needs scoped sub-work with an explicit prompt, tool allow-list, policy, and
budget. The child run returns a result to the parent; the parent does not
automatically inherit the child's entire context.

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
