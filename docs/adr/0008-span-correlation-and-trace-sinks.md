# ADR 0008: Span Correlation Fields and Reference Trace Sinks

## Status

Proposed

## Context

[ADR 0006](./0006-jsonl-traces-with-tiered-detail.md) fixed the trace format as
JSONL of `SparkwrightEvent` and explicitly rejected OTel spans as the primary
shape, on the grounds that "events are facts in a sequence, not durations in a
tree." That decision still stands.

However, consumers downstream of the event stream — debuggers, visualizers,
OTel/Jaeger backends, future per-run flamegraphs — all need to reconstruct
parent/child relationships and durations that are today only implicit in event
pairs (`tool.started` ↔ `tool.completed`, `model.requested` ↔
`model.completed`, etc.). Doing this reconstruction in every sink duplicates
ad-hoc logic and breaks when an extension introduces a new pair.

Surveying prior art in agent-CLI tracing layers (notably their session
tracing utilities) confirmed two patterns worth adopting without inverting
ADR 0006:

1. **Explicit span correlation fields** carried on the event envelope so any
   sink can rebuild the tree without pair-matching heuristics.
2. **A `withSpan` helper** that uses `AsyncLocalStorage` to propagate the
   current span context across async boundaries, so extension authors do not
   thread `parentSpanId` through every call site.

That prior art also ships a Chrome Trace Event ("Perfetto") JSON writer that turns local
runs into a flamegraph viewable in `ui.perfetto.dev`. The cost is small
(~200 lines), the value for debugging an agent loop is large, and it composes
naturally with the existing `EventLog.subscribe` surface.

## Decision

### 1. Add optional correlation fields to `SparkwrightEvent`

Extend the envelope with three optional, additive fields:

```ts
interface SparkwrightEvent<TPayload = unknown> {
  // ...existing fields...
  traceId?: string; // ulid-ish; defaults to runId if omitted
  spanId?: string;
  parentSpanId?: string;
}
```

Rules:

- All three are **optional**. Existing emitters and replayed historical traces
  remain valid — a sink that needs span data MUST treat absence as "no span
  info" rather than an error.
- When present, `(traceId, spanId)` is globally unique within a run; the same
  `spanId` appears on the `*.started` event and its terminating
  `*.completed` / `*.failed` event.
- `parentSpanId` is set from the active span in `AsyncLocalStorage` at emit
  time. The root span of a run has no parent.
- Pure "instant" events (`*.progress`, `context.cache_break.detected`,
  `usage.updated`, etc.) carry the **enclosing** `spanId` as their own
  `spanId` so sinks can attach them to the right bracket; they do not open a
  new span.

Schema change: `schemas/event.schema.json` adds the three properties as
optional strings. Bumps `x-sparkwrightProtocolVersion` to `0.2`. This is
non-breaking by ADR 0006's envelope-stability rule because all three are
optional and ignored by older consumers.

### 2. `withSpan` helper in `@sparkwright/core`

```ts
// packages/core/src/spans.ts
export function withSpan<T>(
  emitter: EventEmitter,
  spec: {
    startType: EventType;
    endType: EventType;
    failType?: EventType;
    payload: unknown;
    metadata?: Record<string, unknown>;
  },
  fn: (spanId: SpanId) => Promise<T> | T,
): Promise<T>;

export function currentSpan(): SpanId | undefined;
```

Implementation:

- Allocates a fresh `spanId` (ulid).
- Reads `parentSpanId` from an `AsyncLocalStorage<SpanId>` keyed by an internal
  symbol. Sets the new id as active for the duration of `fn`.
- Emits `startType` with `{ spanId, parentSpanId }` before `fn` runs.
- Emits `endType` (or `failType`) with the same `spanId` and a
  `durationMs` field merged into metadata when `fn` resolves/rejects.
- Always runs inside `als.run(spanId, fn)` so children emitted from within
  `fn` (including via callbacks scheduled on `setImmediate`, `await`, MCP
  adapter callbacks, etc.) automatically inherit the parent.

This helper is opt-in: core itself does **not** retroactively wrap every
existing `*.started`/`*.completed` pair on day one. Migration is a follow-up,
tracked as a separate Worklog item, so the protocol change can land
independently of call-site churn.

### 3. Reference sinks shipped as separate packages

Two new optional packages subscribe to `EventLog` and translate. Core takes
no dependency on either.

- **`@sparkwright/trace-perfetto`** — Writes Chrome Trace Event format JSON
  to a caller-selected path such as `.sparkwright/trace-perfetto/<run-id>.json`. Each `*.started` /
  `*.completed` pair becomes a `ph: "X"` complete event with `dur`; each
  emitted run / task gets its own `pid`, each sub-agent its own `tid`.
  Drop the file into `ui.perfetto.dev` to visualize. Local-only; no network
  calls. ~250 LOC.

- **`@sparkwright/trace-otel`** — Translates events to OpenTelemetry spans
  via `@opentelemetry/api`. The exporter (OTLP/Console/Jaeger/Honeycomb) is
  selected entirely through the standard OTEL env vars; this package only
  bridges. Consumers who do not install it pay zero bytes for OTel.

Both subscribe via `EventLog.subscribe` only — they cannot mutate the event
stream or block emission. Both treat absence of `spanId` as "synthesize one
from the event id" so they degrade gracefully against pre-0.2 traces.

### 4. Privacy stays a `RunStore` concern

Following ADR 0006's split, redaction and tier filtering remain in the
persistence boundary, not in the span layer. The new sinks receive whatever
the in-process `EventLog` sees (full payloads). Embedders that want
prompt-level redaction in the Perfetto / OTel output configure their sink
wrappers, not core.

## Consequences

Positive:

- Sinks no longer pair-match event names to rebuild trees. The contract is
  on the envelope, not in tribal knowledge.
- `withSpan` makes it cheap for extension authors (skills, custom tools,
  task notifications) to participate in the trace tree correctly.
- Perfetto sink gives the project a debugger-grade visualization with zero
  infra cost; OTel sink unlocks every commercial observability backend
  without polluting core.
- AsyncLocalStorage propagation removes the most common reason extensions
  attach context to the wrong parent.

Negative:

- A second identity scheme (spanId/traceId) exists alongside `runId` and
  `EventId`. We must document precedence ("runId always wins for routing;
  spans are presentation/correlation only").
- `withSpan` requires Node 16+ `AsyncLocalStorage`. Already a baseline
  requirement, but worth restating in `docs/maintainer/ENVIRONMENT.md`.
- Migrating every existing `*.started`/`*.completed` pair to `withSpan` is
  follow-up work; until it lands, sinks see a mixed world (some events with
  `spanId`, some without). Both reference sinks tolerate this.
- Two more packages to release; we add them to
  `docs/maintainer/EXTENSION_RELEASE_CHECKLIST.md`.

## Alternatives considered

- **Make span fields required.** Rejected: breaks ADR 0006's append-only,
  permissive envelope and forces every emitter (including third-party
  extensions on day zero) to thread span ids before tooling exists to make
  that easy.
- **Embed OTel `@opentelemetry/api` in core.** Rejected: contradicts the
  "core depends on nothing observability-shaped" principle and bloats every
  embedder, including those who only want JSONL.
- **Generate Perfetto output from JSONL post-hoc (CLI tool, not a sink).**
  Considered viable as a complement, but a live subscriber lets `tail -f`
  workflows work too. We may add a `sparkwright trace to-perfetto` CLI later
  for replay; it shares the same translator.
- **Use W3C `traceparent` header format for `traceId`.** Deferred: useful
  when SparkWright runs inside a larger OTel-instrumented process, but
  out-of-scope for v0.2. The `trace-otel` sink can synthesize a
  `traceparent` from `traceId` + root `spanId` at export time.

## Follow-Up

1. Schema PR: bump to `0.2`, add the three optional fields, update
   `docs/reference/PROTOCOL.md` ("Span correlation" section) and
   `docs/reference/PROTOCOL_CHANGELOG.md`.
2. Implement `withSpan` + `currentSpan` in `packages/core/src/spans.ts`,
   export from `packages/core/src/index.ts`, cover with unit tests.
3. Migrate `model.requested`/`model.completed`, `tool.*`, and `task.*`
   emit sites to `withSpan` in a follow-up PR. Skill / MCP extensions
   migrate independently.
4. New packages `packages/trace-perfetto`, `packages/trace-otel` with
   readmes pointing at `ui.perfetto.dev` and the relevant OTEL env vars.
5. Update `docs/maintainer/AI_TASK_INDEX.md` with "Add a trace sink" recipe so future
   AI-led work follows the same shape (subscribe + translate, never mutate).
