# Design: Internal Actor Inbox

> Partially implemented design. Step 0 + Step 1 are implemented in
> `@sparkwright/agent-runtime`; workflow-runtime-v1 P2 now uses the workflow
> completed/failed notification input as a durable terminal probe, while Step
> 2+ receiver policy extraction and workflow actor runtime work remain future
> slices. This is a design catalog entry, not
> an active routing map. It records the current design contract for generalizing
> the existing task notification mechanism into a small internal actor inbox.
> Current source
> contracts still live in
> [../modules/agent-runtime.md](../modules/agent-runtime.md),
> [../modules/host.md](../modules/host.md),
> [../modules/protocol.md](../modules/protocol.md),
> [../maps/capabilities/agents.md](../maps/capabilities/agents.md),
> [../maps/runtime/run-loop.md](../maps/runtime/run-loop.md),
> `packages/agent-runtime/src/tasks/notifications.ts`,
> `packages/agent-runtime/src/tasks/manager.ts`,
> `packages/agent-runtime/src/tasks/file-notifications.ts`,
> `packages/agent-runtime/src/index.ts`,
> `packages/core/src/types.ts`,
> `packages/core/src/run.ts`,
> `packages/host/src/runtime.ts`,
> `packages/host/src/traced-process-runner.ts`, and
> `packages/streaming-runtime/src/index.ts`.
>
> First implementation slice: viable as an extraction from the current task
> notification outbox/revival path. The main host still persists terminal task
> notifications and injects them through core `NotificationSource`; Step 1 keeps
> the host on the task-specific bridge while the generic abstraction incubates.

## 1. Problem Statement

SparkWright has several local communication mechanisms, each correct for its
own boundary:

- background tasks use `TaskNotificationSink` plus task output/status storage;
- sub-agents expose parent-visible `subagent.*` lifecycle events while child
  runs keep their own `run.*` streams;
- workflow hooks synchronously steer the run loop with
  `WorkflowHookResult`;
- non-blocking user/event hooks emit `user_hook.*` diagnostics;
- external processes can only report host-ingested progress through constrained
  stderr token lines;
- MCP, ACP, and external-command delegates bridge external protocols into
  SparkWright tools or delegate surfaces.

The next likely feature, a host-owned workflow actor that can run alongside a
main run and report completion/progress, needs the same kind of asynchronous
notification path that background tasks already use. Creating a broad
`RuntimeChannel` or generic actor bus would duplicate existing primitives and
risk becoming a second runtime. The smaller target is to generalize the task
notification shape just enough for another internal actor to use it.

## 2. Goals

- Grow from the existing `TaskNotificationSink` / queue model instead of
  introducing a parallel notification system.
- Keep trace as an audit projection, not a communication bus.
- Keep external transports outside the internal actor model. MCP, ACP, and
  process stderr remain adapter ports with their own capabilities and limits.
- Support lifecycle-style notifications for internal actors: task, workflow,
  run, and agent.
- Keep sender-side and receiver-side contracts separate: producer sink vs
  consumer inbox.
- Make model-context injection explicit and receiver-controlled.
- Avoid a request/response bus in the MVP. Long-running work reports status and
  completion; it does not become synchronous RPC.
- Treat the current host task receiver path as the proof point: receiver
  policy, context projection, and revival waiting already exist for tasks and
  should be generalized deliberately instead of bypassed.
- Keep the MVP small. In-memory inboxes are fine for tests and single-process
  embedders, but the main host task path depends on the file outbox for
  detach/resume replay and cannot be replaced by an ephemeral queue.
- Defer generic durable inbox features that the task outbox does not yet need:
  cross-actor ack policy, seen-id deduplication, dead-letter handling, and GC.

## 3. Non-Goals

- Do not add arbitrary peer-to-peer actor messaging in the MVP.
- Do not add `message` as a notification type.
- Do not put `mcp_server`, `acp_agent`, or `external_process` in the internal
  actor enum.
- Do not replace MCP JSON-RPC, ACP, host protocol, task output storage, or
  trace JSONL.
- Do not add a generic `request(timeoutMs)` API.
- Do not let notification delivery bypass tool policy, approval, run access, or
  workflow-hook gates.
- Do not allow producers to decide that their notification enters model
  context. They may provide a hint; receiver policy decides.
- Do not let producers assign trace span ids. Trace adapters derive trace
  projection from accepted notifications and surrounding run/span context.
- Do not create a second, weaker host context-injection path. Task completion
  already flows through `NotificationSource`; workflow projection should reuse
  or generalize that receiver boundary.

## 4. Current Source Facts

Verified by reading source during this design refresh:

- `packages/agent-runtime/src/tasks/notifications.ts` now defines the split
  `ActorNotificationSink` / `ActorInbox` types beside the compatible
  transport-agnostic `TaskNotificationSink`. The typed actor union includes task
  and workflow notification inputs; workflow remains a design probe only.
  Legacy `TaskNotification` is still terminal only, carries `taskId`,
  `parentRunId`, optional `targetRunId`, `summary`, terminal payload/error,
  optional `outputRef`, and `deliveredAt`.
- `TaskManager` calls its notification sink once after a task reaches a
  terminal state. If the sink throws transiently, the manager pushes the
  notification into its in-process `pendingNotifications()` retry queue, calls
  `onSinkError` when supplied, and still lets the task reach its terminal store
  state. Typed non-retryable actor failures such as `INVALID_ROUTE`,
  `INVALID_ACTOR_NOTIFICATION`, and `UNSUPPORTED_ACTOR_NOTIFICATION` call
  `onSinkError` but do not enter the pending retry queue. The task store
  remains the source of truth.
- `InMemoryTaskNotificationQueue` now exposes three consumer primitives:
  `peek()` snapshots without consuming, `drain(predicate?)` consumes matching
  notifications, and `waitUntilAvailable({ signal, predicate })` waits without
  consuming. It also still has consuming `waitForNext()` for legacy task API
  compatibility, but `ActorInbox` adapters expose only the non-consuming wait
  plus predicate peek/drain. Its optional `maxBufferedNotifications` cap no
  longer silently drops reliable terminal entries; drop-oldest/drop-self is
  limited to lossy actor notifications.
- `FileTaskNotificationOutbox` is the durable counterpart for task terminal
  notifications. `deliver()` appends one JSON entry under
  `task-notifications/`; consumers can `peek(predicate?)`,
  `drain(predicate?)`, `ack(id)`, or non-consumingly
  `waitUntilAvailable({ signal, predicate })`. Its actor adapter derives
  inbox-scoped `sequence` lazily from stable file order with an in-process
  high-water mark and does not change the existing JSON entry format. Because
  that format is still `TaskNotification`, the file-backed actor sink accepts
  only terminal task actor notifications that are expressible without losing
  actor envelope fields; workflow inputs, task progress/output inputs, or
  actor-only fields such as `source.sessionId`, `routeHint.sessionId`,
  `correlationId`, and `suggestedContext` reject with a typed non-retryable
  unsupported-actor error. The actor inbox view skips unreadable or
  actor-invalid durable entries and exposes diagnostics through
  `invalidActorEntries()`; this keeps a single stale/bad file from wedging
  actor `peek()`, `drain()`, or readiness waits. The legacy task listing path
  remains strict for corrupt JSON.
- The main host runtime constructs `TaskManager` with `FileTaskStore` and
  `FileTaskNotificationOutbox` as `notificationSink`. The host task path is
  therefore already durable at the notification edge; a generic in-memory-only
  `ActorInbox` cannot replace it.
- `NotificationSource` and `TaskRevivalSource` live in
  `packages/core/src/types.ts`. The core run loop drains notification sources
  at step start and injects their `PendingNotification` content as user-role
  working context via `run.notification.injected`.
- `TaskRevivalSource` is separate from `NotificationSource` because awaited
  task revival must wait for readiness without consuming notifications. The
  core loop enters the internal `waiting_tasks` state, waits for task
  readiness, command input, or abort, then re-enters a normal step where the
  notification source is the sole consumer.
- `packages/host/src/runtime.ts` implements `createTaskRevivalBridge()`, which
  adapts the durable task outbox into both core interfaces. It filters by
  `parentRunId`, consults `TaskRecord.awaited` for revival eligibility, uses
  `peek()` for pending-awaited checks, uses predicate `drain()` for step-start
  injection, and uses non-consuming `waitUntilAvailable()` for revival waits.
- `pendingNotificationFromTask()` is the existing receiver-side projection
  from task notification to prompt-visible context. It summarizes terminal task
  facts, preserves metadata, and is product behavior for main host runs.
- `packages/agent-runtime/src/index.ts` bridges child run events to
  parent-visible `subagent.*` lifecycle events. This is lifecycle observation,
  not a general child messaging channel.
- `packages/host/src/traced-process-runner.ts` injects
  `SPARKWRIGHT_PROCESS_PROTOCOL=stdio-v1` and accepts only constrained
  `type:"progress"` stderr token records. Unsupported or malformed records are
  dropped and counted; external scripts do not write SparkWright events.
- `packages/core/src/workflow-hooks.ts` defines synchronous
  `WorkflowHookResult` control semantics. A future asynchronous workflow actor
  must not blur this with awaited workflow-hook gates.
- `packages/host/src/runtime.ts` now delivers P2 workflow `completed` /
  `failed` terminal notifications into an in-memory actor sink after the
  `WorkflowRunRecord` reaches a terminal state. These notifications use
  `payload.workflowId` as the workflow run instance id and `workflow.*`
  `TaskError.code` values. They are terminal lifecycle notifications only; P2
  still does not add receiver-side workflow actor policy, durable workflow
  notification outbox, or a `waiting` emitter.
- `packages/protocol/src/index.ts` uses typed discriminated request/event
  shapes. The inbox design should follow that typed style instead of growing a
  stringly typed `topic` plus `payload: unknown` bus.

## 5. Target Shape

The target is an internal, asynchronous notification lane:

```txt
internal actor lifecycle/progress/output
  -> ActorNotificationSink
  -> ActorInbox acceptance
  -> optional receiver policy/context injection
  -> optional trace/event projection
```

Producer and consumer surfaces stay distinct:

- `ActorNotificationSink` is the producer port. It accepts notification inputs
  and reports whether they were accepted or, for lossy notifications only,
  dropped.
- `ActorInbox` is the consumer endpoint. It owns ordering, drain/wait behavior,
  retention, and future durable concerns.

One implementation may implement both interfaces for the in-memory MVP, but
the type boundary must remain split.

### Internal Actors

Only SparkWright-owned lifecycle entities are internal actors:

```ts
type InternalActorKind = "run" | "agent" | "task" | "workflow";

interface ActorRef {
  kind: InternalActorKind;
  id: string;
  /** Owning or parent run scope, when the actor is nested under a run. */
  runId?: string;
  sessionId?: string;
}
```

For the current task path, `TaskNotification.parentRunId` is the receiver/owner
run scope used by host filtering. The generic envelope must preserve that
field explicitly during migration instead of hiding it behind an ambiguous
actor id. A task notification should map to:

- `source: { kind: "task", id: taskId, runId: parentRunId }`;
- `routeHint.parentRunId = parentRunId`;
- `routeHint.targetRunId = targetRunId` when the old notification supplied one;
- old `deliveredAt` remains task payload/metadata because it records the task
  terminal notification timestamp; generic `createdAt` is assigned when the
  actor inbox accepts the notification.

Acceptance must normalize route facts before storage:

- if `routeHint.parentRunId` is missing and `source.runId` is set, copy
  `source.runId` into `routeHint.parentRunId`;
- if `routeHint.sessionId` is missing and `source.sessionId` is set, copy
  `source.sessionId` into `routeHint.sessionId`;
- if an explicit `routeHint.parentRunId` or `routeHint.sessionId` is present
  and disagrees with the corresponding `source` field, reject the notification
  with `INVALID_ROUTE`. `parentRunId` is the durable replay filter; silent
  re-routing is not allowed. `routeHint.targetRunId` is exempt — targeting a
  different run than the owner is its purpose;
- the MVP has no separate `targetHint` input. Existing task `targetRunId`
  migrates directly to `routeHint.targetRunId`;
- defer non-run target hints until a concrete workflow/supervisor receiver
  needs them.

Receiver policy should match the normalized explicit route fields first.
`source.runId` is useful attribution, but it should not become the only routing
fact because existing host code already treats `parentRunId` as the durable
replay filter.

External systems are adapter ports, not actor refs:

- process adapter: one-way progress/output ingestion only;
- MCP adapter: MCP transport and JSON-RPC remain MCP-owned;
- ACP adapter: ACP protocol remains ACP-owned;
- external-command delegate adapter: maps bounded child progress/result summaries
  into existing delegate and trace surfaces.

### Notification Types

MVP notifications are lifecycle or observation records only:

```ts
type ActorNotificationType =
  | "completed"
  | "failed"
  | "cancelled"
  | "progress"
  | "output";
```

There is intentionally no `"message"` type. Adding arbitrary actor-to-actor
messages would reintroduce a generic bus without the typed control surface or
policy model needed to make it safe.

### Producer Input

`routeHint` is normalized routing guidance, not point-to-point ownership.
Lifecycle notifications are observations that can fan out to multiple
interested consumers, such as a parent run and a supervising workflow. The MVP
keeps run routing in `routeHint`; non-run target hints are intentionally
deferred until a concrete receiver needs them.

```ts
interface ActorRouteHint {
  parentRunId?: string;
  targetRunId?: string;
  sessionId?: string;
}

interface ActorNotificationInputBase<TPayload> {
  source: ActorRef;
  routeHint?: ActorRouteHint;
  type: ActorNotificationType;
  /** Optional producer correlation id. Not a storage id or dedup key. */
  correlationId?: string;
  payload: TPayload;
  outputRef?: string;
  suggestedContext?: boolean;
}
```

`suggestedContext` is a hint only. The receiver-side inbox or
`NotificationSource` policy decides whether a notification becomes model
context and how it is summarized.

### Accepted Notification

The inbox assigns `sequence` when a notification is accepted into that inbox.
Sequence is inbox-scoped and monotonic for sorting by that consumer. This avoids
promising global or per-target FIFO that later durable or multi-producer inboxes
may not be able to guarantee.

For durable adapters, `sequence` is a consumer-observed ordering contract, not
necessarily a persisted counter. A file-backed adapter may lazily derive
monotonic sequence numbers from its stable sorted storage ids when draining or
peeking. The first slice should not force a task outbox file-format migration
only to add a counter, and a single durable counter would be fragile for future
cross-process writers. If a durable adapter derives sequence from sorted storage
ids, the monotonic guarantee is strict within a returned `peek()`/`drain()`
batch. Across batches it must either maintain a high-water mark or document the
cross-batch order as best-effort so a late-arriving older storage id cannot
produce an observed sequence lower than one already returned.

```ts
interface ActorNotificationBase<
  TPayload,
> extends ActorNotificationInputBase<TPayload> {
  /** Inbox/outbox-assigned storage identity, not a producer dedup key. */
  id: string;
  sequence: number;
  qos: "lossy" | "reliable";
  createdAt: string;
}
```

`qos` is derived from `type` at construction/acceptance time. Producers do not
set it.

| Type        | QoS        | MVP drop rule                                                                                                |
| ----------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| `completed` | `reliable` | Must be accepted, backpressured, or error. Never silently dropped.                                           |
| `failed`    | `reliable` | Must be accepted, backpressured, or error. Never silently dropped.                                           |
| `cancelled` | `reliable` | Must be accepted, backpressured, or error. Never silently dropped.                                           |
| `progress`  | `lossy`    | May be dropped under capacity or coalescing policy.                                                          |
| `output`    | `lossy`    | May be dropped when it only signals output availability; large output stays in task/output/artifact storage. |

`output` is part of the target vocabulary, but the first implementation can
defer emitting output notifications. Terminal notifications should carry
`outputRef` when output is available; large output remains in task output,
artifact, or future workflow state storage.

### Delivery Result

`dropped` is legal only for lossy notifications. Reliable notifications must
return `accepted`, apply backpressure, or throw. Producer-facing delivery
results do not expose `sequence`: one accepted notification may fan out to
multiple inboxes, and each inbox assigns its own sequence.

```ts
type DeliveryResult =
  | { status: "accepted"; acceptedCount: number; droppedCount?: number }
  | {
      status: "dropped";
      reason: "capacity";
      droppedCount: number;
    };

interface ActorNotificationSink {
  deliver(
    input: AnyActorNotificationInput,
  ): DeliveryResult | Promise<DeliveryResult>;
}

type ActorNotificationPredicate = (
  notification: AnyActorNotification,
) => boolean;

interface ActorInbox {
  peek(
    predicate?: ActorNotificationPredicate,
  ): readonly AnyActorNotification[] | Promise<readonly AnyActorNotification[]>;
  drain(
    predicate?: ActorNotificationPredicate,
  ): AnyActorNotification[] | Promise<AnyActorNotification[]>;
  waitUntilAvailable(options?: {
    signal?: AbortSignal;
    predicate?: ActorNotificationPredicate;
  }): Promise<void>;
}
```

For lossy fan-out, `status: "accepted"` means at least one receiver accepted
the notification. `acceptedCount` reports the number of accepted inboxes, and
optional `droppedCount` reports lossy drops in other inboxes. `status:
"dropped"` means no receiver accepted it. Reliable notifications cannot return
partial drop results.

The in-memory MVP should either be unbounded for reliable notifications or
reject/backpressure them explicitly. A bounded queue with drop-oldest behavior
is only valid for lossy entries unless it accounts for reliable entries
separately. Coalescing can reintroduce a `"superseded"` drop reason later only
after the coalescing key is defined.

`ACTOR_INBOX_CAPACITY` is a typed retryable capacity error. The current
in-memory queue uses it when a bounded queue cannot fit another reliable
terminal notification after dropping all available lossy entries.

Permanent input validation failures must be distinguishable from transient
sink failures. In the MVP, `code: "INVALID_ROUTE"` fires in exactly two cases:
an explicit `routeHint.parentRunId`/`routeHint.sessionId` that contradicts the
corresponding `source` field, or a malformed route id (for example an empty
string). It is a typed non-retryable error. Producers with retry
outboxes, including `TaskManager`, should report that through `onSinkError` (or
an equivalent diagnostic) but must not put the invalid notification into a
pending retry queue that can never drain.

Actor-envelope validation errors are also permanent. `code:
"INVALID_ACTOR_NOTIFICATION"` covers inputs whose actor identity splits from
their payload, such as a task `source.id` that differs from `payload.taskId`, a
workflow `source.id` that differs from `payload.workflowId`, or a task
`payload.parentRunId` that differs from the normalized route parent. `code:
"UNSUPPORTED_ACTOR_NOTIFICATION"` covers adapters that cannot support a valid
actor input without changing their storage contract; the current
`FileTaskNotificationOutbox` uses it for non-terminal-task actor inputs and
legacy-file-format lossy actor envelope fields. These codes are non-retryable
for the same poison-queue reason as `INVALID_ROUTE`.

For reliable terminal notifications, the reliability guarantee is carried by
the producer-side outbox/retry path plus the inbox's refusal to silently drop
reliable entries. In the current task manager this means sink failures go to
`pendingNotifications()` and `onSinkError`, while task terminal state remains in
the store. Reliable delivery must not be interpreted as "block terminal task
transition until prompt context is injected." The current task path uses a
synchronous file outbox and should not introduce long-lived backpressure. If a
future non-blocking producer can encounter a backpressured generic inbox, it
must bound its `deliver()` wait and treat timeout like sink failure so task/run
finalization cannot hang indefinitely. Long-lived unresolved `deliver()`
promises are reserved for future producers that explicitly opt into
backpressure and can tolerate it.

### Receiver Policy, Revival, and Awaited Work

Receiver policy is the boundary that decides:

- which notifications belong to this run/workflow/session;
- whether a notification should become model context, trace-only, or UI-only;
- whether pending actor work should keep a run alive waiting for completion.

The current task bridge proves these are three separate decisions. It matches
by `parentRunId`, projects matched terminal notifications into
`NotificationSource`, and uses `TaskRecord.awaited` to decide whether
`TaskRevivalSource` should keep the run in `waiting_tasks`. A generic actor
receiver should extract that shape rather than collapse readiness waiting into
a consuming queue operation.

`awaited` is not a notification type and is not the same as
`suggestedContext`. For tasks it currently lives on `TaskRecord`; workflow
actors need an equivalent state bit or receiver-owned predicate before
fire-and-forget workflows and completion-awaited workflows can share one inbox.

### Payload Typing

The implementation should start with a typed discriminated union instead of
storing an unconstrained `payload: unknown` everywhere. The generic examples
above describe the envelope; concrete producers should narrow it:

```ts
type AnyActorNotificationInput =
  | TaskCompletedNotificationInput
  | TaskFailedNotificationInput
  | TaskCancelledNotificationInput
  | TaskProgressNotificationInput
  | TaskOutputNotificationInput
  | WorkflowCompletedNotificationInput
  | WorkflowFailedNotificationInput
  | WorkflowProgressNotificationInput;

type AnyActorNotification =
  | TaskCompletedNotification
  | TaskFailedNotification
  | TaskCancelledNotification
  | TaskProgressNotification
  | TaskOutputNotification
  | WorkflowCompletedNotification
  | WorkflowFailedNotification
  | WorkflowProgressNotification;
```

This follows the protocol package style and avoids turning the inbox into an
opaque stringly typed bus.

## 6. Feasibility Verdict

The design is feasible, but the implementation has to be rebased on the
post-background-task reality. The host already has a durable task notification
outbox, a receiver bridge, and core context injection. The generic actor inbox
should extract from that path, not replace it with a narrower in-memory queue.

No hard blocker was found. The constraints that must shape implementation are:

- main-host `TaskManager` already wires `FileTaskNotificationOutbox` as its
  sink, so first-slice success must either include a file-outbox adapter or
  explicitly leave the host on the task-specific outbox/bridge;
- acceptance must normalize route facts (`source.runId` ->
  `routeHint.parentRunId`) before storage and reject explicit route facts that
  contradict `source` with `INVALID_ROUTE`;
- permanent validation failures must be typed non-retryable errors so producer
  retry queues do not accumulate poison notifications;
- the existing receiver contract requires predicate `drain()`, non-consuming
  `peek()`, and non-consuming `waitUntilAvailable({ signal, predicate })`;
- durable adapters may derive observed sequence from stable storage order
  rather than migrating existing file entries to persist a counter, but they
  must define cross-batch monotonic behavior;
- file-backed actor inbox views must skip unreadable or actor-invalid durable
  entries with diagnostics rather than letting one bad file poison the entire
  actor listing/readiness path;
- task revival already depends on `awaited` being a receiver/store predicate,
  not merely lifecycle type or context-injection policy;
- reliable terminal notification durability is producer-side outbox/retry plus
  an inbox rule that reliable entries are not silently dropped; it should not
  block terminal task state from reaching the store;
- bounded in-memory queue behavior must distinguish reliable terminal entries
  from lossy progress/output entries. Drop-oldest is acceptable for lossy data
  only.

## 7. MVP Sequence

### Step 0: Use workflow as the probe — implemented in agent-runtime

Before extracting the final interface, sketch the workflow actor notification
inputs beside the task notification inputs. The extraction should be driven by
two producers, not by task alone. The task side still provides the source of
truth for consumer requirements because it is already wired into host revival.

Status: implemented as typed workflow notification input variants in
`packages/agent-runtime/src/tasks/notifications.ts`; no workflow actor runtime
is implemented.

### Step 1: Adapt existing task notification stores to the split interfaces — implemented in agent-runtime

Refactor or wrap the current task notification surfaces to satisfy split
producer/consumer interfaces while preserving task semantics and host behavior:

- terminal notification after terminal transition;
- task store remains source of truth;
- output remains in task output storage or an `outputRef`;
- both `InMemoryTaskNotificationQueue` and `FileTaskNotificationOutbox` expose
  the consumer primitives the host already uses;
- accepted notifications normalize route facts before storage and reject
  contradictory explicit route facts with `INVALID_ROUTE`;
- accepted task/workflow notifications reject split source/payload identities
  with `INVALID_ACTOR_NOTIFICATION`;
- permanent input validation or unsupported-adapter errors are not queued for
  transient retry;
- producer-facing delivery results do not expose inbox sequence;
- file-backed sequence is derived lazily from stable outbox ordering unless a
  later durable design deliberately migrates the file format; cross-batch
  monotonicity uses a high-water mark or is explicitly best-effort;
- the file-backed actor sink is intentionally task-terminal-only for this
  slice and rejects actor-only envelope fields that the legacy JSON format
  cannot preserve;
- no durable behavior regression and no host product behavior regression.

Focused tests should prove existing task notification behavior still works for
both in-memory embedders and the file-backed host path.

Status: implemented for `InMemoryTaskNotificationQueue`,
`FileTaskNotificationOutbox`, and `TaskManager` retry classification. The host
still uses the task-specific `createTaskRevivalBridge()` receiver path; Step 2
will extract receiver policy/context projection.

### Step 2: Extract the receiver policy/context projection shape

Turn the task-specific shape inside `createTaskRevivalBridge()` into an
explicit receiver policy abstraction:

- route predicate: today `parentRunId` and optional `targetRunId`;
- awaited predicate: today `TaskRecord.awaited !== false`;
- context projection: today `pendingNotificationFromTask()`;
- non-consuming readiness wait: today task outbox `waitUntilAvailable()`.

This can start as a task-only adapter. If it is not in the first code slice,
state that the host continues using the task-specific bridge and that generic
actor inbox work is not replacing host task injection yet.

### Step 3: Add workflow actor skeleton

Introduce the smallest workflow actor that can emit typed `progress`,
`completed`, `failed`, or `cancelled` notifications through the same sink. Do
not add peer-to-peer workflow messaging or synchronous RPC. Its first receiver
policy should reuse the Step 2 shape rather than inventing a second route into
model context.

### Step 4: Revisit generic durability

Task notifications already have a durable file outbox. Only after workflow
usage exists should the design decide whether that task-shaped outbox becomes a
generic durable actor inbox or remains an adapter beside a new storage root.
Ack, at-least-once delivery, seen-id deduplication, retention, dead-letter
handling, and GC should be driven by that concrete workflow need.

## 8. Contracts

- Internal actor refs identify SparkWright-owned lifecycle entities only.
- External transports use typed adapter ports rather than the internal actor
  enum.
- Notifications are lifecycle/observation records, not arbitrary commands.
- `source` is required; route fields such as `parentRunId` remain explicit
  compatibility facts and are normalized at acceptance.
- `source.runId` backfills missing `routeHint.parentRunId`; existing task
  `targetRunId` maps directly to `routeHint.targetRunId`. Non-run target hints
  are deferred until a concrete receiver requires them.
- Explicit `routeHint.parentRunId`/`routeHint.sessionId` values that contradict
  the corresponding `source` fields are rejected with `INVALID_ROUTE`;
  `routeHint.targetRunId` is exempt from this consistency check.
- Actor identity must be internally consistent. Task `source.id` matches
  `payload.taskId`, workflow `source.id` matches `payload.workflowId`, and task
  `payload.parentRunId` matches the normalized route parent.
- Current file-backed actor delivery accepts only terminal task notifications
  that can round-trip through the legacy `TaskNotification` JSON entry format.
  Unsupported actor kinds/types or actor-only envelope fields reject with
  `UNSUPPORTED_ACTOR_NOTIFICATION` instead of being persisted lossy.
- Current file-backed actor consumption skips unreadable or actor-invalid
  durable entries and exposes diagnostics through `invalidActorEntries()`;
  legacy task listing remains strict for corrupt JSON.
- Producer-provided `correlationId` is an optional correlation fact only.
  Inbox/outbox storage ids and sequence numbers are assigned by the accepting
  consumer.
- `createdAt` is assigned at inbox acceptance. Producer timestamps such as task
  `deliveredAt` remain payload/metadata facts.
- Accepted notification `sequence` is inbox-scoped and assigned or derived on
  acceptance; producer-facing `DeliveryResult` does not return one sequence.
  Durable adapters may derive the observed sequence from stable storage
  ordering, but must either preserve monotonicity across batches with a
  high-water mark or document cross-batch ordering as best-effort.
- `ActorInbox` exposes predicate `drain()`, non-consuming predicate `peek()`,
  and non-consuming predicate `waitUntilAvailable()`.
- `ActorInbox` does not expose a consuming wait convenience; old
  `waitForNext()` behavior is replaced by `waitUntilAvailable(predicate)` plus
  `drain(predicate)`.
- Producers cannot set `qos`; it is derived from notification type.
- Reliable notifications are never silently dropped by an inbox. Producer-side
  outbox/retry remains responsible for sink failures and must not be confused
  with blocking terminal task state. Non-blocking producers must bound delivery
  waits or only use sinks that cannot long-backpressure their terminal path.
- Reliable capacity overflow uses retryable `ACTOR_INBOX_CAPACITY`; lossy actor
  entries may still be dropped under the configured capacity policy.
- Permanent validation and unsupported-adapter failures such as
  `INVALID_ROUTE`, `INVALID_ACTOR_NOTIFICATION`, and
  `UNSUPPORTED_ACTOR_NOTIFICATION` are not transient sink failures and must not
  enter retry queues.
- Lossy notifications may be dropped or coalesced, but delivery results must
  expose that drop. Coalescing needs a defined key before adding a
  `"superseded"` reason. Partial fan-out reports `status: "accepted"` with both
  `acceptedCount` and `droppedCount`.
- `awaited`/revival is receiver-owned policy over actor state, not a lifecycle
  type and not a context-injection hint.
- Message delivery itself causes no side effects. Only a subscriber calling an
  existing governed primitive, such as tool execution or run control, can cause
  side effects.
- Trace projection is downstream of accepted notifications. Producers do not
  write span ids or raw trace events through the inbox.
- Model context injection is receiver-owned. `suggestedContext` is advisory.
- Existing task notification public APIs should remain compatible while actor
  notification adapters are introduced. Do not force embedders to migrate in the
  first slice.

## 9. First-Slice Test Plan

Agent-runtime focused tests:

- terminal task notifications are still emitted exactly once after
  `completed`, `failed`, or `cancelled`;
- accepted actor notifications receive inbox-scoped monotonic `sequence`
  values;
- file-backed adapters can provide monotonic observed sequence without
  rewriting existing outbox file entries, including the selected high-water
  mark or best-effort cross-batch behavior;
- `createdAt` is assigned at inbox acceptance while task `deliveredAt` remains
  payload/metadata;
- producer-facing delivery results do not expose a single sequence when fan-out
  is possible;
- lossy partial fan-out reports `acceptedCount` plus `droppedCount`, while
  all-dropped fan-out reports `status: "dropped"`;
- route normalization backfills `routeHint.parentRunId` from `source.runId`,
  and existing task `targetRunId` maps directly to `routeHint.targetRunId`;
- an explicit `routeHint.parentRunId` that contradicts `source.runId` is
  rejected with `INVALID_ROUTE`, while a differing `routeHint.targetRunId` is
  accepted;
- actor source/payload identity splits are rejected with
  `INVALID_ACTOR_NOTIFICATION`;
- `qos` is derived from notification type and cannot be supplied by producers;
- reliable terminal notifications cannot be silently dropped by a bounded
  queue;
- file-backed actor delivery accepts legacy-persistable terminal task actor
  notifications, but rejects workflow/progress/output inputs and actor-only
  envelope fields with `UNSUPPORTED_ACTOR_NOTIFICATION`;
- lossy `progress` or `output` notifications can return `dropped` with counts;
- sink delivery failures still use the existing pending/retry path;
- typed non-retryable validation/unsupported failures call the producer's error
  hook but do not enter the pending retry queue;
- producer `correlationId` values do not act as storage ids or seen-id dedup
  keys;
- typed notification unions do not expose `"message"` or request/response
  shapes;
- in-memory and file-backed inbox adapters both support predicate `peek()`,
  predicate `drain()`, and non-consuming predicate `waitUntilAvailable()`;
- a non-consuming readiness wait does not consume the notification before
  step-start `drain()` can inject it.

Host focused tests are required if the first slice touches
`createTaskRevivalBridge()`, host task notification projection, or file-outbox
routing:

- task notifications are filtered by `parentRunId` for the resumed/active run;
- awaited task readiness uses `TaskRecord.awaited` and fire-and-forget tasks do
  not keep the run alive;
- existing task completion context still reaches the core
  `run.notification.injected` path.

Suggested focused commands for the first slice:

```bash
npm --workspace @sparkwright/agent-runtime test -- test/tasks.test.ts
npm --workspace @sparkwright/agent-runtime run typecheck
npm --workspace @sparkwright/host test -- test/task-revival.test.ts
npm --workspace @sparkwright/host run typecheck
```

## 10. Open Questions

- Should `output` notifications be emitted in the first workflow probe, or
  should first-slice code use terminal `outputRef` only?
- Should an inbox expose lossy drop counters through a status API, trace event,
  or both?
- What is the first workflow actor shape: one-shot background workflow, step
  runner, or scheduled workflow?
- Should workflow notification payloads be stored under session state, workflow
  state, or a future actor state root?
- How should actor inbox notifications appear in capability inspection without
  overloading the existing automation summary?
- What is the workflow equivalent of task `awaited`: a store field, receiver
  predicate, run option, or workflow invocation mode?
- What concrete receiver needs non-run target hints, and should that introduce
  a new `targetHint` field or extend `routeHint`?
- Does fan-out need receiver-level diagnostics that expose per-inbox delivery
  identities/results, or is producer-visible `acceptedCount`/`droppedCount`
  enough?
- Working ownership assumption: follow the current `registerKind("agent", ...)`
  split. Portable task/workflow lifecycle types and task-machine helpers live
  in `agent-runtime`; host owns runner registration, config/model/session
  dependencies, and receiver policy wiring that touches the main run.

## 11. Risks

- Adding a generic `"message"` or `request()` API too early would recreate the
  broad runtime bus this design intentionally avoids.
- Making `target` required would force point-to-point semantics onto fan-out
  lifecycle observations.
- Assigning sequence at the sink, or returning one sequence from
  `DeliveryResult`, would break when multiple producers feed one inbox or one
  producer fans out to multiple inboxes.
- Forcing persisted `sequence` into the existing file outbox would create an
  unnecessary durable format migration and a cross-process counter problem.
- Letting durable sequence derivation go backwards across drain batches would
  violate the consumer's observed ordering contract.
- Treating permanent validation errors as transient sink failures would poison
  producer retry queues with entries that can never succeed.
- Allowing producers to set `qos` would let terminal notifications become
  lossy by mistake.
- Allowing long-lived backpressure on TaskManager's awaited `deliver()` path
  would let notification storage hang terminal task finalization callers even
  though the task record already reached a terminal state.
- Treating `suggestedContext` as authority would create a prompt-injection path
  from child actors or external adapters.
- Replacing the host file outbox with an in-memory-only inbox would lose
  detach/resume replay for background task completion.
- Using a consuming wait primitive for revival would eat the notification
  before step-start context injection can drain it.
- Creating a second host context-injection path instead of generalizing
  `NotificationSource` and `createTaskRevivalBridge()` would weaken the current
  receiver boundary.
- Replacing the task notification public API in one step would create avoidable
  embedder breakage; keep compatibility adapters during the first slice.

## 12. Active Map Routing

When implementing this design, start with:

- [../modules/agent-runtime.md](../modules/agent-runtime.md)
- [../modules/host.md](../modules/host.md)
- [../maps/runtime/run-loop.md](../maps/runtime/run-loop.md)
- [../maps/runtime/tool-orchestration.md](../maps/runtime/tool-orchestration.md)
- [../maps/capabilities/agents.md](../maps/capabilities/agents.md)
- [../maps/trace/raw-trace.md](../maps/trace/raw-trace.md)

Likely touched source:

- `packages/agent-runtime/src/tasks/notifications.ts`
- `packages/agent-runtime/src/tasks/manager.ts`
- `packages/agent-runtime/src/tasks/file-notifications.ts`
- `packages/agent-runtime/src/tasks/tools.ts`
- `packages/agent-runtime/src/index.ts`
- `packages/core/src/types.ts`
- `packages/core/src/run.ts`
- `packages/host/src/runtime.ts`
- future workflow actor files under host or agent-runtime, depending on
  ownership chosen during implementation
- `packages/streaming-runtime/src/index.ts` if notification-to-context
  projection changes

## Last Verified

- Status: Verified
- Date: 2026-07-05T00:42:02+0800
- Scope: workflow-runtime-v1 P2 actor-inbox use: host now delivers workflow
  completed/failed terminal notifications through the actor sink shape after
  durable workflow record terminalization, while workflow receiver policy,
  durable workflow notification outbox, waiting emitters, and actor-owned
  episodes remain future slices.
- Read: `packages/host/src/runtime.ts`,
  `packages/agent-runtime/src/tasks/notifications.ts`,
  `packages/agent-runtime/src/workflows/types.ts`,
  `packages/host/test/workflows.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/workflows.test.ts`;
  `npm --workspace @sparkwright/agent-runtime test -- test/workflows.test.ts
test/doc-store.test.ts`.

- Status: Verified
- Date: 2026-07-03T08:52:33+0800
- Scope: partial implementation checkpoint: Step 0 workflow notification input
  probes and Step 1 split producer/consumer actor notification interfaces are
  implemented in agent-runtime. `InMemoryTaskNotificationQueue` and
  `FileTaskNotificationOutbox` now adapt to actor sink/inbox surfaces while
  preserving legacy task APIs; route normalization, typed non-retry handling
  for route conflicts, actor identity splits, and unsupported file-backed actor
  inputs, retryable capacity overflow, derived QoS, acceptance-time
  `createdAt`, delivery results without sequence, file-backed high-water
  sequence derivation, and file-backed actor invalid-entry skipping are
  covered. Host receiver policy extraction and workflow actor runtime remain
  future steps.
- Read: `docs/_internal/project-map/README.md`,
  `docs/_internal/project-map/modules/agent-runtime.md`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/maps/runtime/run-loop.md`,
  `docs/_internal/project-map/maps/runtime/tool-orchestration.md`,
  `docs/_internal/project-map/maps/capabilities/agents.md`,
  `docs/_internal/project-map/maps/trace/raw-trace.md`,
  `packages/agent-runtime/src/tasks/notifications.ts`,
  `packages/agent-runtime/src/tasks/file-notifications.ts`,
  `packages/agent-runtime/src/tasks/manager.ts`,
  `packages/agent-runtime/src/tasks/index.ts`,
  `packages/agent-runtime/test/tasks.test.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/test/task-revival.test.ts`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
test/tasks.test.ts`; `npm --workspace @sparkwright/agent-runtime run
typecheck`; `npm --workspace @sparkwright/host test --
test/task-revival.test.ts`; `npm --workspace @sparkwright/host run
typecheck`.

- Status: Read-only
- Date: 2026-07-02T23:31:28+0800
- Scope: fourth-pass tightening: adopted the strict route-consistency rule —
  explicit `routeHint.parentRunId`/`routeHint.sessionId` that contradict the
  corresponding `source` fields are rejected with `INVALID_ROUTE`
  (`routeHint.targetRunId` exempt), and `INVALID_ROUTE` is now defined by
  exactly two MVP conditions (source contradiction, malformed route id).
  Retained all third-pass decisions: no `targetHint` input, acceptance-time
  `createdAt`, non-retryable validation errors, batch/high-water-mark sequence
  derivation.
- Read: `docs/_internal/project-map/README.md`,
  `docs/_internal/project-map/modules/agent-runtime.md`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/maps/capabilities/agents.md`,
  `docs/_internal/project-map/maps/runtime/run-loop.md`,
  `packages/agent-runtime/src/tasks/notifications.ts`,
  `packages/agent-runtime/src/tasks/manager.ts`,
  `packages/agent-runtime/src/tasks/file-notifications.ts`,
  `packages/agent-runtime/src/index.ts`,
  `packages/core/src/types.ts`,
  `packages/core/src/run.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/src/traced-process-runner.ts`,
  `packages/core/src/workflow-hooks.ts`,
  `packages/streaming-runtime/src/index.ts`.
- Tests: not run; documentation-only design refresh.
