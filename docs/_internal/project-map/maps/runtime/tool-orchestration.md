# Tool Orchestration

## Purpose

Tool orchestration governs how model-requested tools are validated, grouped,
policy-checked, approved, executed, traced, and summarized.

See [../safety/workspace-writes.md](../safety/workspace-writes.md), [../safety/shell.md](../safety/shell.md), and [../../modules/coding-tools.md](../../modules/coding-tools.md).

## Main Files

- `packages/core/src/run.ts`
- `packages/core/src/run-budget.ts`
- `packages/core/src/tool-orchestration.ts`
- `packages/core/src/runtime/tool-result-analysis.ts`
- `packages/core/src/tools.ts`
- `packages/host/src/tool-catalog.ts`
- `packages/host/src/run-security-plan.ts`
- `packages/host/src/tools.ts`
- `packages/host/src/shell.ts`
- `packages/coding-tools/src/index.ts`
- `packages/coding-tools/src/unified-diff.ts`
- `packages/host/src/runtime/host-runtime.ts`

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

- Prepared-change tools may call `RuntimeContext.requestApproval()` during
  execute after persisting a final effect. This is not a second approval bus:
  it uses the run's normal `approval.requested/resolved` lifecycle. Such tools
  must avoid a redundant pre-staging risky-tool approval on their eligible fast
  path and bind the in-execute request to durable effect identity.

- Tool requests are trace-visible before execution.
- A tool call reserves the run-local and all inherited ancestor-tree
  `maxToolCalls` counters before execution. Core first checks every account and
  commits only after all checks pass, so concurrent in-process sibling Agents
  cannot oversubscribe a shared descendant ceiling and a refused call never
  reaches the tool implementation. Policy/approval ordering and evidence remain
  unchanged.
- `ToolDefinition.previewArgs()` is the source of truth for one-line request
  display. Core writes its bounded output to `tool.requested.payload.preview`;
  TUI/transcript renderers consume that field before falling back to legacy
  name-based formatting for old traces.
- `ToolDefinition.approvalSummaryForArgs()` is the source of truth for
  argument-dependent approval summaries. Core uses it when a tool gate requests
  approval, then falls back to `Run tool <name>`. This keeps capability-grant
  approvals such as `spawn_agent` workspace write grants specific without adding
  tool-name switches in the run loop.
- Workspace writes must produce request, approval/policy evidence, artifact/write terminal events.
- Repeated idempotent/no-op calls should not invent false failures.
- State-observation tools may provide bounded repeated-call guidance. The
  generic repeat guard then records a completed skipped observation and lets
  the model choose a blocking or incremental control surface without core
  hard-coding a tool name.
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
- Live Host catalogs wrap tools whose effective argument-level governance
  declares workspace `write` with a process-local mutation lease. The wrapper
  is applied after tool filtering and before flattening, so parent and child
  coding/Shell/capability mutations share one execution boundary. Agent
  dispatch/delegate tools that admit a child are excluded from parent wrapping;
  the child execution owns the lease and its managed write tools reenter by run
  id. Capability inspection builds inert catalogs and does not acquire leases.
- Host run preparation and configured capability inspection share one immutable
  security plan for resolved access and filesystem/sandbox inputs, then build
  separate stateful lifecycles on top. The plan must not retain prepared MCP
  handles, tool instances, approval state, or Core mutation-policy state.
- Host runtime and CLI direct-core start/resume call the same Host-owned
  run-policy factory, but each call receives a new stateful policy instance.
  This keeps target/write defaults aligned without leaking the mutation
  policy's per-run `writtenPaths` into immutable preparation state.
- That plan reports configured main-Shell sandbox status separately from the
  effective extension-process sandbox. Read-only runs strengthen the latter for
  MCP/Skill preparation; Workflow Script and explicit run-bound command hooks
  apply their capability-specific no-write clamp at their execution boundary.
- CLI capability inspection consumes the Host snapshot as the effective tool,
  delegate, and sandbox source. CLI-only report sections may enrich it, but
  must not synthesize a second effective catalog when Host inspection fails.
- Host-owned task creation schema belongs at the catalog boundary: the main
  catalog can describe registered task kinds and kind-specific payloads for
  model/tool validation, while `TaskManager` remains the execution registry and
  source of live unknown-kind diagnostics.
- `task_create` is a task lifecycle tool, not an internal queue. It supports
  `foreground`, `awaited`, and `background` modes; default foreground may
  promote on budget timeout when policy allows it. Explicit `mode`/`awaited`
  conflicts reject as recoverable argument errors. Global/per-kind concurrency
  caps fail as recoverable tool errors. `task(action:"wait", ids,
mode:"any"|"all")` is the join surface. Detached/promoted create results
  include concrete `nextAction` guidance so the model has a task id and monitor
  action to reuse instead of issuing an equivalent `task_create`.
- The model-facing `task` control schema stays a provider-compatible flat
  object. The wrapper canonicalizes optional fields per action before
  validation/execution, discards empty/action-irrelevant values, and rejects
  conflicting `taskId`/`ids` wait forms.
- Trace report derives a task-specific repeated-create advisory from
  `task_create` lifecycle events when a later same-run create has the same
  `kind` + stable payload fingerprint after an earlier same-payload task
  completed. This diagnostic intentionally ignores scheduling-only differences
  such as `mode`/`awaited` and skips failed, cancelled, partial, or truncated
  prior tasks.
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
- A successful body-level `skill_load` may load deferred schemas named by the
  Skill's `allowed-tools`. Core only marks matching tools already present in the
  run registry; absent/disabled tools stay absent, and normal policy/approval
  still governs execution. Resource-only loads do not change tool loading.
- Child-agent tool orchestration uses catalog selector paths before child tool
  descriptors or delegate tools are created. Dynamic `spawn_agent` uses a
  dynamic child catalog that defaults to read-only tools but can expose managed
  workspace write tools at spawn time when the tool call requests a
  workspace-write grant; it still never exposes `bash`. Configured in-process
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
  fallback for transitions that occur inside an existing worker run. The
  fallback's availability check is over the actual active run registry, while
  allowed-tool comparison is over the active workflow node. That distinction
  prevents a script/non-model drain into a narrowed model node from treating a
  parent-catalog tool as "not found" just because the ideal workflow allowlist
  excludes it. When the narrowed catalog contains deferred tools, host appends a
  scoped `tool_search` over the narrowed catalog only, and the clamp permits only
  that marked scoped discovery tool. The clamp canonicalizes tool-name
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
- Shell tool execution accepts only the canonical per-call
  `foregroundTimeoutMs`; legacy `timeoutMs` is rejected by the closed input
  schema rather than retained behind unreachable runtime alias logic. Result
  payloads preserve timeout/promotion observability (`foregroundTimeoutMs`,
  `promotionAvailable`) for model observations and trace diagnostics. When a
  foreground shell is promoted, the shell tool returns the
  promoted `taskId` at the handoff point; the adopted task then owns ongoing
  stdout/stderr observation and emits `task.created` / `task.started` /
  `task.output` / terminal `task.*` trace facts.
- Shell uses `onBackground` as the shared explicit/timeout handoff primitive and
  writes `shell.background` task records. `onPromote` remains a deprecated API
  alias, while active historical `shell.promoted` records remain readable for
  deduplication.
- The shell handoff resolves `{ awaited, lifetime }` once. TaskManager consumes
  `awaited` as its generic keep-alive contract; shell lifetime remains at this
  boundary and is not added to unrelated task kinds.
- Main-host `task_create` is eager while `task` control remains advanced and
  deferred. A shell result carries its concrete task id and concise management
  guidance; models load `task` through `tool_search` when they need
  get/output/wait/stop. Runtime truth remains the task action result and durable
  record, not model prose.
- Explicit `background:true` shell calls pass validation/policy/approval before
  a direct handoff and return `backgroundOrigin:"explicit"`; they are not
  modeled as promotion. Their task is detached (`awaited:false`) but terminal
  notifications still use the shared notification source. `lifetime:service`
  adds only an immediate-exit grace check, and active equivalent explicit shell
  work deduplicates before process spawn.
- Direct-background results treat the task id, `task.started`, and captured
  early output as sufficient launch confirmation. Guidance forbids a redundant
  `task get` snapshot and points to wait only when the terminal result is needed.
- Shell promotion, task foreground promotion, and dynamic `spawn_agent`
  promotion all honor the host-level `backgroundTasks` policy: disabled rejects
  new background work, foreground-only keeps foreground behavior without
  promotion, and enabled allows awaited background revival.
- Tool argument policy/normalization errors raised by `policyForArgs()` are
  converted into structured `tool.failed` results with
  `TOOL_ARGUMENTS_INVALID` and `metadata.phase: "policyForArgs"`; they do not
  escape the tool span as runtime crashes.
- Batch admission must not infer concurrency safety from static governance when
  `policyForArgs()` can strengthen it. Such tools are serial by default and may
  opt back into argument-specific concurrency only through a pure,
  invalid-input-tolerant `isConcurrencySafe(args)` classifier. Policy and
  approval still execute at the ordinary per-call gate; this rule prevents
  separately authorized mutations from being scheduled concurrently, not an
  approval bypass.
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
- Date: 2026-07-15T07:35:27+0800
- Scope: duplicate/repeated-call, failure-context, no-op, and compaction request
  analysis moved intact to a pure leaf; validation, policy, approval, execution,
  observation, recovery, and event ordering are unchanged.
- Read: Core run tool phases and tool-result-analysis.
- Tests: Core run/runtime-guardrails/trace and Host tools/protocol.

- Status: Read-only
- Date: 2026-07-15
- Scope: CLI config/doctor handler extraction preserves tools configuration
  display and validation; runtime catalog, policy, approval, and invocation are unchanged.
- Read: CLI config-doctor and facade config routing.
- Tests: CLI config focused/full golden and repo-pilot.

- Status: Verified
- Date: 2026-07-15
- Scope: CLI tool capability inventory and delegate diagnostics moved to a
  domain module; catalog assembly, policy, approval, invocation, observation,
  and event order are unchanged.
- Read: CLI capability command and Host tool/delegate APIs.
- Tests: CLI capability/delegate focused slices, full golden, and repo-pilot.

- Status: Read-only
- Date: 2026-07-15
- Scope: CLI trace/session handler relocation preserves direct-core resume tool
  assembly, Host routing, policy, approval, event, and observation behavior.
- Read: CLI trace-session module and both CLI runners.
- Tests: CLI run-resume focused slice, full golden, and repo-pilot.

- Status: Read-only
- Date: 2026-07-15
- Scope: task value conversion moved to a leaf; tool selection, policy,
  approval, invocation, observation, and event order are unchanged.
- Read: concrete runtime and task-projections boundary.
- Tests: Host tools/agent focused suites and repo-pilot.

- Status: Verified
- Date: 2026-07-15
- Scope: tool capability projection and configured/live snapshot merge moved
  to a stateless collaborator; actual catalog assembly, policy, approval,
  invocation, observation, and event behavior are unchanged.
- Read: capability-assembly and concrete runtime tool preparation.
- Tests: Host tools/agent/delegate/protocol focused suites and repo-pilot.

- Status: Verified
- Date: 2026-07-15
- Scope: HostRuntime module relocation only; tool assembly, policy, approval,
  execution, observation, and event behavior are unchanged.
- Read: runtime facade and concrete runtime imports/tool assembly.
- Tests: Host tools/agent/delegate focused suites and repo-pilot.

- Status: Read-only
- Date: 2026-07-15
- Scope: Host execution coordination contracts moved to a type leaf; tool
  preparation, policy, approval, invocation, result, and event behavior are
  unchanged.
- Read: runtime contracts and Host runtime coordination boundary.
- Tests: Host tools/agent/delegate focused suites and repo-pilot.

- Status: Verified
- Date: 2026-07-15
- Scope: unified-diff parsing/application moved behind the coding-tools named
  facade; tool validation, policy, approval, execution, and event ordering are
  unchanged.
- Read: coding-tools facade, unified-diff leaf, and coding-tools tests.
- Tests: coding-tools full suite/typecheck/build and Host tools downstream test.

- Status: Verified
- Date: 2026-07-14
- Scope: checked Host connection principal and Workflow control attribution;
  tool preparation, selection, policy, and invocation contracts are unchanged.
- Tests: Host focused suites and typecheck passed.

- Status: Verified
- Date: 2026-07-14T14:35:00+0800
- Scope: P6 routed review; tool orchestration and lease admission semantics are
  unchanged by module renaming.
- Tests: Host full suite passed.

- Status: Verified
- Date: 2026-07-14
- Scope: reviewed Host IM message and approval routing; tool execution and
  approval policy remain Core/Host execution concerns.

- Status: Verified
- Date: 2026-07-14
- Scope: reviewed atomic interactive command acceptance and Host lanes; tool
  preparation, policy gates, and Core tool execution remain existing owners.

- Status: Verified
- Date: 2026-07-14
- Scope: added catalog-level mutation lease wrapping around actual Host
  parent/child write execution without moving policy, approval, or concurrency
  classification out of Core.
- Read: Host tool catalog/runtime, effective argument governance, Agent spawn
  grants, Shell background handoff, and coordinator wrapper.
- Tests: focused Host tool/Agent/coordinator suites, all workspace tests, and
  release smokes passed. Touched files are format-clean; the global format scan
  is blocked only by pre-existing dirty proposal docs outside this change.

- Status: Verified
- Date: 2026-07-14
- Scope: added atomic tool-call reservation across local and inherited
  descendant-tree work-budget accounts.
- Read: Core tool reservation/execution order and agent-runtime inheritance.
- Tests: Core budget/run 130/130; agent-runtime Agent suites 65/65; Host
  Agent/process/arbiter integration 102/102.

- Status: Verified
- Date: 2026-07-14
- Scope: aligned concurrent batch admission with dynamic tool governance and
  added Agent-specific argument/target classifiers.
- Read: Core tool orchestration/tools/run and Host dynamic/indexed/configured
  Agent tools.
- Tests: Core run 127/127; Host Agent/tool suites 155/155; affected typechecks
  passed.

- Status: Verified
- Date: 2026-07-13T22:42:00+0800
- Scope: centralized Host-shaped run policy construction across Host and
  direct-core while preserving fresh per-run state and existing catalogs.
- Read: Host run policy/runtime, CLI direct runner/resume, and Core policy.
- Tests: Host focused 155/155; CLI 152/152; Core environment/policy 35/35;
  shell-tool 42/42; affected typechecks/builds passed.

- Status: Verified
- Date: 2026-07-13T22:21:00+0800
- Scope: separated configured Shell status from the read-only effective process
  sandbox and applied capability-specific no-write clamps at Workflow/Hook
  execution boundaries; tool policy, approval, and trace lifecycles are unchanged.
- Read: Host security plan/runtime, Workflow node API/hooks, and capability
  inspection assembly.
- Tests: Host focused 263/263; MCP adapter 34/34; CLI inspect 11/11.

- Status: Read-only
- Date: 2026-07-13
- Scope: ACP delegate kept its existing tool descriptor, policy, approval, and
  subagent lifecycle while adding sandbox/access enforcement at execution.
- Read: Host ACP delegate/runtime catalog assembly.
- Tests: Host ACP/external/tool suites 122/122; CLI delegate tests 7/7.

- Status: Verified
- Date: 2026-07-13
- Scope: unified Host run/inspect security derivation and removed the CLI
  snapshot-less effective catalog/delegate/sandbox fallback without changing
  protocol snapshot shape.
- Read: Host runtime/security plan/tool catalog, CLI capability inspection, and
  protocol capability snapshot types.
- Tests: Host focused suite 222/222; Host and CLI typechecks; Host build; CLI
  capability-inspect tests 13/13.

- Status: Verified
- Date: 2026-07-12T23:45:00+0800
- Scope: Skill-declared registered tool dependencies load after `skill_load`
  without an extra `tool_search`; unrelated deferred tools remain lazy.
- Read: core run/context, Skills loader output, capability-builder Skill, and
  focused tests.
- Tests: focused core deferred-tool tests and Skills loader test passed.

- Status: Read-only
- Date: 2026-07-12T20:00:00+0800
- Scope: checked `create_agent` compatibility and CLI-only stats/reconciliation
  additions; deferred loading and runtime tool orchestration are unchanged.
- Read: host tool catalog/Agent tool and CLI handlers.
- Tests: focused host/CLI tests and full release gate; no contract change.

- Status: Read-only
- Date: 2026-07-12
- Scope: checked Markdown Agent workspace-write authoring and Skill reconciliation CLI; no orchestration policy change.
- Tests: focused host/CLI tests passed; release gate pending.

- Status: Verified
- Date: 2026-07-12T02:12:00+0800
- Scope: post-prepare approval orchestration for the safe authored Skill create
  slice; one approval occurs after proposal persistence and before apply.
- Read: `packages/core/src/run.ts`, `packages/core/src/types.ts`,
  `packages/host/src/tools.ts`.
- Tests: host same-run integration/focused tool suite and affected typechecks.

- Status: Verified
- Date: 2026-07-11T22:10:00+0800
- Scope: removed the unreachable shell timeout alias and ensured tool-owned
  repeated-observation guidance cannot convert a prior failure into a completed
  no-op.
- Read: `packages/shell-tool/src/tool.ts`, `packages/core/src/run.ts`, focused
  tests.
- Tests: full `npm run release:check`.

- Status: Verified
- Date: 2026-07-11T21:45:00+0800
- Scope: task wrapper canonicalization, canonical shell timeout schema, and
  direct-background launch-confirmation guidance.
- Read: `packages/agent-runtime/src/tasks/tools.ts`,
  `packages/shell-tool/src/tool.ts`.
- Tests: `npm exec -- vitest run packages/agent-runtime/test/tasks.test.ts
packages/shell-tool/test/shell-tool.test.ts`.

- Status: Verified
- Date: 2026-07-11T19:53:00+0800
- Scope: added tool-owned repeated state-observation guidance and task control
  guidance without changing task wait/output execution semantics.
- Read: `packages/core/src/tools.ts`, `packages/core/src/run.ts`,
  `packages/agent-runtime/src/tasks/tools.ts`.
- Tests: `npm --workspace @sparkwright/core test -- test/run.test.ts`;
  `npm --workspace @sparkwright/agent-runtime test -- test/tasks.test.ts`.

- Status: Verified
- Date: 2026-07-11T02:10:00+0800
- Scope: P4 policy clamp verified across shell, task_create, spawn promotion,
  capability diagnostics, live task revival, and resume orphan handling; P5
  nested background orchestration removed.
- Read: core run/revival, agent-runtime task tools, host run-access/shell/runtime,
  CLI capability inspection and focused tests.
- Tests: 31 focused deterministic P4/revival tests plus Terra foreground-only
  shell/task/spawn traces; affected workspace full/focused tests and builds.

- Status: Verified
- Date: 2026-07-11T00:19:00+0800
- Scope: restored concise background task guidance and advanced/deferred task
  control after a same-prompt Terra A/B showed the nano-specific eager/prose
  compensation was unnecessary.
- Read: `packages/shell-tool/src/tool.ts`,
  `packages/agent-runtime/src/tasks/tools.ts`,
  `packages/host/src/tool-identities.ts`, focused tests.
- Tests: shell-tool, agent-runtime, host, and CLI focused gates; real
  `openai/gpt-5.6-terra` CLI traces; `npm run release:check`.

- Status: Verified
- Date: 2026-07-10T23:00:00+0800
- Scope: direct explicit shell background semantics, pre-spawn deduplication,
  service startup grace, promotion compatibility, and model-visible sparse
  start/dedup guidance.
- Read: `packages/shell-tool/src/tool.ts`, `packages/host/src/shell.ts`,
  `packages/core/src/run.ts`, corresponding focused tests.
- Tests: shell-tool, host shell, and core waiting/cancellation focused suites;
  package typechecks.

- Status: Read-only
- Date: 2026-07-09T08:56:34+0800
- Scope: route check for TUI input/layer cleanup. Activity panel now imports
  event filtering/search/fact helpers from `lib/event-inspector.ts`, but tool
  request/result orchestration, tool display summaries, approval policy, and
  task tool contracts are unchanged.
- Read: `packages/tui/src/components/activity-panel.tsx`,
  `packages/tui/src/lib/event-inspector.ts`,
  `packages/tui/src/lib/tool-display.ts`,
  `docs/_internal/project-map/maps/runtime/tool-orchestration.md`.
- Tests: TUI-focused validation ran via `npm --workspace @sparkwright/tui
test`; `npm --workspace @sparkwright/tui run typecheck`; final
  `npm run release:check`. No tool orchestration contract change was made.

- Status: Verified
- Date: 2026-07-08T23:46:48+0800
- Scope: post-review grant orchestration hardening: per-argument grant policy
  rejects unusable explicit workspace-write grants, approval summaries are
  child-oriented, and run-loop tests cover approval/denial timing for
  `spawn_agent` and `task_create(kind:"agent")`, including bypass
  auto-approval, before their execute paths create children or tasks.
- Read: `packages/core/src/run.ts`,
  `packages/host/src/agent-spawn-grants.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/test/spawn-agent.test.ts`,
  `packages/host/test/tools.test.ts`.
- Tests: `npm --workspace @sparkwright/host test --
test/spawn-agent.test.ts`;
  `npm --workspace @sparkwright/host test -- test/tools.test.ts`.

- Status: Verified
- Date: 2026-07-08T14:42:08+0800
- Scope: tool approval summaries now support tool-owned
  `approvalSummaryForArgs`; dynamic child catalog defaults to read-only but can
  expose managed workspace write tools through spawn-time grants; configured
  delegate catalog behavior is unchanged.
- Read: `packages/core/src/tools.ts`, `packages/core/src/run.ts`,
  `packages/host/src/tool-catalog.ts`,
  `packages/host/src/agent-spawn-grants.ts`,
  `packages/host/src/runtime.ts`.
- Tests: `npm test -w @sparkwright/core -- run.test.ts`;
  `npm test -w @sparkwright/host -- tools.test.ts spawn-agent.test.ts`;
  typechecks for core, agent-runtime, and host.

- Status: Verified
- Date: 2026-07-07T15:21:23+0800
- Scope: trace report now flags completed same-payload repeated `task_create`
  lifecycle misuse while retaining the existing task next-action/body-summary
  feedback contracts.
- Read: `packages/core/src/trace-diagnostics.ts`,
  `packages/core/test/trace.test.ts`,
  `packages/agent-runtime/src/tasks/tools.ts`.
- Tests: `npm --workspace @sparkwright/core test -- test/trace.test.ts`;
  `npm --workspace @sparkwright/core run typecheck`.

- Status: Verified
- Date: 2026-07-07T14:43:43+0800
- Scope: task orchestration feedback hardening after real mini Agent + Skill
  QA: detached/promoted `task_create` outputs now carry concrete monitor
  guidance, and host task notification injection exposes terminal result
  summaries in model-visible body text.
- Read: `packages/agent-runtime/src/tasks/tools.ts`,
  `packages/agent-runtime/test/tasks.test.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/test/task-revival.test.ts`,
  `docs/_internal/project-map/maps/runtime/tool-orchestration.md`,
  `docs/_internal/project-map/maps/capabilities/agents.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
test/tasks.test.ts`; `npm --workspace @sparkwright/agent-runtime run
typecheck`; `npm --workspace @sparkwright/host test --
test/task-revival.test.ts test/spawn-agent.test.ts`; `npm --workspace
@sparkwright/host run typecheck`; `npm run build --workspace
@sparkwright/host`; `npm run check:dist-fresh`.

- Status: Verified
- Date: 2026-07-06T23:31:01+0800
- Scope: workflow-runtime P4 catalog-clamp regression: mid-run script-to-model
  transitions now block actual parent-catalog tools, while model-node worker-entry
  narrowing still stands down to core `TOOL_NOT_FOUND` when the active registry
  truly lacks the tool. Scoped workflow `tool_search` is explicitly marked and
  remains the only discovery exception.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/host/test/workflows.test.ts`.
- Tests: `npm --workspace @sparkwright/host test --
test/workflows.test.ts test/workflow-distill.test.ts
test/workflow-shadow.test.ts`; `npm --workspace @sparkwright/host run
typecheck`.

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

- Status: Verified
- Date: 2026-07-08T20:41:34+0800
- Scope: run access resolution is now shared by host client request helpers and
  host runtime capability inspection. Tool catalog membership is unchanged;
  capability inspect reports scoped diagnostics (`access`, delegate
  `approvalRunOptions`, shell promotion) without bypassing runtime policy.
- Read: `packages/host/src/run-access.ts`,
  `packages/host/src/client-run.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/src/tool-catalog.ts`,
  `docs/_internal/project-map/maps/runtime/tool-orchestration.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/run-access.test.ts test/client-run.test.ts`;
  `npm --workspace @sparkwright/host test -- test/client-run.test.ts test/protocol.test.ts -t "capability inspect|capability inspection|capability inspect payloads"`;
  `npm --workspace @sparkwright/host run typecheck`.
