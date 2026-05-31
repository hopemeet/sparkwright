# Capability Design Guide

This guide explains how to decide whether something should be a Skill, Tool,
MCP server, agent profile rule, or background task.

## Core Rule

Every external capability should enter Sparkwright as one of the existing
runtime primitives:

- `ContextItem`
- `ToolDefinition`
- policy decision
- approval request
- artifact
- trace event

The run loop should not need to know whether a capability came from a Skill,
MCP server, local script, hosted worker, or child agent.

## Decision Table

| Need                                             | Use                                            |
| ------------------------------------------------ | ---------------------------------------------- |
| Teach the agent how to approach a recurring task | Skill                                          |
| Add bounded reference material                   | Skill reference or context extension           |
| Let the agent perform a typed action             | Tool                                           |
| Bridge an external capability server             | MCP adapter normalized to tools/context        |
| Restrict what one agent may do                   | Agent profile                                  |
| Require human control for risky actions          | Policy and approval                            |
| Run long work outside the foreground turn        | Background task                                |
| Repeat work on a schedule                        | Host-owned scheduler that starts governed runs |

## Skills

A Skill is a versioned prompt package and context source:

```txt
skill-name/
  SKILL.md
  scripts/
  references/
  assets/
```

Use a Skill when you need repeatable task guidance, domain conventions, or
curated references. A Skill is not permission to execute. Any script, tool,
network call, or workspace write suggested by a Skill still goes through normal
policy, approval, validation, execution, and trace.

Read [Skills](SKILLS.md) for supported frontmatter and loading behavior.

## Tools

Use a Tool when the model needs to call a typed action. Tools should have:

- a clear name and description
- JSON-schema-like input validation
- narrow authority
- policy-ready metadata
- predictable output shape

Tool origin is metadata. A tool from TypeScript, MCP, a script wrapper, or a
hosted service should all converge to the same execution path:

```txt
schema validation -> policy -> approval -> execute -> validate -> trace
```

## MCP

MCP servers are external capability sources. They should be discovered at the
edge and normalized into Sparkwright tools or context resources.

Do not let MCP bypass the harness boundary. A safe MCP integration records:

- server name and transport
- discovered tool names
- tool origin such as `mcp:<server-name>`
- default risk and approval policy
- execution result and trace events

Capability runtime config supports MCP server descriptors through
[schemas/mcp-server-config.schema.json](../schemas/mcp-server-config.schema.json).

## Agent Profiles

An agent profile describes the capability boundary for one agent:

```json
{
  "id": "reviewer",
  "allowedTools": ["inspect_diff", "skill.load", "mcp_*"],
  "maxSteps": 4,
  "runBudget": {
    "maxToolCalls": 4,
    "maxModelCalls": 4
  },
  "policy": [
    {
      "action": "workspace.write",
      "resource": "*",
      "effect": "deny",
      "reason": "The reviewer is read-only."
    }
  ]
}
```

Use profiles to make delegation explicit. Parent restrictions should remain
constraining for child agents; child allow rules must not override inherited
denies.

Read [packages/agent-runtime/README.md](../packages/agent-runtime/README.md)
for the current helper package.

## Capability Runtime Config

The capability runtime example composes Skills, MCP, and agent policy before a
normal run starts:

```txt
@sparkwright/skills        -> ContextItem[] and optional tools
@sparkwright/mcp-adapter   -> ToolDefinition[]
@sparkwright/agent-runtime -> Policy
@sparkwright/core          -> run lifecycle, tools, policy, trace
```

The config schema is
[schemas/capability-runtime-config.schema.json](../schemas/capability-runtime-config.schema.json).
The runnable example is [examples/capability-runtime](../examples/capability-runtime).

## Capability Chain In Trace

Trace should explain why an action was possible:

```json
{
  "agentId": "reviewer",
  "skillName": "code-reviewer",
  "toolName": "inspect_diff",
  "toolOrigin": "local:function",
  "approval": "not_required",
  "result": "completed"
}
```

For MCP-backed work, include the server:

```json
{
  "agentId": "notifier",
  "skillName": "dingtalk-notifier",
  "toolName": "dingtalk.send_message",
  "toolOrigin": "mcp:dingtalk-server",
  "approval": "required",
  "result": "completed"
}
```

This keeps Skills from becoming invisible prompt magic and keeps MCP from
bypassing policy.

## Design Checklist

Before adding a capability, answer:

- Does it provide context, execute an action, constrain an agent, or schedule a run?
- What is the narrowest useful authority?
- What policy action and resource describe it?
- When should approval be required?
- What artifact or trace event proves what happened?
- Can the capability be disabled without forking the loop?
- Does it preserve prompt-cache stability by using turn/session context instead of rewriting stable sections?
