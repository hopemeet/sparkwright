# Trace Extension Events

This document defines trace metadata and event shapes for extension packages.
Some names are promoted into the core event schema (`extension.process.*`,
`skill.*`, `mcp.server.prepared`, `agent.profile.derived`); newer shapes may
start as documentation contracts before they stabilize.

The goal is reproducibility: a trace consumer should be able to explain which
extension influenced model context, tool availability, policy, or external side
effects.

## Naming

Experimental extension event names use the same dotted style as core events:

```txt
skill.indexed
skill.failed
skill.loaded
mcp.server.prepared
agent.profile.derived
```

Core may later promote stable events into `event.schema.json`. Until then,
these shapes are documentation contracts for extension packages and product
shells.

## extension.process.\*

Emitted by host-controlled process runners for external commands, workflow hook
commands, skill scripts, user hooks, external agents, and custom process
invocations.

Events:

- `extension.process.started`
- `extension.process.progress`
- `extension.process.completed`
- `extension.process.failed`

Payload base:

```json
{
  "invocationId": "proc_...",
  "name": "pre-check",
  "kind": "workflow_hook",
  "runtime": "custom",
  "commandPreview": "node",
  "argsPreview": ["script.js"],
  "cwd": "/workspace"
}
```

Terminal events add:

```json
{
  "exitCode": 0,
  "signal": null,
  "timedOut": false,
  "durationMs": 120,
  "output": {
    "stdoutPreview": "ok\n",
    "stderrPreview": "",
    "stdoutBytes": 3,
    "stderrBytes": 0,
    "stdoutTruncated": false,
    "stderrTruncated": false,
    "artifactIds": ["artifact_..."]
  },
  "progressCount": 2,
  "progressDropped": 0
}
```

External scripts do not write SparkWright events directly. A host runner may
inject:

```txt
SPARKWRIGHT_TRACE_PROTOCOL=extension-jsonl-v1
SPARKWRIGHT_TRACE_INVOCATION_ID=<invocationId>
SPARKWRIGHT_TRACE_EVENTS=<private temp dir>/events.jsonl
```

Scripts may append JSONL progress records only:

```json
{ "type": "progress", "message": "indexed files", "data": { "files": 42 } }
```

The host ignores script-supplied event ids, sequence numbers, timestamps,
span ids, and arbitrary event types. Progress timestamps and `monotonicUs`
are host ingest-time values. `standard` traces suppress raw
`extension.process.progress` rows and aggregate `progressHead` /
`progressTail` onto the terminal event; `debug` traces keep raw progress rows.

Foreground shell commands promoted to background tasks are different: the host
adopts an already running process, so the user-visible lifecycle remains
`task.started` / `task.output` / terminal `task.*`. The shared runner still
collects bounded output summaries and artifacts, but it does not emit
`extension.process.*` for that adopted task process.

Skill inline shell preprocessing, when enabled, uses the same process contract
with `name: "skill-inline-shell"` and `kind: "skill_script"`. These commands
run during host skill loading, before the run event log may exist; hosts buffer
their `extension.process.*` events and flush them once the run starts. The
script still reports only progress JSONL through the host-owned inbox.
`skill_script` command arguments are redacted in process lifecycle previews to a
stable hash/byte summary, and `cwd` is rendered relative to the workspace when
possible. Failed inline shell output is not inserted into the model-facing Skill
body; the body receives a short marker, while trace terminal events retain
bounded stdout/stderr previews for diagnostics.

## skill.indexed

Emitted after a Skill source has been scanned and reduced to index metadata.

```json
{
  "count": 2,
  "skills": [
    {
      "name": "code-reviewer",
      "version": "1.0.0",
      "sourcePath": ".sparkwright/skills/code-reviewer/SKILL.md",
      "contentHash": "..."
    }
  ]
}
```

## skill.failed

Emitted when one Skill source cannot be loaded. Other valid Skills may still be
indexed and used.

```json
{
  "toolCallId": "call_01h",
  "source": ".sparkwright/skills/bad/SKILL.md",
  "message": "Skill description must be a non-empty string: ...",
  "phase": "load"
}
```

On-demand loader failures include `toolCallId` when this event is the
Skill-specific companion to a `tool.failed` result.

## skill.loaded

Emitted when a selected Skill body is loaded into context or through a governed
loader tool.

```json
{
  "name": "code-reviewer",
  "version": "1.0.0",
  "sourcePath": ".sparkwright/skills/code-reviewer/SKILL.md",
  "contentHash": "...",
  "selectionReason": "Matched goal against skill name or description.",
  "agentId": "reviewer",
  "mode": "resident_context"
}
```

`mode` may be:

- `resident_context`
- `on_demand_tool`

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
