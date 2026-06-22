# Architecture

This is a reference overview. If you are new to SparkWright, start with
[the documentation map](../README.md) or the [User Manual](../guides/USER_MANUAL.md).

SparkWright is organized around a small runtime kernel and a set of replaceable edge modules.

```txt
User or System Goal
        |
        v
      Run
        |
        v
  Agent Kernel ----> Event Stream ----> Trace Store
        |
        +----> Model Adapter
        |
        +----> Tool Runtime ----> Policy ----> Approval
        |
        +----> Context Runtime
        |
        +----> Workspace Runtime ----> Artifact
```

## Architectural Posture

SparkWright should be implementation-driven but protocol-aware.

That means the first implementation can be TypeScript, but the core objects must be serializable and documented well enough to support future SDKs, server adapters, and alternate runtime implementations.

## Package Boundaries

The current runtime boundary is:

- `@sparkwright/core`: runtime primitives only — run loop, policy, approval,
  events, trace/session stores, workspace abstractions, and tool contracts.
- `@sparkwright/host`: the runtime assembler — config, providers, skills,
  MCP, agents, shell, workflow hooks, session ownership, and the host protocol.
- `@sparkwright/cli` and `@sparkwright/tui`: host clients. They should drive
  normal runs through `@sparkwright/sdk-node` and the host protocol, not by
  constructing the core runtime directly.
- `@sparkwright/protocol`: shared wire types and protocol-owned enums such as
  permission modes and trace levels.

`--direct-core` is retained only as an internal diagnostics/regression harness.
It bypasses the host and is gated behind `SPARKWRIGHT_ENABLE_DIRECT_CORE=1`.
New product behavior should be added to the host path first; the direct-core
runner should not become a second production runtime.

Architecture checks enforce the most important parts of this boundary: TUI
source cannot import `@sparkwright/core`, and `@sparkwright/core/internal`
imports are allowlisted for the few packages that own reference storage/runtime
plumbing.

## Runtime Kernel

The kernel owns the run lifecycle:

- create a run
- accept a goal and initial context
- call the model adapter
- interpret model tool requests
- dispatch tools
- handle approval pauses
- record events
- collect artifacts
- resolve to completed, failed, cancelled, or waiting states

The kernel should not own provider-specific model logic, UI prompts, workspace implementation details, or tool-specific behavior.

## State Model

For the cross-cutting state map, identity boundaries, store responsibilities,
and trace ownership rules, see [State And Trace Model](./STATE_AND_TRACE_MODEL.md).

Initial v0 run states:

- `created`
- `running`
- `waiting_approval`
- `completed`
- `failed`
- `cancelled`

The state machine should be deliberately small. More states can be added only when traces and examples show real ambiguity.

The state machine is still a core requirement. The loop should not rely on incidental control flow or thrown errors to explain what happened. State transitions should be guarded and paired with explicit stop reasons.

Expected transition shape:

```txt
created
  -> running

running
  -> waiting_approval
  -> completed
  -> failed
  -> cancelled

waiting_approval
  -> running
  -> failed
  -> cancelled
```

Terminal states should not transition again:

- `completed`
- `failed`
- `cancelled`

Stop reasons should be more precise than the terminal state. A failed run might fail because of invalid model output, max steps, approval denial, timeout, policy denial, provider failure, workspace failure, or tool failure. A completed run might complete with a final model answer or with no model configured. A cancelled run should be distinguishable from a timeout or denial. The current runtime supports explicit manual cancellation through a terminal result and `run.cancelled` event; in-flight provider/tool abort cleanup remains later hardening work.

The loop can eventually use an internal result signal:

```ts
type LoopResult = "continue" | "completed" | "failed" | "cancelled" | "compact";
```

This does not require a large session processor. It gives the small loop explicit control points for retries, compaction, cancellation, approval, and trace output.

Streaming should be added through a separate contract rather than hidden inside the synchronous loop. See [Streaming Loop Requirements](./STREAMING_LOOP_REQUIREMENTS.md).

## Event Stream

Events are the most important architectural surface. Every meaningful action should produce an event.

Initial event types:

- `run.created`
- `run.started`
- `run.completed`
- `run.failed`
- `model.requested`
- `model.completed`
- `tool.requested`
- `tool.started`
- `tool.completed`
- `tool.failed`
- `task.started`
- `task.output`
- `task.completed`
- `task.failed`
- `task.cancelled`
- `approval.requested`
- `approval.resolved`
- `artifact.created`
- `extension.process.started`
- `extension.process.completed`
- `extension.process.failed`
- `workspace.read`
- `workspace.write.requested`
- `workspace.write.completed`

Events should be append-only, timestamped, serializable, and safe to persist.

## Session And Replay

Sessions group ordered run ids plus lightweight metadata. The core session
surface stays intentionally small: a `SessionRecord`, an append-only session
event stream, and a store protocol that embedders can back with files, sqlite,
or a service.

The default file-backed implementation is `FileSessionStore`, which persists
`session.json` plus append-only `events.jsonl` under `.sparkwright/sessions/<id>/`.

Session replay is a projection over persisted run traces. A replay-capable
store can load each run's `RunStore` events in session order and expose them as
session-local events with their own sequence numbers. This keeps resume/replay
plumbing extensible without moving model, tool, workspace, or approval behavior
out of the run kernel.

## Tool Runtime

The v0 tool runtime should own:

- tool registration
- tool schema validation
- argument validation
- execution timeouts
- result normalization
- structured errors
- permission metadata
- event emission for tool lifecycle

Tools should be ordinary code. The runtime should make them observable and controllable.

Current implementation note: the repository has a tool registry, dependency-light argument validation, timeout enforcement, lifecycle events, and structured tool results. Policy and approval are enforced by the run loop around risky workspace mutations rather than by provider or CLI edges.

## Policy And Approval

Policy decides whether an action is:

- allowed immediately
- denied
- allowed only after approval

Approval should not be limited to terminal prompts. The same primitive should support CLI, web UI, server callbacks, CI comments, and enterprise approval systems.

Policy composition should stay explicit at the harness boundary. `createLayeredPolicy`
applies deny-before-approval-before-allow semantics across independent policy
layers, while `createPermissionModePolicy` lets product shells expose modes such
as `plan`, `accept_edits`, `dont_ask`, and `bypass_permissions` without moving
permission logic into the model or tool implementations.

## Context Runtime

The context runtime manages what a run can see.

v0 context should focus on:

- typed context items
- source references
- bounded context assembly
- snapshots for trace

Complex retrieval, embeddings, and long-term memory are intentionally out of v0 scope.

## Workspace Runtime

The workspace runtime is the first major domain module.

It owns:

- reading files
- proposing writes
- applying writes
- producing diffs
- respecting workspace boundaries
- detecting changed files
- creating artifacts from modifications

Workspace operations are where SparkWright proves it is more than a toy agent loop.

## Model Adapters

Model providers should live at the edge.

The kernel should talk to a minimal adapter interface:

```ts
interface ModelAdapter {
  complete(input: ModelInput): Promise<ModelOutput>;
}
```

Provider-specific concerns (OpenAI-compatible APIs, alternative cloud APIs, local models, routing services) should not leak into the core run model.

## Package Strategy

v0 should keep distribution simple:

- `@sparkwright/core`
- `@sparkwright/cli`

Internal directories can mirror future packages, but public package count should stay low until API pressure justifies a split.
