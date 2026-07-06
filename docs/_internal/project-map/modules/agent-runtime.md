# Agent Runtime

## Purpose

`@sparkwright/agent-runtime` contains reusable agent-side runtime helpers outside the core run loop: task management, todo ledger supervision, concurrency/worktree coordination, and result protocols.

See also [../maps/capabilities/agents.md](../maps/capabilities/agents.md), [../maps/capabilities/cron.md](../maps/capabilities/cron.md), and [../maps/runtime/tool-orchestration.md](../maps/runtime/tool-orchestration.md).

## Main Files

- `packages/agent-runtime/src/index.ts`
- `packages/agent-runtime/src/tasks/*`
- `packages/agent-runtime/src/doc-store/*`
- `packages/agent-runtime/src/todo/*`
- `packages/agent-runtime/src/concurrency/*`
- `packages/agent-runtime/src/workflows/*`
- `packages/agent-runtime/test/*`

## Owns / Does Not Own

Owns:

- durable task abstractions and task tools
- shared file-backed document-store primitives for session-root stores
- todo ledger parsing and continuation supervision helpers
- worktree/concurrency coordination utilities
- child/delegate policy helpers used by host integrations
- portable workflow type declarations

Does not own:

- core run state machine
- host workflow asset discovery or parsing
- host protocol
- model/provider construction
- TUI display state

## Contracts

- Task events are trace-visible through core when executed as tools.
- `doc-store/` owns workflow-agnostic file-backed primitives for session-root
  stores: atomic text/JSON document writes with Windows rename retry cleanup,
  corrupt-entry-tolerant JSON directory/log scans with diagnostics, JSONL
  append-log helpers, and token-entry single-writer leases. Feature stores such
  as tasks/workflows compose these primitives instead of carrying their own
  atomic-write or append-log copies.
- `task_create` can start external work; read-only task tools inspect state/output.
- `TaskManager.registeredKinds()` exposes live runner keys for model-facing
  diagnostics; `createTaskCreate()` can accept optional
  `TaskCreateKindDescriptor` hints so embedders describe registered kinds and
  kind-specific payload schemas without moving execution out of the live
  `TaskManager` registry.
- Host-owned promoted shell tasks keep durable output in `TaskStore`; host trace
  integration mirrors task output/events without making agent-runtime depend on
  host process runners.
- Todo continuation uses a synthetic goal prefix consumed by TUI replay.
- Agent profile derivation intersects parent/child `use` selectors in the same
  tightening direction as concrete `allowedTools`; `mcp` intersected with
  `mcp:<server>` yields the server selector.
- `AgentProfile.delegateTool` is a portable profile hint shape carried by
  agent-runtime types; host owns discovery, config validation, and conversion
  into concrete delegate tool descriptors.
- `AgentProfile.model` is a portable preferred-model hint. Agent-runtime
  carries it for orchestration but does not construct providers or select model
  adapters; host applies it to configured in-process delegate child runs.
- `AgentProfile.hooks` is a portable, structural workflow-hook carrier for
  profile-authored child-run guardrails. Agent-runtime owns the neutral type and
  `spawnSubAgent.workflowHooks` passthrough; host owns Agent.md parsing,
  validation, and compilation into executable `WorkflowHook[]`.
- `AgentProfile.triggers` and `AgentProfile.when.keywords` are portable
  routing hints carried by agent-runtime types. Host owns parsing, validation,
  matching, sorting, descriptor summaries, and trace events; agent-runtime does
  not use these fields to grant permissions or hide tools.
- `delegate_parallel` is an allowed `SubAgentEntrypoint` metadata value so
  host-owned parallel fan-out can preserve parent-visible lifecycle attribution.
  Agent-runtime does not own the fan-out policy; it only projects the supplied
  entrypoint into `subagent.*` metadata.
- Spawn helpers project one `MultiAgentFacts` snapshot onto parent-visible
  `subagent.*` lifecycle events: `parentRunId`, `childRunId`, parent
  `agentId`, optional `sessionId`, child/delegate `childAgentId`, optional
  `agentProfileId`, `agentName`, `delegateTool`, `entrypoint`, and
  `subagentDepth`. Spawned child run metadata also carries the resolved
  `sessionId` when the parent/input metadata has one, so child-owned EventLog
  events and parent-visible lifecycle events agree after persistence.
- Workflow types in agent-runtime are portable runtime/store declarations.
  `WorkflowRunRecord` is now a durable P2 state document with five-value
  status, version pinning, attempts, evidence refs, verdict/transition logs,
  resume policy, and optional `wait.kind`. `FileWorkflowStore` composes the
  shared doc-store primitives for per-session `workflow-runs/` records, JSONL
  events, corrupt-entry diagnostics, waiting-state invariants, and single-writer
  leases; host owns parsing, projection, and run-loop execution.
- Workflow P1 runtime state transitions are also portable and model/config
  free. `advanceWorkflowState()` evaluates `(state, verdict) -> transition`
  for linear model-node workflows with `retry`, `goto`, `fail`, and terminal
  completion decisions; host projection hooks feed it facts and apply the
  resulting hook effect, but hooks do not own transition logic.
- Workflow P3 Step 2/3 type declarations include portable node/verifier shapes
  for `command`, `delegate`, `task`, `human`, and `diff_scope`. These are
  structural contracts only: agent-runtime does not execute commands, construct
  delegates, start tasks, wait for humans, read git state, or choose
  models/config. Host owns parsing, trust enforcement, primitive invocation,
  waiting emission, and projection evidence.
- Workflow P3 Step 4b.2 adds portable `model` and `runBudget` fields to
  `WorkflowNodeDefinition`, but the same boundary applies: agent-runtime keeps
  the raw structural declaration only. Host owns model-ref resolution,
  model-tier lookup, adapter construction, and applying the budget to worker
  episodes.
- Workflow P4 adds portable `script` execution shape declarations:
  `WorkflowNodeExecuteKind` includes `script`, and
  `WorkflowScriptNodeDefinition` carries path/args/cwd/env/stdin/timeouts,
  output caps, metadata, and declared capability names. Agent-runtime does not
  execute scripts, grant capabilities, map sandbox policy, read workflow asset
  directories, or expose the stdio node API; host owns all of those behaviors.
- Workflow P5 adds portable `parallel` / `join` declarations and durable
  branch-state shape. `WorkflowRunRecord.parallelBranches` and
  `WorkflowRuntimeState.parallelBranches` carry per-branch source node,
  attempt, verdict, evidence refs, completion time, and metadata so host joins
  can resume without re-running branches. Agent-runtime validates referenced
  branch node ids and preserves the state across transitions/store round trips,
  but it does not execute branches, schedule work, call `delegate_parallel`, or
  interpret branch-local transitions. `FileWorkflowStore` lease events describe
  durable record adoption only: a fresh pre-create lease does not append
  `adopted`, while release events use the injected clock when supplied.
- Workflow P6b adds the portable `todo_clear` verifier declaration. It is only
  structural type vocabulary in agent-runtime; host owns parser admission,
  session todo-ledger reads, verdict metadata, and fail-closed runtime behavior.
- P3 Step 1 introduced a portable workflow run-chain driver:
  `runWorkflowRunChain()` owns the "run one episode, inspect terminal evidence,
  maybe continue" loop shape without constructing models or host config.
  `runTodoSupervised()` now expresses the todo-continuation chain as this
  degenerate workflow controller, preserving the existing todo audit decisions
  while moving the loop shape out of host.
- `todo_write` tool schema text owns structural/status/evidence rules only:
  whole-list replacement, canonical statuses, at most one `in_progress`, and
  real evidence before `completed`. Prompt-level cadence ("when to open/update
  the ledger, avoid rewrites, and fold bookkeeping into action turns") lives in
  project-context's tool-gated `todo_planning` section, not in the tool schema
  or todo continuation prompt.
- P3 Step 4a keeps that boundary: host's actor episode driver calls the
  existing todo/workflow chain driver and creates worker runs itself. Do not add
  model construction, host config loading, tool catalogs, or session protocol
  concerns to agent-runtime workflows.
- Workflow actor notifications may use type `waiting` with
  `payload.wait.kind` equal to `input`, `task`, or `approval`. The existing
  actor inbox QoS rules keep this notification reliable because only
  `progress` and `output` are lossy.
- `FileWorkflowNotificationOutbox` is the durable workflow-actor counterpart
  for actor-native workflow notifications. It persists workflow notification
  inputs under `workflow-notifications/*.json`, revalidates them through the
  actor inbox contract on peek/drain, and supports reliable `waiting`
  notifications without changing the legacy task notification file format.
- `subagent.*` terminal fields (`terminalState`, `stepLimitReached`,
  `truncated`, `stopReason`) are derived from the child run's real `run.*`
  outcome and payload flags; parent emit sites must not set a separate terminal
  state.
- `spawnSubAgent` may receive an explicit approval resolver so configured child
  runs can share the parent host/CLI/TUI approval path without gaining a
  free-form interaction channel.
- `spawnSubAgent` accepts `workflowHooks?: WorkflowHook[]` as the child-run
  deterministic hook lane and forwards it into `CreateRunOptions.workflowHooks`.
  Agent-runtime carries caller-supplied hooks; host-owned Agent.md/config
  compilation decides which hooks belong on a child run.
- `spawnSubAgent` accepts an optional explicit `abortSignal`. When omitted, the
  child remains tied to the parent run signal; when supplied, the caller owns the
  child lifecycle. Host uses this for background agent tasks so cancelling the
  task stops the child without coupling it to a foreground-turn interrupt.
- `spawnSubAgent` accepts optional `notificationSources` and
  `taskRevivalSource` and forwards them into child `CreateRunOptions`. Host uses
  this only for opt-in nested background agent tasks so child runs can be revived
  by their own awaited task completions without using a synthetic turn.
- Task records carry first-class `awaited` state. `TaskStore`,
  `FileTaskStore`, `TaskManager`, protocol snapshots, and UI projections should
  preserve it so terminal awaited tasks can wake a run once and then be detached
  after an explicit wait/join consumes them.
- Task notification types now sit beside workflow notification input probes in
  the `ActorNotificationSink` / `ActorInbox` split. Producers use the actor
  sink; consumers use predicate `peek()`/`drain()` plus non-consuming
  `waitUntilAvailable()`. The legacy `TaskNotificationSink` and task
  notification API remain compatible for existing embedders.
- `InMemoryTaskNotificationQueue.waitUntilAvailable({ signal, predicate })` is
  non-consuming and abortable. The actor adapter has the same non-consuming wait
  contract and does not expose `waitForNext()` as part of `ActorInbox`.
  Reliable terminal notifications are not silently dropped under a bounded
  queue; drop-oldest/drop-self is limited to lossy actor notifications.
- `FileTaskNotificationOutbox` is the durable counterpart for terminal task
  notifications. It supports non-consuming `peek()`/`waitUntilAvailable()` and
  predicate `drain()` so hosts can replay only notifications for the resumed
  run. Its JSON entry writes compose the shared `doc-store`
  `atomicWriteTextSync()` primitive, while preserving the existing
  `task-notifications/*.json` format. Its actor adapter derives inbox-scoped
  monotonic sequence from stable file ordering with an in-process high-water
  mark, without changing the existing format. Because that format stores legacy
  `TaskNotification` entries, the file-backed actor sink accepts only terminal
  task actor notifications that can round-trip through that shape; it rejects
  workflow/progress/output inputs and actor-only envelope fields with a typed
  non-retryable `UNSUPPORTED_ACTOR_NOTIFICATION`. It stores
  notifications, not task execution. The actor inbox view skips unreadable or
  actor-invalid file entries and exposes them through `invalidActorEntries()`
  so a single stale/bad file cannot wedge actor `peek()`/`drain()`/readiness
  waits; the legacy task listing path remains strict for corrupt JSON.
- Actor notification acceptance normalizes `source.runId` into
  `routeHint.parentRunId` and `source.sessionId` into `routeHint.sessionId`.
  Explicit source/route contradictions or empty route ids reject with
  `INVALID_ROUTE`; `TaskManager` reports those via `onSinkError` without adding
  them to the transient pending notification retry queue.
- Actor notification acceptance also rejects split identities with
  `INVALID_ACTOR_NOTIFICATION`: task `source.id` must match `payload.taskId`,
  workflow `source.id` must match `payload.workflowId`, and task
  `payload.parentRunId` must match the normalized route parent. TaskManager
  treats all typed non-retryable actor errors as poison-input diagnostics rather
  than transient sink failures.
- `ACTOR_INBOX_CAPACITY` is a typed retryable capacity error. In-memory bounded
  queues may drop lossy actor notifications, but reliable terminal
  notifications overflow by throwing this error instead of silently evicting
  older reliable entries.
- `TaskManager.hasLiveRunner(taskId)` distinguishes current-process task
  execution from reopened durable `pending`/`running` records.
- `task_create` supports `foreground`, `awaited`, and `background` modes. The
  default is foreground; foreground timeout may promote to an awaited background
  task; explicit `mode`/`awaited` conflicts are rejected as recoverable argument
  errors; global/per-kind concurrency caps fail as recoverable tool errors
  rather than queueing internally.
- Foreground `task_create` waits race both the foreground budget timer and
  `TaskManager.requestPromotion(taskId)`, so host/TUI manual promote controls
  can return the same promoted task ticket without waiting for timeout.
- `task(action:"wait", ids, mode:"any"|"all")` is the join surface. It provides
  join-any/join-all barrier semantics without introducing `task_join`.
- Model-facing `task` action schema is action-specific: `get`, `output`, and
  `stop` require a non-empty `taskId`; `wait` requires a non-empty `taskId` or
  non-empty `ids`. Keep the matching `validateInput()` checks in
  agent-runtime, because core's local schema validator intentionally does not
  enforce all JSON Schema guidance keywords.
- `task(action:"list")` and legacy `task_list` default to current-run scope for
  backward compatibility, but accept `scope:"all"` so resumed runs can discover
  durable tasks whose `parentRunId` belongs to an earlier run. Use `get`/`wait`
  / `output` with concrete task ids after discovery.
- `task_create` model-facing description must disclose active task concurrency
  caps, including the default `agent=1` per-kind cap. The cap still fails as a
  recoverable `TASK_CONCURRENCY_LIMIT` tool error rather than queueing work.
- `TaskManager.adoptRunning()` is the promotion primitive for already-started
  work such as shell streams and dynamic `spawn_agent` children; embedders own
  the running promise/controller and task-runtime owns store/cancel/notification
  bookkeeping.
- `RunHandle.maxSteps` is public read-only child-spawn context. Child agents
  inherit the parent run's effective `maxSteps` when no child/profile override
  is provided; explicit child `maxSteps` still wins, while `runBudget` remains
  tightened through parent/child intersection.
- Completed delegation result reuse is backed by a shared, parent-run-scoped
  ledger rather than a `createAgentTool` closure-local cache. Ledger keys include
  the delegation surface identity (`agent_tool`, configured delegate, or dynamic
  spawn) plus the stable child/profile/scope fields needed to avoid reusing a
  different agent's answer. Only completed, non-`stepLimitReached`,
  non-truncated results are reusable.
- `createAgentTool` accepts synchronous or asynchronous `buildSpawnInput`.
  Embedders still own provider/model construction, but async spawn input lets
  host resolve child-scope model adapters on demand before calling
  `spawnSubAgent`.
- `createAgentTool` treats a child result completed with `stepLimitReached` as
  possibly truncated: it returns a warning note and does not store the result in
  the shared delegation ledger.

## Consumers

- Host runtime task manager and todo supervisor.
- CLI task commands.
- TUI replay logic that distinguishes continuation goals.

## Change Checklist

- Check host runtime continuation behavior.
- Check TUI replay if todo continuation wording changes.
- Check task CLI and task tools together.
- Keep task output caps and event volume under control.

## Known Debts

- Task/todo behavior spans host, CLI, TUI replay, and trace diagnostics; ownership can be easy to blur.

## Last Verified

- Status: Verified
- Date: 2026-07-06T14:45:00+0800
- Scope: C9 S1 migration: `FileTaskNotificationOutbox` now uses the shared
  `doc-store` `atomicWriteTextSync()` for `task-notifications/*.json` entry
  writes, retiring its private tmp-write + rename helper without changing the
  file format or actor-inbox semantics.
- Read: `packages/agent-runtime/src/tasks/file-notifications.ts`,
  `packages/agent-runtime/src/doc-store/index.ts`,
  `packages/agent-runtime/test/tasks.test.ts`,
  `packages/agent-runtime/test/doc-store.test.ts`,
  `docs/_internal/proposals/consolidation-agenda.md`,
  `docs/_internal/proposals/substrate-sequencing.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
  test/doc-store.test.ts test/tasks.test.ts`; `npm --workspace
  @sparkwright/agent-runtime run typecheck`.

- Status: Verified
- Date: 2026-07-05T22:37:13+0800
- Scope: workflow-runtime-v1 P9a agent-runtime boundary: `FileWorkflowStore`
  remains the shared workflow-run document store, now with both legacy
  `workflowRunsDir({ sessionRootDir, sessionId })` and workspace-root
  `workspaceWorkflowRunsDir({ workspaceRoot })` helpers. Record schema/file
  format is unchanged.
- Read: `packages/agent-runtime/src/workflows/store.ts`,
  `packages/agent-runtime/src/workflows/index.ts`,
  `packages/agent-runtime/test/workflows.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
  test/workflows.test.ts -t "FileWorkflowStore|workflow-run roots"`; `npm
  --workspace @sparkwright/agent-runtime run typecheck`; `npm --workspace
  @sparkwright/agent-runtime run build`.

- Status: Verified
- Date: 2026-07-05T21:51:25+0800
- Scope: workflow-runtime-v1 P6b portable workflow type boundary:
  `todo_clear` is now a structural verifier declaration only. Agent-runtime
  still does not read todo ledgers, evaluate verifier verdicts, or alter the
  todo supervisor continuation audit.
- Read: `packages/agent-runtime/src/workflows/types.ts`,
  `packages/agent-runtime/src/workflows/index.ts`,
  `packages/agent-runtime/test/workflows.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime run typecheck`;
  `npm --workspace @sparkwright/agent-runtime run build`; `npm --workspace
  @sparkwright/agent-runtime test -- test/workflows.test.ts`.

- Status: Verified
- Date: 2026-07-05T21:40:16+0800
- Scope: workflow-runtime-v1 P6a todo doctrine boundary: `todo_write`
  description keeps status/evidence rules but no longer restates prompt-level
  cadence; `runTodoSupervised()` and continuation prompts remain recovery-only
  and do not own "when to touch the ledger" guidance.
- Read: `packages/agent-runtime/src/todo/tools.ts`,
  `packages/agent-runtime/src/todo/ledger.ts`,
  `packages/agent-runtime/test/todo.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
  test/todo.test.ts -t "todo_write schema|createTodoTools exposes|TodoLedger
  helpers"`; `npm --workspace @sparkwright/agent-runtime run typecheck`.

- Status: Verified
- Date: 2026-07-05T20:18:29+0800
- Scope: workflow-runtime-v1 post-review store hardening: durable branch state
  still round-trips through agent-runtime, fresh pre-create workflow leases no
  longer emit misleading `adopted` events, and release events honor the injected
  clock for deterministic tests. Host still owns branch execution and P5
  projection validation.
- Read: `packages/agent-runtime/src/workflows/store.ts`,
  `packages/agent-runtime/src/workflows/types.ts`,
  `packages/agent-runtime/test/workflows.test.ts`,
  `packages/host/src/workflow-projection.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
  test/workflows.test.ts -t "lease"`; `npm --workspace @sparkwright/agent-runtime
  test -- test/workflows.test.ts`.

- Status: Verified
- Date: 2026-07-05T16:03:27+0800
- Scope: workflow-runtime-v1 P5 agent-runtime boundary: portable workflow
  types/state/store now include `parallel` / `join` declarations and durable
  branch state while branch execution and scheduling stay in host.
- Read: `packages/agent-runtime/src/workflows/types.ts`,
  `packages/agent-runtime/src/workflows/machine.ts`,
  `packages/agent-runtime/src/workflows/store.ts`,
  `packages/agent-runtime/test/workflows.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
  test/workflows.test.ts`; `npm --workspace @sparkwright/agent-runtime run
  typecheck`; `npm --workspace @sparkwright/agent-runtime run build`.

- Status: Verified
- Date: 2026-07-05T15:31:20+0800
- Scope: workflow-runtime-v1 P4 boundary check: script node fields are
  portable workflow type declarations only; agent-runtime still does not run
  script processes, resolve asset paths, grant sandbox/capabilities, or expose
  node APIs.
- Read: `packages/agent-runtime/src/workflows/types.ts`,
  `packages/agent-runtime/src/workflows/index.ts`,
  `packages/host/src/workflows.ts`,
  `packages/host/src/workflow-node-api.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
  test/workflows.test.ts`; `npm --workspace @sparkwright/agent-runtime run
  typecheck`; `npm --workspace @sparkwright/agent-runtime run build`; `npm run
  release:check`.

- Status: Verified
- Date: 2026-07-05T12:15:55+0800
- Scope: workflow-runtime-v1 P3 Step 4b.2 boundary check: `model` and
  `runBudget` are portable workflow node fields only; agent-runtime still does
  not resolve models, construct adapters, read host config, or apply runtime
  budgets.
- Read: `packages/agent-runtime/src/workflows/types.ts`,
  `packages/host/src/workflows.ts`, `packages/host/src/runtime.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime run typecheck`; `npm
  --workspace @sparkwright/agent-runtime test -- test/workflows.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`.

- Status: Verified
- Date: 2026-07-05T11:36:37+0800
- Scope: workflow-runtime-v1 P3 Step 4a boundary check: deleting host
  `startSupervisedRunChain()` did not add model/config/session dependencies to
  agent-runtime. `runWorkflowRunChain()` remains the pure chain driver and
  `runTodoSupervised()` remains the degenerate workflow proof for D18.
- Read: `packages/agent-runtime/src/workflows/run-chain.ts`,
  `packages/agent-runtime/src/todo/supervisor.ts`,
  `packages/host/src/runtime.ts`,
  `packages/agent-runtime/test/workflows.test.ts`,
  `packages/agent-runtime/test/todo.test.ts`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
  test/workflows.test.ts test/todo.test.ts -t "runTodoSupervised|workflow
  run-chain"`.

- Status: Verified
- Date: 2026-07-05T11:21:09+0800
- Scope: workflow-runtime-v1 P3 Step 3 portable workflow waiting boundary:
  `human` is a structural node kind, workflow store events include `waiting`
  and `input`, waiting records keep `wait.kind`, and
  `FileWorkflowNotificationOutbox` durably replays reliable workflow waiting
  actor notifications without moving execution into agent-runtime.
- Read: `packages/agent-runtime/src/workflows/types.ts`,
  `packages/agent-runtime/src/workflows/store.ts`,
  `packages/agent-runtime/src/workflows/notifications.ts`,
  `packages/agent-runtime/test/workflows.test.ts`,
  `packages/agent-runtime/src/tasks/notifications.ts`,
  `packages/agent-runtime/test/tasks.test.ts`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
  test/workflows.test.ts`; `npm --workspace @sparkwright/agent-runtime test --
  test/tasks.test.ts -t "Actor|FileTaskNotificationOutbox|workflow
  waiting|workflow notification|actor notifications"`; `npm --workspace
  @sparkwright/agent-runtime run typecheck`; `npm --workspace
  @sparkwright/agent-runtime run build`.

- Status: Verified
- Date: 2026-07-05T10:39:09+0800
- Scope: workflow-runtime-v1 P3 Step 2 portable workflow type boundary:
  agent-runtime declares structural node/verifier shapes for `command`,
  `delegate`, `task`, and `diff_scope` without taking on host execution,
  model/config, command, delegate, task, or git responsibility.
- Read: `packages/agent-runtime/src/workflows/types.ts`,
  `packages/agent-runtime/src/workflows/index.ts`,
  `packages/host/src/workflows.ts`,
  `packages/host/src/workflow-projection.ts`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
  test/workflows.test.ts`; `npm --workspace @sparkwright/agent-runtime run
  typecheck`; `npm --workspace @sparkwright/host test --
  test/workflow-hooks.test.ts`; `npm --workspace @sparkwright/host run
  typecheck`.

- Status: Verified
- Date: 2026-07-05T10:13:38+0800
- Scope: workflow-runtime-v1 P3 Step 1: added the portable
  `runWorkflowRunChain()` driver under `agent-runtime/src/workflows/` and moved
  `runTodoSupervised()` onto it as the degenerate workflow proof for D18,
  without changing todo audit decisions or workflow store contracts.
- Read: `packages/agent-runtime/src/workflows/run-chain.ts`,
  `packages/agent-runtime/src/workflows/index.ts`,
  `packages/agent-runtime/src/todo/supervisor.ts`,
  `packages/agent-runtime/test/workflows.test.ts`,
  `packages/agent-runtime/test/todo.test.ts`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
  test/workflows.test.ts`; `npm --workspace @sparkwright/agent-runtime test --
  test/todo.test.ts -t "runTodoSupervised|workflow run-chain"`; `npm
  --workspace @sparkwright/agent-runtime run typecheck`.

- Status: Verified
- Date: 2026-07-05T09:01:34+0800
- Scope: P2 post-review store invariant: `FileWorkflowStore.update()` now
  validates `clearWait` after computing the next wait state so callers cannot
  write `status:"waiting"` without `wait.kind`; workflow lease semantics remain
  doc-store-backed and host-owned for fresh/resume adoption.
- Read: `packages/agent-runtime/src/workflows/store.ts`,
  `packages/agent-runtime/test/workflows.test.ts`,
  `packages/host/src/runtime.ts`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
  test/workflows.test.ts`; `npm --workspace @sparkwright/agent-runtime run
  build`; `npm run typecheck:test`.

- Status: Verified
- Date: 2026-07-05T00:42:02+0800
- Scope: workflow-runtime-v1 P2 durable workflow store: `WorkflowRunRecord`
  now writes real state rather than reserved pin fields, and
  `FileWorkflowStore` uses the S1 doc-store primitive for atomic records,
  JSONL events, corrupt-entry skips, and single-writer leases under
  session-root `workflow-runs/`.
- Read: `packages/agent-runtime/src/workflows/types.ts`,
  `packages/agent-runtime/src/workflows/store.ts`,
  `packages/agent-runtime/src/workflows/index.ts`,
  `packages/agent-runtime/test/workflows.test.ts`,
  `packages/agent-runtime/test/doc-store.test.ts`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
  test/workflows.test.ts test/doc-store.test.ts`; `npm --workspace
  @sparkwright/agent-runtime run build`.

- Status: Verified
- Date: 2026-07-04T23:10:33+0800
- Scope: S1 document-store primitive: added `agent-runtime/src/doc-store/`
  atomic text/JSON writes, JSONL append-log helpers, corrupt-entry skip
  diagnostics, and token-entry file-backed single-writer leases; migrated
  `FileTaskStore` record writes to the shared primitive and deleted its
  private `atomicWriteTextSync()` copy. Post-review fixes covered
  token-specific lease refresh/release, no-arg TTL refresh, and temp-file
  exclusion during document directory scans.
- Read: `docs/_internal/proposals/substrate-sequencing.md`,
  `docs/_internal/proposals/workflow-runtime-v1.md`,
  `packages/agent-runtime/src/doc-store/index.ts`,
  `packages/agent-runtime/src/tasks/file-store.ts`,
  `packages/agent-runtime/src/tasks/file-notifications.ts`,
  `packages/core/src/session.ts`, `packages/cron/src/store.ts`,
  `packages/agent-runtime/test/doc-store.test.ts`,
  `packages/agent-runtime/test/tasks.test.ts`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
  test/doc-store.test.ts test/tasks.test.ts`; `npm --workspace
  @sparkwright/agent-runtime run typecheck`; `npm --workspace
  @sparkwright/agent-runtime test`; `npm --workspace @sparkwright/agent-runtime
  run build`.

- Status: Verified
- Date: 2026-07-04T15:09:00+0800
- Scope: workflow-runtime-v1 P1 portable workflow machine: added transition
  definitions, verifier expectation/result types, live runtime state, and the
  pure `advanceWorkflowState()` / validation helpers without model, config, or
  host dependencies.
- Read: `packages/agent-runtime/src/workflows/types.ts`,
  `packages/agent-runtime/src/workflows/machine.ts`,
  `packages/agent-runtime/src/workflows/index.ts`,
  `packages/agent-runtime/test/workflows.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
  workflows.test.ts`; `npm --workspace @sparkwright/agent-runtime run
  typecheck`; `npm run build --workspace @sparkwright/agent-runtime`.

- Status: Verified
- Date: 2026-07-04T08:16:19+0800
- Scope: reserved portable workflow run/definition types and the reliable
  actor-inbox `waiting` workflow notification shape without adding workflow
  runtime state or execution behavior.
- Read: `packages/agent-runtime/src/workflows/types.ts`,
  `packages/agent-runtime/src/workflows/index.ts`,
  `packages/agent-runtime/src/index.ts`,
  `packages/agent-runtime/src/tasks/notifications.ts`,
  `packages/agent-runtime/src/tasks/index.ts`,
  `packages/agent-runtime/test/tasks.test.ts`,
  `docs/_internal/project-map/modules/agent-runtime.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
  test/tasks.test.ts -t "workflow waiting|workflow notification inputs"`;
  `npm --workspace @sparkwright/agent-runtime run typecheck`.

- Status: Verified
- Date: 2026-07-03T19:10:00+0800
- Scope: implemented Internal Actor Inbox Step 0 + Step 1 inside
  agent-runtime, then verified follow-up task tool fixes: `task list` now has
  explicit `scope:"all"` discovery for resumed durable tasks while defaulting
  to current run, and `task_create` describes active concurrency limits
  including the default `agent=1` cap.
- Read: `packages/agent-runtime/src/tasks/notifications.ts`,
  `packages/agent-runtime/src/tasks/file-notifications.ts`,
  `packages/agent-runtime/src/tasks/manager.ts`,
  `packages/agent-runtime/src/tasks/index.ts`,
  `packages/agent-runtime/src/tasks/tools.ts`,
  `packages/agent-runtime/test/tasks.test.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/test/task-revival.test.ts`,
  `docs/_internal/project-map/designs/internal-actor-inbox.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
  test/tasks.test.ts`; `npm --workspace @sparkwright/agent-runtime run
  typecheck`; `npm --workspace @sparkwright/host test --
  test/task-revival.test.ts`; `npm --workspace @sparkwright/host run
  typecheck`.

- Status: Verified
- Date: 2026-07-02T16:47:56+0800
- Scope: tightened deferred `task` action guidance and runtime validation for
  non-empty monitor ids, including stricter explicit empty-`taskId` wait
  parsing after real mini same-turn placeholder calls.
- Read: `packages/agent-runtime/src/tasks/tools.ts`,
  `packages/agent-runtime/test/tasks.test.ts`,
  `packages/host/test/tools.test.ts`,
  `docs/_internal/test-map/failures/task-action-empty-id-recovery.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
  test/tasks.test.ts`; `npm --workspace @sparkwright/agent-runtime run
  typecheck`; `npm run build --workspace @sparkwright/agent-runtime`;
  `npm --workspace @sparkwright/host test -- test/tools.test.ts -t "main host
  tool catalog"`; `npm run check:dist-fresh`.

- Status: Verified
- Date: 2026-07-02T10:05:00+0800
- Scope: foreground task waits now accept a manual promotion signal through
  `TaskManager.requestPromotion()`, with focused coverage for timeout and manual
  promotion ticket paths.
- Read: `packages/agent-runtime/src/tasks/manager.ts`,
  `packages/agent-runtime/src/tasks/tools.ts`,
  `packages/agent-runtime/test/tasks.test.ts`,
  `docs/_internal/proposals/background-task-lifecycle.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
  test/tasks.test.ts -t "manually promoted|manual|promotes foreground tasks"`;
  `npm --workspace @sparkwright/agent-runtime run typecheck`.

- Status: Verified
- Date: 2026-07-02T10:05:00+0800
- Scope: added durable task notification readiness/predicate drain and
  current-process live-runner detection for resume-time orphan handling.
- Read: `packages/agent-runtime/src/tasks/file-notifications.ts`,
  `packages/agent-runtime/src/tasks/manager.ts`,
  `packages/agent-runtime/test/tasks.test.ts`,
  `docs/_internal/proposals/background-task-lifecycle.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
  test/tasks.test.ts -t "FileTaskNotificationOutbox|spawn -> wait completes"`;
  `npm --workspace @sparkwright/agent-runtime run typecheck`.

- Status: Verified
- Date: 2026-07-02T09:30:00+0800
- Scope: patched `task_create` parsing so explicit `mode` is authoritative and
  conflicting `awaited` values reject with `TASK_ARGUMENTS_INVALID`; verified
  notification queue/task_create focused coverage after the background lifecycle
  follow-up.
- Read: `packages/agent-runtime/src/tasks/tools.ts`,
  `packages/agent-runtime/test/tasks.test.ts`,
  `docs/_internal/proposals/background-task-lifecycle.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
  test/tasks.test.ts -t "task_create|notification"`; `npm --workspace
  @sparkwright/agent-runtime run typecheck`.

- Status: Verified
- Date: 2026-07-02T01:15:00+0800
- Scope: task lifecycle now has first-class `awaited` state, non-consuming
  notification readiness waits, foreground/awaited/background `task_create`
  modes, default global/per-kind concurrency caps, wait any/all barriers,
  terminal retention pruning, adopt-running promotion tickets, and child
  notification/revival forwarding for controlled nested background agents.
- Read: `packages/agent-runtime/src/index.ts`,
  `packages/agent-runtime/src/tasks/types.ts`,
  `packages/agent-runtime/src/tasks/store.ts`,
  `packages/agent-runtime/src/tasks/file-store.ts`,
  `packages/agent-runtime/src/tasks/manager.ts`,
  `packages/agent-runtime/src/tasks/notifications.ts`,
  `packages/agent-runtime/src/tasks/tools.ts`,
  `packages/agent-runtime/test/tasks.test.ts`,
  `packages/agent-runtime/test/index.test.ts`.
- Tests: `npm --workspace @sparkwright/agent-runtime test -- test/tasks.test.ts
  test/index.test.ts -t "TaskManager|task_create|task action wait|retention|subagent|spawnSubAgent|usage"`;
  `npm --workspace @sparkwright/agent-runtime run typecheck`;
  `npm run build --workspace @sparkwright/agent-runtime`.

- Status: Verified
- Date: 2026-07-01T13:08:00+0800
- Scope: `task_create` registered-kind diagnostics and model-facing
  kind-specific payload schema hints, including the public barrel export for
  `TaskCreateKindDescriptor`.
- Read: `packages/agent-runtime/src/tasks/manager.ts`,
  `packages/agent-runtime/src/tasks/tools.ts`,
  `packages/agent-runtime/src/tasks/index.ts`,
  `packages/agent-runtime/test/tasks.test.ts`,
  `packages/host/src/tool-catalog.ts`,
  `packages/host/test/tools.test.ts`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
  test/index.test.ts test/tasks.test.ts`; `npm --workspace
  @sparkwright/agent-runtime run typecheck`; `npm run build --workspace
  @sparkwright/agent-runtime`; `npm --workspace @sparkwright/host test --
  test/tools.test.ts -t "main host tool catalog"`; `npm --workspace
  @sparkwright/host test -- test/protocol.test.ts -t "starts a background
  agent through the real task_create tool"`; `npm run check:dist-fresh`.

- Status: Verified
- Date: 2026-06-30T23:59:00+0800
- Scope: task-owned child abort signal for background agent tasks, with parent
  cancellation decoupled from the child when an explicit signal is supplied.
- Read: `packages/agent-runtime/src/index.ts`,
  `packages/agent-runtime/test/index.test.ts`,
  `docs/_internal/project-map/modules/agent-runtime.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime test -- test/index.test.ts
  test/tasks.test.ts`; `npm --workspace @sparkwright/agent-runtime run
  typecheck`.

- Status: Verified
- Date: 2026-06-28T17:51:42+0800
- Scope: `AgentProfile.hooks` is now a neutral structural carrier for
  profile-authored workflow hooks, and `spawnSubAgent` carries caller-supplied
  `WorkflowHook[]` through to child `CreateRunOptions.workflowHooks`.
- Read: `packages/agent-runtime/src/index.ts`,
  `packages/agent-runtime/test/index.test.ts`,
  `packages/core/src/workflow-hooks.ts`,
  `docs/_internal/project-map/modules/agent-runtime.md`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/maps/capabilities/README.md`,
  `docs/_internal/project-map/maps/capabilities/agents.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime test -- test/index.test.ts`;
  `npm --workspace @sparkwright/agent-runtime run typecheck`;
  `npm --workspace @sparkwright/agent-runtime run build`;
  `npm --workspace @sparkwright/host test --
  test/agent-profiles.test.ts test/tools.test.ts test/workflow-hooks.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`.
- Prior verification — Date: 2026-06-28T17:33:27+0800
- Scope: `spawnSubAgent` now carries caller-supplied `WorkflowHook[]` through to
  child `CreateRunOptions.workflowHooks`, keeping Agent.md/config compilation
  outside agent-runtime.
- Tests: `npm --workspace @sparkwright/agent-runtime test -- test/index.test.ts`;
  `npm --workspace @sparkwright/agent-runtime run typecheck`;
  `npx prettier --check packages/agent-runtime/src/index.ts
  packages/agent-runtime/test/index.test.ts
  docs/_internal/project-map/modules/agent-runtime.md
  docs/_internal/project-map/maps/capabilities/agents.md`.
- Prior verification — Date: 2026-06-28T14:13:14+0800
- Scope: `createAgentTool` now awaits async `buildSpawnInput` so host can keep
  child-scope model construction lazy while agent-runtime remains provider
  agnostic.
- Prior verification — Date: 2026-06-27T18:53:34+0800
- Scope: documented the `AgentProfile.model` ownership boundary after checking
  the host-applied in-process delegate model path.
- Prior verification (shared delegation ledger) — Date: 2026-06-27T13:48:00+0800
- Scope: shared delegation result ledger for completed child-agent results
  across `createAgentTool`, configured delegate, `delegate_parallel`, and
  dynamic `spawn_agent` entrypoints.
- Read: `packages/agent-runtime/src/index.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/test/tools.test.ts`,
  `docs/_internal/project-map/modules/agent-runtime.md`,
  `docs/_internal/project-map/maps/capabilities/agents.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime run typecheck`;
  `npm --workspace @sparkwright/agent-runtime test -- test/index.test.ts`;
  `npm --workspace @sparkwright/agent-runtime run build`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/host test -- test/tools.test.ts`;
  `npm --workspace @sparkwright/host run build`;
  `npm --workspace @sparkwright/cli run typecheck`;
  `npm run check:dist-fresh`.
- Prior verification (delegate_parallel metadata) — Date: 2026-06-27T12:16:45+0800
- Scope: `delegate_parallel` is now an allowed `SubAgentEntrypoint` metadata
  value for host-owned foreground parallel delegate fan-out; agent-runtime only
  projects it into sub-agent lifecycle metadata.
- Read: `packages/agent-runtime/src/index.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/test/tools.test.ts`,
  `packages/host/test/protocol.test.ts`,
  `docs/_internal/project-map/modules/agent-runtime.md`,
  `docs/_internal/project-map/maps/capabilities/agents.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime run typecheck`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/host test -- test/tools.test.ts -t "delegate_parallel|foreground parallel|write-capable delegates"`;
  `npm run check`.
- Prior verification — Date: 2026-06-27T11:29:02+0800
- Read: `packages/agent-runtime/src/index.ts`,
  `packages/host/src/agent-profiles.ts`,
  `packages/host/src/delegate-capability.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/test/agent-profiles.test.ts`.
- Tests: `npm --workspace @sparkwright/agent-runtime run typecheck`;
  `npm --workspace @sparkwright/host test -- test/agent-profiles.test.ts -t "routing|triggers"`;
  `npm --workspace @sparkwright/host run typecheck`.
- Prior verification — Date: 2026-06-27T01:25:26+0800
- Read: `packages/agent-runtime/src/index.ts`,
  `packages/host/src/agent-profiles.ts`,
  `packages/host/src/delegate-capability.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/test/agent-profiles.test.ts`.
- Tests: `npm --workspace @sparkwright/agent-runtime run typecheck`;
  `npm --workspace @sparkwright/agent-runtime run build`;
  `npm --workspace @sparkwright/host test -- test/agent-profiles.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`.
- Prior verification — Date: 2026-06-25T23:14:11+0800
- Read: `packages/agent-runtime/src/index.ts`,
  `packages/agent-runtime/test/index.test.ts`.
- Tests: `npm --workspace @sparkwright/agent-runtime test -- test/index.test.ts`;
  `npm --workspace @sparkwright/agent-runtime run typecheck`;
  `npx prettier --check packages/agent-runtime/src/index.ts packages/agent-runtime/test/index.test.ts packages/cron/src/service.ts packages/cron/test/schedule.test.ts packages/cli/src/cli.ts packages/cli/test/cli.test.ts packages/tui/src/lib/create-capability.ts packages/tui/test/create-capability.test.ts`.
