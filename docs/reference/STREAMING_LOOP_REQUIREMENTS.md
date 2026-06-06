# Streaming Loop Requirements

This document defines requirements for streaming loops. The first optional
implementation is `@sparkwright/streaming-runtime`, which supports conservative
after-turn streaming without modifying the core reference loop.

The v0 loop is synchronous on purpose: assemble context, call the model, validate normalized output, run tools, append observations, and repeat. That path should stay small and reliable while streaming requirements mature around it.

## Why Streaming Needs A Separate Contract

Streaming introduces partial model output, provider chunk timeouts, cancellation during in-flight work, and possible concurrent tool calls. Those behaviors should not be hidden inside the v0 loop by incidental callbacks.

A streaming loop needs explicit protocol surfaces for:

- model stream start, chunk, completion, and failure
- provider chunk timeout
- cancellation and cleanup during model or tool execution
- partial assistant text
- partial or incremental tool-call assembly
- concurrent tool-call policy
- usage and cost accounting as it becomes available

## Implemented First Step: After-Turn Streaming

`@sparkwright/streaming-runtime` consumes `ModelAdapter.stream()`, emits
streaming model events, assembles the full assistant turn, and only then runs
tools through normal validation, policy, approval, and tool lifecycle events.
It intentionally does not execute tools eagerly while the model stream is still
active.

```ts
import { createStreamingRun } from "@sparkwright/streaming-runtime";

const run = createStreamingRun({
  goal,
  model,
  tools,
  workspace,
});
```

## Required Event Shape

Streaming events should remain append-only and trace-friendly. Current event
types:

- `model.stream.started`
- `model.stream.chunk`
- `model.stream.completed`
- `model.stream.failed`
- `model.stream.timeout`
- `tool.batch.requested`
- `tool.batch.completed`
- `run.cancel_requested`

The event families stay separate from the synchronous `model.requested` and
`model.completed` events so frontends can distinguish partial stream telemetry
from completed normalized model output.

## Cancellation Requirements

v0 supports manual cancellation as a terminal result and `run.cancelled` event. v1 streaming should add cleanup semantics:

- cancellation can be requested while a model stream is active
- cancellation can be requested while a tool is active
- provider abort signals are propagated when supported
- tool cleanup hooks can run when supported
- trace records whether cleanup was attempted and whether it completed

Cancellation must stay distinguishable from timeout, denial, and provider failure.

## Compaction Requirements

v0 emits `context.compaction_requested` when budget pressure is observed. v1 can add actual compaction without replacing the loop:

- compaction should be an explicit loop signal, not hidden prompt mutation
- compaction should emit events before and after summary creation
- summaries should reference omitted context and related artifacts
- failed compaction should not erase the original trace

Candidate events:

- `context.compaction.started`
- `context.compaction.completed`
- `context.compaction.failed`

## Concurrent Tool Calls

The v0 runtime handles tool calls sequentially. v1 may support concurrent tool calls only after these rules are explicit:

- policy and approval are checked per tool call
- workspace writes remain serialized or conflict-checked
- event ordering stays deterministic enough for replay
- partial failures do not hide successful tool results
- callers can configure max concurrency

## Non-Goals For v1 Streaming

Streaming support should not require:

- a fully generalized session-processor abstraction
- multi-agent orchestration
- long-term memory
- a GUI trace viewer
- broad provider routing

Those may arrive later, but the first streaming loop should preserve Sparkwright's small kernel shape.
