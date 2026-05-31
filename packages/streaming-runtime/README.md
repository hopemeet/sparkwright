# @sparkwright/streaming-runtime

After-turn streaming runtime for Sparkwright.

This package is optional and does not modify `@sparkwright/core`'s reference
run loop. It consumes a `ModelAdapter.stream()` implementation, emits streaming
events, assembles the complete assistant turn, and only then executes requested
tools through Sparkwright validation, policy, approval, and tool lifecycle
events.

## Mode

The initial mode is intentionally conservative:

```txt
stream model chunks
  -> assemble text and complete tool calls
  -> end model turn
  -> execute tools
  -> append tool observations
  -> stream next model turn
```

It does not execute tools eagerly while the model is still streaming.

## Usage

```ts
import { createStreamingRun } from "@sparkwright/streaming-runtime";

const run = createStreamingRun({
  goal: "Inspect the repository",
  model,
  tools,
  workspace,
  streamTimeoutMs: 30_000,
});

for await (const item of run.stream()) {
  console.log(item.type);
}
```

The runtime emits the core streaming event family:

- `model.stream.started`
- `model.stream.chunk`
- `model.stream.completed`
- `model.stream.failed`
- `model.stream.timeout`

Tool calls still use the normal `tool.*`, policy, approval, workspace, and
artifact event paths.
