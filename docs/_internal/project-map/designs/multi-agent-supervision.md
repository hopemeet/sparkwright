# Multi-Agent Invocation Supervision

Status: active staged refactor

## Purpose

Converge SparkWright's configured, indexed, parallel, dynamic, task-owned,
ACP, external-command, and direct-CLI Agent paths onto one invocation and
lifecycle substrate without moving Host governance into core or creating a
generic actor bus.

This design is below the future interactive execution-lane coordinator. One
interactive execution may own many child invocations; an Agent supervisor must
not become a second lane scheduler or run-chain driver.

## Frozen Ownership

- `@sparkwright/agent-runtime` owns portable invocation data, lifecycle state
  transitions, terminal projection, cancellation bookkeeping, and parent-visible
  Agent event projection.
- `@sparkwright/host` owns profile/tool/model resolution, workspace-access
  admission, approvals, process sandboxing, resource leases, and adapter
  construction.
- `@sparkwright/core` owns one run loop, policy/approval execution, event schema,
  budgets, and workspace-write facts. It does not gain Agent adapter branches.
- `@sparkwright/server-runtime` remains the future owner of interactive
  execution-lane queueing, idempotency, capacity, and active-execution
  handoff. Agent supervision does not coordinate different sessions.

## Invariants

1. One immutable invocation identity is reused across every lifecycle phase.
2. An invocation that has not passed Host admission must not emit `started`.
   `admission_pending` is the pre-start state; it is initially reserved in the
   pure data contract before event consumers migrate.
3. Every admitted invocation emits at most one terminal phase.
4. Cancellation is idempotent and reaches the actual child owner (run, task, or
   process), not only its parent tool call.
5. Approval remains a policy decision, not a supervisor shortcut. Two approved
   write-capable children may still need serialization; that is concurrency
   safety, not authorization bypass.
6. Result reuse is exact and parent-scoped. It never substitutes lifecycle or
   resource ownership for a running invocation.
7. Parent/child/session/profile/task identity is stable across transports.

## Prepared Data Boundary

`PreparedAgentInvocation` is serializable data only. It contains stable
identity, routing, transport, depth, optional governance facts, and the
`admission_pending` state. It deliberately excludes models, tools, policies,
emitters, run handles, process handles, and callbacks.

The first migration replaces the in-process `MultiAgentFacts` object and the
ACP/external-command hand-built lifecycle metadata. Event flow remains on the
existing adapters until the supervisor phase. Pure-data projections are tested
directly; lifecycle event streams are not double-executed in shadow mode.

## Target Supervisor Boundary

The supervisor will accept an admitted prepared invocation plus one adapter:

```txt
Host prepares identity + governance
  -> Host admission/lease
  -> AgentSupervisor.start(admitted invocation, adapter)
      -> requested/admission/started
      -> adapter execution
      -> one completed|failed terminal
      -> cancellation + lease release
```

Adapters expose start/cancel/result observation only. They do not emit
`subagent.*` themselves after migration. In-process core runs, task-owned runs,
ACP workers, and external commands keep their native execution mechanisms.

## Resource Arbitration

Workspace arbitration is Host-owned and process-wide, keyed by canonical
workspace root rather than by connection. Read-only work may share; write work
is serialized unless a later conflict detector proves disjoint scopes.

The first write lease must include an escape hatch from day one:

- bounded TTL;
- holder heartbeat/renewal;
- idempotent release;
- expired non-renewing-holder takeover and inspectable owner/queue facts;
- cancellation/finally release;
- no claim of cross-process safety.

The implemented first slice is a process-local fair RW lease coordinator shared by
HostRuntime connections. `spawnSubAgent` exposes an embedder-owned asynchronous
admission seam so in-process children do not enter the Supervisor's admitted
state before a lease is acquired; process adapters use the same coordinator before
their native start signal. Lifecycle metadata carries workspace/concurrency
facts, and the requested-to-started gap exposes queue delay without adding a
second lifecycle event family.

TTL is an availability lease, not a fencing generation. The current slice has
no durable expiry audit, cannot exclude a stale holder after takeover, does not
coordinate other OS processes, and does not serialize non-Agent parent tools.
Those boundaries must remain explicit until Host workspace admission gains a
fenced cross-process protocol.

This Agent lease is the starting point for a generalized Host
`WorkspaceLeaseCoordinator`; it must not remain as a second permanent owner.
The future execution-lane coordinator owns scheduling capacity, not workspace
mutation exclusion. Concrete tool, Agent invocation, and external-process
mutation windows acquire Host workspace leases independently so a waiting
lease does not consume a lane worker for the lifetime of a model execution.

## Communication Boundary

Do not add a universal Agent bus. Parent-visible lifecycle and bounded results
stay on `subagent.*`/tool results. Task and Workflow notifications retain their
narrow typed inbox/outbox contracts. Any expansion of `ActorRef` routing must
add a concrete consumer and delivery semantics in the same phase.

`InternalActorKind` therefore exposes only `task | workflow` today. A task
payload may still use `kind:"agent"` to select the Agent task runner; that is
not an Agent actor-notification lane.

## Delivery Sequence

1. Correctness fixes: argument-level concurrency, exact result identity, unique
   process child ids. Complete.
2. Lifecycle characterization across all entrypoints. Complete.
3. Mechanical module split. Complete.
4. `PreparedAgentInvocation` pure-data boundary; migrate existing metadata
   builders. Complete.
5. `AgentSupervisor`; migrate one adapter at a time and retire adapter-owned
   lifecycle emission. Fix process admission ordering and terminal parity here.
   Complete.
6. Host workspace lease coordinator with TTL/heartbeat and Core-backed in-process
   descendant-tree work-budget enforcement. Complete.
7. Narrow task/communication cleanup and release verification. Complete.

Each behavioral phase must delete or migrate at least one parallel mechanism.
Large event-stream shadow execution is out of scope; characterization tests are
the migration oracle.

## Known Migration Debts

- Workspace exclusion is process-local, Agent-only, and unfenced. Generalizing
  it across Host mutation paths and adding cross-process fencing remain future
  Host workspace-admission work, independent of execution-lane scheduling.
- ACP/external-command process-internal model/tool usage remains opaque to Core
  descendant-tree accounts; only their parent tool call is budget-visible.

## Last Verified

- Status: Verified
- Date: 2026-07-16T08:56:29+0800
- Scope: aligned the completed supervision design with the sole canonical Host
  workspace lease coordinator after compatibility removal.
- Read: Host coordinator, Agent adapters, and supervision ownership boundary.
- Tests: focused Host 70/70, Host typecheck, and the full release gate passed.

- Status: Read-only
- Date: 2026-07-14
- Scope: aligned the completed Agent supervision boundary with the re-baselined
  execution-lane proposal. Agent lifecycle remains below the lane coordinator;
  the current lease coordinator is the migration source for a separate Host
  workspace lease service rather than a scheduler-owned turn lock.
- Read: `packages/agent-runtime/src/agents/supervisor.ts`,
  `packages/host/src/workspace-lease-coordinator.ts`,
  `packages/host/src/runtime.ts`, and
  `docs/_internal/proposals/session-agent-host-coordinator.md`.
- Tests: not run; proposal/map-only review.

- Status: Verified
- Date: 2026-07-14
- Scope: completed the staged multi-Agent supervision migration, narrowed actor
  notification kinds to concrete consumers, and verified the integrated tree.
- Read: all staged implementation seams, linked capability/module maps, and
  focused characterization suites.
- Tests: full `npm run release:check`, including the regression matrix and both
  source/release installation smoke suites.
