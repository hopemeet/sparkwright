# Sparkwright Protocol Changelog

Tracks breaking and non-breaking changes to the JSON Schema contract under `schemas/`.

Conventions:

- Versions follow MAJOR.MINOR.
- MAJOR bumps for breaking changes (removed/renamed fields, narrowed enums, required field added).
- MINOR bumps for additive changes (new optional field, new enum value, new schema file).
- Each entry lists affected schemas and example migration notes.
- Schema files carry the active version in two places: the `$id` URL path segment (e.g. `/v0/`) and the top-level `x-sparkwrightProtocolVersion` annotation.

## Unreleased

- `event.schema.json`: additive — four new `workflow_hook.*` event types for
  deterministic workflow hooks:
  - `workflow_hook.started`
  - `workflow_hook.completed`
  - `workflow_hook.blocked`
  - `workflow_hook.failed`
    Migration: none; consumers that exhaustively match event types should add a
    default ignore arm or render these as host/runtime automation evidence.

- `config.schema.json`: additive — new `capabilities.hooks.workflow` config
  surface. Host-created runs can now attach deterministic workflow hooks with
  `block`, `context`, or `command` actions. The hook config also supports
  optional `description`, `frequency`, matcher `excludePathGlob`, and command
  `injectOutput` controls. Migration: none; omitted hooks keep existing
  behavior.

- `event.schema.json`: additive — new `skill.failed` event type. Emitted when
  one Skill source cannot be loaded while the runtime continues with other
  valid Skills. Migration: none; consumers may render it as a diagnostic
  failure row.

- `event.schema.json`: additive — new optional `monotonicUs` envelope field
  (integer microseconds). Carries process-monotonic high-resolution time (from
  `performance.now()`) so trace sinks get sub-millisecond ordering and real
  span durations that the millisecond-precision `timestamp` cannot express.
  Not wall-clock (origin is `performance.timeOrigin`, not the epoch) and only
  comparable within a single process. Migration: none — the field is optional
  and sinks fall back to `timestamp` when it is absent.

- `event.schema.json`: additive — six existing runtime event types are now
  reflected in the schema and protocol event list:
  - `run.resumed`, `run.waiting_credentials`, `run.credentials_refreshed`
  - `tool.replay_risk`
  - `storage.degraded`, `storage.recovered`
    Migration: none; these events were already emitted by the TypeScript
    runtime, and the JSON Schema enum now matches that public vocabulary.

- `event.schema.json`: additive — four new event `type` enum values for
  sub-agent lifecycle as seen by the PARENT run:
  - `subagent.requested` — emitted by `spawnSubAgent` immediately after the
    child run is constructed but before `.start()` is invoked. Lets sinks
    show a "queued" node when the embedder defers start behind a concurrency
    limit.
  - `subagent.started` — bridged from the child's `run.started`.
  - `subagent.completed` — bridged from the child's `run.completed`. Payload
    includes optional `stopReason`.
  - `subagent.failed` — bridged from the child's `run.failed` or
    `run.cancelled`. Payload includes `reason: "failed" | "cancelled"` and
    optional `error`.
    All four carry `{ childRunId, parentRunId, spanId, goal }` in the payload.
    Migration: none; consumers that exhaustively match event types should add
    a default ignore arm.

- `event.schema.json`: additive — `model.stream.timeout` payloads now carry
  three diagnostic fields:
  - `phase: "pre-first-chunk" | "post-first-chunk"` — `pre-first-chunk` with
    `apiCallCount: 0` means the stall is upstream of the model's first token
    (prompt build, credential resolution, network handshake). `post-first-chunk`
    means the model started responding and then stalled mid-stream. The two
    failure modes require very different triage.
  - `apiCallCount` — number of model stream invocations during the current
    run that produced at least one chunk before this timeout.
  - `chunksReceived` — chunks observed within the current stream before the
    timeout fired.
    Paired with the new optional `streamFirstChunkTimeoutMs` option on
    `createStreamingRun`, which lets embedders set a higher idle threshold
    for the first chunk (pre-token work) and a tighter threshold for
    inter-chunk gaps. When unset, the existing `streamTimeoutMs` applies to
    both phases (legacy single-threshold behavior). Migration: none.

- `event.schema.json`: additive — `workspace.write.completed` payloads may
  now include a `summary` object with the final line count and recent tail
  lines. Migration: none; consumers should ignore the optional field unless
  they want write-readback context.

- `event.schema.json`: additive — new `user_hook.progress` event for
  long-running user-hook runners that stream interim output via
  `UserHookInvocation.reportProgress`. Payload mirrors the shell-style
  `{ stdout?, stderr?, output?, data? }` shape so a host wrapping a shell
  command can pass captured streams through without re-encoding. Migration:
  none; consumers that exhaustively match event types should add a default
  ignore arm.

- `event.schema.json`: additive — three new optional envelope fields for span
  correlation (proposed in
  [ADR 0008](../adr/0008-span-correlation-and-trace-sinks.md)):
  - `traceId` — scopes a run-level trace tree; sinks may synthesize from
    `runId` when absent.
  - `spanId` — brackets a unit of work; paired `*.started` /
    `*.completed` (or `*.failed`) events share this id; instant events carry
    the enclosing span's id.
  - `parentSpanId` — parent in the trace tree; captured from
    `AsyncLocalStorage` by `withSpan()`.
    All three are optional. v0.1 traces remain valid under v0.2 tooling, and
    sinks MUST tolerate absence. Bumps `x-sparkwrightProtocolVersion` from
    `0.1` to `0.2`. Migration: none required for emitters; downstream sinks
    that want a span tree should consume these fields instead of pair-matching
    event names.

- `event.schema.json`: additive — two new event `type` enum values for the
  streaming-runtime `NotificationSource` hook:
  - `run.notification.injected` — a notification source returned items that
    were appended as user-role context items at the start of a step.
  - `run.notification.source_failed` — a `NotificationSource.drain()` threw
    and was swallowed so the loop could proceed.
    Migration: none; consumers that exhaustively match event types should add a
    default ignore arm.
- `event.schema.json`: additive — new event `type` enum values for
  prompt-cache integrity, background tasks, and user-configurable hooks:
  - `context.cache_break.detected` — emitted when a context item previously
    marked stable is observed to have changed between turns.
  - `task.created` / `task.started` / `task.output` / `task.completed` /
    `task.failed` / `task.cancelled` — background-task lifecycle emitted by
    `@sparkwright/agent-runtime` Tasks.
  - `user_hook.invoked` / `user_hook.completed` / `user_hook.failed` —
    settings.json-style user-configurable hooks; core defines the trigger
    vocabulary and forwards events, host owns execution.
    Migration: none; consumers that exhaustively match event types should add a
    default ignore arm.
- `tool.schema.json`: additive — descriptors may now include `interrupt`,
  `loading`, and `resultSize` hints. Migration: none; older consumers can
  ignore these optional fields.
- `event.schema.json`: additive — new `tool.progress` event for long-running
  tools that report progress through `RuntimeContext.reportToolProgress`.
  Migration: none; consumers that exhaustively match event types should add a
  default ignore arm.
- `event.schema.json`: additive — new event `type` enum values for the
  RunHook / UsageTracker / InteractionChannel surfaces:
  - `usage.updated` — emitted by the in-loop UsageTracker after every
    model / tool record. Payload: `UsageSnapshot`.
  - `hook.failed` — emitted when a `RunHook.*` callback throws. Payload
    `{ hookName, phase, message }`.
  - `interaction.requested` / `interaction.resolved` — emitted by
    embedders that funnel approval / question / notification traffic
    through `InteractionChannel`. Payload is the corresponding request
    object plus a `kind` discriminator.
    Migration: none (additive). Consumers that exhaustively match on the
    event-type union should add a `default: ignore` arm.

## 0.1 — initial (2026-05-21)

Initial protocol surface for v0. 20 schemas covering: run lifecycle, events, tools, approvals, artifacts, policy, context, workspace writes, anchored edits, skills, MCP, agent profiles, plans, capability runtime.

Schemas:

- `run.schema.json`, `run-result.schema.json`
- `event.schema.json`
- `tool.schema.json`, `tool-call.schema.json`, `tool-result.schema.json`
- `approval.schema.json`, `approval-response.schema.json`
- `artifact.schema.json`
- `policy-decision.schema.json`
- `context-item.schema.json`
- `workspace-write-proposal.schema.json`
- `anchored-text.schema.json`, `anchored-edit-operation.schema.json`
- `skill-manifest.schema.json`
- `mcp-server-config.schema.json`
- `agent-profile.schema.json`
- `plan.schema.json`, `plan-step.schema.json`
- `capability-runtime-config.schema.json`

Migration: none — this is the baseline.
