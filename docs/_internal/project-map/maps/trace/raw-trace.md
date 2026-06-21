# Raw Trace

## Purpose

Raw trace is the durable append-only event log. It lets maintainers reconstruct
what happened without relying on product UI state.

See [summary-timeline-verify.md](summary-timeline-verify.md) for derived views
and [../session/session-store.md](../session/session-store.md) for session layout.

## Main Files

- `packages/core/src/trace.ts`
- `packages/core/src/trace-codec.ts`
- `packages/core/src/trace-store.ts`
- `packages/core/src/trace-session-consistency.ts`
- `packages/core/src/events.ts`
- `docs/adr/0006-jsonl-traces-with-tiered-detail.md`
- `docs/reference/PROTOCOL.md`
- `docs/reference/RUN_EVENTS.md`

## Data Flow

```txt
EventLog emits full event
  -> FileRunStore.prepareTraceEvent() in trace-store.ts
  -> filterTraceEvent(level) in trace-codec.ts
  -> redactor
  -> append trace.jsonl
  -> materialize artifact files when needed
```

## Contracts

- JSONL: one serialized `SparkwrightEvent` per line.
- Events are ordered by run-local `sequence`.
- `trace.jsonl` is append-only.
- Trace levels filter payload detail: `standard` or `debug`.
- `extension.process.progress` is suppressed in `standard` traces and folded
  into the matching `extension.process.completed` / `failed` event as
  `progressHead`, `progressTail`, and counts; `debug` traces keep raw progress.
- Redaction happens at persistence/forwarding boundaries.
- `trace.ts` remains the named facade for public/core-internal imports; raw
  trace storage is implemented in `trace-store.ts`, while codec/filter/redaction
  primitives are implemented in the dependency-leaf `trace-codec.ts`.
- `artifact.created` remains the materialization boundary for large process
  stdout/stderr logs referenced by `ProcessOutputSummary.artifactIds`.
- Promoted shell task output is traced as `task.output` under the task span and
  summarized on terminal `task.*`; it does not create `extension.process.*`
  lifecycle rows.
- In-process delegate child workspace writes are traced in the child run as
  managed `workspace.write.*` events and summarized to the parent on
  `subagent.*` payloads. Sub-agent lifecycle metadata carries additive audit
  fields (`subagentDepth`, `agentId`, `delegateTool`, `entrypoint`, consistent
  parent/child run ids). SparkWright child-run terminal payloads carry
  `terminalState` and `stepLimitReached`/`truncated` when derived from the child
  `run.*` outcome; external-process parent events must not invent those fields
  without a child `run.*` source.
  MCP tools use normal `tool.*` events; raw traces do not perform filesystem
  side-effect detection.
- External command delegates keep `subagent.*` as their parent-facing lifecycle
  and suppress `extension.process.*`, but still pass a constrained
  `SPARKWRIGHT_TRACE_EVENTS` JSONL inbox to the child process. Accepted progress
  lines are surfaced as a bounded summary on the delegate tool result and
  `subagent.completed.payload.result` (`progressCount`, `progressDropped`,
  `progressHead`, `progressTail`), rather than as raw process lifecycle rows.
- `workspace.write.untracked_access_granted` is an audit-boundary marker for
  external command delegates granted direct read/write workspace access. It
  records access granted / untracked-write-capable only and is not counted as a
  managed `workspace.write.completed` event.
- Skill inline shell preprocessing, when enabled, uses
  `extension.process.*` with `kind: skill_script`; events may be buffered during
  pre-run skill loading and flushed once the run event log exists.
- On-demand `skill.failed` companion events carry the original `toolCallId` so
  raw traces can join them back to the corresponding `tool.failed` event.
- Session-scoped traces aggregate events under `.sparkwright/sessions/<session-id>/trace.jsonl`.
- Agent traces can also be written under `agents/<agent-id>/trace.jsonl`.
- Session run directories do not duplicate trace JSONL; they include
  `trace-pointer.json` with relative links to the session and agent traces.

## Consumers

- CLI `trace events`, `summary`, `timeline`, `report`, and `verify`.
- Host `session.inspect`.
- Session replay and resume fallback.
- External sinks and future trace backends.

## Change Checklist

- Add trace-level payload handling for new large event types.
- Keep artifacts out of large inline payloads.
- Check `transcript.jsonl` behavior if event-to-transcript mapping changes.
- Verify redaction still applies to trace and artifacts.
- Update docs and schemas when event envelope changes.

## Known Debts

- JSONL can grow without bound; retention/rotation remains an embedder concern.
- `workspace.read` can create high-volume noise.
- Stream chunk handling is collapsed at non-debug levels; consumers must not rely on individual chunks unless `debug`.

## Last Verified

- Status: Verified
- Date: 2026-06-21
- Read: `packages/core/src/trace.ts`, `packages/core/src/trace-codec.ts`,
  `packages/core/src/trace-store.ts`,
  `packages/core/src/trace-diagnostics.ts`,
  `packages/core/src/trace-session-consistency.ts`,
  `packages/core/src/index.ts`, `packages/core/src/internal.ts`,
  `packages/core/test/trace.test.ts`,
  `packages/cli/test/cli.test.ts`,
  `docs/_internal/project-map/designs/trace-diagnostics-refactor.md`,
  `docs/_internal/project-map/maps/trace/summary-timeline-verify.md`,
  `docs/_internal/project-map/maps/session/session-store.md`.
- Tests: `npx prettier --check packages/core/src/trace.ts packages/core/src/trace-codec.ts packages/core/src/trace-diagnostics.ts packages/core/src/trace-session-consistency.ts packages/core/src/trace-store.ts`;
  `npm run build`; `npm --workspace @sparkwright/streaming-runtime run build`;
  `npm --workspace @sparkwright/core test -- test/trace.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts`.
