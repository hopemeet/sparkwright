# SparkWright Protocol Changelog

Tracks breaking and non-breaking changes to the JSON Schema contract under `schemas/`.

Conventions:

- Versions follow MAJOR.MINOR.
- MAJOR bumps for breaking changes (removed/renamed fields, narrowed enums, required field added).
- MINOR bumps for additive changes (new optional field, new enum value, new schema file).
- Each entry lists affected schemas and example migration notes.
- Schema files carry the active version in two places: the `$id` URL path segment (e.g. `/v0/`) and the top-level `x-sparkwrightProtocolVersion` annotation.

## Unreleased

- Workflow run snapshots: breaking identity consolidation — `generation`,
  `recordRevision`, source `layer`, `packageHash`, and
  `packageHashPolicyVersion: 2` are required; durable `contentHash` is removed.
  Workflow resume accepts only records backed by the matching executable
  package snapshot. Migration: consume package identity directly and do not
  synthesize missing fencing fields or infer identity from the live asset.

- `host-message.schema.json`: breaking consolidation — capability tool exposure
  tiers no longer admit `legacy`; `list_dir` is canonical `advanced`.
  `CapabilityDelegateToolSummary` no longer echoes delegate
  `requiresApproval`, and `approvalRequiredUnderCurrentRun` is now required.
  Migration: render the current-run approval fact directly and treat delegate
  config as authoring input, not capability output.

- `subagent.*` lifecycle: additive/ordering correction — all built-in Agent
  transports now include terminal `terminalState`/`finality`; admission failures
  emit requested -> failed without a false started phase, and indexed calls use
  `entrypoint:"delegate_agent"`. Migration: consumers must allow requested to
  terminate without started and should continue enforcing one terminal event.

- `subagent.*` metadata: additive — every built-in Agent transport identifies
  `protocol` as `in_process`, `acp`, or `external_command`; process-backed
  invocations also retain `workspaceAccess` when known. Migration: consumers
  may use these optional fields for transport/governance diagnostics and must
  continue grouping lifecycle by `childRunId`.

- `host-message.schema.json`: `capability.inspect` accepts `accessMode` and
  `backgroundTasks`, and `CapabilitySnapshot` may include the same canonical
  access summary. Omitted access keeps the conservative read-only diagnostic
  view.

- `host-message.schema.json`: additive — `run.start`, `run.resume`, and
  `workflow.resume` accept optional `confidentialPaths` plus
  `confidentialDefaults`. Migration: omit `confidentialDefaults` to keep the
  conservative built-in confidential path deny set; send `false` only when a
  client intentionally owns the full confidential path list.

- `event.schema.json`: additive — new `run.budget.exceeded` event type for
  per-source forced-continuation budget exhaustion. Payloads carry `signal`,
  `family`, `source`, `used`, `limit`, and optional `step` / `reason`.
  Migration: consumers should treat the event as a refusal to continue that
  source, not as a terminal run failure.

- `run.completed` payloads: additive — completed runs may include
  `factLedger` (`schemaVersion: "fact-ledger.v1"`) with raw command facts,
  verifier result satisfaction, optional `verificationSource`, workspace write
  epochs, and stale markers.
  Command/verification diagnostics derive from this canonical ledger; terminal
  status consumers use the bounded `outcome` projection.

- `event.schema.json`: additive — reserves `workflow.started`,
  `workflow.node.started`, `workflow.node.completed`, `workflow.waiting`,
  `workflow.interrupted`, `workflow.completed`, `workflow.failed`, and
  `workflow.cancelled` for the workflow runtime lifecycle. P1 begins emitting
  these events for `run.start.workflow` projection runs. Migration: consumers
  should treat workflow lifecycle events as optional annotations unless they opt
  into workflow-aware UI/status rendering. P3 adds the first `workflow.waiting`
  producer for human nodes and pairs it with durable workflow-run `wait` state.

- `host-message.schema.json`: additive — `run.start` accepts optional
  `workflow`, the workflow asset name to instantiate for that run. Migration:
  omit the field to keep ordinary host-run behavior. P1.5 removes the former
  experimental environment gate.

- `host-message.schema.json`: additive — host requests now include
  `workflow.list` and `workflow.resume`. Workflow run records are stored under
  the workspace workflow-run journal, carry a pinned executable package plus a
  snapshot-backed definition, and resume only non-terminal records through a
  single-writer lease. Migration: clients can inspect/resume workflow instances
  without scraping trace events.

- `host-message.schema.json`: additive — `CapabilitySnapshot.workflows` may
  include parsed workflow asset summaries and parse errors. Migration: none;
  clients should treat the field as optional inspection diagnostics.

- `host-message.schema.json`: additive — host requests now include
  `task.list`, `task.get`, `task.output`, `task.stop`, `task.join`, and
  `task.promote`; protocol errors may include `task_not_found`. Migration:
  clients may poll durable background task state and send host-facing
  join/promote controls without parsing task tool output.

- `config.schema.json`: breaking/pre-adoption — workflow hook lifecycle values
  are canonical-only (`RunStart`, `TurnStart`, `ModelOutput`, `PreToolUse`,
  `PostToolUse`, `Stop`, `RunEnd`, `RuntimeSignal`); legacy lifecycle values and
  workflow hook `mode` are removed. Non-blocking subscribers move to
  `capabilities.hooks.events`, and hook actions now include `http` and `agent`
  transports. Migration: rename old lifecycle values, move observe-mode rules to
  `hooks.events`, and replace duplicate trace lifecycle fields with `hook`.

- `host-message.schema.json`: additive — `CapabilitySnapshot.rules.events` may
  include non-blocking event-rule summaries for `capabilities.hooks.events`.
  Migration: none; clients should render the field as optional diagnostics.

- `workflow_hook.*` payloads: breaking/pre-adoption — payloads carry one
  canonical `hook` lifecycle field. Migration: stop reading `configuredHook` or
  workflow hook `mode` from trace payloads.

- `workflow_hook.completed` payloads: additive — `WorkflowHookResult.status`
  may be `advance` for healthy `ModelOutput` / `Stop` continuations that should
  not be rendered as blocked hook decisions. Migration: treat it as a completed
  hook result, not a failure or policy violation.

- `host-message.schema.json`: additive — `CapabilitySnapshot.rules.workflow`
  may include active workflow rule summaries for configured hooks,
  verification invariants, and built-in workflow rules.
  Migration: none; clients should treat the field as optional diagnostics.

- `event.schema.json`: additive — new `agent.routing.evaluated` event type.
  Hosts emit it when delegate routing hints are evaluated for a goal. The first
  mode is `sort`, which preserves the full delegate tool set while recording
  relevant/low ordering evidence. Migration: none; consumers may render it as
  agent-routing diagnostics.

- `host-message.schema.json`: additive —
  `CapabilityDelegateToolSummary.routing` may include delegate routing keywords
  and, after a run goal is evaluated, relevant/low score details. Migration:
  none; clients should treat the field as optional diagnostics.

- `host-message.schema.json`: additive — `CapabilitySnapshot.shell` may include
  `foregroundTimeoutMs` and `promotionAvailable` alongside sandbox status.
  Migration: none; clients should treat the fields as optional diagnostics.

- `host-message.schema.json`: additive — `CapabilitySnapshot` may include a
  `model` summary with pricing status. Hosts report `missing_pricing` before a
  run when the selected model has no built-in or configured cost block.
  Migration: none; clients should treat the field as optional and warning-only.

- `host protocol`: additive — `session.compact` results now include
  `measurement` (savings ratio, tier savings, regime, signal count, and optional
  summarizer metrics). Migration: none; clients should treat the field as
  informational.

- `config.schema.json`: additive — new optional `tasks` map for model-backed
  auxiliary task routing. Each task can set `enabled`, `model`, and a shared
  `budget` block (`maxSourceChars`, `maxInputTokens`, `maxOutputTokens`,
  `maxCostUsd`, `unknownCostPolicy`). Migration: none; omitted tasks preserve
  existing behavior.

- `host-message.schema.json`: additive — `CapabilityDelegateToolSummary` may
  include optional `gatedByRunWrite`. Hosts use it when an in-process delegate
  advertises profile-selected workspace write or shell capability that still
  requires the parent run to enable workspace writes. Migration: none; clients
  should treat the field as optional.

- `host-message.schema.json`: additive — `CapabilityDelegateToolSummary.risk`
  may now report `"safe"` or `"denied"` in addition to `"risky"`. In-process
  delegate spawn is safe by default; child-run tool policy continues to govern
  writes, shell, and other risky actions. Migration: clients should stop
  assuming every delegate descriptor is risky and should use
  `approvalRequiredUnderCurrentRun` for the effective approval gate.

- `host-message.schema.json`: additive — `CapabilitySnapshot.skills` may include
  `inlineShell`, a path-free summary of the effective Skill inline-shell policy
  (`enabled`, timeout/output caps, sandbox mode, write policy, and fail-closed
  status). Migration: none; clients should treat the field as optional.

- Trace/tool behavior: `skill_load` now reports missing, denied, or missing
  resource loads as structured `tool.failed` results with `SKILL_LOAD_FAILED`
  and emits `skill.failed` with the original `toolCallId`. Trace reports use
  that correlation to avoid double-counting recovered companion failures as
  high-severity trace errors. Migration: consumers that previously inspected
  successful `skill_load` outputs for `resource_not_found` should also handle
  `tool.failed`.

- `config.schema.json`: additive — new optional
  `capabilities.skills.inlineShell` config surface. When `enabled: true`, host
  skill loading may expand `` !`cmd` `` snippets through a host-injected runner
  with timeout and output caps. Migration: none; omitted config preserves the
  existing behavior where Skill inline shell is inert.

- `event.schema.json`: additive — new `capability.mutation.completed` event
  type. Emitted when a higher-level capability package mutation completes
  outside the single-file `workspace.write.*` path, such as writing a draft
  Skill proposal package. Migration: none; consumers may render it as
  capability/package mutation evidence and keep workspace-write handling
  unchanged.

- `event.schema.json`: `external.side_effect.completed` was not adopted as a
  public event. MCP stdio servers now default to a neutral temporary cwd when
  `cwd` is omitted; configure an explicit `cwd` for servers that intentionally
  need project files. Consumers should rely on normal `tool.*` events plus
  managed `workspace.write.*` events rather than filesystem side-effect
  forensics.

- `config.schema.json`: additive — new optional
  `capabilities.verification` config surface. Hosts can define named
  verification profiles and compile them into implicit workflow projection
  verifiers. Required profile failures are recorded in the run's verification
  result snapshot and can make a completed run fail. Migration: omitted
  verification config keeps existing behavior; the former `stopGate` config
  field was removed when verification moved behind projection.

- `event.schema.json`: additive — four new `workflow_hook.*` event types for
  deterministic workflow hooks:
  - `workflow_hook.started`
  - `workflow_hook.completed`
  - `workflow_hook.blocked`
  - `workflow_hook.failed`
    Migration: none; consumers that exhaustively match event types should add a
    default ignore arm or render these as host/runtime automation evidence.

- `event.schema.json`: additive — four new `extension.process.*` event types
  for host-controlled external process invocations:
  - `extension.process.started`
  - `extension.process.progress`
  - `extension.process.completed`
  - `extension.process.failed`
    `standard` traces suppress raw progress events and aggregate progress
    head/tail samples onto the terminal event; `debug` traces keep progress.
    Process-backed scripts report progress through stderr token lines under
    `SPARKWRIGHT_PROCESS_PROTOCOL=stdio-v1`; token lines are stripped from
    stderr output surfaces, unknown record types are dropped and counted, and
    terminal process payloads may include bounded debug-only
    `progressDroppedSamples`.
    Migration: none; consumers that exhaustively match event types should add a
    default ignore arm or render these as host process evidence.

- `config.schema.json`: additive — new `capabilities.hooks.workflow` config
  surface. Host-created runs can now attach deterministic workflow hooks with
  `block`, `context`, or `command` actions. The hook config also supports
  optional `description`, `frequency`, matcher `excludePathGlob`, and command
  `injectOutput` / `stdin` controls. Migration: none; omitted hooks keep
  existing behavior.

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
