# Run Events

This document gives frontend and backend embedders a stable way to consume
SparkWright run events without depending on every payload detail. The canonical
protocol surface remains [PROTOCOL.md](./PROTOCOL.md); this guide explains how
to project that stream into timelines, status UI, approval flows, and durable
stores.

## Consumer Contract

Treat the run event stream as an append-only fact log.

- Order by `sequence` within a `runId`. Do not order by wall-clock timestamp.
- Use `id` for idempotency when a transport reconnects or replays history.
- Keep unknown event types. Render them generically or ignore them for UI state,
  but do not reject the run.
- Treat `payload` as event-specific and additive. Stable routing should use
  `type`, `runId`, `sequence`, `timestamp`, and optional span fields.
- Treat `metadata` as supporting evidence, not a required control surface.
- Distinguish full in-process events from filtered `trace.jsonl` events. Trace
  levels may summarize or omit large payload fields.
- Store large values as artifacts and link from events; do not assume event
  payloads contain full diffs, logs, screenshots, or generated files.

For visual nesting, prefer optional `traceId`, `spanId`, and `parentSpanId` when
present. Their absence is valid; consumers should fall back to a flat sequence.

## Timeline Projection

A timeline should be built from event families rather than exact payload shapes.

| Timeline row                      | Primary events                                                                                                                                                                | Stable rendering guidance                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Run lifecycle                     | `run.created`, `run.started`, `run.completed`, `run.failed`, `run.cancelled`                                                                                                  | One run-level row with terminal state and `stopReason` when available             |
| Model turn                        | `model.requested`, `model.completed`, `model.retrying`                                                                                                                        | Show request, retry, and completed output summary                                 |
| Streaming model turn              | `model.stream.*`                                                                                                                                                              | Attach chunks to the active model turn; collapse noisy chunks by UI               |
| Context and prompt                | `context.assembled`, `prompt.built`, `context.cache_break.detected`                                                                                                           | Show counts, sections, cache blocks, and cache-break diagnostics                  |
| Compaction                        | `context.compaction_requested`, `context.compaction.started`, `context.compaction.completed`, `context.compaction.failed`                                                     | Show budget pressure and summary lifecycle                                        |
| Tool batch                        | `tool.batch.requested`, `tool.batch.completed`                                                                                                                                | Show batch mode and tool count                                                    |
| Tool call                         | `tool.requested`, `tool.started`, `tool.progress`, `tool.completed`, `tool.failed`                                                                                            | Group by tool call id or enclosing span when available                            |
| Approval                          | `approval.requested`, `approval.resolved`, `interaction.requested`, `interaction.resolved`                                                                                    | Show pending review and final decision                                            |
| Workspace mutation                | `workspace.write.requested`, `artifact.created`, `workspace.write.completed`, `workspace.write.denied`, `workspace.write.skipped`, `workspace.write.untracked_access_granted` | Link diff artifacts, final mutation state, and untracked write-capable boundaries |
| Sub-agent lifecycle               | `subagent.requested`, `subagent.started`, `subagent.completed`, `subagent.failed`                                                                                             | Group by `childRunId`; show parent request and child terminal status together     |
| Background task / terminal output | `task.created`, `task.started`, `task.output`, `task.completed`, `task.failed`, `task.cancelled`                                                                              | Stream output incrementally; cap retained inline output                           |
| Host-controlled process           | `extension.process.started`, `extension.process.progress`, `extension.process.completed`, `extension.process.failed`                                                          | Show external process invocation, bounded output summary, and progress            |
| Skill and edge lifecycle          | `capability.index.failed`, `skill.indexed`, `skill.failed`, `skill.loaded`, `mcp.server.prepared`, `agent.profile.derived`                                                    | Show capability changes as environment/context evidence                           |
| User hooks                        | `user_hook.invoked`, `user_hook.completed`, `user_hook.failed`, `hook.failed`                                                                                                 | Show as host automation, not model-authored work                                  |
| Workflow hooks                    | `workflow_hook.started`, `workflow_hook.completed`, `workflow_hook.blocked`, `workflow_hook.failed`                                                                           | Show deterministic lifecycle automation and blocking decisions                    |

A backend projection can materialize these rows into a read model, but the
source of truth should remain the append-only event log plus `run.json`,
`result.json`, and artifacts.

## Model Selection Evidence

When present, `run.started.payload.resolvedModel` records the actual model
adapter selected for the run. Consumers can show this in diagnostics, session
inspectors, or trace reports to explain why a run used a specific
provider/model.

Stable consumption rules:

- Prefer `resolvedModel.adapterId` for the concrete adapter label.
- Use `resolvedModel.modelSource.layer` to distinguish explicit request
  overrides from user, project, env, or default config sources.
- Use `resolvedModel.providerSource.layer` to explain where the provider
  definition came from when the run is provider-backed.
- Treat `resolvedModel.authSource` and `resolvedModel.baseURLSource` as source
  labels only. They must not contain API keys, tokens, or raw headers.
- Keep the event optional. Older traces and some embedders may emit
  `run.started` with an empty payload.

## Streaming

Streaming events are partial telemetry. They are not a replacement for the
normalized model result.

- Use `model.stream.started` to open a streaming assistant turn.
- Append `model.stream.chunk` into a transient buffer for live display.
- Use `model.stream.completed` to mark the stream complete, then reconcile with
  the later normalized `model.completed` event when present.
- Use `model.stream.failed` and `model.stream.timeout` to mark the partial turn
  as failed without inventing a terminal run state.
- Do not execute frontend tool UI from streamed partial tool-call text. The
  current streaming runtime waits until the assistant turn is assembled, then
  tools flow through normal `tool.*`, policy, approval, and workspace events.

If chunks arrive after reconnect, deduplicate by event `id` and rebuild the
buffer from ordered events.

## Tool Progress

`tool.progress` is an instant event for long-running tools. It does not change
the tool result contract.

Recommended UI behavior:

- Attach progress to the active `tool.started` row by `toolCallId`, tool name,
  or enclosing span.
- Render `completedUnits / totalUnits` when both are present.
- Treat missing totals as indeterminate progress.
- Keep the final state from `tool.completed` or `tool.failed`, not from the last
  progress event.
- Throttle progress rendering on the frontend; store every event on the backend
  if the trace level allows it.

## Approval And Questions

There are two related surfaces:

- `approval.requested` / `approval.resolved` are the stable approval-specific
  events used around governed actions.
- `interaction.requested` / `interaction.resolved` are the generalized channel
  events for `approval`, `question`, and `notification` exchanges.

Frontend guidance:

- When `approval.requested` appears, show a blocking approval affordance tied to
  the request id or proposal id in the payload.
- When `approval.resolved` appears, close or mark the approval UI with the
  final decision.
- `approval.resolved.autoApproved` is the structured signal for approvals made
  by policy or flags; legacy traces may only carry this in the message text.
- When `interaction.requested` has `kind: "question"`, render the request using
  the structured question shape rather than parsing text.
- When both approval and interaction events exist for the same exchange, merge
  them in the UI instead of showing duplicate prompts.

Backend guidance:

- Persist pending approval/question state separately from the event stream only
  as a cache. The event stream remains the audit record.
- Approval denial is not the same as run cancellation. Follow subsequent
  `workspace.write.denied`, `tool.failed`, or terminal run events for outcome.

## Terminal Events

A run reaches a terminal state through `run.completed`, `run.failed`, or
`run.cancelled`. The returned `RunResult` is the strongest programmatic outcome;
events are the replayable audit trail.

Stable consumption rules:

- Do not infer terminal state from `model.completed` or `tool.completed`.
- Treat `run.cancel_requested` as intent only; wait for `run.cancelled` or the
  returned result before marking the run cancelled.
- Use `run.failed.payload.failure` and `stopReason` when available for error
  categorization.
- Treat failure `metadata.cause` as a bounded diagnostic summary when present.
  Raw provider request bodies, prompt input, and tool schemas must not be
  persisted on terminal failure events; structured provider classification lives
  in `metadata.modelError` when available.
- Once a terminal event is seen, ignore later state-transition attempts except
  to surface `run.state_transition.rejected` as diagnostics.

For durable stores, update the run record and write `result.json` at terminal
completion, but keep `trace.jsonl` append-only.

## Compaction

`context.compaction_requested` records budget pressure and omission/truncation
signals. It does not guarantee that summarization happened.

Consumption guidance:

- Show `context.compaction_requested` as a warning or timeline marker.
- Treat `context.compaction.started`, `context.compaction.completed`, and
  `context.compaction.failed` as the summary lifecycle when present.
- `context.compaction.started` includes the stage name, `tier`, trigger,
  reactive flag, and current size estimate. `context.compaction.completed`
  includes `freedChars`; when a stage runs but produces no savings it includes
  `skippedReason` instead of counting as an applied stage. Completed events may
  also include `warnings` and stage metadata.
- Do not remove earlier events from a replay view after compaction. Compaction
  changes future context, not history.
- If `context.compaction.completed` indicates prompt-cache reset metadata,
  invalidate any frontend prompt-cache visualization for the next turn.

## Prefetch

Context prefetchers overlap memory, Skills, MCP resources, or other context work
with model execution. Today prefetch is an extension point, not a dedicated
stable event family.

Stable consumption guidance:

- Observe resulting context through `context.assembled` and `prompt.built`.
- Treat `validation.failed` with a `PREFETCH_ERROR` finding as a recoverable
  prefetch failure; the run continues with no prefetched items from that source.
- If a host emits product-specific prefetch telemetry, namespace it outside the
  stable core contract or carry it in metadata. Generic consumers should ignore
  it safely.
- Do not block run progress UI waiting for prefetch-specific events.

Future protocol revisions may add dedicated prefetch lifecycle events. Consumers
should use the unknown-event fallback described above.

## Checkpoints

`RunCheckpointV1` is a serializable snapshot shape for durable resume,
branch/fork, and AI debugging. It is not currently a required event family.

Stable consumption guidance:

- Treat checkpoints as snapshots owned by the backend store, not as replacement
  trace events.
- Keep checkpoint identity and creation time in the snapshot record. When
  `eventSequence` is present, treat it as the last persisted event sequence for
  that run; resumed runs continue after it so append-only per-run traces remain
  contiguous.
- Use checkpoint snapshots to resume or branch state, then use events to explain
  how that state was reached.
- Do not treat `eventSequence` as a session-wide or cross-agent ordering key.
  Session traces may contain multiple runs and processes; use event timestamps,
  `traceId`, `runId`, and timeline tooling for aggregate ordering.
- If future `checkpoint.*` events are added, render them as timeline markers and
  keep snapshot payloads outside the event body when large.

## Skill Events

Skill events explain capability/context changes at the edge of the run.

- `skill.indexed` means a Skill source was scanned and reduced to metadata.
- `skill.failed` means one Skill source could not be loaded; other valid Skills
  may still be available. When it is a companion to an on-demand `skill_load`
  tool failure, it should carry that tool's `toolCallId`.
- `skill.loaded` means a selected Skill body was loaded into context or through
  a governed loader tool.
- Related edge events such as `mcp.server.prepared` and
  `agent.profile.derived` explain tool availability and agent policy shaping.

Stable consumption guidance:

- Render these as environment/context evidence, not as model-authored actions.
- Keep names, versions, source paths, content hashes, counts, and selection
  reasons when available.
- Do not require full Skill body text in the event payload.
- Expect some edge lifecycle events to be flushed into the run after
  `createRun()` through a buffered emitter; final `sequence` order is the
  replay order.

## Backend Delivery Checklist

- Persist events append-only, one serialized event per line or row.
- Deliver replay before live tail on reconnect, deduplicated by event `id`.
- Apply trace-level filtering and redaction before external sinks.
- Keep artifacts addressable from event payloads or metadata.
- Flush sinks on terminal result, but never let a sink failure break event
  emission.

## Frontend Rendering Checklist

- Build UI state from event families, not exhaustive type switches.
- Keep a generic row for unknown event types.
- Use terminal run events for final state.
- Collapse high-volume chunk/progress/output events by default, with a way to
  inspect details.
- Keep approval and question UI keyed by request identity so reconnects restore
  pending prompts without duplicates.

Promoted shell tasks keep the task lifecycle as the user-visible row: stdout
and stderr are buffered in `TaskStore`, mirrored as `task.output` events under
the task span, and the terminal `task.completed` / `task.failed` /
`task.cancelled` event carries a `ProcessOutputSummary`. They do not emit a
second `extension.process.*` lifecycle.
