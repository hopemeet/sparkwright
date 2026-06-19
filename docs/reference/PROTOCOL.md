# Protocol Draft

This is a reference contract. If you are new to Sparkwright, start with
[the documentation map](../README.md) or the [User Manual](../guides/USER_MANUAL.md).

This document describes Sparkwright Protocol v0.2. Schema files use `$id` `https://sparkwright.dev/schemas/v0/...` and tag `x-sparkwrightProtocolVersion: '0.2'`. See [PROTOCOL_CHANGELOG.md](./PROTOCOL_CHANGELOG.md) for evolution.

This document defines the first portable shapes for Sparkwright runtime data. The TypeScript implementation may evolve, but these shapes should remain understandable outside TypeScript.

The protocol is intentionally JSON-friendly.

For the state ownership model behind these protocol shapes, see
[State And Trace Model](./STATE_AND_TRACE_MODEL.md).

## Schema Index

The v0 schema files in `schemas/` are a portability aid for SDKs and trace tooling. They describe stable envelope shapes and core protocol objects, while event payloads remain documented in this file until payload-specific schemas are added.

Current schema files:

- `run.schema.json`
- `run-result.schema.json`
- `event.schema.json`
- `tool.schema.json`
- `tool-call.schema.json`
- `tool-result.schema.json`
- `policy-decision.schema.json`
- `approval.schema.json`
- `approval-response.schema.json`
- `artifact.schema.json`
- `context-item.schema.json`
- `workspace-write-proposal.schema.json`
- `anchored-text.schema.json`
- `anchored-edit-operation.schema.json`
- `skill-manifest.schema.json`
- `agent-profile.schema.json`
- `mcp-server-config.schema.json`
- `capability-runtime-config.schema.json`

Trace-level filtering can summarize payloads, so consumers should distinguish full runtime events from filtered JSONL traces when validating payload detail.

## Run

```json
{
  "id": "run_01h",
  "goal": "inspect this repo and suggest a README improvement",
  "state": "completed",
  "stopReason": "final_answer",
  "createdAt": "2026-05-16T10:00:00.000Z",
  "updatedAt": "2026-05-16T10:00:03.000Z",
  "metadata": {}
}
```

Allowed v0 states:

- `created`
- `running`
- `waiting_approval`
- `completed`
- `failed`
- `cancelled`

`stopReason` is optional while a run is active and should be set when the run reaches a terminal state or when a state transition is rejected.

Current stop reasons:

- `no_model_configured`: the run completed without a model adapter
- `final_answer`: the model produced a final answer without tool calls
- `manual_cancelled`: a caller explicitly cancelled the run
- `max_steps_exceeded`: the loop hit its configured step bound
- `max_duration_exceeded`: the run exceeded its `runBudget.maxDurationMs`
- `max_model_calls_exceeded`: the run exceeded its `runBudget.maxModelCalls`
- `max_tool_calls_exceeded`: the run exceeded its `runBudget.maxToolCalls`
- `token_budget_exceeded`: the run exceeded its `runBudget.maxTokens`
- `cost_budget_exceeded`: the run exceeded its `runBudget.maxCostUsd`
- `blocking_limit`: every compaction stage was exhausted and the request is still over the model's hard context limit
- `model_completion_failed`: a model call failed without a successful retry path
- `model_retry_exhausted`: retryable model failures exhausted the retry policy
- `model_output_invalid`: normalized model output did not match the protocol
- `tool_doom_loop`: repeated identical tool calls tripped the loop guard
- `validation_failed`: a validation hook rejected a final output or terminal action
- `hook_stopped`: a hook prevented continuation
- `stop_hook_prevented`: a `pre_terminal` stop hook blocked termination and the loop hit `maxSteps` before resolution
- `aborted_streaming`: streaming was aborted before the model turn completed
- `aborted_tools`: tool execution was aborted before the tool turn completed
- `state_transition_invalid`: an invalid state transition was rejected

## Run Result

`run.start()` returns a terminal result so callers do not need to infer outcomes from event payloads:

```json
{
  "signal": "failed",
  "state": "failed",
  "stopReason": "model_retry_exhausted",
  "failure": {
    "category": "model",
    "code": "MODEL_COMPLETION_FAILED",
    "message": "server unavailable",
    "retryable": true,
    "metadata": {
      "attempts": 3,
      "maxAttempts": 3
    }
  },
  "metadata": {}
}
```

Current terminal result signals are `completed`, `failed`, and `cancelled`. The protocol reserves `continue` and `compact` for future loop control surfaces.

Failure categories are:

- `model`
- `tool`
- `approval`
- `policy`
- `workspace`
- `validation`
- `runtime`

Tool execution preserves structured runtime errors when handlers throw an error-like object with a stable `code`. Workspace failures currently surface through tool results with codes such as:

- `WORKSPACE_PATH_ESCAPED`
- `WORKSPACE_WRITE_CONFLICT`
- `APPROVAL_UNAVAILABLE`
- `APPROVAL_DENIED`
- `POLICY_DENIED`

## Event

```json
{
  "id": "evt_01h",
  "runId": "run_01h",
  "type": "tool.requested",
  "timestamp": "2026-05-16T10:00:01.000Z",
  "monotonicUs": 1287654321,
  "sequence": 4,
  "payload": {},
  "metadata": {},
  "traceId": "trc_01h",
  "spanId": "spn_01h_tool_4",
  "parentSpanId": "spn_01h_interaction_1"
}
```

Rules:

- events are append-only
- events must have monotonically increasing `sequence` values per run
- event payloads should avoid secrets
- large binary outputs should become artifacts, not inline event payloads

### Span Correlation (v0.2, optional)

`traceId`, `spanId`, and `parentSpanId` are **optional** envelope fields added in protocol v0.2 (see [ADR 0008](../adr/0008-span-correlation-and-trace-sinks.md)). They let downstream consumers reconstruct a parent/child tree without pair-matching event names.

Semantics:

- `traceId` scopes a single run-level trace tree. When omitted, sinks may synthesize one from `runId`.
- `spanId` brackets a unit of work. Paired `*.started` and `*.completed` (or `*.failed`) events for the same operation MUST carry the same `spanId`. Instant events (`*.progress`, `usage.updated`, `context.cache_break.detected`, …) carry the **enclosing** span's id so they attach to the right bracket; they do not open a new span.
- `parentSpanId` is captured from `AsyncLocalStorage` when `withSpan()` is used in `@sparkwright/core`. The first span in a run has no parent.

### High-resolution timing (v0.2, optional)

`monotonicUs` is an **optional** envelope field carrying process-monotonic microseconds (from `performance.now()`) captured at emit time. `timestamp` is ISO-8601 with only millisecond resolution, which collapses fast operations onto the same instant and yields zero-duration spans in trace sinks. `monotonicUs` gives sinks sub-millisecond ordering and real span durations.

Semantics:

- It is **not** wall-clock time: the origin is `performance.timeOrigin` (≈ process start), not the Unix epoch. Use `timestamp` for absolute time.
- All EventLogs in one process share the same origin, so `monotonicUs` values are mutually comparable **within a single process's trace**. They are not comparable across processes (e.g. sub-agents running in separate processes) — sinks should fall back to `timestamp` to align cross-process timelines.
- Omitted by pre-v0.2 emitters; sinks MUST fall back to `timestamp` (millisecond precision) when it is absent.
- Absence of any of these fields is valid and MUST be tolerated by sinks (degrade to "no span info" rather than error). This keeps v0.1 traces replayable under v0.2 tooling.

Routing identity remains `runId`; span fields are presentation/correlation only.

Current event types:

- `run.created`
- `run.started`
- `run.resumed`
- `run.waiting_credentials`
- `run.credentials_refreshed`
- `run.completed`
- `run.failed`
- `run.cancelled`
- `run.cancel_requested`
- `run.command.enqueued`
- `run.command.applied`
- `run.notification.injected`: a `NotificationSource` returned items that were appended as user-role context items at the start of a step; metadata: `{ step, sourceIndex, count }`
- `run.notification.source_failed`: a `NotificationSource.drain()` threw; the runtime swallowed the error and continued; metadata: `{ step, sourceIndex, message }`
- `run.state_transition.rejected`
- `run.budget.checked`: per-step budget evaluation; metadata carries usage snapshot
- `plan.created`: a structured plan was produced by the planner surface
- `plan.reviewed`: a plan was reviewed (approved, revised, or rejected) before execution
- `plan.step.started`: execution of a plan step began
- `plan.step.completed`: a plan step finished successfully
- `plan.step.failed`: a plan step failed; recovery is at the planner's discretion
- `model.requested`
- `model.turn.started`: a model turn span opened; subsequent
  `model.requested` / `model.retrying` / `model.stream.*` events and the
  turn's `model.completed` event are nested beneath it.
- `model.turn.completed`: the model turn span closed.
- `model.completed`
- `model.retrying`
- `model.stream.started`: a streaming model response began
- `model.stream.chunk`: a streaming chunk was received (payload kept small)
- `model.stream.text`: non-debug trace sinks may collapse many
  `model.stream.chunk` text deltas into one timing marker. The full assistant
  text remains on `model.completed`.
- `model.stream.completed`: a streaming model response finished normally
- `model.stream.failed`: a streaming model response ended in failure
- `model.stream.timeout`: a streaming model response timed out
- `model.assistant_text`: normalized assistant-facing text was emitted for trace and replay consumers
- `context.assembled`
- `context.compaction_requested`
- `context.compaction.started`
- `context.compaction.completed`
- `context.compaction.failed`
- `capability.index.failed`
- `capability.mutation.completed`: a capability package operation completed
  outside the single-file `workspace.write.*` path. Payload includes
  `{ action, path, reason?, sourcePath?, fileCount?, files? }`.
- `skill.indexed`
- `skill.failed`
- `skill.loaded`
- `mcp.server.prepared`
- `agent.profile.derived`
- `prompt.built`: provider-neutral prompt messages were rendered. Payloads include message/section counts, section metadata, and cache block summaries (`cacheBlocks`, `stablePrefixBlockCount`) so provider adapters and trace sinks can reason about prompt-cache reuse.
- `validation.started`
- `validation.completed`
- `validation.failed`
- `tool.requested`
- `tool.batch.requested`
- `tool.batch.completed`
- `tool.started`
- `tool.progress`
- `tool.completed`
- `tool.failed`
- `tool.replay_risk`
- `storage.degraded`
- `storage.recovered`
- `approval.requested`
- `approval.resolved`
- `artifact.created`
- `workspace.read`
- `workspace.read.denied`: a read was blocked by the run's read-scope policy (confidential path)
- `workspace.anchored_read`
- `workspace.anchored_edit.requested`
- `workspace.anchored_edit.verified`
- `workspace.anchored_edit.rejected`
- `workspace.write.requested`
- `workspace.write.denied`
- `workspace.write.completed`
- `workspace.write.skipped`: a tool decided the requested mutation was a no-op
  (e.g. the desired content was already present) and emitted no write
  proposal. Payload: `{ path: string, reason?: string }`. Useful so callers
  can distinguish "no write attempted" from "write attempted and applied".
- `usage.updated`: a per-run usage aggregator emitted a fresh snapshot
  (tokens, cost, wall time, per-tool, per-model). Payload: `UsageSnapshot`.
- `hook.failed`: a `RunHook.*` callback threw. Payload:
  `{ phase: string, toolName?: string, message: string }`. Loop continues.
- `workflow_hook.started` / `workflow_hook.completed` /
  `workflow_hook.blocked` / `workflow_hook.failed`: deterministic workflow
  hook lifecycle for `SessionStart`, `UserPromptSubmit`, `ModelOutput`,
  `PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd`, and `RuntimeSignal`.
  Payloads carry `{ hookName, hookId?, hook, step?, metadata }`; completion
  includes the normalized hook result, blocked includes reason/findings, and
  failed includes `{ error: { code, message } }`.
- `extension.process.started` / `extension.process.progress` /
  `extension.process.completed` / `extension.process.failed`: host-controlled
  external process invocation evidence. External processes cannot write
  arbitrary Sparkwright events; host runners may expose a JSONL progress inbox
  and re-emit accepted progress with host-owned `event.sequence`, `timestamp`,
  `monotonicUs`, and span fields. Terminal payloads include a shared
  `ProcessOutputSummary` with bounded stdout/stderr previews, byte counts,
  truncation flags, and optional `artifactIds` for materialized logs.
  `standard` traces suppress raw progress events and fold progress head/tail
  samples into the terminal event; `debug` traces keep raw progress.
- `interaction.requested`: the runtime asked the InteractionChannel for an
  approval / question / notification. Payload:
  `{ kind: "approval"|"question"|"notification", request|notification }`.
- `interaction.resolved`: the channel returned a response (or the
  notification was delivered).
- `context.cache_break.detected`: a context item previously emitted as
  `stability: stable` was observed to have changed between turns. Payload:
  `{ runId, step, prefixIndex, priorHash, currentHash, role }`. Diagnostic
  only — does not alter the run.
- `subagent.requested` / `subagent.started` / `subagent.completed` /
  `subagent.failed`: parent-run view of child agent lifecycle emitted by
  `@sparkwright/agent-runtime`. The child still has its own `run.*` event
  stream; these events let a parent trace show fan-out and completion status.
- `task.created` / `task.started` / `task.output` / `task.completed` /
  `task.failed` / `task.cancelled`: background-task lifecycle events emitted
  by `@sparkwright/agent-runtime` Tasks. Tasks are spawned by a run and live
  alongside it (they are NOT new runs). Payloads carry `{ taskId, kind,
parentRunId, ... }`.
- `user_hook.invoked` / `user_hook.progress` / `user_hook.completed` /
  `user_hook.failed`: host-supplied user-configurable hook lifecycle. Core
  defines the trigger vocabulary (`UserHookTrigger`) and forwards matching
  events through `bindUserHooks`; the host owns runner execution.
  `user_hook.progress` is optional and emitted by the host via
  `UserHookInvocation.reportProgress` for long-running runners (e.g. shell
  commands streaming stdout/stderr). Payloads carry `{ hookId, hookName,
trigger, runId, source?, stdout?, stderr?, output?, data? }`.

### Experimental Edge Lifecycle Events

The extension packages may emit experimental edge lifecycle events through the
generic event envelope. Payloads remain intentionally small. Reproducibility and
audit facts should live in event `metadata` so standard trace filtering can keep
the useful evidence.

Common metadata:

```json
{
  "experimental": true,
  "schemaVersion": "edge-trace.v0.1",
  "sourcePackage": "@sparkwright/skills",
  "agentId": "reviewer"
}
```

`skill.indexed`:

```json
{
  "payload": { "count": 2 },
  "metadata": {
    "experimental": true,
    "schemaVersion": "edge-trace.v0.1",
    "sourcePackage": "@sparkwright/skills",
    "skills": [
      {
        "name": "code-reviewer",
        "version": "1.0.0",
        "sourcePath": ".sparkwright/skills/code-reviewer/SKILL.md",
        "contentHash": "..."
      }
    ]
  }
}
```

`skill.failed`:

```json
{
  "payload": {
    "source": ".sparkwright/skills/bad/SKILL.md",
    "message": "Skill description must be a non-empty string: ..."
  },
  "metadata": {
    "experimental": true,
    "schemaVersion": "edge-trace.v0.1",
    "sourcePackage": "@sparkwright/skills",
    "phase": "load"
  }
}
```

`skill.loaded`:

```json
{
  "payload": { "name": "code-reviewer", "status": "loaded" },
  "metadata": {
    "experimental": true,
    "schemaVersion": "edge-trace.v0.1",
    "sourcePackage": "@sparkwright/skills",
    "version": "1.0.0",
    "sourcePath": ".sparkwright/skills/code-reviewer/SKILL.md",
    "contentHash": "...",
    "selectionReason": "Matched goal against skill name or description.",
    "mode": "resident_context"
  }
}
```

`mcp.server.prepared`:

```json
{
  "payload": { "name": "github", "status": "connected", "toolCount": 3 },
  "metadata": {
    "experimental": true,
    "schemaVersion": "edge-trace.v0.1",
    "sourcePackage": "@sparkwright/mcp-adapter",
    "serverType": "stdio",
    "toolNameMap": [
      {
        "toolName": "mcp_github_read_file",
        "serverName": "github",
        "mcpToolName": "read_file"
      }
    ]
  }
}
```

`agent.profile.derived`:

```json
{
  "payload": {
    "parentAgentId": "planner",
    "childAgentId": "reviewer",
    "effectiveToolCount": 2
  },
  "metadata": {
    "experimental": true,
    "schemaVersion": "edge-trace.v0.1",
    "sourcePackage": "@sparkwright/agent-runtime",
    "inheritedPolicyCount": 2,
    "effectivePolicyCount": 3
  }
}
```

### Run Start Events

`run.started` payloads may include `resolvedModel` when the host can report the
actual adapter selected for the run. This is diagnostic evidence for model
selection and configuration precedence; it must not include raw provider keys,
tokens, or request headers.

```json
{
  "resolvedModel": {
    "modelRef": "openai/gpt-5.4-mini",
    "providerKey": "openai",
    "modelId": "gpt-5.4-mini",
    "adapterId": "openai:gpt-5.4-mini",
    "modelSource": {
      "layer": "project",
      "path": "/repo/.sparkwright/config.json"
    },
    "providerSource": {
      "layer": "user",
      "path": "/home/user/.config/sparkwright/config.json"
    },
    "authSource": "env:OPENAI_API_KEY",
    "baseURLSource": "env:OPENAI_BASE_URL"
  }
}
```

Field semantics:

- `modelRef`: the model reference after CLI/config/default resolution.
- `providerKey` and `modelId`: the parsed provider and model identifiers.
- `adapterId`: the stable model adapter id used in trace and usage buckets.
- `modelSource`: where the selected `modelRef` came from. `layer: "request"`
  means the caller explicitly passed a model, usually through `--model` or
  host protocol input. Config-backed values should report `user`, `project`, or
  `env` when known.
- `providerSource`: where the provider definition came from, when applicable.
- `authSource`: source label for the credential used to construct the provider
  adapter, for example `env:OPENAI_API_KEY` or `config`. This field is not a
  credential and must not contain secret material.
- `baseURLSource`: source label for the provider base URL when one is set, for
  example `env:OPENAI_BASE_URL` or `config`.

### Run Completion Events

`run.completed` payloads should include the terminal reason:

```json
{
  "reason": "final_answer",
  "message": "Completed approval-gated write path for README.md."
}
```

`run.failed` payloads should include a reason, stable error code, human-readable message, structured failure, and optional metadata:

```json
{
  "reason": "model_retry_exhausted",
  "code": "MODEL_COMPLETION_FAILED",
  "message": "server unavailable",
  "failure": {
    "category": "model",
    "code": "MODEL_COMPLETION_FAILED",
    "message": "server unavailable",
    "retryable": true
  },
  "metadata": {
    "attempts": 2,
    "maxAttempts": 2,
    "retryable": true
  }
}
```

`run.cancelled` payloads should include the cancellation reason, message, and metadata:

```json
{
  "reason": "manual_cancelled",
  "message": "User stopped the run.",
  "metadata": {
    "source": "cli"
  }
}
```

### State Transition Rejection

`run.state_transition.rejected` records attempts to move from an invalid or terminal state:

```json
{
  "from": "completed",
  "to": "running",
  "reason": "terminal_state"
}
```

The run state should not change when this event is emitted.

### Run Commands And Cancellation

`run.command.enqueued` records an external command accepted by the run handle. `run.command.applied` records that the loop consumed it at a turn boundary. Current command types are `user_message` and `cancel`.

```json
{
  "commandType": "user_message",
  "step": 2,
  "metadata": {}
}
```

`run.cancel_requested` records cancellation intent before the terminal `run.cancelled` event:

```json
{
  "reason": "stop now",
  "metadata": {}
}
```

### Model Retry

`model.retrying` records retryable model failures before the next attempt:

```json
{
  "step": 1,
  "attempt": 1,
  "nextAttempt": 2,
  "maxAttempts": 3,
  "delayMs": 500,
  "error": {
    "message": "rate limited",
    "status": 429,
    "retryAfterMs": 1000
  }
}
```

Retryable failures currently include explicit `retryable: true`, HTTP-like `408`, `409`, `425`, `429`, and `5xx` statuses, plus common transient network and rate-limit error codes.

Before re-issuing a retryable call the loop waits `delayMs` (also recorded on the event). The delay is computed from the `ModelRetryPolicy`: an exponential backoff of `initialDelayMs * backoffMultiplier^(attempt-1)` capped at `maxDelayMs`, with optional `jitter` (`"full"` by default — sampled uniformly in `[0, computed]`). When the provider supplies a cool-down (`error.retryAfterMs`, normalized from a numeric `retryAfter`/`retryAfterMs` field or an HTTP `Retry-After` header in seconds or HTTP-date form) and `respectRetryAfter` is enabled (default), the loop waits at least that long — never sooner than the provider asked, but still bounded by `maxDelayMs`. Set `initialDelayMs: 0` to restore the legacy immediate-retry behavior.

Provider adapters should avoid hidden internal retries when possible. The AI SDK adapter defaults provider-level retries to `0` so Sparkwright can emit each `model.requested` and `model.retrying` event itself. Non-recoverable provider errors such as OpenAI-compatible `insufficient_quota`, `invalid_api_key`, and `model_not_found` are treated as non-retryable even when the HTTP status is `429`.

### Validation Events

Validation hooks let applications turn code-owned checks into first-class
harness evidence. v0 hooks can run at `tool_result`, `workspace_write`,
`pre_terminal`, `post_sampling`, and `final_output`.

For project-facing workflow rules, prefer `workflow_hook.*` through
`capabilities.hooks.workflow` or `createRun({ workflowHooks })`: use
`PreToolUse` for tool gates, `PostToolUse` for checks after actions, and
`Stop` for "do not finish yet" gates. Keep validation hooks for embedder-owned
proposal/content validation that needs code access to the subject.

`validation.started` payload:

```json
{
  "hookName": "final-answer-policy",
  "stage": "final_output",
  "metadata": {
    "step": 3
  }
}
```

`validation.completed` and `validation.failed` payloads include the hook result:

```json
{
  "hookName": "write-policy",
  "stage": "workspace_write",
  "result": {
    "status": "failed",
    "findings": [
      {
        "code": "README_LOCKED",
        "message": "README writes are locked.",
        "severity": "error"
      }
    ]
  },
  "metadata": {
    "path": "README.md",
    "proposalId": "write_01h"
  }
}
```

Tool-result validation failures are returned to the model as failed tool observations so the model can recover. Workspace-write validation failures emit `workspace.write.denied` and prevent mutation. `pre_terminal` validation failures inject continuation context and keep the loop running for compatibility with older stop-hook integrations. Final-output validation failures fail the run with `stopReason: "validation_failed"` and failure category `validation`.

### Context Compaction Request

`context.compaction_requested` records context budget pressure. It is a signal for callers and future compaction components; v0 does not compact through an LLM automatically.

```json
{
  "step": 2,
  "selectedCount": 3,
  "omittedCount": 1,
  "reasons": {
    "max_total_chars_exceeded": 1
  },
  "metadata": {
    "totalChars": 6000
  }
}
```

Future compaction implementations should emit `context.compaction.started`, `context.compaction.completed`, or `context.compaction.failed` around summary creation. The original trace should remain intact even when compaction fails.

### Tool Batch Events

`tool.batch.requested` and `tool.batch.completed` describe how the loop grouped model-requested tool calls before execution. A batch may be `concurrent` when all tools are concurrency-safe, or `serial` when the tool requires ordered execution.

```json
{
  "step": 1,
  "batchIndex": 0,
  "mode": "concurrent",
  "toolCallCount": 2,
  "toolNames": ["read_a", "read_b"]
}
```

### Tool Progress Events

Long-running tools may call `RuntimeContext.reportToolProgress`, which emits
`tool.progress` without changing the tool result contract.

```json
{
  "toolCallId": "call_01h",
  "toolName": "grep",
  "label": "grep",
  "completedUnits": 25,
  "totalUnits": 100,
  "metadata": {}
}
```

### Workspace Write Events

`workspace.write.requested` uses the workspace write proposal shape:

```json
{
  "id": "write_01h",
  "runId": "run_01h",
  "path": "README.md",
  "content": "# Updated\n",
  "diff": "--- a/README.md\n+++ b/README.md\n@@\n-# Old\n+# Updated\n",
  "reason": "Append Sparkwright CLI Golden Path",
  "createdAt": "2026-05-16T10:00:02.000Z",
  "metadata": {}
}
```

The same shape is described by `schemas/workspace-write-proposal.schema.json`.

`workspace.write.completed` payload:

```json
{
  "proposalId": "write_01h",
  "path": "README.md",
  "diffArtifactId": "artifact_01h",
  "summary": {
    "lineCount": 12,
    "lastLines": ["", "## Notes", "", "Generated note."]
  }
}
```

`workspace.write.denied` payload:

```json
{
  "proposalId": "write_01h",
  "path": "README.md",
  "reason": "Approval denied.",
  "approvalId": "approval_01h"
}
```

### Hash-Anchored Edit Events

Hash-anchored edits are a workspace mutation primitive for coding agents. They emit their own verification events before falling through to the normal workspace write proposal path.

Event types:

- `workspace.anchored_read`
- `workspace.anchored_edit.requested`
- `workspace.anchored_edit.verified`
- `workspace.anchored_edit.rejected`

The important protocol property is that accepted anchored edits still produce `workspace.write.requested`, policy/approval events, `artifact.created` for approved writes, and either `workspace.write.completed` or `workspace.write.denied`. Anchored edits are a safer way to construct a proposed file update, not a bypass around controlled workspace mutation.

## Tool

```json
{
  "name": "read_file",
  "description": "Read a UTF-8 text file inside the workspace.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string"
      }
    },
    "required": ["path"]
  },
  "policy": {
    "risk": "safe",
    "requiresApproval": false
  },
  "interrupt": {
    "behavior": "cancel"
  },
  "loading": {
    "defer": false,
    "alwaysLoad": true
  },
  "resultSize": {
    "maxChars": 200000
  },
  "governance": {
    "allowedAgents": ["repo-pilot"],
    "allowedRoles": ["developer"],
    "dataSensitivity": "internal",
    "sideEffects": ["read"],
    "idempotency": "idempotent",
    "audit": {
      "level": "metadata",
      "retentionDays": 30
    },
    "costEstimate": {
      "tier": "free"
    }
  }
}
```

Tool risk levels:

- `safe`
- `risky`
- `denied`

Tool governance metadata is optional but should be used for production tools. The registry accepts caller scopes, rate limits, output contracts, side-effect metadata, idempotency, audit policy, data sensitivity, and cost estimates. `requiresApproval` forces the approval path even when `risk` is `safe`.

Tool descriptors may also include optional runtime hints:

- `interrupt.behavior`: whether a product shell should cancel or block when new user input arrives during execution.
- `loading.defer` / `loading.alwaysLoad`: hints for tool discovery and provider prompt packing.
- `resultSize.maxChars` / `resultSize.neverPersist`: hints for embedders that materialize large outputs as artifacts.

## Tool Call

```json
{
  "id": "call_01h",
  "runId": "run_01h",
  "toolName": "read_file",
  "arguments": {
    "path": "README.md"
  }
}
```

## Tool Result

```json
{
  "toolCallId": "call_01h",
  "status": "completed",
  "output": {
    "content": "# Sparkwright\n"
  },
  "artifacts": []
}
```

Allowed statuses:

- `completed`
- `failed`
- `cancelled`

## Policy Decision

```json
{
  "action": "workspace.write",
  "decision": "requires_approval",
  "reason": "Workspace writes require approval by default.",
  "metadata": {
    "path": "README.md"
  }
}
```

Allowed decisions:

- `allow`
- `deny`
- `requires_approval`

## Approval Request

```json
{
  "id": "approval_01h",
  "runId": "run_01h",
  "action": "workspace.write",
  "summary": "Write README.md",
  "details": {
    "path": "README.md",
    "diffArtifactId": "artifact_01h"
  },
  "createdAt": "2026-05-16T10:00:02.000Z",
  "status": "pending"
}
```

Allowed statuses:

- `pending`
- `approved`
- `denied`
- `expired`

## Approval Response

```json
{
  "approvalId": "approval_01h",
  "decision": "approved",
  "message": "Looks good.",
  "autoApproved": false
}
```

Allowed decisions:

- `approved`
- `denied`

`autoApproved` is optional. When present and `true`, it marks approvals resolved
by policy or command-line flags without requiring consumers to parse `message`.
Older traces may only expose this fact through message text.

## Artifact

```json
{
  "id": "artifact_01h",
  "runId": "run_01h",
  "type": "diff",
  "name": "README.md diff",
  "path": ".sparkwright/runs/run_01h/artifacts/readme.diff",
  "metadata": {
    "targetPath": "README.md"
  }
}
```

Initial artifact types:

- `text`
- `json`
- `diff`
- `patch`
- `file`
- `log`

## Context Item

```json
{
  "id": "ctx_01h",
  "type": "file",
  "source": {
    "kind": "workspace",
    "path": "README.md"
  },
  "content": "# Sparkwright\n",
  "parts": [
    {
      "type": "image",
      "data": "base64...",
      "mediaType": "image/png",
      "name": "screenshot.png"
    }
  ],
  "metadata": {}
}
```

`parts` is optional and carries extensible multimodal input associated with the
textual `content` summary. Current part types are `text`, `image`, `file`, and
`audio`; media parts use either base64 `data` or a resolvable `uri`.

Initial context types:

- `user`
- `system`
- `file`
- `tool_result`
- `summary`

## Trace Files

The file trace protocol is JSONL: one serialized event per line, in sequence order.

Current local run store layout:

```txt
.sparkwright/
  runs/
    <run-id>/
      run.json
      trace.jsonl
      result.json
      artifacts/
        <artifact-id>.json
        <artifact-id>.<ext>
```

`run.json` stores the latest persisted run record and is rewritten with terminal state when a run finishes. `result.json` stores the terminal `RunResult`. `trace.jsonl` is append-only and contains filtered events according to the selected trace level.

Trace levels:

- `standard`: keep useful summaries while truncating large values
- `debug`: preserve full event payloads

Large outputs, diffs, logs, screenshots, and generated files should be written as artifacts and referenced from events or context metadata.

## CLI Golden Path

The deterministic CLI golden path is a protocol smoke test, not a provider-specific behavior.

Command shape:

```bash
npm run build --workspaces
npm exec sparkwright -- run "inspect this repo and suggest a README improvement" \
  --workspace examples/repo-pilot \
  --target README.md \
  --write \
  --yes \
  --trace-level standard
```

Expected write-path event sequence includes:

```txt
run.created
run.started
context.assembled
prompt.built
model.requested
model.completed
tool.requested
tool.started
workspace.read
tool.completed
context.assembled
prompt.built
model.requested
model.completed
tool.requested
tool.started
workspace.read
workspace.write.requested
artifact.created
approval.requested
approval.resolved
workspace.write.completed
tool.completed
context.assembled
prompt.built
model.requested
model.completed
run.completed
```

If `--write` is used without `--yes` in a non-interactive environment, approval is denied and the sequence should include `workspace.write.denied` and `tool.failed` instead of `workspace.write.completed`.
