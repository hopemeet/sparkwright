# ADR 0007: Buffered Emitter For Pre-Run Extension Events

## Status

Accepted

## Context

Several extension packages (`@sparkwright/skills`, `@sparkwright/mcp-adapter`, `@sparkwright/agent-runtime`) perform work that produces meaningful trace events **before a run exists**. Skill indexing walks the filesystem and emits `skill.indexed`; MCP server preparation handshakes with each configured server and emits `mcp.server.prepared`; agent-profile derivation emits `agent.profile.derived`. These are edge-lifecycle facts the auditor expects to see in the run's `trace.jsonl` — but they happen during the construction of the inputs to `createRun()`, not during the run loop itself.

This produces a chicken-and-egg tension:

- The events belong to a specific run (the one that consumes the indexed skills / prepared servers / derived profile).
- The `EventLog` that owns sequence numbers and listener fan-out is created **inside** `createRun()`. It does not exist when the extension work runs.
- Pushing the extension events into the run **after** it starts would lose the "emit as it happens" semantics the rest of the kernel relies on, and would force every extension package to invert its control flow around a deferred-emit queue.
- Extension packages are intentionally decoupled from `EventLog` — they should depend on the _protocol_ of emission, not the reference implementation, so alternative emitters (scoped, filtered, multi-sink) remain possible.

A solution must let extensions emit naturally during their own work, defer materialization of `id` / `sequence` / `runId` until a real `EventLog` exists, and keep the wiring explicit at the example-runtime layer rather than hidden in core.

## Decision

Two protocol-level constructs in `packages/core/src/events.ts`:

1. **`EventEmitter`** — the minimal interface (`emit(type, payload, metadata?)`) that every extension package accepts as an **optional** constructor argument. `EventLog` `implements EventEmitter`. If the caller passes `undefined`, the extension silently no-ops emission. This decouples extensions from the reference `EventLog` and from any requirement that a run exist.

2. **`BufferedEmitter` + `createBufferedEmitter()`** — an `EventEmitter` that records `(type, payload, metadata)` tuples into an in-memory buffer and returns a placeholder `SparkwrightEvent` to satisfy the contract. `flush(target: EventEmitter)` drains the buffer into a real emitter (typically `run.events`) in original order, at which point each entry is re-emitted with a real id, sequence number, and run id assigned by the target.

The capability-runtime example (`examples/capability-runtime/run.ts`) demonstrates the canonical wiring: create a buffered emitter, pass it to skill indexing / MCP preparation / agent-profile derivation, then call `createRun(...)`, then `pendingEvents.flush(run.events)`. Extension events land in the run's trace in the order they were emitted, with sequence numbers contiguous with the run's own events.

## Consequences

Positive:

- Extension packages can emit at the natural point in their own control flow without knowing whether a run exists yet.
- Extension packages depend only on the `EventEmitter` interface, not on `EventLog`. Alternative emitters (scoped, filtered, test doubles) drop in without code changes.
- The buffered emitter preserves emission order, so the trace shows extension work in the sequence it actually happened.
- Wiring is **explicit** at the embedder layer (one `createBufferedEmitter()` call, one `flush()` call). The kernel does not need a global registry or a special pre-run mode.
- Listeners on `EventLog` see flushed events normally, so live-trace consumers and `FileRunStore` need no special case.

Negative:

- If the embedder forgets to call `flush()`, buffered events are silently lost. This is a deliberate trade — alternatives that auto-flush would require global state or implicit coupling between buffer and run. The example and docs make the pattern visible.
- Buffered events receive their final `id` / `sequence` / `timestamp` at flush time, not emit time. This is acceptable for edge-lifecycle events (the `metadata` payload can carry an originating timestamp if needed) but would be wrong for events whose ordering relative to in-run events is semantically meaningful.
- Two emitter shapes (`EventEmitter`, `BufferedEmitter extends EventEmitter`) is mildly more surface area than a single emitter, but the inheritance keeps consumers unaware of the buffering behavior they don't need.

## Alternatives considered

- **Defer all extension emits until after `createRun`.** Rejected: forces every extension package to either return an event log of its own or hand back a queue, both of which invert the natural control flow and complicate composition (skills + mcp + agent-runtime all need their own deferred queues).
- **Core exposes a process-global emitter singleton.** Rejected: kills test isolation, pollutes concurrent runs in the same process, and silently couples unrelated callers. Inverts the kernel's general posture of explicit dependency wiring.
- **Extension packages take a concrete `EventLog` instance.** Rejected: requires the run to exist first (forcing pre-run extension work to be re-architected), and tightens coupling against the reference implementation rather than the protocol — which is exactly what the v0.1 protocol-interface work was unwinding.
- **Synthesize a "pre-run" `EventLog` and merge it after `createRun`.** Rejected: merge semantics (renumbering, listener replay, id rewriting) are subtler than a buffer-then-replay, and a partial `EventLog` would still need most of the buffering machinery internally.

## Follow-Up

Reference implementation: `EventEmitter`, `BufferedEmitter`, `createBufferedEmitter` in `packages/core/src/events.ts`. Canonical wiring example: `examples/capability-runtime/run.ts`. The four edge-lifecycle events that motivated this pattern are listed in `docs/TRACE_EXTENSION_EVENTS.md`. A future revision may attach an originating timestamp to buffered entries so that consumers can distinguish emit time from flush time when the gap is material.
