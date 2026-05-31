# Trace Extension Events

This document defines experimental trace metadata and event shapes for extension
packages. These names are not required in the core event schema yet; extension
packages may attach the same data to run metadata or existing events until the
shapes stabilize.

The goal is reproducibility: a trace consumer should be able to explain which
extension influenced model context, tool availability, policy, or external side
effects.

## Naming

Experimental extension event names use the same dotted style as core events:

```txt
skill.indexed
skill.loaded
mcp.server.prepared
agent.profile.derived
```

Core may later promote stable events into `event.schema.json`. Until then,
these shapes are documentation contracts for extension packages and product
shells.

## skill.indexed

Emitted after a Skill source has been scanned and reduced to index metadata.

```json
{
  "count": 2,
  "skills": [
    {
      "name": "code-reviewer",
      "version": "1.0.0",
      "sourcePath": "skills/code-reviewer/SKILL.md",
      "contentHash": "..."
    }
  ]
}
```

## skill.loaded

Emitted when a selected Skill body is loaded into context or through a governed
loader tool.

```json
{
  "name": "code-reviewer",
  "version": "1.0.0",
  "sourcePath": "skills/code-reviewer/SKILL.md",
  "contentHash": "...",
  "selectionReason": "Matched goal against skill name or description.",
  "agentId": "reviewer",
  "mode": "resident_context"
}
```

`mode` may be:

- `resident_context`
- `tool_observation`

## mcp.server.prepared

Emitted after an MCP server has been prepared or skipped.

```json
{
  "serverName": "github",
  "status": "connected",
  "toolCount": 3,
  "toolNameMap": [
    {
      "toolName": "mcp_github_read_file",
      "serverName": "github",
      "mcpToolName": "read_file"
    }
  ]
}
```

`status` may be `connected`, `disabled`, or `failed`. Failed events should
include a short non-secret `error` string.

## agent.profile.derived

Emitted when an application derives an effective child or scoped agent profile.

```json
{
  "agentId": "reviewer",
  "parentAgentId": "planner",
  "parentAgentDenyCount": 1,
  "parentRunDenyCount": 1,
  "childDenyCount": 0,
  "effectiveToolCount": 2
}
```

The event should not include long prompts or secrets. Include profile ids,
counts, and policy sources rather than full product-specific auth state.

## Current Recommended Metadata

Until these events become first-class, callers should store extension metadata
on `run.metadata`:

```json
{
  "agentId": "reviewer",
  "loadedSkills": [],
  "indexedSkills": [],
  "mcpStatuses": {},
  "mcpToolNameMap": []
}
```

Tool origin should use `ToolGovernance.origin` so policy and approval receive
the same source metadata that trace consumers inspect.
