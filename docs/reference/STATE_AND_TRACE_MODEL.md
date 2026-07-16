# State And Trace Model

This is a reference contract. If you are new to SparkWright, start with
[the documentation map](../README.md) or the [User Manual](../guides/USER_MANUAL.md).

SparkWright treats state as a set of narrow, layered contracts rather than one
global application database. The runtime kernel owns the smallest possible
execution state; embedders own product state, gateway routing, durable storage,
and visualizations through replaceable stores and sinks.

This document is the map for that boundary. It complements
[Architecture](./ARCHITECTURE.md), [Protocol](./PROTOCOL.md), and the trace ADRs.

## Design Posture

The core rule is:

```txt
Facts enter the append-only event stream first.
Stores, indexes, dashboards, and replay tools derive from those facts.
```

That keeps SparkWright usable as a kernel inside CLIs, IDEs, gateways, CI jobs,
servers, and workflow engines without forcing every embedder to adopt the same
database or observability backend.

## Identity Boundaries

SparkWright uses several ids. They are intentionally not interchangeable.

| Id                      | Scope                      | Owner                     | Purpose                                                                              |
| ----------------------- | -------------------------- | ------------------------- | ------------------------------------------------------------------------------------ |
| `sessionId`             | Multiple runs              | Embedder / `SessionStore` | Groups related runs into one conversation or working session.                        |
| `runId`                 | One run                    | Core runtime              | Routes lifecycle, events, artifacts, result, and persistence for a single execution. |
| `event.id`              | One event                  | Core runtime              | Identifies a single append-only fact.                                                |
| `event.sequence`        | One run                    | Core runtime              | Orders events inside a run.                                                          |
| `SessionEvent.sequence` | One session                | `AppendOnlySessionStore`  | Orders session-level facts and replay projections.                                   |
| `traceId`               | One trace tree             | Core span layer / sink    | Groups correlated spans for visualization.                                           |
| `spanId`                | One bracketed unit of work | Core span layer           | Correlates start/end events and instant child events.                                |
| `parentSpanId`          | One parent span            | Core span layer           | Reconstructs trace hierarchy.                                                        |

Routing identity is `runId` inside the kernel and `sessionId` at the session
edge. Span fields are presentation and correlation data only; they must not be
used to decide ownership, permissions, or resume behavior.

Use `createSessionId()` for new sessions and `asSessionId()` when adapting a
host- or gateway-provided string into the typed core surface. The brand is a
compile-time guardrail; the wire representation stays a plain JSON string.

## State Layers

### 1. Run State

Run state is the lifecycle for one task. It is represented by `RunRecord`,
`RunResult`, `RunLoopState`, and the in-memory state held by the active
`RunHandle`.

Core owns:

- state transitions: `created`, `running`, `waiting_approval`, `completed`,
  `failed`, `cancelled`
- stop reasons and terminal result signals
- tool/model/approval/workspace lifecycle events
- budget and usage checks
- cancellation and command injection

Persistence boundary:

- `RunStore.append(event)` records the event stream.
- `RunStore.finish(run, result)` records terminal state.
- `RunStore.loadEvents(runId)` enables replay when implemented.
- `createSessionRunStoreFactory(...)` composes a `SessionStore` with any
  `RunStore` factory so run membership is recorded before run evidence is
  persisted.

Default implementation: `FileRunStore`.

### 2. Session State

Session state groups runs. A session is not memory and is not a permission
cache. It is a durable ordering surface for related runs.

Core protocol:

- `SessionRecord`: id, timestamps, ordered `runIds`, metadata, event count
- `SessionEvent`: append-only session-level facts
- `SessionStore`: create/get/append/list
- `AppendOnlySessionStore`: session-local event stream
- `replaySessionEventsFromRunStore`: projects run traces into session order
- `forkSessionFromEvent`: creates a branch for debugging or alternate futures

Default implementations:

- `InMemorySessionStore`
- `FileSessionStore`

Default file layout:

```txt
.sparkwright/sessions/<session-id>/
  session.json
  events.jsonl
```

`events.jsonl` contains session-local facts such as session creation, run
membership, replay projections, and host-level session operations. Manual
session compaction appends `session.compaction.completed` when `compact.json`
is written and `session.compaction.skipped` when no artifact is written; these
events carry durable audit facts and references, not compacted summary content.

### 3. Event And Trace State

Events are the evidence plane. They are append-only, timestamped,
JSON-serializable facts emitted by the runtime and extension boundaries.

Run-level ordering:

```txt
runId + event.sequence
```

Session-level ordering:

```txt
sessionId + SessionEvent.sequence
```

Trace visualization:

```txt
traceId + spanId + parentSpanId
```

Trace persistence is not the same as runtime ownership. JSONL traces, Perfetto
files, OpenTelemetry exporters, and product dashboards are sinks over the same
event facts. Lightweight analytics should read the trace and derive summaries
with helpers such as `summarizeTraceJsonl` / `summarizeTraceFile`; they should
not become a second source of truth.

Host-controlled process runners (`extension.process.*`) follow the same rule:
external scripts may report progress only through host-owned stderr token-line
telemetry, while the host assigns event ids, sequence, timestamps, and span
fields. Redaction remains at the trace persistence boundary (`FileRunStore`),
and large stdout/stderr content should be summarized inline and materialized
through `artifact.created`.

For local integrity checks, `validateSessionTraceConsistency` inspects a
session directory and verifies that session events, run membership, trace
metadata, per-run event sequences, and run/result files agree.
`repairSessionTraceConsistency` can conservatively repair derived
`session.json` fields such as `runIds`, `agents`, `eventCount`, and
`updatedAt`; it never invents missing run/result files and must be explicitly
applied.

Default file layout for session-scoped run traces:

```txt
.sparkwright/sessions/<session-id>/
  trace.jsonl
  transcript.jsonl
  agents/<agent-id>/trace.jsonl
  agents/<agent-id>/transcript.jsonl
  agents/<agent-id>/runs/<run-id>/trace-pointer.json
  agents/<agent-id>/runs/<run-id>/run.json
  agents/<agent-id>/runs/<run-id>/result.json
  artifacts/
  blobs/
```

Session-scoped run directories hold per-run state. `trace-pointer.json` points
back to the session and agent trace files that contain the run's events.
Transcript prompt rows reference leading system messages with `systemRef`; the
referenced array lives only at `blobs/<systemRef>.json`. Rehydration therefore
requires the owning session's `blobs/` directory.

### 4. Runtime Live State

Runtime live state exists only while a run is active in a process. Examples:

- assembled context
- prompt messages
- retry counters
- active model index and fallback count
- repeated tool-call guard state
- pending commands
- in-flight approval waiters
- prefetched context or summaries
- active task notifications

Live state may be summarized into `RunCheckpointV1`, but not every active
resource is automatically resumable. Checkpoints must state resumability
explicitly instead of implying that a paused process can always be restored.
When a checkpoint includes `eventSequence`, it records the last persisted event
sequence for that run so resume can append new events without restarting the
run's sequence numbering.

### 5. Gateway Routing State

Gateways map external conversations to SparkWright sessions.

Typical routing shape:

```txt
platform + chat + thread + optional user -> sessionKey -> sessionId
```

The gateway owns `sessionKey` construction, de-duplication of inbound platform
messages, approval callback routing, and the mapping from active run ids back to
outbound targets.

Kernel rule: gateway state may choose a `sessionId`, but it must not bypass run
policy, approval, workspace boundaries, or trace emission.

Current IM gateway state is file-backed by `GatewayStore` and contains:

- `sessions`: stable `sessionKey -> sessionId` mappings
- `runTargets`: `runId -> outbound target` routing
- `approvalRuns`: `approvalId -> runId` callback routing
- `processedMessages`: bounded inbound message de-duplication

### 6. Workspace And Artifact State

Workspace state is user project state plus durable artifacts produced by a run.
The runtime does not treat raw file edits as invisible side effects.

Expected path:

```txt
tool request -> policy -> approval when needed -> workspace operation -> event -> artifact/result
```

Artifacts are durable outputs such as diffs, patches, reports, logs, files, or
structured JSON. Large data should be stored as artifacts or blobs instead of
being inlined into event payloads.

Checkpoint and rollback support should be modeled as an edge store around
workspace operations. It should produce trace evidence, but it should not become
the canonical run or session store.

### 7. Config And Secret State

Config and secrets are edge state. They decide how a host constructs providers,
tools, policies, stores, and sinks.

Core expectations:

- provider keys and auth tokens must not enter event payloads
- trace stores apply redaction before persistence
- product shells own config loading and secret resolution
- runtime data shapes remain serializable without depending on config files

### 8. Memory And Context State

Memory is context, not session state. Long-term recall belongs behind
`MemoryStore`, `MemoryProvider`, `ContextExtension`, or a custom
`ContextAssembler`.

Session replay should rebuild what happened. Memory retrieval should decide
what is useful for a new run. Keeping those surfaces separate prevents a
resumed session from silently inheriting stale permissions or hidden facts.

`projectSessionReplayToContextItems` is the first replay-to-context bridge. It
projects persisted session events into an explicit `summary` context item with
`source.kind = "session_replay"`, so follow-up runs can see prior trace evidence
without pretending that full process resume occurred.
`projectSessionReplayToTranscript` provides a more human/model-readable
transcript projection for resume workflows that want conversation-shaped
history rather than raw event lines.

The CLI exposes these primitives directly:

```bash
sparkwright trace summary <trace.jsonl> --format text
sparkwright trace events <trace.jsonl> --type tool.failed --limit 20 --jsonl
sparkwright trace timeline <trace.jsonl> --format text
sparkwright trace report <trace.jsonl> --format text
sparkwright session check <session-id> --workspace <repo> --format text
sparkwright session inspect <session-id> --workspace <repo> --compaction --format text
sparkwright session repair <session-id> --workspace <repo> --dry-run
sparkwright session resume <session-id> "next goal" --workspace <repo>
```

`trace report` is the human-oriented diagnostic layer over the same raw trace:
it highlights verdict, efficiency, failure recovery, safety posture, repeated
reads, and cost-reporting gaps without replacing `summary`, `timeline`, or
`verify`. Public `summary.errorCount` remains a raw event count for analytics;
report verdicts derive their high-severity runtime-error findings from
reportable failures after tool-outcome recovery and companion-event correlation.

Host clients can request the same inspection bundle with `session.inspect`,
which returns trace summary, consistency report, and timeline phases in one
response for TUI or dashboard use. With `compaction: true`, `session.inspect`
also returns a compaction audit view derived from `compact.json` and
session-local `session.compaction.*` events. The CLI exposes the same narrow
view as `session inspect --compaction`; it shows artifact paths, counts,
measurement/fingerprint metadata, skipped reasons, warning codes, and
event/artifact consistency without printing the compacted summary body.

The TUI `/sessions` dialog consumes this through the host protocol: press `i`
on a selected session to inspect diagnostics, including the compaction audit
when available, or Enter to switch/resume that session id.

### 9. Task State

Tasks are work spawned by a run and living alongside it. They are not child
runs unless an embedder explicitly models them that way.

Task lifecycle events are `task.created`, `task.started`, `task.output`,
`task.completed`, `task.failed`, and `task.cancelled`. Durable task backends
should implement `TaskStore` in `@sparkwright/agent-runtime` and keep the parent
run id in task metadata.

When a foreground shell is promoted to a task, the host adopts the already
running process instead of restarting it. The promotion path emits
`task.created` before the task span opens with `task.started`. Stdout/stderr
remain durable in `TaskStore`; trace output is mirrored as `task.output` under
the task span; the terminal task event carries `ProcessOutputSummary` with
optional log artifact ids. This path intentionally does not emit
`extension.process.*` lifecycle events.

## Store And Sink Responsibilities

| Surface                  | Required role                                               | Default                    |
| ------------------------ | ----------------------------------------------------------- | -------------------------- |
| `RunStore`               | Persist run events, terminal record, result, and artifacts. | `FileRunStore`             |
| `SessionStore`           | Persist ordered run membership and session metadata.        | `FileSessionStore`         |
| `AppendOnlySessionStore` | Persist session-local events.                               | `FileSessionStore`         |
| `TraceSink`              | Observe/forward event stream without owning persistence.    | `MemoryTrace`              |
| `TaskStore`              | Persist background task lifecycle and output.               | Agent-runtime memory store |
| `MemoryStore`            | Store recall entries for future context assembly.           | In-memory/reference stores |

Stores own durability. Sinks own forwarding or visualization. Neither should
mutate runtime events after emission.

## What Must Emit Events

The following changes should be trace-visible:

- run lifecycle transitions
- model requests, completions, retries, and stream boundaries
- context assembly and compaction
- session compaction attempts
- tool request/start/progress/completion/failure
- approval request and resolution
- policy-denied or approval-denied workspace writes
- workspace reads and writes
- artifacts
- usage updates
- validation and hook outcomes
- task lifecycle
- gateway or host lifecycle events when they affect run/session routing

Prefer existing event types with additional metadata. Add a new event type only
when a new fact cannot be represented without ambiguity.

## What Should Not Be Core State

These are important, but they belong at the edge:

- a mandatory SQLite or Postgres schema
- a mandatory dashboard
- long-term memory provider internals
- provider SDK client caches
- OAuth tokens and API keys
- gateway platform pairing files
- terminal shell process state
- local sandbox filesystem snapshots

SparkWright should define protocols that let these systems attach cleanly.

## Implementation Guidance

When adding stateful behavior:

1. Identify the owner: core, host, gateway, tool, store, sink, or embedder.
2. Decide whether it is durable state, live process state, or derived view
   state.
3. Emit append-only events for facts that affect audit, replay, approval,
   failure analysis, or user-visible behavior.
4. Keep routing ids separate from trace visualization ids.
5. Add store interfaces before adding mandatory storage products.
6. Redact at persistence and forwarding boundaries.
7. Document the file layout or external backend contract.

The preferred direction is a small protocol surface with strong evidence, not a
large central object that remembers everything.
