# @sparkwright/trace-perfetto

Subscribe to a SparkWright `EventLog` and produce a Chrome Trace Event JSON
file that can be opened at [ui.perfetto.dev](https://ui.perfetto.dev) for a
flamegraph view of the run.

## Why

The JSONL trace ([ADR 0006](../../docs/adr/0006-jsonl-traces-with-tiered-detail.md))
is the source of truth, but it is not visual. For debugging an agent loop,
nothing beats seeing spans nested by parent/child on a timeline. This package
is the translation layer — it never mutates the event stream, only subscribes.

## Usage

```ts
import { createRun } from "@sparkwright/core";
import { attachPerfettoSink } from "@sparkwright/trace-perfetto";

const run = createRun({
  /* … */
});

const sink = attachPerfettoSink({
  source: run.events, // anything exposing subscribe((event) => void)
  outPath: ".sparkwright/trace-perfetto/" + run.id + ".json",
});

try {
  await run.execute();
} finally {
  sink.close(); // writes the file
}
```

Open the resulting file in <https://ui.perfetto.dev> (drag-and-drop).

## Pairing strategy

Events become a Perfetto "complete" event (`ph: "X"`) with a duration when
the sink can pair a start and an end. It tries, in order:

1. **`spanId` correlation** ([ADR 0008](../../docs/adr/0008-span-correlation-and-trace-sinks.md)) —
   the preferred path. Use `withSpan()` from `@sparkwright/core` to get
   automatic span ids.
2. **Type-suffix heuristic** — `tool.started` ↔ `tool.completed` per run,
   for code that hasn't migrated to `withSpan` yet. Less reliable when
   multiple in-flight operations share a prefix.
3. **Instant marker** — any event that can't be paired becomes a `ph: "i"`
   marker, so nothing is silently dropped.

## Lanes (`pid` / `tid`)

By default, each run gets its own `pid` and each sub-agent its own `tid`
(derived from the `agent.name` metadata field, falling back to the semantic
`agent.role`; the main thread stays on `tid=1`). Override `laneFor` to
customize.

## Agent-level semantics

Spans opened via `withSpan(..., { semantics })` carry optional agent-level
annotations — `agentRole`, `toolSelectionReason`, `decisionKind` — written
into start/end event metadata under stable keys (`SPAN_SEMANTIC_METADATA_KEYS`
in `@sparkwright/core`). The sink surfaces them so a trace reflects _agent
intent_, not just LLM/tool mechanics:

- `args.semantics` on each complete span exposes all three fields for
  inspection and audit.
- `decisionKind` is folded into the Perfetto `cat` (e.g. `tool,plan`) so the
  UI can group and color spans by decision phase (plan / act / observe / …).
- `agentRole` feeds the lane assignment above, so multi-role traces split into
  per-role `tid` lanes even without an explicit `agent.name`.

```ts
await withSpan(
  events,
  {
    startType: "tool.started",
    endType: "tool.completed",
    semantics: {
      agentRole: "planner",
      toolSelectionReason: "cheapest read tool for the file",
      decisionKind: "plan",
    },
  },
  () => readFileTool.run(args),
);
```
