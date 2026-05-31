# Skill, MCP, And Agent Capability Model

This note defines how Sparkwright should treat Skills, MCP servers, tools, and future multi-agent sessions without making the core run loop large.

## Core Principle

Core owns the unified runtime protocol and safety boundary.

Skills, MCP servers, hosted tools, local scripts, and agent roles are capability sources at the edge. Before execution, they should converge into existing Sparkwright primitives:

- `ContextItem`
- `ToolDefinition`
- policy decisions
- approval requests
- trace events
- artifacts

The run loop should not need to know whether a tool came from in-process TypeScript, an MCP server, a skill script, or a hosted worker.

## Concepts

### Skill

A Skill is a versioned prompt package and context source.

It can describe:

- when it should be used
- how the agent should approach a task
- which references should be loaded
- which scripts may be executed
- which tools or capabilities are relevant

A Skill is not itself permission to execute. Any tool, script, workspace write, network call, or external side effect suggested by a Skill still goes through Sparkwright policy, approval, validation, and trace.

The preferred package shape is compatible with common `SKILL.md` conventions:

```txt
skill-name/
  SKILL.md
  scripts/
  references/
  assets/
```

The minimum supported frontmatter should be:

```yaml
---
name: dingtalk-notifier
description: Sends DingTalk group notifications when the user asks to send DingTalk, webhook, notification, or group messages.
metadata:
  version: 1.0.0
---
```

### MCP Server

An MCP server is an external capability source.

MCP tools and resources should be discovered at the edge, normalized into Sparkwright descriptors, and then registered as `ToolDefinition` values or context sources.

The core rule is:

```txt
MCP tool -> Sparkwright ToolDefinition -> policy -> approval -> execute -> trace
```

Core should not directly depend on MCP protocol details.

### Tool

A Tool is the runtime execution interface controlled by Sparkwright.

Tool origin is metadata. Tool execution is always governed by the same runtime path:

- schema validation
- policy check
- approval when required
- execution
- output validation
- observation formatting
- trace and artifact recording

Examples of tool origins:

- `local:function`
- `local:script`
- `mcp:<server-name>`
- `hosted:<provider>`

### Agent Profile

An Agent Profile describes the capability boundary for one agent in a future multi-agent run.

Each agent may have different skills, tools, MCP servers, policies, and context strategies.

Example:

```ts
// shape mirrors @sparkwright/agent-runtime AgentProfile, see packages/agent-runtime/src/index.ts
interface AgentProfile {
  id: string;
  name?: string;
  description?: string;
  mode?: "primary" | "child" | "all"; // @reserved v0.2
  model?: unknown; // @reserved v0.2
  prompt?: string; // @reserved v0.2
  allowedTools?: string[];
  deniedTools?: string[];
  policy?: CapabilityRule[];
  maxSteps?: number;
  runBudget?: RunBudget;
  metadata?: Record<string, unknown>;
}
```

Skill access (`allowedSkills`, `deniedSkills`) is scoped through
`SkillAccessPolicy` in `@sparkwright/skills` rather than the agent profile
itself; MCP-server scoping is currently expressed by which servers a shell
chooses to prepare.

Skill and tool selection should be agent-scoped, not global.

## Progressive Skill Loading

Skills should be loaded progressively to preserve context budget.

### Level 1: Skill Index

Load only `name`, `description`, source path, version, and content hash.

Represent this as `ContextItem` metadata with `layer: "skill_index"`.

### Level 2: Selected Skill Body

When a skill matches the goal and agent profile, load the relevant `SKILL.md` body into selected context.

Trace the selection reason and content hash.

### Level 3: Resources And Scripts

Load `references/` files or execute `scripts/` only when the selected skill instructs the agent to use them and the current task requires them.

Scripts are not trusted just because they are bundled with a Skill. They should execute through a governed tool path.

## Trace Requirements

Skills are prompt packages, but they still affect model behavior, tool selection, and execution boundaries. Therefore, Skill usage should be traceable.

The first implementation does not need to store full skill contents in trace. It should store enough metadata to reproduce and audit behavior:

- agent id, when available
- skill name
- version
- source path or URI
- content hash
- selection reason
- loaded resources
- tools or MCP capabilities made relevant by the Skill

Suggested event names:

```txt
skill.indexed
skill.loaded
mcp.server.prepared
agent.profile.derived
```

For v0.1, these are experimental edge lifecycle events. Payloads should stay
compact, with reproducibility facts in event metadata. Resource and script
events remain future candidates.

## Capability Chain

In a multi-agent run with MCP-backed tools, trace should be able to explain the causal chain:

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

This keeps Skills from becoming invisible prompt magic and keeps MCP from bypassing the harness safety model.

## Package Boundaries

Near-term:

```txt
packages/core
  run / events / tools / context / policy / approval / trace

packages/skills
  SKILL.md parser
  skill index
  deterministic skill selector
  skill-to-context helper
  agent-scoped skill filtering
  optional skill.load tool for progressive loading
```

Future packages can split out when the surface grows:

```txt
packages/skills
  resource loading

packages/mcp-adapter
  MCP client
  MCP tool discovery
  MCP tool -> ToolDefinition
  conservative default policy for MCP tools

packages/agent-runtime
  agent profiles
  child profile policy derivation
  parent deny and approval inheritance
  agent profile policy adapter
```

Future packages can grow these surfaces when use cases require them:

```txt
packages/mcp-adapter
  OAuth and token storage
  MCP resources and prompts as context sources
  tool list change watching

packages/agent-runtime
  child run execution helpers
  multi-agent sessions
  per-agent context strategies
```

## First Implementation Slice

The first slice should avoid changing the run API.

Instead of adding this immediately:

```ts
createRun({
  goal,
  skills,
});
```

provide an external helper that converts Skills into existing run inputs:

```ts
const prepared = await prepareSkillsForRun({
  goal,
  skillRoots: ["./skills"],
});

const run = createRun({
  goal,
  context: prepared.context,
  tools: [...normalTools, ...prepared.tools],
  metadata: {
    loadedSkills: prepared.loadedSkills,
  },
});
```

The first helper should support:

- done: parsing `SKILL.md` frontmatter
- done: validating `name` and `description`
- done: creating skill index context
- done: selecting skills with a simple deterministic matcher
- done: loading selected skill bodies
- done: returning prepared context
- done: returning loaded skill metadata
- done: filtering available skills with agent-scoped allow and deny lists
- done: optionally returning a `skill.load` tool for on-demand skill body loading
- done: listing sampled skill resource files without executing bundled scripts

It should not implement marketplace, hot reload, auto-update, self-evolving skills, or full multi-agent orchestration.

## Non-Goals For The First Slice

- No marketplace or registry
- No lockfile
- No skill auto-update
- No self-modifying Skill loop
- No direct MCP dependency in core
- No global Skill injection into every agent
- No bypass around existing tool policy and approval

## MCP Adapter Slice

The first MCP adapter slice follows the same edge-helper pattern as Skills:

```ts
const prepared = await prepareMcpToolsForRun({
  servers: [
    {
      type: "stdio",
      name: "example",
      command: "example-mcp-server",
    },
  ],
});

const run = createRun({
  goal,
  tools: [...normalTools, ...prepared.tools],
});
```

Implemented:

- done: `stdio` and Streamable HTTP server config shapes
- done: disabled, connected, and failed status results
- done: MCP tool discovery through `tools/list`
- done: MCP tool conversion into Sparkwright `ToolDefinition`
- done: sanitized, server-prefixed tool names with collision handling
- done: conservative default `risk: "risky"` and `requiresApproval: true`
- done: source tool name mapping for audit/debug
- done: close handle for adapter-owned MCP clients

Deferred:

- OAuth and stored tokens
- MCP prompts and resources as context sources
- hot tool-list updates
- dynamic connect/disconnect management
- server-scoped and tool-scoped policy overrides beyond the first package-level default

## Agent Runtime Slice

The first agent runtime slice is not a multi-agent orchestrator. It is a policy
and profile derivation helper that makes child-run safety explicit:

```ts
const derived = deriveChildAgentProfile({
  parentAgent,
  parentRunPolicy,
  childAgent,
});

const policy = createAgentProfilePolicy(derived.effectiveProfile, basePolicy);
const runOptions = compileAgentProfileRunOptions(derived.effectiveProfile, {
  fallbackPolicy: basePolicy,
});
```

Implemented:

- done: `AgentProfile` and `CapabilityRule` types
- done: child profile derivation
- done: parent run deny and approval inheritance
- done: parent agent deny and approval inheritance
- done: tool allow-list intersection and deny-list union
- done: budget and max-step tightening
- done: conversion from agent profile into Sparkwright `Policy`
- done: profile-to-`createRun` option fragment compilation for future subagent tools

Deferred:

- child run execution and result collection
- background agents
- dynamic routing
- planner-driven multi-agent sessions
- agent-specific context assemblers

## Design Test

Any future Skill, MCP, or multi-agent feature should pass this test:

1. Can the run loop remain unaware of the capability origin?
2. Can policy and approval still block risky actions?
3. Can trace explain which agent used which skill and tool?
4. Can a failed run be reproduced from skill version, source, and content hash?
5. Can context budget be preserved through progressive loading?

If the answer is no, the feature belongs at the edge or needs a clearer adapter boundary.
