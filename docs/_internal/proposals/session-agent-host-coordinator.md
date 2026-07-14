# Host Execution Lane Coordinator

Status: Draft for review (v4)
Date: 2026-07-14

> Internal architecture proposal. This document does not change runtime
> behavior by itself.
>
> v4 re-baselines the former Session Agent Host Coordinator after the Workflow
> actor, durable Workflow service/channel, Agent invocation supervision,
> descendant-tree budget, run-security-plan, and workspace Agent arbitration
> refactors. The product goal remains multi-session main-agent concurrency and
> host-owned IM control. The implementation model changes from a
> `SessionTurnScheduler` wrapped around `HostRuntime` to a process-scoped
> `ExecutionLaneCoordinator` behind a decomposed Host service.

## Decision Summary

The v3 proposal must not be implemented as written.

Keep:

- Gateway is a protocol/delivery adapter; Host owns authorization and execution
  control.
- Core owns one run loop and its command queue.
- Ordinary interactive work for one session is serial by default; different
  sessions may run concurrently.
- Idempotency, bounded queues, authenticated principals, control bindings,
  approval authorization, and replayable delivery are required.
- `@sparkwright/server-runtime` remains the transport-neutral process
  coordination package.

Change:

- `sessionId` is not the universal actor or execution identity. It remains a
  conversation/history/storage identity. Interactive sessions map to an
  execution lane, while Workflow, Task, and Agent invocation identities stay
  separate.
- The coordinator schedules opaque executions, not run trees. Workflow episode
  advancement, Task revival, and Agent invocation lifecycles keep their current
  owners.
- Existing `RunManager` remains a thin core-run convenience API. The new
  coordinator uses an independent `ExecutionDriver` port.
- Scheduler capacity and workspace mutation exclusion are separate. The
  scheduler must not hold a workspace write lock for an entire model turn or
  execution.
- `HostRuntime` compatibility means protocol compatibility over the same
  process Host service, not a second direct execution path that bypasses the
  coordinator.
- Host decomposition precedes scheduler implementation.

## Read Before Reviewing

- [project map: host](../project-map/modules/host.md)
- [project map: agent runtime](../project-map/modules/agent-runtime.md)
- [project map: edge packages](../project-map/modules/edge-packages.md)
- [run loop](../project-map/maps/runtime/run-loop.md)
- [session store](../project-map/maps/session/session-store.md)
- [resume and replay](../project-map/maps/session/resume-replay.md)
- [Agent supervision](../project-map/designs/multi-agent-supervision.md)
- [internal actor inbox](../project-map/designs/internal-actor-inbox.md)
- [substrate sequencing](substrate-sequencing.md)
- [`packages/host/src/runtime.ts`](../../../packages/host/src/runtime.ts)
- [`packages/host/src/server.ts`](../../../packages/host/src/server.ts)
- [`packages/server-runtime/src/index.ts`](../../../packages/server-runtime/src/index.ts)
- [`packages/server-runtime/src/workflow-service.ts`](../../../packages/server-runtime/src/workflow-service.ts)
- [`packages/server-runtime/src/workflow-supervisor.ts`](../../../packages/server-runtime/src/workflow-supervisor.ts)
- [`packages/agent-runtime/src/workflows/run-chain.ts`](../../../packages/agent-runtime/src/workflows/run-chain.ts)
- [`packages/agent-runtime/src/agents/supervisor.ts`](../../../packages/agent-runtime/src/agents/supervisor.ts)
- [`packages/host/src/workspace-agent-arbiter.ts`](../../../packages/host/src/workspace-agent-arbiter.ts)
- [`packages/im-gateway/src/gateway.ts`](../../../packages/im-gateway/src/gateway.ts)
- [`packages/agent-runtime/src/workflows/channels.ts`](../../../packages/agent-runtime/src/workflows/channels.ts)

## Current Source Facts

- `serveConnection()` creates one `HostRuntime` per connection. Disconnect
  cleanup denies that runtime's approvals and cancels its active run.
- `HostRuntime` is still the dominant composition object. It owns connection
  event emission, active-run state, cancellation, approvals, Task stores and
  runners, Workflow stores/inboxes/outboxes, capability inspection, session
  inspection, run preparation, Workflow projection, and episode driving.
- `prepareHostRunEnvironment()` builds a large mutable environment containing
  model, policy, workspace, skills, MCP, tools, Agent profiles/delegates,
  Workflow state/hooks, stores, metadata, event emitters, and close hooks.
- Main todo continuation already uses the Workflow-owned generic run-chain
  driver. Host creates transient core runs; Workflow/todo logic decides whether
  another episode is needed.
- Agent invocation identity and lifecycle are now owned by
  `PreparedAgentInvocation` and `AgentSupervisor`. Host owns Agent admission,
  workspace leases, tools/models/policy, and adapter construction.
- `WorkspaceAgentArbiter` is already a process-local fair read/write lease
  coordinator keyed by canonical workspace realpath. It protects Agent
  executions only; it does not serialize ordinary parent-run tool writes or
  coordinate across processes.
- Workflow jobs use a unique job `sessionId`; `controlSessionId` is attribution
  only. Multiple jobs controlled from one user session must not become one
  serialized interactive lane accidentally.
- `server-runtime` is no longer unused. CLI uses its Workflow service/carrier
  and supervisor; IM gateway uses its Workflow channel coordinator; Host uses
  its in-flight command dispatcher. Its older `RunManager`, `SessionManager`,
  `ApprovalBroker`, and `ConnectionHub` convenience stack is still not the
  canonical Host execution path.
- `DurableCommandDispatcher` only coalesces concurrent in-flight calls in
  memory. Durable Workflow command truth lives in command/outcome files; the
  class name must not be interpreted as durable persistence.
- IM gateway still owns ordinary session routing, active-session maps, queued
  messages, run targets, approval-to-run routing, and message dedupe. Workflow
  channel bindings and delivery receipts already provide a stronger host-side
  precedent.
- Core already exposes `enqueueCommand()` and `injectUserMessage()`, and consumes
  commands at a run-loop boundary. It still does not expose a public read-only
  command-acceptance predicate.
- File session/run storage remains best-effort for concurrent processes.
  Workflow stores have stronger lease/journal behavior, but that does not make
  all session and trace stores multi-process safe.

## Product Model

An ordinary interactive session is a long-lived main-agent control surface:

```txt
conversation session
  -> interactive execution lane
      -> queued user work
      -> at most one active execution
          -> one or more core runs/episodes
          -> child Agent invocations
          -> awaited/background Tasks
```

This mapping is a product default, not a universal identity equation:

```txt
sessionId       = conversation/history/store identity
laneId          = serial scheduling identity
executionId     = one accepted unit of interactive work
runId           = one core run
workflowRunId   = one durable Workflow actor
taskId          = one Task actor
childRunId      = one Agent invocation execution identity
connectionId    = one transport client
principalId     = one authenticated caller identity
```

For ordinary interactive work:

```txt
laneId = interactive-session:<workspaceId>:<sessionId>
```

Workflow jobs keep their current independent job sessions and
`workflowRunId`. Their `controlSessionId` does not become a lane key. Task
revival and Agent invocation are nested execution mechanisms, not sibling
session queues.

## Goals

- Run many interactive session agents concurrently in one Host process.
- Keep one interactive session deterministic through a bounded serial lane.
- Move ordinary IM session queueing, active execution routing, approval routing,
  and canonical session bindings into the Host control plane.
- Preserve Core, Workflow, Task, and Agent supervisor ownership.
- Reduce Host complexity while introducing coordination; each migration phase
  must retire a parallel state holder or execution path.
- Establish ports that can later gain durable command stores, worker leases,
  fencing, and database-backed coordination.

## Non-Goals

- Do not turn `sessionId` into a universal actor id.
- Do not route Workflow advancement, Task revival, or child Agent lifecycle
  through the interactive lane scheduler.
- Do not add a generic actor bus or arbitrary actor-to-actor messages.
- Do not merge Core and Workflow run loops.
- Do not pool live MCP clients or other mutable resources before they have
  explicit multiplexing, lease, event-routing, and shutdown contracts.
- Do not claim high availability from an in-memory coordinator or file locks.
- Do not preserve a long-lived coordinator-bypass execution path for
  compatibility.

## Frozen Ownership Matrix

| Boundary                                                                         | Owner                                                       | Coordinator rule                                                                                                  |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Conversation history and session run membership                                  | Core session store, composed by Host                        | Lane references `sessionId`; it does not redefine session persistence.                                            |
| Interactive lane queue, idempotency, fairness, capacity, atomic terminal handoff | `server-runtime` `ExecutionLaneCoordinator`                 | One active execution per interactive lane by default.                                                             |
| Authentication, principal derivation, session binding policy                     | Host control plane                                          | Do not trust caller-authored `verified` source fields.                                                            |
| Host execution assembly                                                          | Host `ExecutionDriver` implementation                       | Builds models, tools, policy, workspace, hooks, stores, and adapters.                                             |
| In-run command consumption and terminal run facts                                | Core                                                        | Reuse the existing command queue; do not create a second run-internal queue.                                      |
| Todo/Workflow episode continuation                                               | Agent-runtime Workflow/todo driver                          | Coordinator waits for the execution driver's terminal signal; it does not inspect individual run terminal events. |
| Durable Workflow adoption, waiting, control, recovery                            | Workflow store/supervisor/service                           | `controlSessionId` is attribution only and never an interactive lane lock.                                        |
| Task terminal/revival readiness                                                  | `TaskManager`, Task outbox, Core notification/revival ports | Background Tasks may outlive an interactive execution; awaited Task behavior remains run-owned.                   |
| Child Agent invocation identity/lifecycle                                        | `AgentSupervisor`                                           | Child runs are not enumerated or supervised by the lane coordinator.                                              |
| Workspace mutation admission                                                     | Host `WorkspaceLeaseCoordinator`                            | Independent from lane scheduling; acquire at concrete mutation/invocation/process boundaries.                     |
| Run interaction approval/question broker                                         | Process Host interaction service                            | Approval is execution-scoped and authorized against principal/binding policy.                                     |
| External channel binding and delivery receipts                                   | Host/server-runtime control-channel service                 | Gateway stores transport delivery facts only.                                                                     |
| Protocol event projection                                                        | Host protocol adapter                                       | Core/Workflow/Task facts remain canonical; protocol events are projections.                                       |

## Target Shape

```txt
CLI / TUI / SDK / Web / IM
  -> ConnectionAdapter
      -> authenticated PrincipalContext
      -> protocol request/response projection
  -> HostControlPlane                         per process
      -> typed command acceptance
      -> control bindings / permissions
      -> interaction routing
      -> subscriptions / delivery projection
  -> ExecutionLaneCoordinator                server-runtime
      -> bounded per-lane FIFO
      -> in-flight idempotency
      -> fairness / global capacity
      -> active execution registry
      -> atomic terminal handoff
  -> HostExecutionDriver                     host
      -> HostExecutionAssembler
      -> todo/Workflow episode driver
      -> ordinary Core RunHandle(s)
          -> AgentSupervisor for child invocations
          -> TaskManager for Tasks

WorkspaceContextRegistry                     per process
  -> immutable workspace snapshots/caches
  -> workspace Task/Workflow stores and services
  -> WorkspaceLeaseCoordinator
```

`server-runtime` must not import Host. Host implements the driver port and
injects it into the coordinator.

## Core Coordination Types

Names are draft but ownership is not.

```ts
interface PrincipalContext {
  principalId: string;
  kind: "host_client" | "gateway" | "system";
  authenticatedBy: string;
  gatewayId?: string;
  claims?: Record<string, unknown>;
}

interface InteractiveSessionLaneRef {
  laneId: string;
  workspaceId: string;
  sessionId: string;
}

interface CommandSource {
  sourceId: string;
  transport: "local" | "websocket" | "gateway" | "internal";
  connectionId?: string;
  gatewayId?: string;
  bindingId?: string;
  channelId?: string;
  threadId?: string;
  platformUserId?: string;
}

type ExecutionRetention = "connection" | "session" | "durable";

type InteractiveLaneCommand =
  | { kind: "start"; input: unknown }
  | { kind: "resume"; input: unknown }
  | { kind: "message"; content: string; parts?: unknown[] };

interface ExecutionCommandEnvelope {
  commandId: string;
  idempotencyKey?: string;
  lane: InteractiveSessionLaneRef;
  principal: PrincipalContext;
  source: CommandSource;
  retention: ExecutionRetention;
  command: InteractiveLaneCommand;
  receivedAt: string;
  metadata?: Record<string, unknown>;
}
```

`PrincipalContext` is created by Host from connection authentication and
trusted gateway configuration. A gateway may provide bounded platform claims,
but it cannot mint `kind:"system"` or mark itself verified.

`CommandSource` is normalized by Host after validating the connection,
gateway claim namespace, and control binding. It is attribution and reply
routing, not authority; authorization always uses `PrincipalContext` plus the
binding policy. Message coalescing keys on `sourceId`, never on unvalidated
gateway payload fields.

### Execution Driver Port

```ts
interface StartExecutionContext {
  executionId: string;
  lane: InteractiveSessionLaneRef;
  principal: PrincipalContext;
  retention: ExecutionRetention;
  signal: AbortSignal;
  metadata?: Record<string, unknown>;
}

interface ExecutionDriver<TStartInput = unknown> {
  start(
    input: TStartInput,
    context: StartExecutionContext,
  ): Promise<ExecutionHandle>;
}

type ExecutionState =
  | "starting"
  | "active"
  | "waiting_approval"
  | "waiting_credentials"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

interface ExecutionSnapshot {
  executionId: string;
  laneId: string;
  sessionId: string;
  state: ExecutionState;
  currentRunId?: string;
  rootRunId?: string;
  terminal: boolean;
  updatedAt: string;
}

interface ExecutionHandle {
  snapshot(): ExecutionSnapshot;
  canAccept(command: InteractiveLaneCommand): boolean;
  dispatch(command: InteractiveLaneCommand): Promise<void> | void;
  cancel(input?: { reason?: string }): Promise<void> | void;
  subscribe(listener: (event: ExecutionEvent) => void): () => void;
  completion: Promise<ExecutionSnapshot>;
}
```

The coordinator treats the handle as opaque. It does not maintain
`childRunIds`, infer execution terminal state from a core run event, or know
whether the driver used one run, todo continuations, or another Host-owned
episode shape.

Existing `RunManager` remains unchanged and is not the factory port for Host
executions. A thin single-run driver may compose it for simple embedders, but
Host uses its own `HostExecutionDriver`.

### Async Start And Idempotency

Driver start is async. Under the lane mutex, coordinator must:

1. validate lane limits and access;
2. allocate `commandId` and `executionId`;
3. publish the in-flight idempotency record;
4. transition the lane to `starting`;
5. release the mutex before awaiting expensive Host assembly;
6. re-enter the mutex to attach the handle or record a start failure.

A duplicate arriving during `starting` returns the existing command/execution
result. It never starts another driver.

An idempotency key is scoped to lane plus normalized source. Reusing it with a
different command digest is a conflict, not a cache hit. P2 retains accepted
records through terminal completion plus a bounded replay window; P4 persists
the same contract in the command/outcome journal.

`DurableCommandDispatcher` should be renamed to reflect its current in-memory
behavior, for example `InFlightCommandCoalescer`, or hidden behind a broader
command-store abstraction. Persistence belongs to a command/outcome store, not
that class.

## Scheduling Semantics

### Ordinary Interactive Lane

- One active execution per lane.
- Different lanes may run concurrently up to `maxConcurrentExecutions`.
- A `message` is dispatched to the active handle only when
  `handle.canAccept(message)` is true and terminal handoff has not begun.
- Otherwise the message is queued for the next execution.
- A new `start`/`resume` while active is queued or rejected by explicit policy;
  it is never silently merged into the active execution.
- Execution completion and queue drain are serialized under the lane mutex.
- Core run completion is not lane completion. Only `handle.completion` is.
- Same-source adjacent queued messages may coalesce under bounded age/count/
  size limits while preserving the ordered original command/source parts.
  Cross-source messages do not coalesce by default.
- `cancel_execution` targets only the active execution; queued commands remain.
- `cancel_session` closes the lane by policy, cancels the active execution, and
  explicitly resolves every cleared queued command as cancelled to its source.
  Queue entries are never silently dropped.

### Fairness And Capacity

Initial process-local policy:

```ts
interface ExecutionLaneCoordinatorConfig {
  maxConcurrentExecutions: number;
  maxQueueDepthPerLane: number;
  maxQueuedLanes: number;
  activeMessagePolicy: "inject_or_queue" | "queue_only" | "reject";
  messageCoalescing: "same_source" | "off";
}
```

Use session-round-robin among runnable lane heads. Global capacity admission
is a bounded active-execution count in P2; an admitted execution keeps that
slot until terminal even while awaiting a model, approval, or workspace lease.
Model, process, and workspace adapters own separate resource limits, so they do
not consume mutation permits before admission and unrelated already-admitted
lanes can continue. Yielding/reacquiring execution capacity would require an
explicit driver parking protocol and is deferred rather than inferred from
internal run state. Weighted tenant fairness and quotas wait until tenant
identity is real.

### Disconnect And Retention

Disconnect behavior is explicit per accepted execution:

- `connection`: cancel when the owning connection disappears and no transfer
  policy applies. This preserves current CLI/TUI behavior where desired.
- `session`: execution remains Host-owned while session subscribers or bindings
  may reconnect.
- `durable`: execution is backed by durable actor/worker state; ordinary P1
  interactive executions do not claim this level.

Do not preserve the current global rule that every connection close always
cancels its work once session-owned control is introduced.

### Workflow, Task, And Agent Boundaries

- Workflow service/supervisor continues to claim and advance
  `workflowRunId`. It does not queue behind `controlSessionId`.
- A Workflow worker episode may use Host execution assembly, but Workflow owns
  waiting, resumption, adoption, and terminal status.
- Awaited Task revival stays inside Core's current notification/revival seam.
- Background Tasks may outlive the interactive execution and do not keep the
  lane active merely because their process remains alive.
- Child Agent invocation lifecycle stays under `AgentSupervisor`; its workspace
  lease and descendant budget are not lane scheduler state.

## Host Decomposition Before Coordination

Adding a scheduler around the current `HostRuntime` would retain its ownership
mix and introduce another state registry. The first implementation phase is an
equivalent-behavior decomposition.

### Process Scope: `HostService`

Created once by `runHostMain()` and injected into all connections:

- `WorkspaceContextRegistry`;
- interaction/approval registry;
- connection/subscription registry;
- principal and control-binding policy;
- process health and graceful drain.

From P2 onward `HostService` also composes exactly one
`ExecutionLaneCoordinator`. The coordinator owns its active-execution
registry; `HostService` must not mirror that state.

`serveConnection()` must stop constructing the canonical execution engine per
connection. A connection controller keeps handshake, request validation,
principal, subscriptions, and response projection only.

### Workspace Scope: `WorkspaceContext`

Keyed by canonical workspace root. It owns:

- workspace identity and config/capability snapshot cache;
- Task manager and Task stores/outbox;
- Workflow stores/control inbox/notification outbox adapters;
- workspace lease coordinator;
- immutable or safely shareable capability indexes;
- idle lifecycle and shutdown.

The workspace registry key may include a config/capability fingerprint for
immutable snapshots, but the mutation-lock scope is canonical workspace root
only.

### Execution Scope

Split the current prepared environment into explicit parts:

```txt
ExecutionPlan
  immutable resolved access/config/model/capability identity

ExecutionResources
  live model adapter, MCP preparation, event bindings, workspace instance,
  run stores, policy instances, close/dispose hooks

ExecutionDriverState
  abort controller, current/root run projection, episode completion,
  interaction ownership, event projection
```

Fresh stateful policies, `LocalWorkspace`, event emitters, run stores, and
run-bound references stay execution/run scoped.

### Conservative Resource Pooling

P1 may cache:

- loaded config and its fingerprint;
- parsed Agent/Workflow/Skill indexes where their APIs support invalidation;
- provider registry/model factory metadata;
- immutable security-plan inputs and capability descriptions.

P1 must not pool by default:

- `LocalWorkspace` instances;
- stateful policy instances;
- run/event emitters;
- approval resolvers;
- run stores;
- live MCP clients currently bound to run emitters and close hooks;
- mutable Workflow lease writers.

Live MCP pooling is a separate change requiring multiplexed event routing,
per-execution policy/sandbox context, ref-counted shutdown, config invalidation,
and failure isolation.

### Remove Mutable Latest-Run Slots

`HostRuntime.agentSpawnDeps` cannot survive multi-execution Host ownership. A
Task runner must resolve immutable, execution-specific context by
`executionId`/`parentRunId`, or capture a self-contained Task execution lease at
Task creation. It must never read "the latest run" dependencies.

Likewise:

- replace process-shared `runChainCancelled` booleans with execution-owned
  abort/cancellation state;
- move pending approval ownership into the process interaction registry;
- move `lastCapabilitySnapshot` into workspace/execution projections rather
  than one connection's last run.

## Workspace Concurrency

Lane serialization and filesystem mutation serialization are different
problems.

Generalize the current `WorkspaceAgentArbiter` into one Host-owned
`WorkspaceLeaseCoordinator` with a backend port:

```ts
interface WorkspaceLeaseCoordinator {
  acquire(input: {
    workspaceRoot: string;
    owner: WorkspaceLeaseOwner;
    mode: "read" | "write";
    signal?: AbortSignal;
  }): Promise<WorkspaceLease>;
}
```

Rules:

- key by canonical workspace realpath;
- process-local backend first; fenced distributed backend later;
- fair queue, abortable wait, TTL/heartbeat where holders may outlive a call,
  idempotent release, inspection;
- acquire around concrete write-capable tool calls, Agent invocations, hooks,
  scripts, and opaque processes according to their mutation window;
- do not hold a workspace write lease while waiting on model output or human
  approval;
- do not have the lane coordinator hold a write lease for the entire
  execution;
- nested owners must use explicit owner lineage/reentrancy or release before
  invoking a child that needs the same scope, preventing parent/child deadlock;
- authorization remains separate: an approved write can still wait for a
  concurrency lease.

The generalized coordinator must replace `WorkspaceAgentArbiter`; it must not
be added beside it as a second permanent workspace lock owner.

## Principal, Bindings, And Approvals

### Principal Derivation

- Local stdio connection receives a Host-created local principal.
- WebSocket bearer/mTLS/auth adapters create a connection principal.
- A trusted gateway principal may submit bounded platform claims such as
  platform/chat/thread/user identity.
- Host configuration defines which gateway may claim which namespace.
- Gateway input cannot claim `system`; internal cron/supervisor work receives a
  Host-minted system principal.

### Session Control Binding

The existing Workflow channel binding is the nearest implemented precedent.
Extract or reuse its underlying binding/revocation/delivery-receipt substrate
without turning it into a generic message bus.

A session binding contains:

- session/lane subject;
- principal and authenticated gateway/channel identity;
- allowed typed commands (`message`, `inspect`, `approve`, `cancel_execution`,
  `cancel_session`);
- creation, expiry, and revocation facts;
- delivery cursor/receipts.

IM self-binding is disabled by default. Binding creation requires an
authenticated Host client, admin command, or explicit allowlist policy.

### Approval Routing

- approval maps to `runId -> executionId -> laneId/sessionId`;
- first valid resolution wins;
- initiating principal may resolve only when policy grants it;
- another bound principal requires `approve` permission;
- unauthorized links do not receive actionable approval payloads;
- timeout policy may vary by control surface;
- Workflow durable human/approval waits keep their Workflow control-store
  semantics rather than being forced into a live run approval map.

Adopting the process interaction registry must delete the duplicate
`HostRuntime.pendingApprovals` ownership. Existing `ApprovalBroker` may be
evolved or replaced, but two canonical pending maps are not acceptable.

## Events And Delivery

Keep canonical facts distinct:

- Core event log: run/tool/policy/workspace facts.
- Execution lifecycle: lane acceptance, queued/starting/active/terminal,
  current-run projection, cancellation.
- Workflow/Task actor stores and outboxes: their own lifecycle and wake facts.
- Delivery receipts: external-channel delivery attempts and outcomes.
- Host protocol events: projections for clients.

Do not create a second canonical copy of core events in `ConnectionHub` or an
execution store. An in-memory hub may retain bounded replay for active
subscribers, but durable recovery must read canonical stores/journals.

IM delivery failure never fails the execution. P3 must provide bounded outbox
and reconnect replay using stable delivery keys. Retention overflow emits a
diagnostic and advances an explicit cursor; it does not silently pretend full
delivery.

## Package Placement

### `@sparkwright/core`

- Keep single-run loop, command queue, policy, approvals, events, run store and
  checkpoint semantics.
- Add a public read-only command-acceptance predicate if the coordinator needs
  it. Do not add lane/session scheduling.

### `@sparkwright/agent-runtime`

- Keep Workflow/todo run-chain driver, durable Workflow/Task stores, actor
  notifications, and Agent invocation/supervisor contracts.
- Do not add interactive session scheduling or external control bindings.

### `@sparkwright/server-runtime`

- Own `ExecutionLaneCoordinator`, in-memory queue/idempotency implementation,
  execution registry ports, process interaction/control-channel coordination,
  and future durable worker coordination.
- Keep Workflow service/supervisor/channel modules explicit.
- Split the large root `index.ts` into focused modules and re-export public API;
  do not create another package unless a real dependency-cycle pressure appears.
- Keep existing `RunManager` as a simple core-run utility rather than mutating it
  into Host's execution factory.

### `@sparkwright/host`

- Own `HostService`, connection adapter, workspace registry, execution
  assembler/driver, resource lifecycle, workspace lease implementation,
  authentication policy, and protocol projection.
- Retain product-specific config/model/Skill/MCP/Agent/Workflow/tool assembly.

### Protocol, SDK, Gateway

- Protocol adds typed execution/session-control operations only when the Host
  service is ready to own them.
- SDK exposes attach/subscribe/inspect/cancel using execution identity while
  preserving run-oriented compatibility fields.
- Gateway owns platform verification, formatting, and transport delivery only.
  After migration it no longer owns canonical active session queue, run target,
  approval target, or session-link policy.

## Compatibility Policy

Compatibility preserves wire behavior, not duplicate runtime ownership.

- Existing `run.start` may continue returning the first/root `runId` and add
  optional `executionId`.
- Existing `run.inject_message`/`run.cancel` resolve `runId` to its owning
  execution before dispatch/cancel.
- Existing clients without explicit source use their authenticated connection
  principal.
- `HostRuntime` may remain as a facade during migration, but its methods must
  delegate to the same process Host service once the coordinator is active.
- A compatibility path that constructs independent runs and bypasses lane,
  interaction, or workspace coordination is temporary only and cannot remain
  after P2 completion.

## Delivery Plan

### P0: V4 Re-Baseline And Characterization

- Land this ownership model.
- Add characterization coverage for current start/resume/inject/cancel/
  approval/disconnect behavior, todo continuation, Workflow waiting/resume,
  Task revival, and IM queueing.
- No runtime behavior change.

### P1: Decompose Host Without Changing Behavior

- Extract `HostExecutionAssembler` from run preparation.
- Extract `HostExecutionDriver` from episode driving and cancellation state.
- Extract session query/compaction and capability inspection services.
- Introduce process `HostService` and workspace registry.
- Replace latest-run `agentSpawnDeps` with execution-specific Task context.
- Keep per-connection behavior through a facade while characterization tests
  stay green.

Deletion boundary:

- `HostRuntime` no longer constructs Task/Workflow stores or owns run assembly
  details directly;
- latest-run mutable Task dependency slot is removed;
- workflow/session/capability method clusters move out of the giant class.

### P2: In-Process Interactive Execution Lanes

- Add `ExecutionLaneCoordinator` and `ExecutionDriver` port in server-runtime.
- Create one process coordinator and route ordinary `run.start`/resume/message/
  cancel through it.
- Implement bounded queue, in-flight idempotency, lane-round-robin fairness,
  atomic terminal handoff, and explicit retention.
- Keep Workflow service, Task revival, and Agent supervision outside the lane
  scheduler.

Deletion boundary:

- per-connection `active`, `startingRun`, and `runChainCancelled` ownership is
  replaced by execution-owned state;
- compatibility facade no longer bypasses the coordinator;
- duplicate Host and server-runtime pending approval ownership is reduced to one
  process interaction registry.

### P3: Host-Owned Session Control And IM Migration

- Add authenticated principals and trusted gateway claim policy.
- Add session control bindings, typed permissions, subscriptions, approval
  routing, bounded outbox, and delivery receipts.
- Route IM ordinary messages through Host lane commands.

Deletion boundary:

- remove IM gateway `activeSessions`, `queuedMessages`, canonical `runTargets`,
  and `approvalRuns` state;
- gateway store retains delivery/dedupe facts only;
- ordinary session binding policy no longer lives in gateway.

### P4: Durable Single-Host Coordination

- Add command/outcome journal and durable lane queue store.
- Persist accepted execution records and interrupted recovery decisions.
- Reuse document-store and proven Workflow journal/lease patterns where their
  semantics match; do not alias different schemas merely to reduce file count.
- Add graceful process drain and restart recovery.

Deletion boundary:

- in-memory-only accepted-command truth is removed;
- recovery no longer depends on gateway retries recreating lost work.

### P5: Multi-Process / Multi-Host

- Replace file session/run coordination where concurrent writers are possible.
- Add worker leases, fencing generations, heartbeat/expiry, assignment, and
  tenant/backpressure policy.
- Add DB/Redis implementations behind existing queue/lease/outbox ports.
- Add gateway/session affinity only as routing optimization, not ownership.

Do not claim high availability until fencing, durable accepted-command truth,
idempotent execution adoption, and delivery replay are tested under process
failure.

## Test Plan

### P1 Characterization And Decomposition

- one connection still rejects or queues concurrent starts according to the
  current compatibility behavior before P2;
- disconnect cancellation and approval denial remain characterized;
- todo continuation uses multiple core runs but one driver completion;
- Workflow waiting may finish a worker run without making the Workflow actor
  terminal;
- background Task and Agent Task context never resolves through another run's
  latest mutable dependencies;
- capability/session/workflow inspection output is unchanged after extraction.

### P2 Coordinator

- two interactive sessions execute concurrently;
- one lane serializes two starts;
- message injection and terminal handoff race is atomic;
- duplicate command during async start returns the same execution;
- child run terminal does not drain the lane;
- todo continuation run terminal does not drain the lane before driver terminal;
- Workflow `controlSessionId` does not serialize independent job sessions;
- background Task may outlive execution without blocking the next lane item;
- retention policy controls disconnect cancellation;
- queue bounds and fairness are deterministic.

### Workspace Concurrency

- same canonical root aliases contend on one scope;
- write tool calls and write-capable Agent/process invocations serialize;
- read leases may share;
- lease wait is abortable, does not acquire a mutation permit before grant,
  and does not block unrelated already-admitted lanes;
- abort removes a waiter;
- nested parent/child access cannot deadlock;
- authorization denial is distinct from lease contention;
- config fingerprint changes do not split write-lock scope.

### P3 Control And Delivery

- untrusted gateway claims are rejected;
- gateway cannot mint system principal;
- session self-binding is disabled unless configured;
- command permissions are binding-scoped;
- approval is first-writer-wins and execution-scoped;
- unauthorized links do not receive actionable approval details;
- same-source message coalescing preserves each part's attribution;
- delivery failure does not fail execution;
- reconnect replays bounded outbox exactly once per delivery key where the
  transport supports idempotency.

### P4/P5 Failure Tests

- restart after accepted but not started command;
- restart during async Host assembly;
- interrupted active execution adoption policy;
- stale worker lease and fencing takeover;
- duplicate adoption cannot execute one command twice;
- multi-process same-session and same-workspace contention;
- outbox replay after gateway and Host restart;
- graceful drain rejects new work and completes/cancels owned work by policy.

## Risks And Open Questions

- Exact public names: keep `SessionTurn` as product language while using
  `Execution` internally, or expose `executionId` directly?
- Should P2 return `executionId` immediately and `runId` later, or preserve the
  current response timing until protocol P3?
- Which immutable workspace indexes have reliable invalidation contracts today?
- What is the minimum self-contained context a background Agent Task must own
  after its parent execution becomes terminal?
- Should the process interaction registry evolve existing `ApprovalBroker` or
  replace it with a typed broker that also models connection principal and
  execution ownership?
- Can Workflow channel binding storage be generalized without weakening its
  current workflow-specific expected-generation checks? Shared primitives are
  preferred; forced schema unification is not.
- Which execution retention should be default for CLI, TUI, Web, and IM?
- P4 store choice should follow failure/recovery requirements. Do not choose
  Postgres/Redis/SQLite before the command, lease, and fencing contracts are
  frozen.

## Recommendation

Approve v4 as the new design baseline and retire v3's direct implementation
plan.

The first code slice is Host decomposition plus characterization, not
`session-turn-scheduler.ts`. The first concurrency milestone is:

```txt
one Host process
  -> one HostService
  -> one in-process ExecutionLaneCoordinator
  -> many interactive session lanes
  -> one active opaque execution per lane
  -> existing Workflow/Task/Agent supervisors remain authoritative
  -> all clients control executions through one Host control plane
```

This reaches useful multi-session concurrency while reducing, rather than
adding to, SparkWright's current runtime complexity.
