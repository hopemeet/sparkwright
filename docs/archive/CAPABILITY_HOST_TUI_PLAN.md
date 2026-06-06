# Capability Host/TUI Plan

This document records the product-level plan for making Skills, MCP, and
multi-agent capabilities usable from the Sparkwright host and TUI without
moving runtime authority into the frontend.

## Positioning

The host is the source of truth for capability assembly. The TUI is an
observation and light-control surface.

The preferred boundary is:

```txt
host owns capability assembly
core owns run lifecycle, policy, approval, and trace
TUI owns inspection, navigation, and user-facing controls
```

Do not make the TUI load Skills, interpret agent profiles, discover MCP
servers, or maintain a second copy of runtime state. Those decisions must be
made before `createRun()` and recorded in events and run metadata so a trace can
explain and reproduce what happened.

## Current Gap

The repository already has the primitives:

- `@sparkwright/skills` can prepare Skill context and optional tools.
- `@sparkwright/mcp-adapter` can normalize MCP tools into Sparkwright tools.
- `@sparkwright/agent-runtime` can derive profiles and mount child-agent tools.
- `schemas/capability-runtime-config.schema.json` describes a composed
  capability runtime.
- `docs/reference/PROTOCOL.md` already reserves extension events such as `skill.loaded`
  and `subagent.started`.

The product host/TUI path does not yet compose these primitives. The TUI starts
a host run through `run.start`, and the host currently creates a main-agent run
with built-in workspace/shell/cron tools only. Skills, MCP, and child agents are
available as packages and examples, not as first-class host/TUI capabilities.

## Non-Goals

- Do not create a second gateway layer beside `@sparkwright/protocol`,
  `@sparkwright/sdk-node`, and `@sparkwright/host`.
- Do not make the TUI a runtime planner or capability loader.
- Do not replace the append-only transcript with a complex repainting viewport.
- Do not add large management overlays before the host can report real
  capability state.
- Do not let child-agent allow rules override parent denies.

## Risks And Conflicts

### TUI State Duplication

The TUI already has `RunController`, `EventStore`, `QueueStore`, and
`LayerStack`. Adding a large turn-state owner would create competing state
centers. Keep lifecycle ownership in the existing controller/store split. If
listener code grows, extract a pure host-event dispatcher rather than adding a
second controller.

### Trace Reproducibility

If the TUI directly scans Skill directories or toggles agent profiles outside
host config, the trace may no longer explain why a capability was present.
Capability selection must flow through host config, run metadata, and emitted
events.

### Multi-Agent Projection

`EventStore.activeTool` is a single string and is not enough for concurrent
sub-agents. Multi-agent support needs a projection keyed by run or agent id,
not more single-value fields.

### Main-Agent Session History

Current host conversation history is main-agent oriented. Child-agent work
should not automatically become the next parent turn's conversation context.
The parent should receive bounded child summaries through the agent tool result;
that summary, not the child's private transcript, becomes parent-visible
context.

### Transcript Noise

The main transcript should show only high-signal capability events. Noisy facts
such as full Skill index inventories belong in inspect panels and trace, not in
the default conversation stream.

## Architecture Plan

### 1. Productize Capability Runtime Config

Unify the example capability-runtime config with the shared host config. A
stable shape should live under a single top-level capability field, for example:

```json
{
  "capabilities": {
    "skills": {
      "roots": ["./skills"],
      "includeLoaderTool": true,
      "loadSelectedSkills": true,
      "maxSelectedSkills": 3
    },
    "mcp": {
      "servers": []
    },
    "agents": {
      "profiles": []
    }
  }
}
```

The exact schema can evolve, but the ownership rule should not: config tells
the host what may be prepared; the host decides what is actually attached to a
run and records the result.

### 2. Assemble Capabilities In HostRuntime

Before `createRun()`, the host should:

- create a buffered extension emitter;
- prepare Skills with `prepareSkillsForRun()`;
- prepare MCP tools with `prepareMcpToolsForRun()`;
- derive the main agent profile and policy;
- mount configured child-agent tools when profiles are enabled;
- merge built-in, Skill, MCP, and agent tools;
- pass selected Skill context into `createRun({ context })`;
- write indexed/loaded capabilities into run metadata;
- flush buffered extension events onto `run.events` after the run exists;
- close external capability resources during run/runtime cleanup.

The host remains responsible for approval, policy, run store selection, and
trace level. Capability packages should only produce `ContextItem[]`,
`ToolDefinition[]`, policy inputs, and events.

### 3. Add Capability Snapshot RPC

`host.ready.capabilities` is useful for protocol feature flags but too coarse
for UI inspection. Add a request such as:

```txt
capability.inspect
```

It should return the current host/session capability snapshot:

```ts
{
  tools: Array<{ name: string; origin?: string; risk?: string }>;
  skills: {
    indexed: Array<{ name: string; sourcePath?: string; contentHash?: string }>;
    loaded: Array<{
      name: string;
      sourcePath?: string;
      selectionReason?: string;
    }>;
  }
  mcp: {
    statuses: Array<{
      serverName: string;
      status: string;
      toolNames: string[];
    }>;
  }
  agents: {
    profiles: Array<{ id: string; name?: string; mode?: string }>;
  }
}
```

The snapshot should be host-authored. The TUI should not reconstruct it by
reading config and local files.

### 4. Add TUI Capability Projections

Keep the append-only transcript. Add a derived projection for capability state:

```ts
interface CapabilityProjection {
  toolsByAgent: Map<string, ActiveToolState[]>;
  subagentsById: Map<string, SubagentState>;
  indexedSkills: SkillSummary[];
  loadedSkills: LoadedSkillSummary[];
  mcpServers: McpServerSummary[];
}
```

This projection can be maintained from `run.event` plus optional
`capability.inspect` snapshots. It should feed inspect panels and the sidebar,
not replace the canonical event list.

### 5. Add Read-Only TUI Surfaces First

Start with read-only commands:

- `/capabilities` shows tools, Skills, MCP servers, and agent profiles.
- `/skills` filters the capability view to indexed and loaded Skills.
- `/agents` shows main agent, child profiles, and sub-agent lifecycle events.

Avoid write/control actions until the host has stable config, policy, and trace
coverage for those actions.

### 6. Render High-Signal Events

Teach the transcript and event detail views about:

- `skill.loaded`
- `mcp.server.prepared`
- `agent.profile.derived`
- `subagent.requested`
- `subagent.started`
- `subagent.completed`
- `subagent.failed`

Default transcript rendering should stay compact. Full payloads remain in event
detail and trace exports.

## Implementation Order

1. Extend shared config/schema with capability runtime settings.
2. Load and validate capability settings in the host config path.
3. Assemble Skills and MCP in `HostRuntime.startRunInner()`.
4. Add agent profile derivation and optional child-agent tool mounting.
5. Record capability metadata and flush buffered extension events.
6. Add `capability.inspect` to protocol, schemas, host server, and SDK client.
7. Add TUI capability projection and read-only `/capabilities`.
8. Add focused `/skills` and `/agents` panels.
9. Add event rendering and tests for extension lifecycle events.
10. Add integration tests for host runs with Skills, MCP, and child agents.

## Test Requirements

- Config validation accepts the capability shape and rejects unknown fields.
- Host runs with no capability config preserve today's behavior.
- Skill-enabled host runs emit `skill.indexed` / `skill.loaded` and include
  selected Skill context.
- MCP-enabled host runs normalize tools and apply configured policy.
- Child-agent tools emit sub-agent lifecycle events and preserve parent policy
  restrictions.
- TUI event projection handles concurrent sub-agents without relying on a
  single global active tool.
- Read-only capability panels render from host facts, not filesystem scans.

## Design Rule Of Thumb

If a capability affects what the model can know or do, it belongs in host/runtime
assembly and trace. If a capability helps the user understand, inspect, or
navigate what happened, it belongs in the TUI.
