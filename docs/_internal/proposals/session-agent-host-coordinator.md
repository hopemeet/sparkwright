# Session Agent Host Coordinator

Status: Draft for review (v3)
Date: 2026-06-29

> Internal planning document. This proposal does not change runtime behavior by
> itself. It defines the target shape for making sessions first-class host-owned
> agent control units that can be driven from IM, WebSocket, CLI/TUI, API, or
> future gateways.
>
> v3 changes vs v2: the scheduler's active unit is now a `SessionTurn`
> / run-chain handle, not a single `RunHandle`; the old `RunFactory` idea
> becomes a turn-level factory port so host can preserve todo-supervised
> continuations and child/delegate runs; workspace resource-pool keys are split
> from workspace write-lock scopes; workspace resource pools gain explicit
> lifecycle rules; core `canAcceptCommand()` is promoted to a P1 deliverable;
> async turn creation, in-flight idempotency, multi-link approvals, lock wakeups,
> and host-minted `system` sources are written as design rules.

## Purpose

SparkWright already has the right lower-level pieces for governed agent runs:
core run state, host protocol, sessions, approval routing, trace, resume,
background tasks, cron, SDK clients, WebSocket transport, `server-runtime`, and
an IM gateway.

The missing product/runtime primitive is a shared session concurrency layer.
Today a host connection owns one `HostRuntime`, and one connection has at most
one active host turn at a time. Different connections can run in parallel, but
there is no shared coordinator that treats each `sessionId` as a durable main
agent with its own queue, active turn, linked external controls, event
subscribers, idempotency, and delivery state.

The target shape:

```txt
Gateway / CLI / TUI / SDK / IM
  -> host protocol / adapter layer
  -> shared @sparkwright/server-runtime coordinator
      -> SessionTurnScheduler
      -> SessionLinkStore
      -> SessionAccessPolicy
      -> WorkerPool
      -> RunManager / SessionManager / ApprovalBroker / ConnectionHub
      -> SessionTurnFactory port
          -> host-owned HostSessionTurnFactory
              -> per-workspace resource pool
              -> parent/child/continuation core runs
```

The core stance: **Gateway adapts external identity and protocol; host owns
session binding, permissions, scheduling, and logical turn lifecycle; core owns
one run loop.**

## Read Before Reviewing

- [project map: host](../project-map/modules/host.md)
- [project map: protocol](../project-map/modules/protocol.md)
- [project map: session store](../project-map/maps/session/session-store.md)
- [project map: edge packages](../project-map/modules/edge-packages.md)
- [internal design: actor inbox](../project-map/designs/internal-actor-inbox.md)
- [`packages/host/src/runtime.ts`](../../../packages/host/src/runtime.ts)
- [`packages/host/src/server.ts`](../../../packages/host/src/server.ts)
- [`packages/host/src/transport-ws.ts`](../../../packages/host/src/transport-ws.ts)
- [`packages/server-runtime/src/index.ts`](../../../packages/server-runtime/src/index.ts)
- [`packages/im-gateway/src/gateway.ts`](../../../packages/im-gateway/src/gateway.ts)
- [`packages/im-gateway/src/store.ts`](../../../packages/im-gateway/src/store.ts)
- [`packages/core/src/run.ts`](../../../packages/core/src/run.ts)
- [`packages/core/src/session.ts`](../../../packages/core/src/session.ts)
- [`packages/core/src/storage-lock.ts`](../../../packages/core/src/storage-lock.ts)

## Current Facts

- Host is already the composition boundary around core. It loads config,
  providers, skills, MCP, agents, shell settings, workflow hooks, session
  stores, and protocol-facing runtime methods.
- Current host runtime is per connection. The host map and source both state
  that a single connection runs at most one active run at a time.
- That single active host turn is not always a single core run. Host has
  `runChainCancelled` for todo-supervised chains, can create continuation runs,
  and can spawn in-process child/delegate runs. A logical session turn may
  therefore contain a root run, delegated child runs, and continuation runs
  under one cancellation/terminal-lifecycle scope.
- WebSocket transport accepts concurrent clients, but each connection receives a
  fresh `HostRuntime` via `serveConnection()`.
- `@sparkwright/server-runtime` has reusable `ConnectionHub`, `RunManager`,
  `SessionManager`, `ApprovalBroker`, and capability registry primitives. It is
  currently optional and not wired into host/CLI as the main process
  coordinator.
- `RunManager.createRun()` currently calls core `createRun()` directly. It does
  not know how to perform host-specific assembly such as config loading, skill
  loading, MCP preparation, shell sandbox resolution, agent profiles, or
  workspace-scoped stores.
- Host-specific resources are workspace-keyed, not process-global:
  `loadHostConfig(workspaceRoot)`, skill roots, MCP server cwd validation, and
  shell sandbox config all depend on the resolved workspace root.
- Core already has a run command queue. `RunHandle.injectUserMessage()` calls
  `enqueueCommand()`, and the run loop consumes queued commands at the beginning
  of each turn. `waiting_approval` and `waiting_credentials` are non-terminal.
- Core does not currently expose a public read-only `canAcceptCommand()`
  predicate. P1 should add one instead of duplicating terminal-state checks in
  host/server-runtime.
- IM gateway currently owns platform routing state such as session key to
  session id, run targets, approval routing, and processed-message dedupe. This
  works for the first Telegram bridge, but it should not become the canonical
  owner of turn lifecycle semantics.
- File-backed session/run storage is best-effort. `FileRunStore` is explicitly
  not safe for multiple processes appending to the same root without an
  external lock or database-backed coordination.

## Product Model

Treat every session as a long-lived main agent control unit:

```txt
session_A -> main agent A -> queue -> active turn/run-chain -> trace/events
session_B -> main agent B -> queue -> active turn/run-chain -> trace/events
session_C -> main agent C -> queue -> active turn/run-chain -> trace/events
```

IM, Web, CLI, TUI, or API clients are control surfaces for these session agents.
They do not own the session agent.

Default concurrency semantics:

- Same session: one active turn; additional user messages are injected into the
  active turn when it can still accept commands, otherwise queued for the next
  turn.
- Different sessions: may run concurrently up to host/global limits.
- Same workspace across multiple sessions: reads may run concurrently, but
  workspace mutations require the shared workspace lock/conflict policy.

## Goals

- Make `sessionId` the runtime concurrency boundary for main-agent work.
- Let multiple sessions run concurrently inside one host process.
- Keep same-session execution deterministic through a serial queue.
- Let IM sources link to sessions without moving turn lifecycle into gateway.
- Route approvals, cancellation, injection, and terminal turn events through a
  host-owned session registry.
- Preserve existing core run semantics and keep core focused on one run loop.
- Reuse `@sparkwright/server-runtime` instead of creating another parallel
  run/session/approval/event stack.
- Start with an in-process implementation that can later gain DB-backed stores,
  distributed locks, worker leases, and multi-host routing.

## Non-Goals

- Do not make same-session parallel runs the default.
- Do not turn the gateway into the canonical owner of session/run state.
- Do not add a generic actor message bus.
- Do not require a database for the first increment.
- Do not change core run state machine semantics.
- Do not solve full multi-region or Kubernetes high availability in the first
  increment.
- Do not share workspace-scoped resources across different workspaces.

## Package Placement

### `@sparkwright/server-runtime`

Owns the transport-neutral session coordination substrate:

- `SessionTurnScheduler`
- `SessionQueue`
- `SessionTurnState` and `SessionRuntimeState`
- `SessionTurnFactory` / `SessionTurnHandle` ports
- `SessionLinkStore` interfaces and in-memory implementation
- `SessionAccessPolicy` interface
- scheduler integration with `RunManager`, `SessionManager`,
  `ApprovalBroker`, and `ConnectionHub`

It must not import `@sparkwright/host`.

### `@sparkwright/host`

Owns product assembly:

- implements `HostSessionTurnFactory`
- owns `WorkspaceResourcePool`
- resolves host config, models, skills, MCP, shell sandbox, workflow hooks,
  agent profiles, workspace stores, and capability diagnostics
- adapts host protocol requests into server-runtime scheduler calls

Host remains the place that knows how SparkWright runs inside a workspace.

### `@sparkwright/core`

Owns only single-run semantics:

- run loop
- tool dispatch
- policy and approvals
- workspace write events
- command queue
- public read-only command-acceptance predicate
- trace/checkpoint/result/budget semantics

### Gateway / IM Packages

Own external protocol and delivery adaptation only. They provide authenticated
source claims to host and deliver host events back to external surfaces.

## Resource Ownership

The resource tiers are part of the design, not implementation detail.

```txt
per-process:
  scheduler
  event hub
  server capability type registry
  provider package registry / model factory helpers
  metrics and process health

per-workspace resource pool
  key = canonical workspaceRoot + config fingerprint
  loaded host config
  skill roots and prepared skill index/cache
  MCP server pool and lazy-tool preparation state
  shell sandbox runtime/config
  workspace capability snapshot/cache

per-workspace write lock
  scope = canonical workspaceRoot
  waiter queue / release wakeup state

per-session:
  queue
  activeTurnId
  links
  subscribers
  session access policy state
  delivery cursor / pending outbox metadata
  coalescing and idempotency windows

per-turn:
  SessionTurnHandle
  rootRunId
  currentRunId
  childRunIds / continuation run ids
  turn terminal signal
  turn cancellation scope
  initiating source

per-run:
  RunHandle
  approval waiters
  run store
  LocalWorkspace / controlled workspace runtime
  run event stream
```

The resource-pool key and write-lock scope are related but not identical. Both
derive from the canonical workspace root, but the pool key also includes the
config fingerprint because config, skills, MCP, and shell sandbox may change.
The write-lock scope must not include the config fingerprint because two
different config views of the same root still mutate the same files.

`WorkspaceResourcePool` entries need explicit lifecycle:

- reference count or lease per active turn;
- no eviction while referenced by active turns;
- idle TTL eviction after the final release;
- explicit MCP server shutdown and sandbox/resource close hooks on eviction;
- config-fingerprint invalidation creates a new pool entry without killing the
  old entry until active turns release it.

Provider package registration can be process-global, but resolved model config
and model adapters may be workspace- or run-sensitive because workspace config,
model override, pricing, and credentials can differ.

## P0 Boundary Matrix (Frozen 2026-07-06)

This matrix is the C3 P0 deliverable. It freezes ownership before any
`SessionTurnScheduler` implementation so the coordinator does not become a
fourth ambiguous owner of "the next execution".

| Boundary | Frozen owner | Current / compatibility path | Rule |
| --- | --- | --- | --- |
| Create a session turn | `server-runtime` `SessionTurnScheduler` allocates `queueEntryId` / `turnId`; host-owned `SessionTurnFactory` assembles the logical turn/run-chain. | Per-connection `HostRuntime.startRun()` may continue to create runs directly until the coordinator path becomes default. | Core creates runs, not session turns. Once P1 is default, new durable session turns enter through the scheduler. |
| Continue execution inside an active turn | Core owns in-run command consumption and continuation. Workflow owns workflow episode advancement. `TaskManager` owns task terminal/revival signals. Scheduler owns only selecting the next queued session turn after the active turn is terminal. | Existing todo-supervised continuations and child/delegate runs remain host run-chain behavior wrapped by one future `SessionTurnHandle`. | No component outside the active turn may drain the session queue or declare the turn terminal. |
| Inject user commands/messages | `SessionTurnScheduler` routes same-session messages to the active `SessionTurnHandle`; the handle delegates to the current/root `RunHandle.injectUserMessage()`. | Current `HostRuntime.injectRunMessage()` checks the active run id and calls core's command queue directly. | Do not create a second in-run command queue in server-runtime. Injection reuses core `enqueueCommand()`. |
| Emit terminal and wakeup notifications | Core emits run terminal facts; task/workflow outboxes emit task/workflow terminal and wakeup facts; host/coordinator routes and fans out those facts. | Current host runtime forwards buffered run, task, and workflow notifications to the connected client. | Coordinator may wake parked queues and subscribers, but it must not invent terminal facts. |
| Hold workspace lock and resource pool | Host owns `WorkspaceResourcePool` and workspace write-lock implementation; scheduler holds a logical lease while a turn is runnable/active. | Current per-connection host runtime resolves workspace-scoped config, stores, MCP, sandbox, and write policy inline. | Pool key is workspace root plus config fingerprint; write-lock scope is workspace root only. Leases release on turn terminal/cancel. |
| Coordinate across processes | No P0/P1 component coordinates across processes. P3 owns DB/Redis-backed queues, locks, leases, stores, and outboxes. | File stores remain best-effort and must not be treated as multi-process-safe. | In-process success is not evidence of distributed safety. Cross-process coordination requires a dedicated store/lock backend. |
| Preserve per-connection `HostRuntime` | Host keeps per-connection `HostRuntime` as the compatibility adapter while the scheduler rolls out. | `serveConnection()` still creates a fresh `HostRuntime`; one connection has one active runtime/run-chain. | Compatibility mode may bypass cross-session coordination. It is not the target owner and must not be cited as P1 completion. |

## SessionTurnFactory Port

`server-runtime` needs a turn creation port because it cannot import host, and
host-specific turn assembly cannot be reproduced inside server-runtime. The
port must represent a logical host turn/run-chain, not only a single core run.

Draft shape:

```ts
interface SessionTurnFactoryContext {
  sessionId: string;
  workspaceRoot: string;
  workspacePoolKey: string;
  workspaceLockScope: string;
  source?: VerifiedSourceIdentity;
  metadata?: Record<string, unknown>;
}

interface SessionTurnFactory<TInput = CreateManagedRunOptions> {
  createTurn(
    input: TInput,
    context: SessionTurnFactoryContext,
  ): Promise<SessionTurnHandle>;
}

interface SessionTurnHandle {
  turnId: string;
  sessionId: string;
  rootRunId?: string;
  currentRunId?: string;
  childRunIds: readonly string[];
  state: SessionTurnState["state"];
  terminal: boolean;

  canAcceptMessage(): boolean;
  injectUserMessage(input: InjectSessionMessageInput): Promise<void> | void;
  cancelTurn(input?: { reason?: string; metadata?: Record<string, unknown> }):
    Promise<void> | void;
  subscribe(listener: SessionTurnEventListener): Unsubscribe;
}
```

`RunManager` should call an injected factory path instead of assuming all work
is a direct core `createRun()` call. The default factory remains the current
thin behavior for embedders that only need one core run:

```txt
default SessionTurnFactory
  -> core createRun(resolveRunOptions(options))
  -> single-run SessionTurnHandle wrapper
```

Host injects:

```txt
HostSessionTurnFactory
  -> resolve workspace pool key and workspace lock scope
  -> get/create WorkspaceResourcePool entry
  -> assemble model/tools/policy/workspace/runStore/hooks/delegates
  -> create root core run
  -> create child/delegate/continuation runs as host semantics require
  -> expose one SessionTurnHandle to server-runtime
```

This keeps the coordination center in server-runtime without creating a
server-runtime -> host dependency cycle, while preserving current host
todo-supervised cancellation and continuation behavior.

`createTurn()` is async. P1 must account for the gap between accepting a queue
entry and receiving the root run id:

- scheduler allocates `queueEntryId` and `turnId` under the session mutex before
  awaiting host assembly;
- in-flight idempotency records point at that entry/turn immediately;
- duplicate submissions during assembly return the existing accepted entry/turn
  state instead of starting a second turn;
- protocol compatibility can continue returning the root `runId` once factory
  resolution completes, but the internal scheduling contract is turn-first.

## Core Types

Names are intentionally draft names.

```ts
type SourceKind = "host_client" | "im" | "api" | "system";

interface SourceIdentity {
  kind: SourceKind;
  gatewayId?: string;
  platform?: string;
  chatId?: string;
  threadId?: string;
  userId?: string;
  userName?: string;
  tenantId?: string;
  clientId?: string;
  metadata?: Record<string, unknown>;
}

interface VerifiedSourceIdentity extends SourceIdentity {
  verifiedBy: "host" | "gateway";
  verifiedAt: string;
}

interface SessionLinkRecord {
  id: string;
  sessionId: string;
  source: SourceIdentity;
  permissions: SessionPermission[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

type SessionPermission =
  | "message"
  | "inspect"
  | "approve"
  | "cancel_turn"
  | "cancel_session"
  | "link"
  | "unlink";

interface SessionQueueEntry {
  id: string;
  sessionId: string;
  turnId?: string;
  idempotencyKey?: string;
  coalesceKey?: string;
  kind: "start" | "resume" | "message";
  source: VerifiedSourceIdentity;
  payload: unknown;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

interface SessionTurnState {
  turnId: string;
  sessionId: string;
  workspaceRoot: string;
  workspacePoolKey: string;
  workspaceLockScope: string;
  state:
    | "queued"
    | "starting"
    | "running"
    | "waiting_approval"
    | "waiting_credentials"
    | "cancelling"
    | "completed"
    | "failed"
    | "cancelled";
  rootRunId?: string;
  currentRunId?: string;
  childRunIds: string[];
  submittedBy: VerifiedSourceIdentity;
  terminalReason?: unknown;
  updatedAt: string;
}

interface SessionRuntimeState {
  sessionId: string;
  status:
    | "idle"
    | "queued"
    | "running"
    | "waiting_approval"
    | "cancelling"
    | "draining"
    | "blocked"
    | "error";
  activeTurnId?: string;
  currentRunId?: string;
  workspaceRoot?: string;
  workspacePoolKey?: string;
  workspaceLockScope?: string;
  queueDepth: number;
  linkedSourceCount: number;
  updatedAt: string;
}
```

`coalesceKey` should include source identity by default. Only consecutive
messages from the same source should merge automatically; cross-source messages
must remain distinct so attribution is preserved.

## Coordinator Surface

P1 should keep the public surface narrow:

```ts
interface SessionCoordinator {
  submit(input: SubmitSessionWorkInput): Promise<SubmitSessionWorkResult>;
  inject(input: InjectSessionMessageInput): Promise<InjectSessionMessageResult>;
  cancelTurn(input: CancelSessionTurnInput): Promise<void>;
  cancelSession(input: CancelSessionInput): Promise<void>;
  resolveApproval(input: ResolveSessionApprovalInput): Promise<void>;
  inspectSessionState(sessionId: string): Promise<SessionRuntimeState>;
}
```

Existing protocol paths that address cancellation by `runId` should become a
compatibility adapter: resolve `runId -> turnId -> sessionId`, then apply
turn-level cancellation policy. Cancelling an arbitrary child run must not
accidentally leave the parent turn free to continue unless an explicit internal
policy says so.

P2 can add:

```ts
interface SessionLinkCoordinator {
  linkSession(input: LinkSessionInput): Promise<SessionLinkRecord>;
  unlinkSession(input: UnlinkSessionInput): Promise<void>;
  listSessionLinks(sessionId: string): Promise<SessionLinkRecord[]>;
  subscribe(input: SubscribeSessionEventsInput): HostEventSubscription;
}
```

Do not pull link/unlink/subscribe into P1. Those require explicit protocol and
trust-boundary decisions.

## Scheduling Semantics

### Submission

1. Caller submits work with `sessionId`, `workspaceRoot` or equivalent routing
   context, `source`, and optional `idempotencyKey`.
2. Host verifies the source claim and session access policy.
3. Scheduler takes the session mutex and records any idempotency entry before
   awaiting async host assembly.
4. If the session has no active turn, scheduler starts a turn when global
   capacity and workspace lock requirements allow.
5. If the session has an active turn that can accept messages:
   - message input is forwarded through `SessionTurnHandle.injectUserMessage()`;
   - a new start/resume request is queued or rejected depending on policy.
6. If the active turn is terminal or terminal handoff has begun, message input
   is queued for the next turn.
7. Turn terminal event and queue drain run under the same session mutex, so
   there is no window where a message can be injected into a dying turn.

The scheduler must not treat every core run terminal event as session terminal.
Child/delegate/continuation runs are members of a `SessionTurn`. Only the
turn-level terminal signal can release the session mutex for queue drain.

### Injection

Do not invent a second run-internal queue. Injection reuses core:

```txt
SessionTurnScheduler
  -> active SessionTurnHandle.injectUserMessage()
  -> current/root RunHandle.injectUserMessage()
  -> core RunHandle.enqueueCommand()
  -> run loop consumes commands at next turn boundary
```

This means:

- mid-tool-call messages do not interrupt the tool; they are consumed at the
  next core run turn;
- `waiting_approval` and `waiting_credentials` are non-terminal and can accept
  queued user messages;
- the scheduler's "can inject" predicate is turn-level
  `SessionTurnHandle.canAcceptMessage()`.

P1 should add a public read-only `RunHandle.canAcceptCommand()` helper in core.
The default turn handle can implement `canAcceptMessage()` from that helper plus
the scheduler's own terminal-handoff guard. Host's turn handle can additionally
guard broader run-chain cancellation/terminal state.

### Capacity

Initial in-process config:

```ts
interface SessionTurnSchedulerConfig {
  maxConcurrentTurns: number;
  maxQueueDepthPerSession: number;
  maxQueuedSessions: number;
  sameSessionPolicy: "inject_or_queue" | "queue_only" | "reject";
  messageCoalescing: "same_source" | "off";
}
```

Default recommendation:

- `maxConcurrentTurns`: small configurable value, for example `4`.
- `maxQueueDepthPerSession`: bounded, for example `20`.
- `sameSessionPolicy`: `inject_or_queue`.
- `messageCoalescing`: `same_source`.

### Fairness

The first scheduler should use a simple session-round-robin queue:

- one active turn per session;
- choose next runnable session from a FIFO of sessions with queued work;
- do not let one noisy session monopolize all workers.

If a session is blocked on a workspace lock, park it and release the worker
slot. Do not repeatedly pick and re-block the same session in a busy loop.

Weighted tenant fairness can wait until tenant quotas exist.

## Source Trust And IM Session Links

`SourceIdentity` is not trusted by default. A gateway supplies raw platform
facts; host must verify that the gateway itself is trusted before turning those
facts into `VerifiedSourceIdentity`.

Minimum trust posture:

- Host registers trusted gateways by token, mTLS identity, or signed-claim key.
- Gateway claims carry gateway id, issue time, source identity, and optionally
  idempotency key.
- Host rejects `kind: "system"` from gateways. `system` is host-generated only.
- Cron-triggered runs, supervised continuations, and other internal automation
  should route through coordinator-minted `system` sources instead of bypassing
  session access policy and event attribution.
- `session.link` creation is allowed only from an authenticated host client or
  project/user allowlist. IM self-link is disabled by default.
- IM source with `message` permission does not automatically get `approve`,
  `cancel_session`, `link`, or `unlink`.

IM-session binding stays host-owned:

```txt
telegram chat/thread/user
  -> gateway verifies platform token/webhook
  -> gateway sends signed or authenticated source claims
  -> host verifies gateway
  -> host checks SessionLinkStore
  -> host schedules work for sessionId
```

A session can link multiple external sources:

```txt
session_123
  -> telegram chat A
  -> slack thread B
  -> web client C
```

## Idempotency And Coalescing

IM and webhook retries are normal. Queue entries should carry
`idempotencyKey` when the source can provide one.

P1 in-memory dedupe:

- scope: `sessionId + source + idempotencyKey`;
- window: bounded count or TTL;
- duplicate `start`/`resume`/`message` returns the prior accepted queue/turn
  result when available.
- if the first accepted entry is still queued, starting, or running, duplicate
  delivery returns that existing entry/turn status rather than enqueueing a new
  entry;
- the dedupe record is written while holding the session mutex before any async
  `createTurn()` work begins.

Message coalescing:

- default is same-source only;
- preserve the original source metadata for each merged message part;
- cap merged content by count, age, and character budget;
- do not merge across different IM users/chats/sources by default.

## Protocol Direction

P1 can avoid wire churn by keeping current protocol calls and using internal
metadata for source claims where only trusted local clients participate.

P2 should make the contract explicit:

- add optional verified/claim-bearing source envelope to relevant request
  payloads:
  - `run.start`
  - `run.resume`
  - `run.inject_message`
  - `run.cancel`
  - `approval.resolve`
  - `session.inspect`
- add session link requests:
  - `session.link`
  - `session.unlink`
  - `session.links`
- add queue/active-turn inspection:
  - `session.state`
  - optional `session.queue.list`

Backward compatibility:

- Existing clients with no `source` are treated as `host_client` for their
  connection.
- Existing direct host behavior can remain available until the coordinator path
  is the default.

## Event Routing And Delivery

Host should maintain:

- `runId -> turnId -> sessionId`
- `approvalId -> runId -> turnId -> sessionId`
- `sessionId -> linked sources`
- `connectionId -> subscribed sessions`

Events from a run should be routed to:

- the client that submitted the run;
- any active subscribers to the session;
- linked external sources whose permissions/subscription rules allow the event.

Gateway delivery failure must not affect run execution. It should be surfaced
as a delivery diagnostic, not as a core run failure.

However, IM is a user-facing control plane. The design must reserve an outbox
seam:

- session events get a monotonic delivery sequence for each interested link or
  a replayable cursor over session events;
- each link may have a bounded pending outbox in P2;
- reconnecting gateways can replay from cursor;
- dropping due to retention limits emits a delivery diagnostic.

P1 does not need durable delivery, but it must not choose an event model that
makes P2 outbox/replay impossible.

Approval resolution is first-writer-wins. A second resolution of the same
approval should be idempotently rejected or reported as already resolved, not
applied again. Approval timeout should be configurable per source/link class.

Approval visibility and authority must be policy-gated. Default policy:

- the source that initiated the active turn can resolve approvals it is allowed
  to see;
- other linked sources can resolve only when their link has `approve`;
- linked sources without `approve` may receive redacted progress events but not
  actionable approval prompts;
- all approval decisions must still be routed through host policy before
  reaching core.

## Storage And Locks

### P1 In-Process

Use existing `FileSessionStore` / `FileRunStore` and in-memory scheduler state.
This supports local multi-session concurrency in one host process.

Required safeguards:

- same-session serial queue;
- one active turn per session inside the process;
- workspace write lock before mutating shared workspaces;
- workspace lock waiters are parked and woken on lock release;
- bounded queue sizes;
- idempotency window;
- no cross-workspace resource sharing.

### P2 Durable Single Host

Add file-backed or lightweight durable queue state:

- pending queue entries survive host restart;
- active turn recovery uses checkpoint/resume where possible;
- stale active turns can be marked interrupted;
- per-link outbox/cursor survives gateway reconnect.

### P3 Multi-Process / Multi-Host

Do not scale the file store directly. Add DB/Redis-backed implementations:

- `SessionStore`
- `RunStore`
- `SessionLinkStore`
- `SessionQueueStore`
- `LockStore`
- delivery outbox
- worker lease / heartbeat table

At this point gateway can route by `sessionId` to a host shard, but host
coordinator remains the runtime owner.

## Workspace Isolation

Session isolation is not enough when sessions share a workspace.

Rules:

- Reads can run concurrently unless confidential path policy denies them.
- Writes to the same workspace should be serialized unless a conflict detector
  proves they do not overlap.
- `workspacePoolKey` is derived from canonical `workspaceRoot` plus config
  fingerprint.
- `workspaceLockScope` is derived from canonical `workspaceRoot` only.
- Same root with different config fingerprints may use different resource pool
  entries, but must still contend on the same workspace write lock.
- Workspace locks must not be held across model turns.
- Lock acquisition order is fixed:

```txt
session lock -> workspace lock -> store lock
```

- If a session cannot acquire a workspace lock, park it and release its worker
  slot until the lock can be retried.
- Lock retry should be driven by a waiter queue signaled on lock release, not by
  scheduler polling.
- Approval UI should show when a session is waiting on workspace contention.

Future shape:

```txt
session lock: session:<sessionId>         // same-session run serialization
workspace lock: workspace:<canonicalRoot> // write conflict prevention
store lock: store:<root/sessionId>        // multi-process trace safety
```

## Actor-Inbox Boundary

This proposal intentionally does not add a generic actor bus. The session queue
is a constrained per-session FIFO for user/control work:

- accepted entry types are start, resume, and message;
- routing key is session id;
- same-session ordering is owned by the scheduler;
- delivery into model context still happens through core run commands or new
  run creation.

The internal actor inbox design remains the right shape for asynchronous
lifecycle/progress notifications. If a future session agent needs internal
notifications, it should align with `ActorNotificationSink` rather than turning
the session queue into a generic message bus.

## Cancellation

Keep cancellation granular:

```ts
cancelTurn({ sessionId, turnId, reason })
cancelSession({ sessionId, reason, clearQueue })
```

`cancelTurn` targets the active logical turn/run-chain. `cancelSession` may
cancel the active turn and optionally clear queued work. Existing protocol calls
that only provide `runId` should resolve the owning turn before applying
cancellation policy.

Host should preserve the existing distinction between a single core
`run.cancel()` and the broader `runChainCancelled` behavior for supervised
chains. User-facing cancellation of a main-agent turn should stop the whole
turn chain, including continuations that have not started yet.

If `clearQueue` removes queued entries, each removed entry must receive a
delivery notification or queue-dropped event for its source. Do not silently
drop IM/user-submitted work.

## Failure Handling

- Client disconnect: detach that subscriber; do not necessarily cancel the turn
  if the turn is owned by the session actor and other subscribers/links remain.
- Gateway disconnect: external source becomes temporarily undeliverable; queued
  and active work remain host-owned.
- Approval timeout: deny safely, with timeout configurable by source/link class.
- Queue overflow: reject or summarize with a clear host error and source
  delivery notification.
- Host shutdown: cancel active in-process turns in P1; P2+ records interrupted
  state and attempts resume.
- Duplicate IM messages: dedupe by `sessionId + source + idempotencyKey`.
- Workspace lock contention: park session without consuming a worker slot.

## Delivery Plan

### P0: Document And Freeze The Boundary

- Land this v3 proposal.
- Land the P0 boundary matrix above, including the per-connection
  `HostRuntime` compatibility path.
- Record in project map that `server-runtime` is the intended session
  coordination center, with a turn/run-chain scheduler rather than a
  single-run scheduler, but is not yet wired into host/CLI.
- No runtime behavior change.

### P1: In-Process SessionTurnScheduler In `server-runtime`

Goal: useful local multi-session concurrency without database dependencies.

Implementation candidates:

- `packages/server-runtime/src/session-turn-scheduler.ts`
- `packages/server-runtime/src/session-links.ts`
- `packages/server-runtime/src/session-turn-factory.ts`
- `packages/server-runtime/test/session-turn-scheduler.test.ts`
- host-side `HostSessionTurnFactory` and `WorkspaceResourcePool` under
  `packages/host/src/*`
- core-side `RunHandle.canAcceptCommand()`

Behavior:

- shared scheduler per host process;
- one active turn per session;
- different sessions run concurrently up to `maxConcurrentTurns`;
- same-session injection-or-queue using core command queue;
- approval/cancel route through coordinator;
- workspace write lock for mutating work;
- workspace lock waiters park and wake on release;
- workspace resource pool refcount/idle eviction and MCP shutdown hooks;
- same-source message coalescing;
- idempotency window, including in-flight duplicate submissions;
- host-minted `system` sources for internal automation paths that enter the
  scheduler;
- no public protocol changes required yet.

### P2: Protocol, Session Links, And IM Delivery

Goal: make IM/session binding and event delivery first-class.

Implementation candidates:

- protocol request types for session link/state operations;
- host protocol docs and schema fixtures;
- trusted gateway/source claim verification;
- IM gateway sends authenticated source claims instead of owning canonical
  session-link policy;
- gateway store keeps transport delivery state only;
- bounded per-link outbox/cursor.

### P3: Durable Queue And Restart Recovery

Goal: host restarts do not lose queued session work.

Add:

- durable queue records;
- startup recovery pass;
- active-turn interruption/resume policy;
- queue inspection commands;
- delivery outbox persistence.

### P4: Distributed Runtime

Goal: high-concurrency/high-availability deployment.

Add:

- DB/Redis-backed stores;
- worker leases and heartbeats;
- distributed lock implementation for `StorageLock`;
- gateway/session affinity;
- queue backpressure and tenant quotas;
- health/readiness/metrics.

## Test Plan

P1 tests:

- two different sessions can run concurrently;
- same session queues second start while first is active;
- same session injects a message into active non-terminal turn through
  `SessionTurnHandle.injectUserMessage()` and core
  `RunHandle.injectUserMessage()`;
- terminal handoff and queue drain are atomic under the session mutex;
- `waiting_approval` / `waiting_credentials` runs can accept queued messages;
- child/delegate run terminal events do not drain the session queue until the
  owning turn is terminal;
- terminal turn receives no new injected message; message queues for next turn;
- cancel targets the active turn for the correct session and stops supervised
  continuations;
- compatibility cancel by `runId` maps to the owning turn;
- cancel session with `clearQueue` emits queue-dropped notifications;
- queue depth limit rejects new work deterministically;
- same-source queued messages coalesce; cross-source messages do not;
- idempotency key dedupes repeated IM delivery, including duplicates while
  `createTurn()` is still pending;
- workspace lock contention parks the session, releases worker capacity, and
  wakes on lock release;
- workspace resource pool entries are not evicted while active turns reference
  them and close MCP/sandbox resources on idle eviction;
- same root with different config fingerprints uses different resource pools
  but the same workspace write lock scope;
- core `RunHandle.canAcceptCommand()` reports false for terminal runs and true
  for non-terminal waiting states;
- coordinator-minted `system` source is used for internal automation paths that
  enter the scheduler;
- client disconnect does not cancel session-owned runs unless configured.

P2 tests:

- `session.link` / `session.unlink` protocol validation;
- untrusted gateway source claims are rejected;
- IM self-link is disabled unless explicitly allowed;
- IM source can message only linked session;
- linked source without `approve` cannot resolve approval;
- linked source with `approve` can resolve an approval for the same session;
- duplicate approval resolution is first-writer-wins;
- event fan-out reaches linked source and current host client;
- gateway reconnect can replay bounded outbox/cursor.

P3/P4 tests:

- restart with queued work;
- interrupted active turn recovery;
- durable outbox replay;
- distributed lock contention;
- same workspace write contention across sessions;
- worker lease expiry and reassignment.

## Open Questions

- Should P2 source claims be encoded as a protocol-owned typed object, or as a
  signed gateway claim envelope whose contents are host-owned?
- Which session links can be authored from project config versus host admin
  commands?
- Should event fan-out default to all linked sources, only subscribed links, or
  only the source that initiated the current turn?
- Resolved by C3 P0 on 2026-07-06: host keeps the current per-connection
  `HostRuntime` as a compatibility adapter, but it is not the target
  coordination owner and may bypass cross-session scheduling.
- What is the smallest useful DB-backed store: Postgres-only first, or an
  interface plus file/SQLite/Postgres implementations?

## Recommendation

Build P1 in `@sparkwright/server-runtime` first, with a `SessionTurnFactory`
port and host-owned `HostSessionTurnFactory` implementation. Keep gateway thin.
Do not invest more in same-session tool concurrency as the primary scaling
story.

The first valuable milestone is:

```txt
one host process
  -> server-runtime SessionTurnScheduler
  -> per-workspace resource pools
  -> many session agents
  -> one active turn/run-chain per session
  -> different sessions run concurrently
  -> IM/Web/CLI/TUI can all control the same session model
```

That milestone preserves today's local runtime while creating the path toward
future high-concurrency and high-availability deployments.
