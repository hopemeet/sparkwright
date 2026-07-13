# Multi-Agent Invocation Supervision

Status: active staged refactor

## Purpose

Converge SparkWright's configured, indexed, parallel, dynamic, task-owned,
ACP, external-command, and direct-CLI Agent paths onto one invocation and
lifecycle substrate without moving Host governance into core or creating a
generic actor bus.

This design is below the future session-turn coordinator. A session turn may
own many child invocations; an Agent supervisor must not become a second
session scheduler or run-chain driver.

## Frozen Ownership

- `@sparkwright/agent-runtime` owns portable invocation data, lifecycle state
  transitions, terminal projection, cancellation bookkeeping, and parent-visible
  Agent event projection.
- `@sparkwright/host` owns profile/tool/model resolution, workspace-access
  admission, approvals, process sandboxing, resource leases, and adapter
  construction.
- `@sparkwright/core` owns one run loop, policy/approval execution, event schema,
  budgets, and workspace-write facts. It does not gain Agent adapter branches.
- `@sparkwright/server-runtime` remains the future owner of session-turn
  scheduling. Agent supervision does not coordinate different sessions.

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
- expired-holder takeover with an audit fact;
- cancellation/finally release;
- no claim of cross-process safety.

This Agent lease is compatible with the future session-turn workspace lock but
must not create a second permanent owner. The session coordinator remains the
target place to hold logical turn leases once wired.

## Communication Boundary

Do not add a universal Agent bus. Parent-visible lifecycle and bounded results
stay on `subagent.*`/tool results. Task and Workflow notifications retain their
narrow typed inbox/outbox contracts. Any expansion of `ActorRef` routing must
add a concrete consumer and delivery semantics in the same phase.

## Delivery Sequence

1. Correctness fixes: argument-level concurrency, exact result identity, unique
   process child ids. Complete.
2. Lifecycle characterization across all entrypoints. Complete.
3. Mechanical module split. Complete.
4. `PreparedAgentInvocation` pure-data boundary; migrate existing metadata
   builders. Complete.
5. `AgentSupervisor`; migrate one adapter at a time and retire adapter-owned
   lifecycle emission. Fix process admission ordering and terminal parity here.
6. Host workspace lease arbiter with TTL/heartbeat, then tree-level budget
   enforcement.
7. Narrow task/communication cleanup and release verification.

Each behavioral phase must delete or migrate at least one parallel mechanism.
Large event-stream shadow execution is out of scope; characterization tests are
the migration oracle.

## Known Migration Debts

- ACP and external-command adapters currently emit `started` before
  workspace-access admission and omit `terminalState` on successful terminal
  events.
- Indexed delegation currently preserves the hidden direct delegate's
  `entrypoint:"delegate"` instead of the indexed surface identity.
- Per-connection `HostRuntime` does not coordinate workspace writers across
  clients; the compatibility path remains until a process-wide owner is wired.
