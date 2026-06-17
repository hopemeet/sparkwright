# Build Capabilities

Use this reference to decide what to create and how to verify it.

## Decision Tree

- User wants SparkWright to remember reusable guidance, examples, domain rules,
  or workflow instructions: create a **Skill**.
- User wants a role with its own prompt, tool limits, max steps, or delegated
  work: create an **agent profile** and optionally a **delegate tool**.
- User wants to connect an external service, local daemon, database adapter, or
  tool server: configure an **MCP server**.
- User wants repeated or scheduled work: create a **cron job**.
- User wants a named shortcut prompt: create a **slash command** under
  `.sparkwright/command/`.
- User wants tools allowed, blocked, or lazily loaded: update **tool filters**.
- User wants provider, model, workspace, permission mode, skills, MCP, agents,
  or TUI preferences: update **config**.

If more than one option fits, choose the smallest capability that satisfies the
request. Prefer a Skill before an agent when no independent role or delegation
boundary is needed. Prefer a slash command before a Skill when the user only
wants one named prompt.

## Project Setup

Project capability files live under `.sparkwright/`. If the project surface is
missing, scaffold it first:

```bash
npm exec sparkwright -- init --project
```

Inspect effective state:

```bash
npm exec sparkwright -- capabilities inspect --workspace . --format text
```

## Skills

Use a Skill for reusable instructions or reference material.

```bash
npm exec sparkwright -- skills create <name> --description "what it does" --workspace .
npm exec sparkwright -- skills validate --workspace . --format text
```

Then edit `.sparkwright/skills/<name>/SKILL.md` when the generated template
needs task-specific routing, operating rules, or references.

Good Skill content:

- clear trigger scope
- what to read or inspect first
- rules for when not to use the Skill
- references in `references/` when the body would become long

Skills are context and capability hints, not authority. They do not bypass
policy, approval, validation, or workspace write controls.

## Agent Profiles

Use an agent profile when the user wants a specialist role or constrained child
run.

```bash
npm exec sparkwright -- agents create <id> \
  --prompt "what this agent should do" \
  --allow <tool-pattern> \
  --max-steps 4 \
  --workspace .

npm exec sparkwright -- agents validate --workspace .
```

Add `--delegate <tool_name>` only when the main agent should be able to call
the profile as a tool. A profile without a delegate tool is still inspectable
but not callable by the main agent.

Use allow/deny rules to constrain the child agent. Child allow rules must not
be treated as permission escalation; inherited policy still applies.

## MCP Servers

Use MCP when SparkWright needs tools from an external process or service.

Project config example:

```json
{
  "capabilities": {
    "mcp": {
      "servers": [
        {
          "type": "stdio",
          "name": "workspace",
          "command": "node",
          "args": ["./tools/workspace-mcp.js"],
          "cwd": ".",
          "enabled": true
        }
      ],
      "defaultTimeoutMs": 30000,
      "namePrefix": "mcp",
      "defaultPolicy": {
        "risk": "risky",
        "requiresApproval": true
      }
    }
  }
}
```

Rules:

- Keep credentials out of project config.
- Set conservative policy for tools that can mutate workspace state, reach
  network services, or touch external systems.
- Use `capabilities inspect` after editing to confirm the server appears.
  Add `--resolve-mcp` when you need the host to prepare MCP servers and show
  resolved tool names, tool counts, and prepare failures.

## Cron Jobs

Use cron for scheduled or repeated automation.

```bash
npm exec sparkwright -- cron create \
  --schedule "every 1h" \
  --prompt "task to run" \
  --name <name>

npm exec sparkwright -- cron list
```

For manual verification:

```bash
npm exec sparkwright -- cron run <job-id-or-name> --model deterministic --yes
```

Use `--skill <name>` when the scheduled task should load a specific Skill.
Scheduled work should still respect permissions and approval policy.

## Slash Commands

Use a slash command for a named prompt shortcut.

Create `.sparkwright/command/<name>.md`:

```md
---
description: Explain what the command does
model: deterministic
subtask: false
---

Prompt text sent when the command runs.

Optional user input: $ARGUMENTS
First positional argument: $1
```

Commands return a start-run intent; they do not bypass the run boundary.

## Tool Filters

For user-level changes:

```bash
npm exec sparkwright -- tools list --format text
npm exec sparkwright -- tools disable <tool-name...>
npm exec sparkwright -- tools defer <tool-name...>
```

Add `--workspace <path>` to update project defaults in
`<workspace>/.sparkwright/config.json` instead. You can also edit the file
directly:

```json
{
  "capabilities": {
    "tools": {
      "disabled": ["shell"],
      "defer": ["mcp_*"]
    }
  }
}
```

Omit `enabled` unless the user explicitly wants an allowlist.

## Verification Checklist

- `capabilities inspect` reflects the new capability.
- `skills validate` or `agents validate` passes when those surfaces changed.
- Cron jobs appear in `cron list`.
- Project config remains secret-free.
- The final response tells the user what changed and how to try it.
