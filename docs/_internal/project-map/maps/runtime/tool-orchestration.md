# Tool Orchestration

## Purpose

Tool orchestration governs how model-requested tools are validated, grouped,
policy-checked, approved, executed, traced, and summarized.

See [../safety/workspace-writes.md](../safety/workspace-writes.md), [../safety/shell.md](../safety/shell.md), and [../../modules/coding-tools.md](../../modules/coding-tools.md).

## Main Files

- `packages/core/src/run.ts`
- `packages/core/src/tool-orchestration.ts`
- `packages/core/src/tools.ts`
- `packages/host/src/tool-catalog.ts`
- `packages/host/src/tools.ts`
- `packages/host/src/shell.ts`

## Data Flow

```txt
model tool calls
  -> host tool catalog assembly
  -> CLI diagnostic catalog profile for direct-core/cron when not using a live host
  -> validation/gating
  -> tool.batch/tool.requested events
  -> policy and approval where needed
  -> tool execution
  -> tool.completed/tool.failed
  -> model observation + trace summaries
```

## Contracts

- Tool requests are trace-visible before execution.
- `ToolDefinition.previewArgs()` is the source of truth for one-line request
  display. Core writes its bounded output to `tool.requested.payload.preview`;
  TUI/transcript renderers consume that field before falling back to legacy
  name-based formatting for old traces.
- Workspace writes must produce request, approval/policy evidence, artifact/write terminal events.
- Repeated idempotent/no-op calls should not invent false failures.
- Repeated calls inherit enough prior same-target failure context to keep
  expected policy/approval denials non-failing. This rule is category-based,
  not tool-specific; do not special-case shell/bash when adding future guarded
  tools.
- Read-family tools execute through the controlled workspace guard. A
  confidential read denied by the run policy emits `workspace.read.denied` and
  a `tool.failed` with `READ_SCOPE_DENIED`; it must not also emit
  `workspace.read` for the denied path.
- Tool target identity for capability calls (cron/agent/task) keys on the
  top-level `ref` via the shared `stableRefTarget` helper
  (`packages/core/src/run-outcome.ts`). Both the doom-loop guard
  (`semanticToolTarget` in run.ts) and outcome recovery (`targetValue` in
  run-outcome.ts) consume it, so a model varying cosmetic `job`/`patch` fields
  cannot escape the guard or break same-target recovery. The two functions stay
  intentionally different in their _fallback_ breadth (guard narrower) — do not
  merge them.
- Finality of destructive mutations: a `tool.completed` with `output.changed ===
true` records a mutation index for its target (`mutatedByTarget`). A
  runtime-error failure (e.g. `TOOL_EXECUTION_FAILED: not found`) on that same
  target whose index is _after_ a recorded mutation index is classified
  `recovered` (expected idempotent fallout), not unresolved, and is surfaced as
  the `mutationFollowups` diagnostic. Ordering matters — a mutation that lands
  after the failure must not reach back and launder it. Scope is runtime errors
  only; arg/policy denials are never laundered this way.
- Tool progress is advisory; terminal tool state comes from `tool.completed` or `tool.failed`.
- Host runtime tool surfaces should be catalogued before being flattened to
  `ToolDefinition[]`; capability snapshots use catalog source metadata and
  identity metadata (`canonicalName`, `legacyNames`, `defaultExposureTier`,
  `relatedTools`, `requiresTool`, and per-run `effectiveLoading`).
- Host-owned task creation schema belongs at the catalog boundary: the main
  catalog can describe registered task kinds and kind-specific payloads for
  model/tool validation, while `TaskManager` remains the execution registry and
  source of live unknown-kind diagnostics.
- `task_create` is a task lifecycle tool, not an internal queue. It supports
  `foreground`, `awaited`, and `background` modes; default foreground may
  promote on budget timeout when policy allows it. Explicit `mode`/`awaited`
  conflicts reject as recoverable argument errors. Global/per-kind concurrency
  caps fail as recoverable tool errors. `task(action:"wait", ids,
  mode:"any"|"all")` is the join surface.
- Deferred `task` action monitoring is guarded in both model guidance and
  runtime validation: the schema advertises action-specific non-empty
  `taskId`/`ids` requirements, while the tool-owned `validateInput()` enforces
  them before policy/approval/execution. Trace outcome recovery may downgrade
  empty monitor placeholder failures only after later concrete same-action task
  monitoring succeeds.
- `workspace.write` includes public `write`/`edit` plus advanced
  `edit_anchored_text`; new coding tools must be classified by exactly one
  workspace selector before they can appear in filtered catalogs.
- Managed workspace-write tools mark `origin.metadata.managedWorkspaceWrite`.
  In write-enabled runs, core lets those tools reach the `workspace.write` diff
  approval path; in read-only runs, write-side-effect tools are denied at the
  run write gate before approval.
- Host catalog filtering treats `tools.use` as the source/capability selector
  boundary, then intersects it with concrete `tools.allowed` before
  `tools.disabled` removes names. This happens before runtime/model descriptors
  are built. `tools.defer` only marks remaining tools for deferred schema
  loading. Generated `tool_search` entries must pass through the same filters
  so they cannot escape a configured selector/allowlist/denylist; selector-kept
  deferred tools implicitly retain `tool_search`, and discovery results include
  required/related tool closures outside max-result truncation.
- Child-agent tool orchestration uses catalog selector paths before child tool
  descriptors or delegate tools are created. Dynamic `spawn_agent` is
  intentionally limited to the read-only child catalog; configured in-process
  delegates use the configured delegate child catalog so child-profile
  `use`/`allowedTools` can expose workspace write tools and `bash` while still
  layering parent run policy and approvals. The configured delegate child run
  receives only the effective profile tool set, so prompt descriptors and
  runtime callability stay aligned. Child-scope model overrides are resolved
  lazily at tool invocation: dynamic spawn resolves `spawnModel` before
  `spawnSubAgent`, configured delegates resolve `profile.model` /
  `delegateModel` before the child run, and `delegate_parallel` resolves all
  selected child models before launching any eligible children.
- Configured delegation uses one resolved target list but two model-facing
  surfaces: `delegate_agent` is catalogued as the default indexed single-target
  entry point, while direct `delegate_*` aliases are catalogued only for pinned,
  per-profile exposed, legacy all, or `exposure: "all"` delegates. Hidden
  delegate tools remain available to `delegate_agent` so per-target policy,
  approval, and ledger behavior stay shared.
- `delegate_parallel` is catalogued only when
  `capabilities.agents.enableParallelDelegates` is true. It uses the same
  catalog filtering as other `agents` tools, accepts `agentId` (preferred) or
  legacy `toolName` targets, reports read-only side effects, and runs as one
  foreground tool call that launches multiple eligible in-process/read-only
  delegate children before awaiting all results.
- Dynamic `spawn_agent` separates tool transport completion from child-answer
  finality. A child answer that lands on the last allowed step can be
  `tool.completed`, while the output metadata/message marks the child answer as
  partial through `stepLimitReached`, `truncated`, and `finality` for trace
  consumers and context compaction.
- Child-agent step budgets inherit the parent run's effective `maxSteps` by
  default. Dynamic spawn and configured in-process delegates pass explicit
  child `maxSteps` only when requested/configured; otherwise `spawnSubAgent`
  uses `parent.maxSteps`.
- Workflow P3 Step 4b.1 filters the worker episode catalog at `createRun()`
  time when the actor is positioned on a model node with `node.tools`.
  This is a physical `ToolDefinition[]` narrowing for that worker entry, not a
  dynamic mid-run catalog mutation. The workflow PreToolUse clamp remains a
  fallback for transitions that occur inside an existing worker run. When the
  narrowed catalog contains deferred tools, host appends a scoped `tool_search`
  over the narrowed catalog only, so deferred schema loading still works without
  exposing disallowed parent-catalog tools. The clamp canonicalizes tool-name
  comparisons, so legacy declarations such as `tools: [read_file]` permit the
  canonical worker tool `read`. In the P10a two-stage `PreToolUse` path, the
  clamp runs in the governance pass after configured argument rewrites, so
  rewritten paths/tool arguments are checked before budget, repeat, policy,
  approval, and execution.
- Workflow P3 Step 4b.2 adds model-node `model` / `runBudget` routing at the
  same worker-entry boundary. It changes the worker's model adapter and budget
  parameters, but does not change tool identity, tool catalog construction, or
  capability inspection.
- Workflow P3 Step 4b.3 does not add `workflow_start` to any catalog. Model
  workers can start workflows only through the already-selected workflow
  projection path; a future model-facing spawn tool must be born through the
  task lifecycle and explicit recursion/access constraints, not by appending an
  ordinary local tool.
- In-process delegate child writes are parent-visible through a rollup of the
  child run's own `workspace.write.completed` events onto `subagent.completed`
  (`workspaceWrites`), bridged in `spawnSubAgent` — not a parent-side filesystem
  snapshot. Shell duplicate-loop detection keys on command plus cwd, ignoring
  incidental execution fields such as `timeoutMs`.
- Shell tool execution treats legacy `timeoutMs` as an observable alias for
  `foregroundTimeoutMs`, not as an incidental hard-kill field. Result payloads
  preserve timeout/promotion observability (`foregroundTimeoutMs`,
  `promotionAvailable`, `timeoutMsAliasUsed`) for model observations and trace
  diagnostics. When a foreground shell is promoted, the shell tool returns the
  promoted `taskId` at the handoff point; the adopted task then owns ongoing
  stdout/stderr observation and emits `task.created` / `task.started` /
  `task.output` / terminal `task.*` trace facts.
- Shell promotion, task foreground promotion, and dynamic `spawn_agent`
  promotion all honor the host-level `backgroundTasks` policy: disabled rejects
  new background work, foreground-only keeps foreground behavior without
  promotion, and enabled allows awaited background revival.
- Tool argument policy/normalization errors raised by `policyForArgs()` are
  converted into structured `tool.failed` results with
  `TOOL_ARGUMENTS_INVALID` and `metadata.phase: "policyForArgs"`; they do not
  escape the tool span as runtime crashes.
- Tool input validation has two layers: JSON schema first, then optional
  `ToolDefinition.validateInput(args, ctx)`, then `policyForArgs()`, policy /
  approval, execute, and output validation. `validateInput()` is a runtime-level
  semantic check only; the restricted context allows read/canonical/diff access
  but prevents workspace writes, artifacts, progress, and external side
  effects. Validation failures become structured `tool.failed` results with
  `metadata.phase: "validateInput"` and execute/approval are skipped.
- Tool result presentation is a tool-definition hint, not a second observation
  protocol. `ToolDefinition.resultPresentation` names the semantic kind and
  preserve/pagination fields; concrete read/discovery/search tools still return
  the factual fields that observation formatters and reports can preserve.
- Unloaded deferred tools are still soft-gated. If a deferred tool is
  registered but has not been loaded into the provider schema for this run, and
  its arguments fail JSON schema validation, core keeps the normal failed tool
  lifecycle but adds recovery metadata (`reason: "schema_not_loaded"`,
  `recoveryTool: "tool_search"`, `recoveryQuery: "select:<toolName>"`,
  `deferred: true`, `schemaLoaded: false`) and model-visible guidance to call
  `tool_search` before retrying. The recovery decision uses the deferred tools
  loaded at the start of the model turn, so a same-turn `tool_search` cannot
  make sibling invalid deferred calls look schema-loaded. A model that already
  supplies valid arguments can still execute the deferred tool in this
  soft-recovery phase.
- Terminal `tool.completed` / `tool.failed` events carry stage timing metadata
  when those phases ran: `schemaValidationMs`, `inputValidationMs`,
  `policyForArgsMs`, `policyDecisionMs`, `approvalWaitMs`, `executionMs`, and
  `resultValidationMs`. `approvalWaitMs` covers only the approval resolver wait,
  not policy decision time.
- Core duplicate diagnostics distinguish same-concurrent-batch
  `in_flight_duplicate` calls from completed-result repeats. In-flight
  duplicates receive an accurate skipped tool result and do not mark the target
  as failed/no-op for next-turn repeat bookkeeping. Same-batch duplicate
  multiplicity still feeds the repeated-call / doom-loop guard, so pathological
  same-turn fan-out is not hidden by the in-flight diagnostic.
- Concurrent tool batches emit trace events, after-tool hooks, run-health
  feedback, duplicate diagnostics, and doom-loop bookkeeping in real-time
  completion order. Only model-visible `tool_result` observation context is
  delayed until the batch completes, then appended in original request order.
  Serial batches still append observations immediately.
- Completed read-like tool results also feed `RunHealthAnalyzer`; repeated
  unchanged file windows append `run.health` context for the next model turn
  without altering the original `tool.completed` result or trace semantics. For
  paginated read windows, host read tools should expose structured `nextOffset`
  whenever line-offset continuation is valid, and run-health feedback should
  include the next unread offset when a model pages backwards into an
  already-read window.
- direct-core/cron diagnostic runs should flatten `createCliDiagnosticToolCatalog`; avoid local shim tools that bypass the same policy/approval/write surfaces.
- Configured workflow hook command actions share the traced process runner with
  shell/tool diagnostics and run with process kind `workflow_hook`. Event hook
  command actions run with process kind `user_hook` through `bindUserHooks()`
  and must not block tool orchestration or approval flow. HTTP and agent hook
  actions are host-owned side effects outside the traced process runner.
- Workflow command actions can opt into `resultMode: "stdoutJson"` for
  successful commands. The command stdout is parsed into a `WorkflowHookResult`
  before core applies block/rewrite/context effects; failed or timed-out
  commands still follow the existing `blockOnFailure`/`onError` path. Live
  progress for command hooks, event hooks, skills, delegates, and promoted task
  observation uses host-owned stderr `SPARKWRIGHT_EVENT:` token lines; token
  lines are stripped before stderr previews/artifacts/live output/task output.
  For `PreToolUse`, result-producing configured actions run in the rewrite pass;
  static block/context actions and workflow clamps run in governance over the
  rewritten arguments.

## Consumers

- Core run loop.
- Host tool catalog plus coding tools, shell, MCP, skills, agents, tasks.
- CLI direct-core and cron runners through `createConfiguredCliTools`.
- Trace timeline and summary.
- TUI event rendering.

## Change Checklist

- Keep tool ids stable enough for approval, grouping, and duplicate diagnostics.
- Check policy metadata and side-effect classifications.
- Check host catalog source metadata and `capability.inspect` parity.
- Check trace payload size and result summarization.
- Add tests for recoverable failures and retries.

## Known Debts

- Duplicate non-read tool calls remain a common diagnostic issue.
- Tool result text can be too verbose for both trace and model context.
- Large-result handling is not a blank slate: shell and traced process runner
  paths already materialize stdout/stderr artifacts, observation formatting
  summarizes model-visible output, and `trace-store.ts` owns
  `artifact.created`. Do not add a global run-loop spill post-processor without
  first preserving existing artifact ownership and `resultSize.neverPersist`.
- CLI `capabilities inspect` derives diagnostic tool inventory from runtime snapshots; `tools list` has been removed to keep one authoritative tool inventory entry point.
- TUI live rendering and transcript export now share presentation summaries, but trace/model-context result compaction is still a separate backend concern.

## Last Verified

- Status: Verified
- Date: 2026-07-06T21:18:25+0800
- Scope: C13-② post-acceptance read-tool policy fix: protocol runs that rely
  on workspace config now reach the same effective read-scope policy as CLI-
  supplied runs. Tool catalog/filtering and `tool.requested`/`tool.failed`
  orchestration are unchanged.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/test/protocol.test.ts`,
  `packages/host/src/tools.ts`,
  `packages/core/src/workspace.ts`.
- Tests: `npm --workspace @sparkwright/host test --
  test/protocol.test.ts -t "confidential"`.

- Status: Verified
- Date: 2026-07-06T20:47:10+0800
- Scope: C13-② read tool orchestration check: built-in confidential read
  defaults are enforced inside the normal tool execution path, preserving
  `tool.requested`/`tool.failed` pairing and avoiding `workspace.read` on
  denied paths.
- Read: `packages/core/src/policy.ts`, `packages/core/src/workspace.ts`,
  `packages/host/src/tools.ts`, `packages/host/src/runtime.ts`,
  `packages/cli/test/cli.test.ts`.
- Tests: `npm --workspace @sparkwright/core test -- test/policy.test.ts
  test/workspace.test.ts`; `npm --workspace @sparkwright/cli test --
  test/cli.test.ts -t "confidential"`.

- Status: Verified
- Date: 2026-07-05T23:08:34+0800
- Scope: P10a D20 tool orchestration ordering: configured `PreToolUse` rewrites
  apply before governance clamps, while budget, repeat, policy, approval, and
  execution remain downstream of both passes.
- Read: `packages/core/src/run.ts`, `packages/core/src/workflow-hooks.ts`,
  `packages/host/src/workflow-hooks.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/core/test/workflow-hooks.test.ts`,
  `packages/host/test/workflow-hooks.test.ts`.
- Tests: `npm --workspace @sparkwright/core test --
  test/workflow-hooks.test.ts -t "PreToolUse|workflowHooks"`; `npm
  --workspace @sparkwright/core run typecheck`; `npm --workspace
  @sparkwright/core run build`; `npm --workspace @sparkwright/host test --
  test/workflow-hooks.test.ts -t "PreToolUse|blocks tools outside|configured
  PreToolUse"`; `npm --workspace @sparkwright/host run typecheck`.

- Status: Read-only
- Date: 2026-07-05T22:20:59+0800
- Scope: workflow-runtime-v1 P8a routed-page check: shared workflow trace
  observation reads historical `tool.requested` / `tool.completed` events for
  offline coverage only. It does not alter catalog assembly, validation,
  approval, execution, trace emission, or tool result semantics.
- Read: `packages/host/src/workflow-trace-observation.ts`,
  `packages/host/src/workflow-shadow.ts`,
  `packages/cli/src/cli.ts`,
  `packages/host/test/workflow-shadow.test.ts`.
- Tests: not run for live tool orchestration; P8a made no tool execution
  semantic change. Focused shadow gates passed in host/CLI.

- Status: Verified
- Date: 2026-07-05T13:59:13+0800
- Scope: P3 Step 4b.1 review fix: workflow worker-entry catalog narrowing
  preserves deferred-tool discovery by adding a scoped `tool_search` only when
  the filtered catalog includes deferred tools, and the PreToolUse fallback
  uses canonical tool-name comparison.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/host/test/workflows.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/workflows.test.ts -t
  "narrows model worker catalogs|keeps scoped tool_search"`; `npm --workspace
  @sparkwright/host test -- test/workflow-hooks.test.ts -t "blocks tools
  outside|PreToolUse"`.

- Status: Verified
- Date: 2026-07-05T12:23:15+0800
- Scope: workflow-runtime-v1 P3 Step 4b.3 tool-orchestration boundary:
  `workflow_start` is intentionally absent from host catalogs and workflow
  episode catalogs in P3.
- Read: `packages/host/src/tool-catalog.ts`,
  `packages/host/src/tool-identities.ts`, `packages/host/src/runtime.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `rg -n "workflow_start" packages/host/src packages/host/test
  packages/cli/test packages/protocol/src docs/reference`; `npm run
  release:check`.

- Status: Verified
- Date: 2026-07-05T12:15:55+0800
- Scope: workflow-runtime-v1 P3 Step 4b.2 tool-orchestration boundary:
  model-node `model`/`runBudget` are worker `createRun()` parameters and do not
  change catalog construction beyond the already-landed Step 4b.1 narrowing.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/host/test/workflows.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/workflows.test.ts -t
  "node model and budget|narrows model worker catalogs"`.

- Status: Verified
- Date: 2026-07-05T11:49:40+0800
- Scope: workflow-runtime-v1 P3 Step 4b.1 tool orchestration: workflow model
  worker episodes receive a filtered `ToolDefinition[]` based on the active
  node's `tools`, and unavailable tool calls surface through core as
  `TOOL_NOT_FOUND`.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/host/test/workflows.test.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/workflows.test.ts -t
  "narrows model worker catalogs|workflow"`; `npm --workspace
  @sparkwright/host test -- test/workflow-hooks.test.ts -t "blocks tools
  outside|PreToolUse"`.

- Status: Read-only
- Date: 2026-07-05T00:42:02+0800
- Scope: workflow-runtime-v1 P2 routing check: durable workflow list/resume and
  projection snapshot persistence do not change tool validation, approval,
  execution, or model-visible tool observation semantics.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/core/src/run.ts`,
  `docs/_internal/project-map/maps/runtime/tool-orchestration.md`.
- Tests: not run for tool-orchestration-specific behavior; P2 made no tool
  execution semantic change.

- Status: Verified
- Date: 2026-07-02T21:55:07+0800
- Scope: repeated-tool orchestration now distinguishes repeated expected
  denials from ordinary repeated argument/runtime failures, preserving generic
  tool target identity and recovery semantics across run outcome and trace
  diagnostics.
- Read: `packages/core/src/run.ts`, `packages/core/src/run-outcome.ts`,
  `packages/core/src/trace-diagnostics.ts`,
  `packages/core/test/run.test.ts`,
  `packages/core/test/run-outcome.test.ts`,
  `packages/core/test/trace.test.ts`,
  `docs/_internal/project-map/maps/runtime/tool-orchestration.md`.
- Tests: `npm --workspace @sparkwright/core test --
  test/run.test.ts test/run-outcome.test.ts test/trace.test.ts`;
  `npm --workspace @sparkwright/core run typecheck`;
  `npm run build --workspace @sparkwright/core`;
  `npm run check:dist-fresh`.

- Status: Verified
- Date: 2026-07-02T16:47:56+0800
- Scope: refreshed task monitor orchestration after real mini empty-id
  placeholder calls: agent-runtime now validates action-specific ids, host
  catalog preserves the deferred schema, and core outcome recovery recognizes
  later concrete same-action monitoring.
- Read: `packages/agent-runtime/src/tasks/tools.ts`,
  `packages/agent-runtime/test/tasks.test.ts`,
  `packages/core/src/run-outcome.ts`,
  `packages/core/test/run-outcome.test.ts`,
  `packages/core/test/trace.test.ts`,
  `packages/host/src/tool-catalog.ts`,
  `packages/host/test/tools.test.ts`,
  `docs/_internal/test-map/failures/task-action-empty-id-recovery.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
  test/tasks.test.ts`; `npm --workspace @sparkwright/core test --
  test/run-outcome.test.ts test/trace.test.ts`; `npm --workspace
  @sparkwright/host test -- test/tools.test.ts -t "main host tool catalog"`;
  core/agent-runtime typecheck and builds; `npm run check:dist-fresh`.

- Status: Verified
- Date: 2026-07-02T09:30:00+0800
- Scope: refreshed task orchestration after making `task_create` explicit mode
  authoritative over the compatibility `awaited` flag, with conflicts rejected;
  host notification bridge now surfaces detached terminal task notifications
  while keep-alive remains awaited-only.
- Read: `packages/agent-runtime/src/tasks/tools.ts`,
  `packages/agent-runtime/test/tasks.test.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/test/task-revival.test.ts`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
  test/tasks.test.ts -t "task_create|notification"`; `npm --workspace
  @sparkwright/host test -- test/task-revival.test.ts`; relevant workspace
  typechecks for agent-runtime and host.

- Status: Verified
- Date: 2026-07-02T01:15:00+0800
- Scope: tool orchestration now routes background lifecycle through shared task
  primitives: `task_create` modes and recoverable caps, task wait any/all,
  foreground promotion for tasks/shell/spawn gated by `backgroundTasks`, and
  controlled nested child-agent task creation when the agents policy opts in.
- Read: `packages/agent-runtime/src/tasks/tools.ts`,
  `packages/agent-runtime/src/tasks/manager.ts`,
  `packages/host/src/tool-catalog.ts`,
  `packages/host/src/shell.ts`,
  `packages/host/src/runtime.ts`,
  `packages/core/src/run.ts`,
  `packages/host/test/spawn-agent.test.ts`,
  `packages/agent-runtime/test/tasks.test.ts`.
- Tests: `npm --workspace @sparkwright/agent-runtime test -- test/tasks.test.ts
  -t "TaskManager|task_create|task action wait|retention"`;
  `npm --workspace @sparkwright/host test -- test/spawn-agent.test.ts -t
  "promotes slow dynamic|foreground-only background policy|depth-bounded sub-agents|bounded by maxDepth"`;
  host/agent-runtime typecheck and builds.

- Status: Verified
- Date: 2026-07-01T20:51:06+0800
- Scope: thin result-presentation metadata for read/discovery/search tools and
  trace-report workspace-read attribution through existing tool spans.
- Read: `packages/core/src/tools.ts`,
  `packages/coding-tools/src/index.ts`,
  `packages/core/src/trace-diagnostics.ts`,
  `packages/coding-tools/test/index.test.ts`,
  `packages/core/test/trace.test.ts`,
  `docs/_internal/project-map/maps/runtime/tool-orchestration.md`.
- Tests: `npm --workspace @sparkwright/coding-tools test -- test/index.test.ts`;
  `npm --workspace @sparkwright/core test -- test/trace.test.ts`;
  `npm --workspace @sparkwright/core run typecheck`;
  `npm --workspace @sparkwright/coding-tools run typecheck`;
  `npm --workspace @sparkwright/host run typecheck`.

- Status: Verified
- Date: 2026-07-01T13:08:00+0800
- Scope: host catalog task-create schema ownership for background-agent tasks,
  including live registered-kind diagnostics and downstream real task runner
  coverage.
- Read: `packages/host/src/tool-catalog.ts`,
  `packages/agent-runtime/src/tasks/tools.ts`,
  `packages/agent-runtime/src/tasks/manager.ts`,
  `packages/host/test/tools.test.ts`,
  `packages/host/test/protocol.test.ts`,
  `docs/_internal/project-map/maps/runtime/tool-orchestration.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
  test/index.test.ts test/tasks.test.ts`; `npm --workspace
  @sparkwright/agent-runtime run typecheck`; `npm --workspace
  @sparkwright/host test -- test/tools.test.ts -t "main host tool catalog"`;
  `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t
  "starts a background agent through the real task_create tool"`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm run check:dist-fresh`.

- Status: Verified
- Date: 2026-07-01T11:56:08+0800
- Scope: rechecked deferred schema recovery against model-turn snapshots,
  coding-tool semantic validation boundaries, host read literal path handling,
  and shared host background-agent task runner coverage.
- Read: `packages/core/src/run.ts`, `packages/core/src/tools.ts`,
  `packages/core/test/run.test.ts`, `packages/coding-tools/src/index.ts`,
  `packages/coding-tools/test/index.test.ts`, `packages/host/src/tools.ts`,
  `packages/host/src/runtime.ts`, `packages/host/test/tools.test.ts`,
  `packages/host/test/agent-task-runner.test.ts`,
  `docs/_internal/project-map/maps/runtime/tool-orchestration.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/run.test.ts`;
  `npm --workspace @sparkwright/coding-tools test -- test/index.test.ts`;
  `npm --workspace @sparkwright/host test -- test/tools.test.ts`;
  `npm --workspace @sparkwright/host test -- test/agent-task-runner.test.ts`;
  `npm --workspace @sparkwright/core run typecheck`;
  `npm --workspace @sparkwright/coding-tools run typecheck`;
  `npm --workspace @sparkwright/host run typecheck`.

- Status: Verified
- Date: 2026-06-30T23:59:00+0800
- Scope: deferred tool schema soft recovery, stage timing metadata,
  `validateInput()` ordering, concurrent observation ordering, and large-output
  materialization boundaries.
- Read: `packages/core/src/run.ts`, `packages/core/src/tools.ts`,
  `packages/core/test/run.test.ts`, `packages/host/src/tools.ts`,
  `packages/coding-tools/src/index.ts`, `packages/shell-tool/src/tool.ts`,
  `packages/host/src/traced-process-runner.ts`, `packages/core/src/context.ts`,
  `packages/core/src/trace-store.ts`,
  `docs/_internal/project-map/maps/runtime/tool-orchestration.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/run.test.ts`;
  `npm --workspace @sparkwright/coding-tools test -- test/index.test.ts`;
  `npm --workspace @sparkwright/host test -- test/tools.test.ts`;
  `npm --workspace @sparkwright/shell-tool run typecheck`;
  `npm --workspace @sparkwright/core run typecheck`;
  `npm --workspace @sparkwright/coding-tools run typecheck`;
  `npm --workspace @sparkwright/host run typecheck`.

- Status: Verified
- Date: 2026-06-30T09:30:00+0800
- Scope: shell foreground-to-background promotion now returns the promoted
  task id at handoff, leaves ongoing output ownership with the background task,
  and records the full task lifecycle beginning with `task.created`.
- Read: `packages/shell-tool/src/tool.ts`,
  `packages/host/src/shell.ts`,
  `packages/host/src/traced-process-runner.ts`,
  `packages/host/test/tools.test.ts`,
  `packages/shell-tool/test/shell-tool.test.ts`,
  `docs/_internal/project-map/maps/runtime/tool-orchestration.md`.
- Tests: `npm --workspace @sparkwright/shell-tool test --
  test/shell-tool.test.ts`;
  `npm --workspace @sparkwright/host test -- test/tools.test.ts -t
  "promotes long-running shell"`;
  `npm --workspace @sparkwright/shell-tool run typecheck`;
  `npm --workspace @sparkwright/host run typecheck`.

- Status: Verified
- Date: 2026-06-29T17:40:00+0800
- Scope: paginated read outputs now carry structured `nextOffset`, and
  run-health repeated-read feedback includes the next unread offset for
  backwards paging without converting successful reads into hard failures.
- Read: `packages/host/src/tools.ts`, `packages/core/src/run-health.ts`,
  `packages/core/src/run.ts`, `packages/host/test/tools.test.ts`,
  `packages/core/test/run.test.ts`,
  `docs/_internal/project-map/maps/runtime/tool-orchestration.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/tools.test.ts`;
  `npm --workspace @sparkwright/core test -- test/context.test.ts test/run.test.ts
  test/trace.test.ts`; `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/core run typecheck`.

- Status: Verified
- Date: 2026-06-29T09:28:39+0800
- Scope: tool orchestration now receives canonical descriptors from the host
  catalog, keeps advanced tools deferred behind `tool_search`, expands
  required/related discovery closures, and treats `bash` as the canonical shell
  execution tool while retaining legacy trace parsing.
- Read: `packages/core/src/tools.ts`, `packages/core/src/tool-search.ts`,
  `packages/core/src/run.ts`, `packages/host/src/tool-identities.ts`,
  `packages/host/src/tool-catalog.ts`, `packages/host/src/runtime.ts`,
  `packages/host/test/tools.test.ts`, `packages/host/test/protocol.test.ts`.
- Tests: `npm --workspace @sparkwright/core test -- test/tool-search.test.ts test/context.test.ts test/run.test.ts test/trace.test.ts`;
  `npm --workspace @sparkwright/host test -- test/tools.test.ts test/protocol.test.ts test/config.test.ts`.

- Status: Verified
- Date: 2026-06-28T20:30:50+0800
- Scope: foreground tool execution now reaches core approval policy with
  explicit `read_file` read-only governance metadata; plan/read-only mode
  allows only safe tools whose side effects are declared read-only/no-op while
  repeated-read loop handling stays unchanged.
- Read: `packages/core/src/run.ts`,
  `packages/core/src/policy.ts`,
  `packages/host/src/tools.ts`,
  `packages/host/src/tool-catalog.ts`,
  `packages/host/test/tools.test.ts`,
  `packages/host/test/protocol.test.ts`,
  `docs/_internal/project-map/maps/runtime/tool-orchestration.md`.
- Tests: `npm --workspace @sparkwright/core test -- test/policy.test.ts test/access-mode.test.ts test/trace.test.ts`;
  `npm --workspace @sparkwright/host test -- test/run-access.test.ts test/protocol.test.ts test/tools.test.ts`;
  real mini CLI/TUI read-only traces verified with 0 approvals and 0 writes.

- Status: Verified
- Date: 2026-06-28T14:13:14+0800
- Scope: multi-model child-scope defaults are resolved lazily during
  `spawn_agent`, configured delegate, and `delegate_parallel` tool execution
  without changing catalog/filtering semantics.
- Read: `packages/agent-runtime/src/index.ts`,
  `packages/host/src/runtime.ts`, `packages/host/src/tool-catalog.ts`,
  `packages/host/test/tools.test.ts`, `packages/host/test/protocol.test.ts`,
  `docs/_internal/project-map/maps/runtime/tool-orchestration.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime test -- test/index.test.ts`;
  `npm --workspace @sparkwright/host test --
test/config.test.ts test/tools.test.ts test/protocol.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`.
- Prior verification — Date: 2026-06-28T13:34:37+0800
- Scope: workflow command `stdoutJson` remains the hook control plane while
  command/event hook process progress now uses stderr `SPARKWRIGHT_EVENT:`
  token lines; token stripping covers runner output, live streaming, task
  output, and delegate progress summaries without changing tool orchestration
  terminal semantics.
- Prior verification — Date: 2026-06-27T22:36:34+0800
- Scope: P4/P5 hook action execution kept tool orchestration behavior intact
  while splitting non-blocking event command diagnostics into the user-hook lane
  and adding workflow HTTP/agent result parsing.
- Prior verification — Date: 2026-06-27T19:27:28+0800
- Scope: removed the dead `toolset.ts` flattening wrapper from runtime routing;
  tool orchestration still flattens host catalog entries directly when needed.
- Tests: `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/host test --
test/agent-profiles.test.ts test/skill-evolution.test.ts
test/protocol.test.ts`.
- Prior verification — Date: 2026-06-27T14:22:00+0800
- Scope: checked host catalog integration for default `delegate_agent`, filtered
  direct `delegate_*` aliases, and `agentId`-aware `delegate_parallel`.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/tool-catalog.ts`,
  `packages/host/test/tools.test.ts`,
  `packages/host/test/protocol.test.ts`,
  `docs/_internal/project-map/maps/runtime/tool-orchestration.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/config.test.ts test/tools.test.ts test/agent-profiles.test.ts test/protocol.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/host run build`.
- Prior verification (delegate_parallel Phase 4a runtime) — Date: 2026-06-27T12:16:45+0800
- Scope: checked host catalog integration for opt-in `delegate_parallel` as an
  `agents` source tool that stays within normal foreground tool execution and
  catalog filtering.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/tool-catalog.ts`,
  `packages/host/test/tools.test.ts`,
  `packages/host/test/protocol.test.ts`,
  `docs/_internal/project-map/maps/runtime/tool-orchestration.md`.
- Tests: `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/host test -- test/tools.test.ts -t "delegate_parallel|foreground parallel|write-capable delegates"`;
  `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t "delegate_parallel|reserved by an existing delegate|reserved name"`;
  `npm run check`.
- Prior verification (access mode) — Date: 2026-06-26T23:59:00+0800
- Read: `packages/core/src/run.ts`, `packages/core/src/run-outcome.ts`,
  `packages/core/src/trace-diagnostics.ts`, `packages/shell-tool/src/tool.ts`,
  `packages/cron/src/tool.ts`, `packages/core/test/run-outcome.test.ts`,
  `packages/core/test/run.test.ts`, `packages/core/test/trace.test.ts`,
  `packages/host/src/run-access.ts`, `packages/cli/src/cli.ts`.
- Tests: `npm --workspace @sparkwright/core test -- test/access-mode.test.ts`;
  `npm --workspace @sparkwright/host test -- test/run-access.test.ts test/protocol.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts`;
  `npm run schema:check`; `npm run build`; `npm run check:dist-fresh`.
