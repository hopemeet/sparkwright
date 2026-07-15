# Host

## Purpose

`@sparkwright/host` is the composition boundary around core. It loads config,
providers, skills, MCP servers, agent profiles, shell settings, workflow hooks,
session stores, and protocol-facing runtime methods.

See also [../maps/runtime/run-loop.md](../maps/runtime/run-loop.md) and
[../maps/capabilities/README.md](../maps/capabilities/README.md).

## Main Files

- `packages/host/src/runtime.ts`
- `packages/host/src/session-queries.ts`
- `packages/host/src/session-compaction.ts`
- `packages/host/src/run-access.ts`
- `packages/host/src/run-security-plan.ts`
- `packages/host/src/run-policy.ts`
- `packages/host/src/server.ts`
- `packages/host/src/connection.ts`
- `packages/host/src/agent-spawn-grants.ts`
- `packages/host/src/tool-catalog.ts`
- `packages/host/src/tool-surface.ts`
- `packages/host/src/tool-identities.ts`
- `packages/host/src/tools.ts`
- `packages/host/src/shell.ts`
- `packages/host/src/workspace-snapshot.ts`
- `packages/host/src/workspace-lease-coordinator.ts`
- `packages/host/src/workspace-agent-arbiter.ts` (compatibility re-export)
- `packages/host/src/workflow-hooks.ts`
- `packages/host/src/invariant-projection.ts`
- `packages/host/src/workflows.ts`
- `packages/host/src/workflow-projection.ts`
- `packages/host/src/workflow-node-api.ts`
- `packages/host/src/workflow-distill.ts`
- `packages/host/src/workflow-shadow.ts`
- `packages/host/src/workflow-trace-observation.ts`
- `packages/host/src/active-rules.ts`
- `packages/host/src/traced-process-runner.ts`
- `packages/host/src/acp-child-agent.ts`
- `packages/host/src/skill-inline-shell.ts`
- `packages/host/src/external-command-agent.ts`
- `packages/host/src/delegate-capability.ts`
- `packages/host/src/indexed-delegate-tool.ts`
- `packages/host/src/agent-profiles.ts`
- `packages/host/src/crash-log.ts`
- `packages/host/src/model-builder.ts`
- `packages/host/src/model-factory.ts`
- `packages/host/src/config.ts`
- `packages/host/src/config-zod-schema.ts`
- `packages/host/src/client-input.ts`
- `packages/host/test/protocol.test.ts`
- `packages/host/test/tools.test.ts`

## Owns / Does Not Own

Owns:

- host protocol method implementations such as `run.start`, `run.resume`, `session.inspect`, `session.compact`, and `capability.inspect`
- provider/model construction for local host runs
- provider pricing resolution for run metadata, session compaction usage hints,
  and `capability.inspect` diagnostics
- skill, MCP, shell, cron, and agent capability preparation
- host tool catalog entries that preserve runtime tool source metadata
- immutable per-run/per-inspect derivation of resolved access, workspace,
  confidential path inputs, skill/config roots, and shell sandbox status
- host-level approval resolver and pending approval routing
- host-client approval helpers used by frontends that must not import core directly
- session diagnostics bundle composition
- shell live-process handoff into task state, including explicit/promotion
  origin, awaited policy, service metadata, and pre-spawn active-task lookup

Does not own:

- core state machine semantics
- event envelope schema
- TUI rendering state
- CLI argument parsing

## Contracts

- `createMainHostToolCatalog()` owns config/source admission.
  `tool-surface.ts` then owns canonical Profile allow/deny narrowing, Workflow
  narrowing, required-schema promotion, and scoped discovery for main,
  delegate, dynamic child, fresh, resume, and continuation paths. Each step is
  monotonic: it cannot restore a removed tool, and every retained
  `tool_search` is rebuilt over exactly the final definitions instead of
  reusing a broader captured index. Child policy remains defense in depth.
- A Todo continuation first proves `todo_write` survived admission and current
  Workflow narrowing. If absent, `runTodoSupervised()` hands off with
  `required_tool_unavailable` before emitting the directive that requires that
  tool.
- Workflow projection selects its `RunEnd` terminal owner once at construction.
  Host-supervised Workflow runs use `episode_chain`, so projection never races
  Todo continuation/handoff and Host finalization owns the durable terminal
  state for every Core stop reason.

- `SkillCommandService` owns create preparation, session/run draft dedupe,
  approval preparation, receipt persistence, and approved apply. CLI/TUI/model
  adapters must not reproduce those transitions. Low-level proposal/history
  functions remain in `skill-evolution.ts` for the service and advanced
  lifecycle commands.

- Host owns the first Skill prepared-change transaction slice. A safe authored
  `create_skill` persists the final proposal/effect hash, requests
  `skill.apply` through the run approval channel, records the hash-bound
  receipt, applies in the same tool episode, and persists history/mutation
  receipt. Proposal storage is the slow-path source of truth; TUI state is only
  presentation. Other Skill entrypoints are not unified yet.

- Host's model-facing Markdown Agent authoring surface uses canonical `name` as
  the filename stem and public identity. Runtime `AgentProfile.id` remains an
  internal compatibility field, legacy Markdown `id` overrides remain
  readable, and new files omit inferred child mode and inherited budgets.
  Explicit model refs are resolved against current layered config before write.
  Authoring aliases `inherit` / `default` normalize to omission, the sole
  persisted inheritance form. Markdown discovery drops and reports invalid
  model-ref syntax instead of advertising profiles that fail only when
  delegated.

- One active HostExecution per compatibility runtime facade.
- One execution-wide abort spans assembly
  and all todo/workflow episodes on that connection. Disconnect and legacy
  cancel trip the same abort; Core run cancellation remains run-scoped.
- Background Agent `task_create` tools capture their model, policy, session,
  child-store, permission, and workspace-lease dependencies in an inline Task
  runner. Host has no mutable latest-run Agent dependency slot.
- `HostExecution` is the lifecycle owner for one interactive execution. It owns
  execution/session/root/current/final identity, run aliases, the episode-chain
  abort, live approval waiters, completion, and idempotent resource disposal.
  Core terminal for an episode does not complete the execution while the
  Workflow/todo run-chain driver selects a continuation.
- `resolveExecutionPlan()` freezes workspace/session/model/access identity
  before `createExecutionResources()` creates a fresh LocalWorkspace, trace
  emitter, and session store handles. Live execution resources are not pooled.
- `HostService` is the process composition root and the only production
  `HostRuntime` factory. It keys `WorkspaceContext` by canonical workspace and
  session-store roots, shares one workspace mutation lease coordinator per
  canonical workspace, attaches runtime facades, provides execution/run alias
  lookup without copying execution truth, and drains attached runtimes.
- `HostService` owns one in-memory `ExecutionLaneCoordinator` and is the
  canonical production path for ordinary start, resume, inject, and cancel.
  Lane identity is canonical session-store root plus persisted session id.
  Same-lane executions serialize; different lanes may consume the bounded
  process capacity concurrently. Core episode terminal does not release the
  lane until `HostExecution.completion` settles.
- `HostService` also owns ordinary IM session bindings, exact subject
  authorization, approval-to-execution routing, retained runtime attachment,
  and per-binding delivery cursors over a bounded event-projection outbox.
  Self-binding requires both an authenticated transport principal and explicit
  operator enablement. Handshake `client.name` is frozen client metadata and an
  authenticated-only additional allowlist input; it never derives principal
  identity. Host assigns every new binding's session; a caller-supplied session
  id can only echo the session of an existing live exact principal+subject
  binding during reconnect. This live control state is process memory and is separate from
  durable Workflow channel bindings and Core's canonical event log.
- Host connection principals are derived before handshake from transport/auth
  context. The configured single WS bearer credential maps to a stable,
  non-secret server-side credential-slot id so reconnect can reuse an exact
  binding and replay unacknowledged deliveries. Unauthenticated WS/stdio uses a
  connection-scoped principal and cannot self-bind. External connections cannot
  mint `system`, `verified`, `trusted`, `principalId`, or `authenticatedBy`.
- Host handshake is single-use. Duplicate or concurrent handshakes are rejected
  and cannot mutate principal or client metadata. Workflow protocol control and
  resume commands record the real connection principal/auth method rather than
  a fixed protocol-client attribution.
- `WorkspaceContext` owns the shared TaskManager/store/outbox and Workflow
  notification/control adapters. It never owns live MCP, LocalWorkspace,
  mutable policy, event emitter, approval resolver, or active execution.
- `run-security-plan.ts` is the immutable boundary between config/access
  parsing and runtime assembly. A run and `capability.inspect` derive the same
  workspace, access, confidential paths, skill/config roots, and resolved shell
  sandbox inputs there. It must not own prepared tools/processes, approval
  resolvers, traces, Workflow state, or Core's mutable per-run mutation policy.
- `run-policy.ts` is the stateful companion factory. Every call creates a fresh
  layered policy and fresh mutation `writtenPaths` state. Host runtime and the
  internal CLI direct-core start/resume paths share its target/default
  guardrails, but never share a returned policy instance.
- The security plan keeps configured shell-sandbox status separate from the
  process sandbox passed to local extension adapters. Read-only run access
  strengthens that adapter input to fail-closed no-write without misreporting
  the main Shell tool's configured sandbox mode in capability inspection.
- Workflow Script execution receives write access only when both the resolved
  run access and the script's declared capabilities allow `write`. Command
  hooks are likewise strengthened to fail-closed no-write when run metadata
  explicitly carries `shouldWrite:false`; missing metadata retains the legacy
  embedder contract.
- CLI `capabilities inspect` treats the Host `CapabilitySnapshot` as required
  for effective tool, delegate, and sandbox facts. It may add CLI-only config
  diagnostics and optional MCP resolution detail, but it no longer reconstructs
  a fallback Host tool catalog or independently reports sandbox availability.
- Session root defaults to `<workspace>/.sparkwright/sessions`.
- Host protocol `run.failed` events emitted by runtime carry canonical
  `failure` and deprecated compatibility `error`; failed core completions remain
  `run.completed` with optional `failure`.
- `run.start` and `run.inject_message` accept protocol `input.parts`; host
  normalizes them into core `ContextItem.parts` while keeping `goal`/`content`
  as text summaries.
- `session.inspect` returns summary, consistency, and timeline derived from `trace.jsonl`.
- `session.compact` is best-effort and uses core `compactSessionTurns()` over
  completed user/assistant turns. Successful responses include `freedChars`,
  `measurement`, optional `skippedReason`, optional `warnings`, and
  `artifactPath`; no-savings or write-failure outcomes return `ok: true` with
  `artifactPath: null`. Explicit `llm` requests resolve through the host model
  factory: provider/scripted refs use the model-backed Tier 3 summarizer, while
  deterministic refs use the preview path and return a warning.
- Host appends `session.compaction.completed` or
  `session.compaction.skipped` to the session event stream after each
  successful `session.compact` response, recording durable audit facts without
  compacted summary content.
- Host `session.inspect` accepts optional `compaction: true`; runtime also
  exposes a compaction-only inspection path for CLI use. The compaction report
  joins `compact.json` with `session.compaction.*` events and omits summary
  content.
- Future run context consumes `compact.json` only when its `throughRunId`
  anchors to completed turns; otherwise host injects a conversation-layer
  warning item instead of silently dropping the artifact.
- Resume prefers `checkpoint.json`; `fromTrace` reconstruction is best-effort and requires force when not fully resumable.
- Host runtime accepts trace detail `standard` or `debug`; `minimal` is rejected
  at protocol/config/CLI validation.
- Config loading accepts `config.json`, `config.yaml`, and `config.yml` in the
  user and project layers. Within a layer, JSON wins over YAML/YML and multiple
  files are reported as a non-fatal same-layer conflict; explicit
  `$SPARKWRIGHT_CONFIG` still loads as the final file layer.
- `shell.foregroundTimeoutMs` is the single configurable foreground shell
  budget. It defaults to 300000 ms, is capped at 600000 ms, flows through the
  host tool catalog to main and configured-delegate child shell tools, and is
  surfaced by capability inspection. It is not a process hard-kill timeout.
- `config-zod-schema.ts` is the source for the generated
  `schemas/config.schema.json`; `npm run schema:generate` refreshes it and
  `npm run schema:check` fails on drift before Ajv fixture validation. Exported
  config section types in `config.ts` are re-exported from this Zod source where
  the shape is host-owned. Runtime loader validation now shares the Zod source
  for primitive field checks (strings, arrays, booleans, numbers, string
  records). Section key validation for `tools`, `write`, `runBudget`,
  `approvals`, `shell`, shell sandbox subsections, `capabilities`,
  `capabilities.skills` subsections, `capabilities.hooks`/workflow hook
  subsections, `capabilities.verification` subsections, `capabilities.mcp`,
  `capabilities.mcp.defaultPolicy`, `capabilities.agents`, and
  `capabilities.agents.delegateTools`,
  `capabilities.agents.profiles`, `tasks.<name>` auxiliary task routing and
  shared `budget` blocks, and external delegate metadata sections
  (`metadata.acp`, `metadata.externalCommand`), and grouped config sections
  (`identity`, `policy`, `run`, `ui`), provider definitions, provider model
  entries, provider cost blocks, and workflow hook action branches is also
  derived from Zod validator schemas;
  enum/literal checks for trace level, shell sandbox modes, skill evolution,
  workflow hooks, verification, MCP startup/schema-load modes, and agent
  profile modes also reuse Zod-exported option lists. Root/shared scalar
  validation for `model`, `workspace`, `confidentialPaths`, `maxSteps`, and
  `run.accessMode` also consumes the Zod source while preserving host loader
  partial recovery. Strict root unknown-key validation remains a
  `sparkwright config validate` / generated JSON Schema responsibility; the
  runtime host loader intentionally ignores unknown root keys for UI/future
  compatibility. Externally-owned schemas (`capabilities.mcp.servers` and
  `capabilities.agents.profiles`) remain integration edges, with host runtime
  validation preserving existing partial parsing and source-relative path
  resolution.
- Host approval resolution preserves optional resolver `message` and
  `autoApproved` fields so trace summaries can distinguish auto-approved
  decisions from manual approvals without parsing prose.
- Host protocol `run.start` and `run.resume` pass `shouldWrite` as the
  workspace-write capability gate into core policy. Read-only runs
  (`shouldWrite: false`) keep the hard-deny write gate; interactive TUI clients
  that need write approvals send `shouldWrite: true` with an approval-oriented
  `permissionMode`.
- Host start/resume/workflow-resume run policies pass `confidentialPaths` and
  `confidentialDefaults` through core `resolveRunConfidentialPaths()`.
  `confidentialDefaults` defaults to true and may be set false by config or
  protocol clients to opt out of SparkWright's built-in conservative read-deny
  list while retaining any explicit `confidentialPaths`.
- `workflow.list` projects only authorization presence flags and non-sensitive
  policy fields; target and confidential path values stay in the durable host
  record. `workflow.resume` reapplies those persisted values when the client
  omits them, preserving the authorization boundary without broadcasting paths.
- `run.accessMode` is the single user-facing run autonomy knob. The protocol
  `RunStart`/`RunResume` payloads accept optional `accessMode`
  (`read-only`/`ask`/`accept-edits`/`bypass`); `host/src/run-access.ts`
  (`resolveRunAccessFields`) compiles it to `permissionMode` + `shouldWrite` and,
  when a conflicting legacy `permissionMode`/`shouldWrite` is also present,
  prefers `accessMode` and records the overridden field names in run metadata
  (`accessMode`, `accessModeOverrodeLegacyFields`) via `buildAccessMetadata`.
  When `accessMode` is absent the previous `permissionMode`/`shouldWrite`/default
  path is used, but host runtime defaults can still clamp legacy fields through
  an `accessModeCeiling`. The mapping primitive lives in core
  (`compileRunAccessMode`/`clampAccessMode`/`ACCESS_MODES`), mirrored as a wire
  type in `@sparkwright/protocol`. `server.ts` validates the `accessMode` enum at
  the wire boundary.
- `permissionMode` is no longer a user-facing config/CLI surface; it is an
  internal compile target only. Config exposes `run.accessMode` (the flat
  `permissionMode`/`policy.permissionMode` fields were removed, and
  `ui.tuiPermissionMode` was removed instead of keeping a second persisted
  autonomy axis). The loader (`config.ts`) derives the internal
  `SharedConfig.permissionMode` from `accessMode`. Project `run.accessMode` is
  also exposed as `accessModeCeiling`; lower layers, CLI flags, host clients, and
  TUI runtime switches are clamped to that ceiling while stricter requests remain
  effective. The CLI flag is `--access-mode` (compiled to
  `permissionMode`/`shouldWrite` locally after ceiling clamp); `tui`/`acp` launch
  flags are also `--access-mode`. The internal host↔host
  spawn IPC (`host/src/main.ts` + `client-spawn.ts`) still speaks the low-level
  `--permission-mode` contract. `approvals.cronMode` remains a low-level
  `permissionMode` field; `dont_ask` has no `accessMode` equivalent by design.
- TUI approval auto-policy goes through `@sparkwright/host` helpers; TUI source
  must not import `@sparkwright/core` directly.
- Host client input helpers build protocol `RunInputPart` image attachments and
  shared input metadata for CLI/TUI clients. They do not read files; product
  surfaces keep their own sync/async IO and user-facing error wording.
- Legacy `capabilities.tools` config is rejected; top-level `tools.use`,
  `tools.allowed`, `tools.disabled`, and `tools.defer` are the supported tool
  filters. `tools.use` is a selector whitelist expanded at the host catalog
  layer where source metadata is still available, `allowed`/`disabled` trim the
  prepared catalog by concrete name, and `defer` only changes schema loading
  for tools that remain. The effective config canonicalizes legacy selector and
  tool aliases.
- Main, dynamic-spawn child, configured-delegate child, and diagnostic tool
  lists are derived from `tool-catalog.ts`; dynamic `spawn_agent` uses a
  dynamic child catalog that defaults to read-only tools but can expose managed
  workspace write tools (`write`, `edit`, `edit_anchored_text`) only when the
  tool call requests a spawn-time workspace-write grant. It never exposes
  `bash`. Configured in-process delegates use a separate profile-aware child
  catalog for workspace read/write coding tools plus `bash` when selected.
  Catalog entries keep tool definition, source, and stable identity metadata;
  callers that need bare `ToolDefinition[]` flatten catalog entries with
  `catalogToolDefinitions()`.
- The main host catalog exposes eager `task_create` and advanced/deferred
  `task` control when the background task surface is enabled. Existing-task
  control is discoverable through the normal scoped `tool_search` path rather
  than charging every model turn for its schema. Host owns the `agent` kind descriptor and
  its model-facing payload schema (`goal`, `role`, `prompt`, optional
  `allowedTools`, `grant`, `maxSteps`, `metadata`); execution still dispatches
  through the `TaskManager` runner registered by `HostRuntime`. For
  `grant.workspaceWrite: true` or explicit write tools, the descriptor supplies
  grant-aware policy/governance and approval summary metadata before the task
  starts, while the background child consumes the same scoped grant as
  `spawn_agent`. The `maxSteps` payload guidance mirrors dynamic `spawn_agent`:
  omit it to inherit the parent run's effective step budget, and allocate
  enough turns for read/search plus final synthesis instead of using very low
  caps.
- The main host catalog preserves the shared deferred `task` action schema from
  agent-runtime, including action-specific non-empty id constraints, so
  `tool_search select:task` gives the provider the same guidance the runtime
  validates.
- Host wires the shared `TaskManager` notification sink into a durable
  `FileTaskNotificationOutbox` that backs per-run core notification/revival
  sources. All terminal task notifications for the run can be injected through
  `run.notification.injected`; only awaited tasks wake core's internal
  `waiting_tasks` state. Injected terminal task notification body text includes
  a bounded `Result summary: ...` when a task result is present, because the
  model-facing body must carry child-result evidence rather than relying only
  on notification metadata. Host does not synthesize a new user turn. On
  `run.resume`, pending/running task records for the resumed run that do not
  have a current-process live runner are failed explicitly as orphaned
  in-process tasks.
- Host owns workflow asset discovery, parsing, and P1 projection compilation.
  `workflows/<asset>/workflow.md` folder assets are parsed with shared
  markdown-folder-asset plumbing, optional `config.yaml`, and per-node markdown
  sections, then surfaced through capability snapshots and CLI inspection.
  After P1.5, runtime instantiation no longer requires the experimental
  workflow flag because the old verification/documented-command gate producers
  are deleted.
- `sparkwright run --workflow <name>` / `run.start.workflow` instantiate a
  host-owned single-family projection hook set named `workflow:<workflowRunId>`.
  The projection owns live in-memory node state, TurnStart node context,
  PreToolUse block-only clamps, Stop verifier gates over the core FactLedger,
  `workflow.*` lifecycle events, and runtime interruption facts. It delegates
  transition decisions to the portable agent-runtime state machine.
- Workflow runs are durable host-orchestrated records. After P9a, fresh runs
  write `FileWorkflowStore` records under the workspace-level
  `.sparkwright/workflow-runs/` store while retaining `sessionId` on each
  record; legacy `<sessionRoot>/<sessionId>/workflow-runs/` records remain
  list/resume compatible. Host acquires the workflow run's single-writer lease
  before fresh record creation or resume, pins the compiled workflow definition
  snapshot, persists projection snapshots into current node, attempts,
  verdict/transition logs, and run/fact evidence refs, refreshes a single-writer
  lease while the run chain is active, and releases the lease on terminal/
  rejected paths. `workflow resume` uses the pinned definition and the located
  store, not the live asset folder or a reconstructed session-root store;
  workspace-level records are preferred over matching legacy session-local
  copies for the same `workflowRunId`/`sessionId`; `verifyOnResume` re-runs
  verifier nodes whose latest stored verdict is passed before trusting the
  stored position. Waiting-input resume does not consume the durable wait until
  host run preparation has succeeded; if a later pre-run failure occurs, host
  restores the prior waiting record before returning the error.
- Fresh workflow-job starts return `{runId, workflowRunId, sessionId}` after
  durable record creation. A typed `controlSessionId` is accepted only for a
  workflow start, must differ from the job session, and is stored as record
  attribution; it is never used to load conversation history. Resume returns
  and executes against the record's original job session.
- Host delivers completed/failed workflow terminal notifications and P3
  `waiting` notifications through the workflow actor inbox with
  `payload.workflowId === WorkflowRunRecord.id`; waiting notifications are
  backed by `FileWorkflowNotificationOutbox`, not the legacy task notification
  format. Durable truth lives in `WorkflowRunRecord` / store events.
- P3 Step 4a retired `startSupervisedRunChain()`. Fresh run, `run.resume`, and
  `workflow.resume` now enter `startWorkflowActorEpisodeChain()`: the
  workflow/todo actor owns the chain shape through agent-runtime's
  `runTodoSupervised()` -> `runWorkflowRunChain()` path, while host creates
  transient core `createRun()` episodes and wires active-run/session/lease/event
  glue. Workflow records mark `metadata.episodeDriver:"workflow_actor"` and
  `episodeKind`.
- P3 Step 4b.1 narrows worker-entry tool catalogs for model nodes with
  `node.tools`: `runtime.ts` filters the `ToolDefinition[]` passed to
  `createRun()` and records `episodeAllowedTools`. `workflow-projection.ts`
  keeps the PreToolUse clamp as a fallback for mid-run transitions, including a
  non-model/script drain that reaches a later model node inside an already-created
  core run. That fallback checks the actual current worker registry before
  standing down for core `TOOL_NOT_FOUND`; it must not use the ideal workflow
  allowlist as a proxy for physical availability. If the narrowed catalog
  contains deferred tools, host appends a scoped `tool_search` whose descriptor
  source is the narrowed catalog only; PreToolUse allows only that marked scoped
  tool_search without reopening the parent catalog. The clamp compares allowed
  tool names canonically, so legacy declarations such as `tools: [read_file]`
  still allow the canonical worker tool `read`.
- P3 Step 4b.2 routes active model-node `model` and `runBudget` at worker
  entry: `workflows.ts` parses the node fields, `runtime.ts` resolves model
  refs through the configured model-tier surface, passes the selected adapter
  and per-attempt budget to `createRun()`, and records `workflowEpisode`,
  per-episode usage snapshots, and aggregate `workflowUsage` on
  `WorkflowRunRecord.metadata`. Retry escalation inside one core run is not
  implemented until model-node boundaries become separate worker episodes.
  Projection snapshots refresh `workflowEpisode.nodeId` and
  `episodeAllowedTools` when a mid-run non-model drain reaches a model node, so
  durable workflow records reflect the current model boundary even though the
  core worker run was created before the drain.
- P3 Step 4b.3 resolves D11 by not shipping a model-facing `workflow_start`
  tool in P3. Host workflow instantiation remains limited to CLI/config/
  protocol request surfaces (`run --workflow` / `run.start.workflow`), and
  workflow episode catalogs must omit `workflow_start` by default. Future
  spawn-shaped support must first join the unified task lifecycle and enforce
  explicit recursion depth plus access clamping.
- P4 script nodes are host-owned non-model workflow nodes. `workflows.ts`
  parses `execute: script` plus asset-local `script.path` / args / env / cwd /
  stdin / timeouts / output caps / declared capabilities, and pins
  `WorkflowDefinition.sourcePath` / `sourceDir` into the durable definition
  snapshot so resumed runs execute the pinned asset-local script path rather
  than rediscovering live asset state. `workflow-projection.ts` drains the node
  through `workflow-node-api.ts`, which runs a stdio JSON-RPC child through
  `TracedProcessRunner.runJsonRpc()`: stdout is RPC only, stderr remains
  telemetry/progress, and scripts report effects through host API methods such
  as `progress`, `getEvidence(nodeId)`, governed `invoke(type:"command")`,
  `complete`, and `fail`. Script-declared write capability is fail-closed when
  the parent run lacks `shouldWrite`; scripts do not write trace directly and do
  not receive raw host capabilities.
- P4 keeps node-boundary compaction and retry-time model escalation out of
  host execution. There is still no `workflow_start` tool; script nodes do not
  introduce an expression language, and data flow between nodes remains
  explicit host `getEvidence(nodeId)` over recorded evidence refs.
- P5 `parallel` / `join` nodes remain host projection behavior over durable
  workflow state. `workflows.ts` parses explicit `parallel.branches`,
  `parallel.maxConcurrency`, and `join.waitFor`; `workflow-projection.ts`
  executes only non-model branch nodes (`command`, `delegate`, `task`,
  `script`), persists branch verdict/evidence in
  `WorkflowRunRecord.parallelBranches`, and lets `join` read that state without
  re-running branches. `parallel` requires explicit `onPass` and rejects pass
  edges into its own branch set, so adjacency cannot fall through into branch
  execution. P5 rejects branch-local `verify` declarations because branch Stop
  verifiers are not wired. `parallel` preserves branch `runtime_error` and
  delegate_parallel infrastructure crashes as fail-closed node verdicts; `join`
  requires each waited branch to have one producer and rejects stale
  `sourceNodeId` state. Branch-local transitions are not interpreted in P5;
  only the `parallel` / `join` node verdicts advance through
  `advanceWorkflowState()`. All-delegate fan-out must call the existing
  `delegate_parallel` tool and is batched by `maxConcurrency`; P5 does not add a
  workflow scheduler, branch cancellation bus, nested parallel, human/model
  branches, branch verifier execution, or `workflow_start`.
- P6b `todo_clear` is a host-evaluated workflow verifier. `workflows.ts` parses
  the portable verifier declaration; `runtime.ts` supplies a provider for the
  current session's `todo.md`; `workflow-projection.ts` reads that provider at
  Stop, passes only when no unfinished todo items remain, records summary
  metadata/evidence refs, and fail-closes missing or unreadable providers as
  runtime errors. It does not replace the todo supervisor continuation audit or
  add FactLedger todo state.
- P7a `workflow-distill.ts` is a read-only deterministic session-trace
  distiller. It consumes existing trace events, derives observed tools/paths/
  post-write verification commands, and renders a review-first workflow draft.
  Failed or hook-blocked tool requests are not treated as observed productive
  tools, and read-only drafts no longer pre-seed `grep`/`glob` unless those
  tools were actually observed. It does not write workflow assets, create
  skill-evolution proposals, mutate traces, or add protocol/TUI runtime
  behavior.
- P8a `workflow-shadow.ts` is a read-only deterministic offline coverage
  reporter. It compares an existing workflow asset against an existing session
  trace using the shared `workflow-trace-observation.ts` extraction path and
  reports matched/missing/unobserved coverage for successful observed tools,
  writes, `diff_scope`, command-verifier-like shell commands, and `todo_clear`.
  Failed or hook-blocked tool requests stay out of coverage requirements. It
  does not instantiate workflows, write workflow-run records, mutate traces,
  execute nodes, or add live protocol/TUI shadow telemetry.
- `TracedProcessRunner` owns the shared bounded progress head/tail sampler used
  by stdio JSON-RPC process progress and by the external-command delegate. Keep
  future process integrations on this shared runner/sampler path rather than
  rebuilding local stdout/stderr progress collectors.
- P3 Step 2 supervised projection supports non-model `command`, `delegate`, and
  `task` nodes at host-owned node boundaries. `workflows.ts` parses explicit
  node runner fields plus `diff_scope`; `workflow-projection.ts` drains
  non-model nodes through governed primitives until the next model boundary.
  Command nodes require static argv plus `authorized: true` /
  `authorization: trusted`; delegate nodes call the configured `delegate_agent`
  primitive; task nodes call the explicit `task_create` primitive injected from
  the main host catalog. `diff_scope` is evaluated from FactLedger write facts
  newer than the projection's node-entry epoch marker. Projection hooks remain
  worker-side adapters for model-run guidance/drain; resident ownership is the
  workflow record plus actor episode chain.
- P3 Step 3 supervised projection supports `human` nodes as waiting boundaries:
  `workflow-projection.ts` emits `workflow.waiting`, snapshots
  `phase:"waiting"` with `wait.kind`, and host persists
  `WorkflowRunRecord.status:"waiting"` before releasing the lease.
  `workflow.resume` consumes `input` waits at the actor boundary by appending a workflow store
  `input` event, clearing `wait`, advancing the human node with a passed
  verdict, and starting the next transient host worker episode.
- P1 workflow command verifiers require static command + args tokens and an
  explicit asset authorization declaration (`authorized: true` or
  `authorization: trusted`) before projection instantiation. Hook execution
  remains non-interactive, so unauthorized verifier commands reject the workflow
  instead of prompting at execution time.
- Host verification profiles and documented-command checks are built-in
  run-level invariant projections, not workflow assets and not linear
  state-machine nodes. They share the verifier execution pipeline and core
  FactLedger result protocol, use `FactLedger.writeEpoch` for freshness, skip
  before the first workspace write, skip reruns within an already-clean epoch,
  and return bounded `advance` retries with model-visible failure evidence when
  require-mode invariants are dirty. `suggest` verification is guidance-only and
  does not instantiate an invariant projection. `capabilities.verification.stopGate`
  and `capabilities.verification.afterWrites.frequency` are no longer config
  surfaces; `afterWrites.injectOutput` controls retry evidence injection.
- `backgroundTasks` is the session-level foreground/background policy
  (`disabled`, `foreground-only`, `enabled`). It is accepted on
  `run.start`/`run.resume`, configurable through host config, clamped by
  access-mode governance ceilings, and consumed by task creation, shell
  promotion, and dynamic `spawn_agent` promotion.
- Host-owned task tools pass default concurrency caps to agent-runtime
  (`global=4`, `agent=1`) unless configured. Cap violations are recoverable
  tool errors and must not become an internal host queue.
- Host Agent tools classify Core same-turn concurrency from effective call
  capability rather than their static read-shaped wrapper. Dynamic
  `spawn_agent` remains concurrent only without a workspace-write grant;
  configured direct/indexed delegates remain concurrent only when their child
  catalog is read-only, shell-free, and does not require spawn approval.
  Invalid or unresolved Agent arguments fail closed to serial execution; the
  normal validation/policy path still owns their user-visible failure.
- `indexed-delegate-tool.ts` owns the generic `delegate_agent` argument parsing,
  target routing, preview, target policy projection, and target concurrency
  delegation. `runtime.ts` assembles its resolved profiles/tools and retains a
  compatibility re-export; it must not grow a second indexed-router copy.
- Host-facing task controls `task.join` and `task.promote` are protocol/runtime
  controls for TUI and other clients. They do not reuse model-facing task tool
  JSON: join marks a task awaited, while promote forwards a manual foreground
  promotion signal into `TaskManager`.
- `tool-identities.ts` maps implementation names to the canonical public
  model-facing surface (`read`, `write`, `edit`, `bash`, `glob`, `grep`),
  records legacy aliases, classifies default exposure tier, and records related
  or required tools such as the anchored verified-edit pair.
- Dynamic `spawn_agent` output includes child identity/finality facts for the
  parent (`childRunId`, `role`, `stepLimitReached`, `truncated`, and
  `finality`). A child answer produced on the last allowed step remains a
  completed tool transport result, but host marks the answer `partial` and
  prefixes the message with a warning.
- Dynamic `spawn_agent` starts foreground by default and may promote after the
  foreground budget when `backgroundTasks=enabled`. Promotion adopts the already
  running child through `TaskManager.adoptRunning()` and preserves
  parent-visible `subagent.*` events, usage rollup, run-store attribution,
  terminal projection, and the delegation ledger; it is not a simple wrapper
  task around a child promise.
- Background task lifecycle remains flat in v1. Dynamic and configured child
  agents do not receive `task_create`; only a top-level run can create
  background agent tasks. `capabilities.agents.maxDepth` still bounds ordinary
  child/delegate spawning but is not a nested-background opt-in.
- Background `agent` tasks use the shared `runHostAgentTask()` helper. The task
  controller signal is the child run's abort owner, so `task_stop` cancels the
  child lifecycle independently of the foreground parent turn. The helper also
  threads the controller task id into dynamic-spawn metadata so parent-visible
  `subagent.*` terminal events for `entrypoint:"agent_task"` can be joined back
  to `task_create` outputs.
- Dynamic `spawn_agent` and configured in-process delegate children inherit the
  parent run's effective `maxSteps` by default. Explicit child/delegate/profile
  `maxSteps` values still override, but host no longer applies the previous
  dynamic-spawn 16-step cap; depth controls live in
  `capabilities.agents.maxDepth`.
- Host-owned tools, including dynamic `spawn_agent`, skill mutation tools, and
  host `read`, provide `ToolDefinition.previewArgs()` so live clients can
  render concise `tool.requested.payload.preview` text without hard-coding host
  tool argument shapes.
- Host `read` returns model-visible paginated windows: line windows are bounded
  by an internal character ceiling aligned with core observation formatting,
  and outputs include `startLine`, `endLine`, `totalLines`, `hasMore`, and
  `nextOffset` when another clean line-offset page is available.
- The deterministic demo model is a diagnostics adapter, but it must still
  reflect the active core run: it reads `ModelInput.run.goal` for output text
  and keeps turn state per run id so shared child-scope adapters do not leak the
  parent construction goal or another child's turn count.
- Core coding catalog exposes public `write`/`edit` workspace-write tools;
  `read_anchored_text` and `edit_anchored_text` are an advanced deferred pair
  and read-only child catalogs intentionally omit write tools.
- `tool-selectors.ts` owns the selector vocabulary (`workspace.read`,
  `workspace.write`, `bash`, `planning`, `skills`, `agents`, `tasks`, `cron`,
  `mcp`, `mcp:<server>`) and the semantic intersection for layered selector
  config (`mcp` intersected with `mcp:demo` yields `mcp:demo`). `tool_search` is
  not a selector: `shouldAppendDiscoveryTool` is the single owner of the rule
  that appends it (exempt from allow/selector filtering) when the filtered set
  still contains a deferred tool; `resolveConfiguredToolAllowlist` lets
  snapshot-less diagnostics (CLI inspect fallback) resolve selectors against the
  real catalog instead of a selector-blind list.
- Main-agent and child-agent profile `use` selectors are intersected with the
  prepared catalog before concrete `allowedTools` trimming. Configured delegate
  profiles intersect against the configured delegate child catalog, not the
  read-only spawn catalog; deferred selected tools retain `tool_search` as
  derived discovery infrastructure, and required/related tool closures are kept
  discoverable together. Parent/child profile selector intersections use the
  same `mcp`/`mcp:<server>` semantics as top-level `tools.use`.
- Markdown-authored agent profiles are discovered recursively under layered
  `.sparkwright/agents` roots and parsed as YAML frontmatter plus prompt body.
  Frontmatter supports the config-profile common case (`name`, `description`,
  `mode`, `model`, `use`, `allowedTools`/`tools`,
  `deniedTools`/`disallowedTools`, `maxSteps`, `runBudget`, `metadata`, and
  inline `delegateTool`). Config-defined profiles still win wholesale by id.
  Runtime discovery and layered agent reports share the same source-aware
  scanner in `agent-profiles.ts`; report code adds layer/root/source diagnostics
  on top rather than re-walking markdown files separately.
- Host folds inline profile `delegateTool` hints under explicit
  `capabilities.agents.delegateTools` with explicit config winning when the
  same profile id or delegate tool name appears. Runtime snapshots, CLI inspect
  fallback, direct `delegates run`, and delegate target construction all consume
  the resolved delegate list. Delegate tool descriptions use
  `delegate.description` when present, otherwise profile `description` as the
  routing hint before falling back to a generic bounded-task description.
- Host separates configured delegation targets from direct named tool exposure.
  non-`main`, non-`mode: primary` profiles with `mode` omitted, `mode: child`,
  or `mode: all` are addressable through the generic `delegate_agent` tool by
  `agentId` even when no `delegate_*` tool is exposed, unless the profile sets
  `exposeAsDelegate: false` and is not explicitly configured as a delegate.
  `capabilities.agents.exposure` defaults to `indexed`; direct `delegate_*`
  tools are exposed only for `pinnedDelegates`, per-profile
  `exposeAsDelegate: true`, legacy `exposeChildrenAsDelegates: true`, or
  `exposure: "all"`.
- Host evaluates configured delegate routing hints (`triggers` and
  `when.keywords`) during run preparation only. It reuses the skill matcher to
  sort and label delegates for the current goal, records the decision in
  `agent.routing.evaluated`, and passes routing summaries into capability
  descriptors. It must not hide delegates or change approval/workspace policy
  from these hints.
- `capabilities.agents.enableParallelDelegates` is a host-owned opt-in that
  appends `delegate_parallel` to the main host tool catalog as an `agents`
  source tool. Version 1 is foreground/blocking, starts all accepted children
  before awaiting them, targets configured delegates by `agentId` (preferred) or
  legacy `toolName`, and only accepts configured in-process delegates whose
  effective child tool set has `workspaceAccess: "none"` and no `shell`.
  ACP, external-command, workspace-writing, and shell-capable delegates fail
  closed before any child is spawned. If a directly exposed delegate already
  owns the reserved `delegate_parallel` tool name, host drops the built-in tool
  and emits a warning-severity `capability.index.failed` event.
- Configured in-process delegate child runs receive the host approval resolver
  so workspace-write and shell approval requests route through the parent run's
  CLI/TUI approval path; they do not receive an interaction channel.
- Profile `hooks` authoring is parsed into the neutral `AgentProfile.hooks`
  carrier from Agent.md frontmatter and `capabilities.agents.profiles[].hooks`.
  Profile hooks are workflow-only, restricted to `command`, `block`, `context`,
  and `http` actions; malformed entries and `agent` actions are dropped before
  runtime. Host then compiles hooks with `createInProcessDelegateHooksResolver`
  at each in-process child spawn, producing fresh `WorkflowHook[]` per run for
  direct delegates, `delegate_agent`, and `delegate_parallel`. ACP and
  external-command delegates remain process-boundary integrations and do not
  receive these hooks. The resolver compiles only the child profile's own
  `hooks`; global verification and documented-command invariants are not
  injected into delegate child runs.
- Dynamic `spawn_agent` children select `capabilities.agents.spawnModel` when
  set, otherwise the parent run's effective model. Configured in-process
  delegate child runs select `profile.model`, then
  `capabilities.agents.delegateModel`, then the parent model. Both child-scope
  configured refs use the same model factory as the main run, but adapters are
  resolved lazily on tool invocation so an unavailable child model fails that
  child/delegate call instead of rejecting unrelated parent run preparation.
  ACP and external-command delegates remain process boundaries and do not
  inherit these parent-process adapter overrides.
- Configured in-process delegate descriptors report the shared delegate policy
  profile (`risk: "safe"` by default for spawn, plus effective approval facts)
  alongside profile-selected write/shell potential
  (`approvalRequiredUnderCurrentRun`, `approvalReasons`,
  `approvalRunOptions`). They use `gatedByRunWrite` when the parent run has not
  enabled workspace writes; that field is a capability gate, not an approval
  reason.
- `capability.inspect` describes ACP, external-command, and configured
  in-process delegates in `agents.delegateTools`; CLI and TUI consume that
  snapshot descriptor instead of maintaining a local in-process delegate
  inventory.
- `CapabilitySnapshot.agents.profiles` reports the full resolved agent profile
  inventory from layered Agent.md files plus inline config. It is diagnostic
  inventory, not callability: primary/non-delegate profiles remain visible here
  even when only child/all profiles become `delegate_agent` targets or direct
  `delegate_*` aliases.
- `capability.inspect` also exposes host-owned `rules.workflow` descriptors for
  configured workflow hooks, verification invariants, and the documented-command
  built-in invariant, plus `rules.events` descriptors for configured
  non-blocking event subscribers. These descriptors are
  inspection-only summaries: they report source, lifecycle/trigger,
  matcher/action summaries, blocking potential, enabled/active status, and hints
  without changing hook arrays or executors. The documented-command pack still
  uses conditional construction, so inactive runs do not gain a new Stop hook or
  extra `workflow_hook.*` events; active failures mark the completed run through
  the verifier outcome rather than blocking final answer text.
- Configured workflow hooks use canonical lifecycle values only:
  `RunStart`, `TurnStart`, `ModelOutput`, `PreToolUse`, `PostToolUse`, `Stop`,
  `RunEnd`, and `RuntimeSignal`. `capabilities.hooks.events` rules are bound per
  run through `bindUserHooks()` as non-blocking `command` / `http` / `agent`
  subscribers; the trigger vocabulary includes runtime budget diagnostics such
  as `run.budget.checked` and `run.budget.exceeded`. Workflow actions support
  command `stdoutJson`, HTTP
  `responseJson`, and agent `workflowResult` paths for returning core
  `WorkflowHookResult` values; malformed results follow the hook `onError` path.
  Result-producing configured `PreToolUse` hooks are tagged for the rewrite
  pass, static block/context hooks for the governance pass, and the workflow
  projection tool clamp also runs in governance so it sees rewritten arguments.
- Host runtime hook assembly also includes the built-in
  `runtime:partial_subagent_finality_disclosure` Stop hook after configured,
  verification/documented-command, and workflow projection hooks. It advances at
  most once per run when the pending final answer omits a caveat but raw events
  show `subagent.*` or `spawn_agent` child finality was partial, step-limited,
  truncated, or failed. It must not treat ordinary truncated read/tool output as
  child-finality evidence.
- Workflow action results are gated by `enforceWorkflowHookEffect`, which rejects
  lifecycle-illegal effects before they reach core: `rewrite` only at
  `PreToolUse`, `advance` only at `ModelOutput` / `Stop`, `block` at every
  lifecycle except `RunEnd` (fire-and-forget), and
  `continue` context only where the run loop consumes it (`RunStart`,
  `TurnStart`, `ModelOutput`, `PostToolUse`, `RuntimeSignal`). A hook that
  returns an effect its lifecycle cannot apply fails loudly rather than being
  silently dropped.
- `agent` actions run a configured delegate agent through the host
  `delegate_agent` tool. They are awaited inline inside the workflow gate, so an
  agent action at `PreToolUse`/`Stop` spends foreground run time synchronously —
  this is intentional: only a blocking result can carry `workflowResult`
  block/rewrite back into the lifecycle (non-blocking automation belongs in
  `capabilities.hooks.events`). Guards: targets whose tool policy is `risky` or
  `requiresApproval` are refused (hooks cannot prompt for spawn approval),
  same-identity spawns are refused as recursive (`AgentHookActionState.active`),
  and a Stop agent that already blocked the run is skipped on later Stop firings
  (`blockedStopActions`) so a blocking agent cannot loop the run.
- `http` action network access is host-owned policy under
  `capabilities.hooks.http` (allowlist + `allowPrivateNetwork`). It is accepted
  only from user config or `SPARKWRIGHT_CONFIG`; `stripProjectHttpHooks` removes
  the policy and any `http` hook/event action found in project config. Each
  request must match the allowlist, then the resolved address is checked
  (link-local always blocked; private networks blocked unless
  `allowPrivateNetwork`). The request pins the connection to the validated
  address and does not follow redirects, closing the resolve→connect DNS-rebind
  and 3xx-redirect SSRF windows that a plain `fetch` would leave open.
- `capability.inspect` accepts an optional active model ref from protocol
  clients. Host resolves `CapabilitySnapshot.model` from that requested model
  when present, otherwise from `RuntimeOptions.defaultModel` / loaded config;
  merging with the last runtime snapshot must preserve the configured/requested
  model summary.
- Model pricing status is resolved once in `model-builder.ts` /
  `model-factory.ts`: explicit provider `cost` wins over built-in pricing, and
  missing pricing reports `costUnavailableReason: "missing_pricing"`. Host run
  metadata, `run.started.payload.resolvedModel`, and
  `capability.inspect.model.pricing` consume that same status instead of
  recomputing cost availability.
- `create_agent` returns callability feedback for create/duplicate-create
  results. Child/all profiles are callable by `agentId` through
  `delegate_agent`; a direct `delegate_*` alias is optional exposure. Primary
  profiles remain inspectable main-run templates, not configured child
  delegates.
- The model-facing `create_agent` schema does not advertise legacy `force`.
  Equivalent requested profile state is idempotent and returns
  `changed:false` even if a legacy/direct caller passes `force:true`; replacing
  a different existing profile must remain an explicit choice rather than an
  accidental repeated create. `action:"update"` patches supplied profile fields,
  can set/remove the delegate tool, and keeps delegate `maxSteps` in sync when
  that field changes. `action:"replace"` requires a non-empty `replaceReason`,
  requires a replacement prompt, removes stale delegate tools for the profile,
  and records a replace mutation. Agent profile writes must preserve sibling
  `capabilities.agents` fields such as `maxDepth`; the manager only replaces
  `profiles` / `delegateTools`.
- Host configured-delegate entrypoints use the agent-runtime shared delegation
  ledger: direct `delegate_*` tools and generic `delegate_agent` share the same
  hidden configured delegate tools, `delegate_parallel` reuses those results
  before spawning, and dynamic `spawn_agent` stores/reuses completed dynamic
  scope results under a prompt/role/tools key. Failed, step-limited, or
  truncated children remain non-reusable.
- Host in-process, ACP, and external-command Agent adapters now construct the
  same agent-runtime `PreparedAgentInvocation` data before projecting parent
  lifecycle identity. Host still owns governance admission and adapter
  execution; agent-runtime Supervisor owns the parent-visible transitions.
- Agent adapters delegate parent-visible lifecycle transitions to
  agent-runtime `AgentSupervisor`. ACP emits `started` only after access,
  workspace, sandbox, and worker-launch preparation; external commands use the
  traced-process `onStarted` signal after sandbox/process admission. Admission
  failures therefore terminate as requested -> failed, and process successes
  carry the same terminal state/finality fields as in-process children.
- The indexed router marks internal tool-to-tool arguments with a non-JSON
  invocation entrypoint so direct aliases remain `delegate` while
  `delegate_agent` lifecycle records the real indexed surface. Model-authored
  string fields cannot override this attribution marker.
- `workspace-lease-coordinator.ts` owns the process-local Host workspace lease
  primitive; `workspace-agent-arbiter.ts` is only a compatibility re-export. One
  `WorkspaceLeaseCoordinator` singleton is shared by HostRuntime connections
  and keyed by realpath-canonical workspace root. Host wraps actual parent and
  child coding/Shell/capability mutation windows, while write-capable
  in-process, ACP, and external delegates retain a lease for their full
  execution. Dynamic Agent grant/delegate dispatch tools are not themselves
  wrapped because their child owns the mutation window.
- `session-queries.ts` owns session listing, trace inspection, compaction
  inspection, transcript previews, and session fork queries. `runtime.ts`
  delegates those protocol-compatible operations without retaining duplicate
  implementations.
- `session-compaction.ts` owns manual compaction preparation, optional
  summarizer model assembly, artifact writes, and compaction event recording.
  Runtime supplies completed immutable turns and does not retain a second
  compaction implementation.
- Same-owner acquisition is reference-counted and reentrant, so a child holding
  its execution lease can call managed write tools. A descendant request that
  would wait on an ancestor fails fast instead of entering a run-chain
  deadlock. FIFO admission prevents later readers from starving a queued
  writer. Acquisitions auto-renew by default; waits are abortable, release is
  idempotent, and involuntary loss is observable and initiates adapter abort.
- This coordinator remains narrower than a workspace transaction manager: it
  does not coordinate other Node processes or distributed hosts, and TTL/loss
  notification is not a fencing generation or proof that a stale process has
  stopped writing. A future session coordinator remains the target long-lived
  owner.
- `capabilities.agents.maxDepth` is enforced before dynamic spawn, LLM child
  delegates, ACP delegates, and external-command delegates start; sub-agent
  events carry `subagentDepth` metadata so nested runs share one depth budget.
  The CLI `delegates run` path loads the same effective agents policy and keeps
  `undefined` `maxDepth` as no configured ceiling. Direct `delegates run`
  resolves its session id before creating the synthetic parent run so lifecycle
  events carry the same `sessionId` before and after trace persistence.
- CLI diagnostic/direct-core and cron runner tool lists use the `createCliDiagnosticToolCatalog` profile instead of hand-rolled read/write tool definitions.
- `capability.inspect` tool summaries should use catalog metadata when `ToolDefinition.governance.origin` is absent.
- Host crash logs are user state under `$XDG_STATE_HOME/sparkwright/host-crashes`
  or `~/.local/state/sparkwright/host-crashes`; `~/.sparkwright` is reserved
  for source-installed program files.
- Shell mutation protection covers managed project capability files under
  `.sparkwright/skills`, `.sparkwright/agents`, and `.sparkwright/command`; cron
  state is not project-authored.
- `workspace-snapshot.ts` owns host-side workspace snapshot/diff/rollback
  primitives used by foreground shell mutation rollback. Snapshots record
  regular files and symlinks; rollback removes created/replacement symlinks and
  restores captured bytes through Core `LocalWorkspace` rather than direct
  filesystem writes. The audit remains whole-tree and does not observe writes
  outside the workspace.
- Runtime exposes MCP tools as normal tools. Stdio MCP servers without explicit
  `cwd` run from the adapter's neutral temporary cwd; host run metadata records
  configured MCP servers whose explicit `cwd` resolves inside the workspace so
  CLI summaries can disclose that static posture.
- Configured in-process delegate child writes are surfaced to parent-scoped CLI
  summaries by rolling up the child run's own `workspace.write.completed` events
  onto `subagent.completed`/`subagent.failed` (`workspaceWrites`), bridged in
  `spawnSubAgent` — not by a parent-side filesystem snapshot. This avoids
  time-window misattribution and double event families; it is sound because the
  delegate child catalog has no untracked writer (shell rolls back unmanaged
  mutations, no MCP in the child catalog).
- `TracedProcessRunner` is the host-owned process execution and observation
  boundary for external commands. It emits `extension.process.*` by default,
  exposes only constrained `SPARKWRIGHT_EVENT:` stderr token progress under
  `SPARKWRIGHT_PROCESS_PROTOCOL=stdio-v1`, strips token lines from all stderr
  output surfaces, and lets callers override progress routing (for example,
  task progress to `task.output`) without hard-coding business event families
  in the runner.
- `TracedProcessRunner.runJsonRpc()`, external command delegates, and Skill
  inline shell consume shell-sandbox's compiled launch/grant decisions. Host
  retains stdout/stderr protocols, timeout/kill, progress, artifacts, cleanup,
  and boundary-specific trace events; the sandbox package does not become a
  universal process runner.
- Configured workflow command hooks keep their `workflow_hook.*` lifecycle and
  use `TracedProcessRunner` internally for process spans, output summaries, and
  artifact materialization.
- External command delegates keep `subagent.*` as the parent-visible lifecycle
  and reuse `TracedProcessRunner` with `emitLifecycle: false` so process output,
  sandbox fallback, timeout, and artifact handling stay consistent without
  duplicating lifecycle rows. Their stderr token progress is collected into
  bounded `progressCount` / `progressDropped` / `progressHead` /
  `progressTail` summaries on the delegate tool result and
  `subagent.completed.payload.result`, not routed as `extension.process.*`.
  Read/write ACP and external command delegates emit
  `workspace.write.untracked_access_granted` when direct workspace access is
  granted; this is a boundary marker, not a managed write event.
  Parent-visible lifecycle metadata uses parent `agentId`, inherited
  `sessionId`, plus `childAgentId`/`agentProfileId` for the external profile
  identity so direct CLI JSON output and persisted trace attribution agree.
- ACP delegates use the same `workspaceAccess:none|read_write` sandbox/access
  compilation as external command delegates. `none` runs from a private
  writable execution cwd but forces a fail-closed sandbox that protects the
  workspace from writes: bind allowlisting owns the Linux boundary and explicit
  protected-root denies own the macOS boundary. `read_write` requires the parent
  run write gate and emits the untracked-access marker. ACP JSON-RPC, permission,
  timeout, and session shutdown stay in `acp-client-adapter`.
- Background shell tasks adopt the already-started shell stream through
  `TracedProcessRunner.observeStreaming`, keep `task.*` as the lifecycle, emit
  `task.created` before opening the task span with `task.started`, write full
  stdout/stderr to `TaskStore`, and mirror bounded progress/output into the run
  trace as `task.output` under the task span. The foreground shell tool returns
  the background `taskId` at the handoff point rather than waiting for the task
  to complete. Handoff is an untracked write-capable boundary rather than a
  per-file attribution point: background tasks emit
  `workspace.write.untracked_access_granted` with
  `protocol: "background_shell"`, `backgroundOrigin`, and sandbox status, and do not run the
  foreground shell's post-completion workspace snapshot rollback.
- Host protocol task inspection (`task.list`, `task.get`, `task.output`,
  `task.stop`) is implemented in `runtime.ts` over `TaskStore` and dispatched
  from `server.ts`. `task.list` is workspace-scoped unless the client supplies
  `parentRunId`; it is a snapshot/poll API for clients such as TUI Activity
  Drawer, does not create a streaming subscription, and does not make TUI task
  state canonical.
- The registered `agent` task kind snapshots per-run dynamic-spawn
  dependencies from `HostRuntime.prepareRun` and runs the same read-only
  dynamic child-agent path as `spawn_agent`, but passes the task controller's
  abort signal into `spawnSubAgent`. The task lifecycle owns cancellation and
  emits a compact `agent.completed` event chunk while the full child result
  remains the task result.
- Skill inline shell preprocessing is host-owned when enabled by
  `capabilities.skills.inlineShell.enabled`: runtime injects an
  `inlineShellRunner` into `prepareSkillsForRun`, the runner uses
  `TracedProcessRunner` with `kind: skill_script`, and pre-run process events
  are buffered until the real run event log is available.
- Markdown agent profile id collisions discovered during run preparation are
  emitted through the same pre-run buffer as
  `capability.index.failed` warnings (`severity: "warning"`,
  `kind: "agent_profile"`), then flushed into the real run event log and trace
  after the run starts.
- Host `update_skill` proposals are run-scoped idempotent for model-authored
  drafts: a repeated draft request for the same skill and run id returns the
  existing draft instead of writing a new proposal. The tool reports
  `changed:false` and `existing:true` for that repeat.

## Consumers

- `@sparkwright/sdk-node` clients.
- CLI host mode.
- TUI `RunController`.
- Future IDE, bot, and server clients.

## Change Checklist

- Check `packages/protocol/src/index.ts` for method payload/response changes.
- Check CLI and TUI clients for request/response assumptions.
- Check `capability.inspect` text output if capability snapshot fields change.
- Verify session diagnostics still read the right `trace.jsonl` path.

## Known Debts

- Host is a large composition point; changes can look local while affecting trace, sessions, and capabilities.
- Capability snapshot fields are useful but can become stale if new tools bypass `tool-catalog.ts`; direct-core/cron should add tools by catalog profile, not local factories.
- Agent lifecycle is assembled separately by in-process, dynamic/task,
  ACP, external-command, and direct CLI execution paths. Parent-visible phase
  transitions now share `AgentSupervisor`, but execution/cancellation handles
  remain adapter-native and need continued cross-entrypoint characterization.

## Last Verified

- Status: Verified
- Date: 2026-07-15T23:51:43+0800
- Scope: consolidated Profile admission, Workflow narrowing, required-schema
  promotion, and scoped discovery in `tool-surface.ts`; removed the parallel
  episode visibility model; selected Workflow `RunEnd` terminal ownership once
  at hook construction.
- Read: Host catalog/Profile/delegate/spawn assembly, fresh/resume/continuation
  episode construction, Workflow projection and Host finalization.
- Tests: Host focused tool-surface/Workflow 127/127 and typecheck; full release
  gate pending below.

- Status: Verified
- Date: 2026-07-15
- Scope: structural tool-decision audit and unified Host episode planning.
- Read: catalog construction, Profile resolution, Workflow actor paths,
  run/session resume, Todo supervision, capability inspect, trace output.
- Tests: Host full suite 597/597 plus real mini sessions
  `audit_todo`, `session_mrlmpwmud4y4ghev`,
  `session_workflow_f8250519447d491c929868a1e06ca410`, and TUI
  `session_tui_mrlmxc7z`; trace verify/session check passed.

- Status: Verified
- Date: 2026-07-15
- Scope: Todo-supervisor continuation episodes now promote an already-admitted
  deferred `todo_write` definition to `alwaysLoad`, matching the synthetic
  reconciliation directive without widening configured or Workflow-node tool
  scope. Fresh main episodes retain the normal deferred catalog.
- Read: `packages/host/src/runtime.ts`, todo supervisor/ledger, Host protocol
  continuation tests, and the real Sonnet continuation trace.
- Tests: Host continuation loading 2/2, focused resume protocol 1/1, Host
  typecheck, and real session `session_mrlkn469h2ylznbk` reconciled in one
  continuation with no extra workspace file or budget failure.

- Status: Verified
- Date: 2026-07-15T10:29:00+0800
- Scope: closed the Markdown Agent lazy model-ref failure at schema, semantic
  authoring, config loading, and layered discovery boundaries.
- Read: Host config/schema, Markdown Agent tooling/discovery/report paths, and
  focused tests.
- Tests: Host build; tools, Agent profile, and config suites 200/200 passed;
  real mini Agent create/delegate regression passed 2/2; full
  `npm run release:check` passed.

- Status: Verified
- Date: 2026-07-14
- Scope: isolated Host connection principals from handshake metadata, required
  authenticated IM self-binding, stabilized single-bearer reconnect identity,
  prohibited new self-bindings from selecting another session, froze handshake,
  and corrected Workflow API attribution.
- Read: Host connection/WS/stdio/main/server, IM control/service/runtime, tests,
  protocol/SDK/Gateway consumers.
- Tests: Host IM/WS/protocol/workflow/service focused suites 111/111; affected
  typechecks passed.

- Status: Verified
- Date: 2026-07-14T14:35:00+0800
- Scope: P6 split session query and compaction behavior out of `runtime.ts`,
  moved the workspace lease implementation to its canonical filename, and kept
  the old arbiter module as a state-free compatibility re-export.
- Read: Host runtime, session modules, workspace lease coordinator, production
  imports, and focused tests.
- Tests: Host 571/571; Host typecheck/build; project-map drift check.

- Status: Verified
- Date: 2026-07-14
- Scope: moved ordinary IM session execution, binding, approval routing,
  subscription retention, and bounded replay into HostService.
- Read: Host IM control, HostService/server/runtime integration, protocol/SDK,
  Gateway bridge/store/adapters, and focused tests.
- Tests: Host 571/571; server-runtime 29/29; protocol 8/8; SDK 12/12; IM
  Gateway 9/9; affected typecheck/build and schema checks.

- Status: Verified
- Date: 2026-07-14
- Scope: routed ordinary interactive execution through the process HostService
  and transport-neutral single-process execution lanes.
- Read: HostService/runtime/HostExecution, server-runtime execution lanes,
  protocol adapters, ACP/CLI callers, and focused tests.
- Tests: server-runtime 29/29; Host 563/563; ACP 15/15; CLI 37/37;
  agent-runtime 94/94; full `npm run release:check`.

- Status: Verified
- Date: 2026-07-14
- Scope: introduced process HostService/workspace contexts and migrated all
  production HostRuntime construction through the service.
- Read: Host stdio/WS server/main, ACP session/inspection, CLI Workflow/session/
  capability paths, Workflow service/supervisor adapters, manifests, and tests.
- Tests: Host service/protocol/WS 58/58 plus typecheck/build; ACP 15/15 plus
  typecheck; CLI focused 31/31 plus typecheck.

- Status: Verified
- Date: 2026-07-14
- Scope: extracted HostExecution, immutable execution planning, and live
  execution resource creation while retaining protocol compatibility.
- Read: Host start/resume/Workflow episode driver, approval/inject/cancel,
  resource cleanup, Core run, agent-runtime todo/Workflow drivers, and tests.
- Tests: Host full 562/562; agent-runtime Task/Workflow/control 107/107; Core
  run 129/129; Host typecheck/build.

- Status: Verified
- Date: 2026-07-14
- Scope: Host execution-coordinator P1 prerequisites: atomic inject rejection,
  immutable Agent Task context, and execution-wide assembly/episode abort.
- Read: Host runtime protocol/start/resume/inject/cancel/cleanup and task tool
  assembly plus Core and agent-runtime contracts.
- Tests: Host protocol/Agent-task/revival 57/57; Core run 129/129;
  agent-runtime Task/Workflow 94/94; affected typecheck and Host build.

- Status: Verified
- Date: 2026-07-14
- Scope: generalized child-only Agent admission into one Host process-local
  parent/child workspace mutation coordinator with reentrancy, run-chain
  fail-fast, auto-renewal, loss notification, and adapter termination.
- Read: runtime/catalog assembly, Agent admission, Shell/background transfer,
  ACP/external adapters, and traced process cleanup.
- Tests: focused suites 235/235; all workspaces/tests and release smokes passed.
  Touched files are format-clean; the global format scan is blocked only by
  pre-existing dirty proposal docs outside this change.

- Status: Verified
- Date: 2026-07-14
- Scope: wired process-local workspace Agent RW admission through configured,
  indexed, parallel, dynamic/task-owned, ACP, and external-command paths.
- Read: Host runtime assembly, process adapters, agent-runtime admission seam,
  workspace-write safety map, and active supervision design.
- Tests: Host arbiter/Agent/process focused suites 162/162; Host typecheck
  passed after rebuilding agent-runtime.

- Status: Verified
- Date: 2026-07-14
- Scope: migrated all production `subagent.*` emitters to `AgentSupervisor`,
  moved process `started` after admission, added terminal parity, and corrected
  indexed entrypoint attribution.
- Read: Host indexed/process adapters, traced process runner, agent-runtime
  supervisor, and lifecycle tests.
- Tests: Host Agent/process lifecycle 173/173 with files serialized; Host
  typecheck passed.

- Status: Verified
- Date: 2026-07-14
- Scope: migrated ACP/external-command lifecycle identity and governance facts
  onto `PreparedAgentInvocation`, removing two hand-built metadata copies while
  retaining adapter execution/event order.
- Read: ACP/external-command adapters, agent-runtime invocation projection, and
  cross-entrypoint lifecycle tests.
- Tests: Host Agent lifecycle suites 157/157 with test files serialized; Host
  typecheck passed after rebuilding agent-runtime.

- Status: Verified
- Date: 2026-07-14
- Scope: mechanically extracted the indexed `delegate_agent` router from the
  Host composition file without changing its target, policy, concurrency, or
  execution behavior.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/indexed-delegate-tool.ts`, and Host Agent tool tests.
- Tests: Host tools 100/100; Host typecheck passed after rebuilding
  agent-runtime.

- Status: Verified
- Date: 2026-07-14
- Scope: established normalized lifecycle characterization across configured
  direct/indexed/parallel delegates, dynamic/promoted Agent runs, background
  Agent tasks, ACP/external adapters, and direct CLI delegates.
- Read: Host Agent tools/adapters/task runner/direct delegate runner and
  parent-visible lifecycle events.
- Tests: Host lifecycle suites 157/157; agent-runtime Agent tests 38/38; direct
  CLI delegate 1/1; test typecheck passed.

- Status: Verified
- Date: 2026-07-14
- Scope: closed Agent argument-level concurrency gaps, removed fuzzy delegation
  reuse, and added collision-resistant ACP/external child run ids.
- Read: Host dynamic/configured/indexed delegate assembly, spawn grants, ACP and
  external-command adapters, plus Core/agent-runtime boundaries.
- Tests: Host Agent/tool focused suites 155/155; Core run 127/127;
  agent-runtime Agent tests 38/38; affected typechecks passed.

- Status: Verified
- Date: 2026-07-14
- Scope: enforced workspace-write protection for ACP/external delegates with
  `workspaceAccess:none`, including macOS deny-list compilation and unavailable
  runtime failure, while retaining private cwd scratch writes.
- Read: Host ACP/external delegate adapters and shell-sandbox source/tests.
- Tests: shell-sandbox plus Host ACP/external focused suites 40/40; Host
  typecheck passed.

- Status: Verified
- Date: 2026-07-13T22:42:00+0800
- Scope: extracted the fresh Host run-policy factory and reused it in runtime
  plus direct-core start/resume, removing duplicated/default-drifted policy
  assembly without moving mutable state into the security plan.
- Read: Host run policy/runtime/config, CLI direct-core start/resume, Core
  mutation policy, and focused tests.
- Tests: Host policy/security-plan/tools/protocol 155/155; CLI 152/152; Core
  environment/policy 35/35; shell-tool 42/42; affected typechecks/builds passed.

- Status: Verified
- Date: 2026-07-13T22:30:00+0800
- Scope: foreground Shell snapshots now detect symlink mutations and rollback
  reuses Core containment for binary restoration. Sandbox config/schema wording
  now distinguishes no-fallback enforcement from OS filesystem guarantees.
- Read: Host snapshot/shell/config schema, Core LocalWorkspace, shell-sandbox,
  generated config schema, and configuration guide.
- Tests: Host config/snapshot/tools 161/161; Host typecheck; schema check;
  shell-sandbox 14/14 and build; Core workspace/checkpoint 31/31 and build.

- Status: Verified
- Date: 2026-07-13T22:21:00+0800
- Scope: read-only run access now strengthens local extension, Workflow Script,
  and explicit run-bound command-hook process sandboxes without changing the
  configured main-Shell status reported by capability inspection.
- Read: Host security plan, runtime assembly, Workflow node API/hooks, MCP
  preparation boundary, and focused tests.
- Tests: Host typecheck; security-plan/workflow-hooks 78/78;
  protocol/tools/workflows 185/185; MCP adapter 34/34; CLI inspect 11/11.

- Status: Verified
- Date: 2026-07-13
- Scope: brought ACP child delegates under the configured sandbox launch path
  and added read-write untracked-access audit parity with external commands.
- Read: Host ACP/external delegate assembly, delegate runner, runtime, and ACP
  client worker.
- Tests: Host ACP/external/tool tests 122/122; ACP adapter 2/2; typechecks passed.

- Status: Verified
- Date: 2026-07-13
- Scope: moved OS-specific no-write/positive-root compilation and argv sandbox
  availability/fallback decisions out of Host adapters while retaining their
  distinct process lifecycles.
- Read: Host traced process runner, external command agent, Skill inline shell,
  and shell-sandbox source/tests.
- Tests: Host focused process suites 37/37 and Host typecheck passed.

- Status: Verified
- Date: 2026-07-13
- Scope: extracted the immutable Host run security plan shared by run
  preparation and capability inspection; removed CLI's snapshot-less effective
  tool/delegate/sandbox fallback.
- Read: `packages/host/src/runtime.ts`, `packages/host/src/run-access.ts`,
  `packages/host/src/run-security-plan.ts`, `packages/cli/src/cli.ts`, and
  focused Host/CLI tests.
- Tests: Host run-security/client/config/tools/protocol tests 222/222 passed;
  Host and CLI typechecks passed; Host build passed; CLI capability-inspect
  tests 13/13 passed.

- Status: Verified
- Date: 2026-07-12T23:35:00+0800
- Scope: model-facing Markdown Agent authoring now uses canonical public
  `name`, keeps runtime `id` internal, and omits inferred default fields.
- Read: `packages/host/src/tools.ts`, `packages/host/src/agent-profiles.ts`,
  focused Host tests, and routed project maps.
- Tests: `npm --workspace @sparkwright/host test -- test/tools.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`; focused Prettier and
  `git diff --check` passed.

- Status: Verified
- Date: 2026-07-12T20:00:00+0800
- Scope: reviewed Agent exact-file authoring validation, production asset stats
  scanning with run-scoped Workflow outcomes and durable layers,
  transactional Skill reconciliation/import, and suggestion state.
- Read: host tools, agent profiles, asset stats, Skill registry/review/suggestions.
- Tests: focused host suites and host typecheck passed.

- Status: Verified
- Date: 2026-07-12
- Scope: added rebuildable Agent/Workflow observation primitives, explicit Skill
  registry reconciliation, and advisory Skill evidence suggestions; none of
  these paths auto-create or apply a managed change.
- Read: `asset-stats.ts`, `skill-registry.ts`, `skill-suggestions.ts`,
  `skill-review-digest.ts`, `runtime.ts`, and CLI reconciliation routing.
- Tests: focused host/CLI tests, workspace check, regression matrix, source
  install smoke, and release install smoke passed.

- Status: Verified
- Date: 2026-07-12T17:28:16+0800
- Scope: Phase 5 routes normal `create_agent` authoring to a single project
  Markdown file with semantic summary, workspace-write approval, rediscovery,
  and package identity capture; config profiles stay explicit governance.
- Tests: focused host Agent tests and full `npm run release:check`.

- Status: Verified
- Date: 2026-07-12T16:47:44+0800
- Scope: Workflow content-addressed executable snapshots now publish atomically
  and concurrent pins reuse the same verified immutable package directory.
- Read: `packages/host/src/workflows.ts`, shared package-v2 snapshot substrate,
  and focused Workflow concurrency tests.
- Tests: Workflow focused host/CLI suites, test typecheck, and full
  `npm run release:check`.

- Status: Verified
- Date: 2026-07-12T16:36:08+0800
- Scope: Workflow instantiate now pins a v2 executable package snapshot and
  resume verifies its hash before using a snapshot-backed definition.
- Read: `packages/host/src/runtime.ts`, `packages/host/src/workflows.ts`, and
  Workflow host/CLI tests.
- Tests: Workflow focused host/CLI suites and full `npm run release:check`.

- Status: Verified
- Date: 2026-07-12T08:25:00+0800
- Scope: introduced the shared Skill command boundary and moved all ordinary
  create/apply adapters onto it.
- Read: `packages/host/src/skill-command-service.ts`, exports and consumers.
- Tests: host focused suites and host build/typecheck.

- Status: Verified
- Date: 2026-07-12T02:12:00+0800
- Scope: safe authored Skill prepared-change fast path and durable recovery
  metadata; no host protocol schema change.
- Read: `packages/host/src/tools.ts`,
  `packages/host/src/skill-evolution.ts`, `packages/host/src/index.ts`.
- Tests: host focused Skill suites (109 tests) and host typecheck.

- Status: Verified
- Date: 2026-07-11T15:30:00+0800
- Scope: Package G durable notification wait identity/generation projection,
  retirement of process-local delivery truth, and dispatch of already accepted
  binding-authorized commands.
- Read: `packages/host/src/runtime.ts`, `packages/host/src/server.ts`,
  `packages/host/test/workflows.test.ts`, `packages/host/test/protocol.test.ts`.
- Tests: Host workflow/protocol 83 focused tests plus typecheck/build.

- Status: Read-only
- Date: 2026-07-11T15:00:00+0800
- Scope: Package G design retires per-process workflow delivery dedupe as the
  only cursor and routes durable responses through binding-authorized Package D
  commands; ordinary foreground approval remains connection-owned.
- Read: `packages/host/src/runtime.ts`,
  `packages/agent-runtime/src/workflows/notifications.ts`,
  `packages/agent-runtime/src/workflows/control.ts`.
- Tests: not run; design-only source reconciliation.

- Status: Verified
- Date: 2026-07-11T14:30:00+0800
- Scope: Package F service-only fixed workflow identity start and claimed
  supervisor recovery reuse existing Host authorization/execution assembly;
  protocol clients cannot select the durable workflow id.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/test/workflows.test.ts`,
  `packages/cli/src/cli.ts`.
- Tests: Host workflow/protocol 82 tests plus typecheck/build.

- Status: Read-only
- Date: 2026-07-11T14:00:00+0800
- Scope: Package F design verified that connection-owned Host runtimes cancel
  active work on disconnect, so detached workflow execution must be owned by a
  durable service adapter rather than a disconnected protocol client.
- Read: `packages/host/src/server.ts`, `packages/host/src/runtime.ts`,
  `packages/host/src/main.ts`, `packages/cli/src/runners/host-runner.ts`.
- Tests: not run; design-only source reconciliation.

- Status: Verified
- Date: 2026-07-11T13:30:00+0800
- Scope: Package E claimed-writer Host adapter reuses the ordinary workflow
  resume environment and rejects writer/workflow identity mismatch without a
  second claim.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/test/workflows.test.ts`,
  `packages/server-runtime/src/workflow-supervisor.ts`.
- Tests: Host workflow/protocol focused tests, typecheck/build, and E release gate.

- Status: Read-only
- Date: 2026-07-11T13:10:00+0800
- Scope: Package E design keeps Host as claimed workflow episode assembler and
  preserves authorization/hooks/tool-policy boundaries; server-runtime does not
  gain direct WorkflowRunRecord mutation authority.
- Read: `packages/host/src/runtime.ts`,
  `packages/agent-runtime/src/workflows/store.ts`,
  `packages/server-runtime/src/index.ts`, and review section 8.14.
- Tests: not run; design-only source reconciliation.

- Status: Verified
- Date: 2026-07-11T13:00:00+0800
- Scope: Package D Host control adapter derives authenticated source/scope,
  dispatches typed durable commands, polls active workflow controls with the
  existing writer, and routes compatibility `workflow.resume` through the inbox.
- Read: `packages/host/src/runtime.ts`, `packages/host/src/server.ts`,
  `packages/host/test/workflows.test.ts`, `packages/host/test/protocol.test.ts`,
  `packages/agent-runtime/src/workflows/control-processor.ts`.
- Tests: Host workflow/protocol focused suites, typecheck/build, and full D
  release gate recorded in the workflow durable-jobs test map.

- Status: Verified
- Date: 2026-07-11T10:40:00+0800
- Scope: Package C migrates every Host live workflow writer—fresh create,
  resume input, episode registration/projection/usage, terminal/supervisor
  finalization, and rollback compensation—to `WorkflowLeaseBoundWriter`.
- Read: `packages/host/src/runtime.ts`, Host workflow/protocol tests, agent
  runtime workflow store and journal.
- Tests: Host workflow/protocol 79 tests; Host typecheck/build; CLI workflow
  slice 13 tests.

- Status: Verified
- Date: 2026-07-11T00:00:00+0800
- Scope: Package B workflow job identity response, control-session validation
  and durable attribution, and resume session preservation.
- Read: `packages/host/src/runtime.ts`, `packages/host/src/server.ts`,
  `packages/host/src/client-run.ts`, focused host tests.
- Tests: host client-run/workflow/protocol suites (91 tests), host typecheck and
  build; affected CLI/TUI integration tests.

- Status: Verified
- Date: 2026-07-11T02:10:00+0800
- Scope: P4/P5 closure: unified background policy remains effective across
  shell/task/spawn; premature nested child `task_create` opt-in and registry
  were removed so v1 lifecycle is flat.
- Read: `packages/host/src/runtime.ts`, `packages/host/src/config.ts`,
  `packages/host/src/config-zod-schema.ts`, `packages/host/test/config.test.ts`,
  `packages/host/test/spawn-agent.test.ts`.
- Tests: 86 full host config/spawn tests; focused P4 host gates; host typecheck
  and build; schema check.

- Status: Verified
- Date: 2026-07-11T01:04:00+0800
- Scope: workflow list authorization snapshots redact path values while resume
  continues to default omitted fields from the persisted workflow record.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/test/protocol.test.ts`, workflow resume tests.
- Tests: focused host protocol/workflow suites and host typecheck; full
  `npm run release:check` on the same source tree.

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
- Scope: host shell direct-background adoption sets explicit work detached,
  preserves promoted work as awaited, persists origin/lifetime, and performs
  same-run active task lookup before shell spawn.
- Read: `packages/host/src/shell.ts`, `packages/host/test/tools.test.ts`,
  `packages/shell-tool/src/tool.ts`.
- Tests: focused host shell suite and host typecheck.

- Status: Verified
- Date: 2026-07-09T21:52:00+0800
- Scope: Workflow Job Session post-QA fix: `workflow.resume` now preserves
  waiting records when run preparation fails, restores consumed wait snapshots
  on pre-run failure, and prefers workspace workflow records over matching
  legacy session-local copies.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/test/workflows.test.ts`,
  `packages/agent-runtime/src/workflows/store.ts`.
- Tests: `npm --workspace @sparkwright/host test -- test/workflows.test.ts -t
"waiting notifications|prepare a run|legacy session copies|terminal
workflow|unsafe workflow"`; `npm --workspace @sparkwright/host run
typecheck`.

- Status: Verified
- Date: 2026-07-09T21:22:00+0800
- Scope: Workflow Job Session Stage C persists resolved workflow
  `authorizationSnapshot` fields in `WorkflowRunRecord`, exposes them through
  `workflow.list`, and lets `workflow.resume` use the record snapshot as
  fallback defaults when payload fields are omitted. Existing terminal
  rejection and verify-on-resume semantics remain unchanged.
- Read: `packages/host/src/runtime.ts`,
  `packages/agent-runtime/src/workflows/types.ts`,
  `packages/agent-runtime/src/workflows/store.ts`,
  `packages/host/test/protocol.test.ts`,
  `packages/host/test/workflows.test.ts`.
- Tests: `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t
"workflow.list|durable workflow list"`; `npm --workspace @sparkwright/host
test -- test/workflows.test.ts -t "verifyOnResume|resumes workflow
records|pinned definition|terminal workflow"`; `npm --workspace
@sparkwright/host run typecheck`.

- Status: Verified
- Date: 2026-07-09T21:10:00+0800
- Scope: Workflow Job Session Stage A kept host workflow control semantics
  unchanged while projecting the latest durable workflow verdict into
  `workflow.list` snapshots for TUI read-only attach/status views.
- Read: `packages/host/src/runtime.ts`,
  `packages/protocol/src/index.ts`,
  `packages/host/test/protocol.test.ts`.
- Tests: `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t
"workflow.list|durable workflow list"`; `npm --workspace @sparkwright/host
run typecheck`.

- Status: Verified
- Date: 2026-07-08T23:46:48+0800
- Scope: post-review hardening for host access/grant plumbing: legacy
  `permissionMode:"dont_ask"` is clamped by `accessModeCeiling` for effective
  writes, legacy override diagnostics report only provided conflicting fields,
  dynamic spawn grant summaries/F2 guidance were corrected, unusable explicit
  write grants fail argument policy, and parent run-loop tests now cover
  `spawn_agent`/`task_create(kind:"agent")` gate timing plus bypass
  auto-approval.
- Read: `packages/host/src/run-access.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/src/agent-spawn-grants.ts`,
  `packages/host/test/run-access.test.ts`,
  `packages/host/test/spawn-agent.test.ts`,
  `packages/host/test/tools.test.ts`.
- Tests: `npm --workspace @sparkwright/host test --
test/run-access.test.ts`;
  `npm --workspace @sparkwright/host test -- test/spawn-agent.test.ts`;
  `npm --workspace @sparkwright/host test -- test/tools.test.ts`.

- Status: Verified
- Date: 2026-07-07T16:15:00+0800
- Scope: background `agent` task trace attribution; host now passes the
  controller `taskId` into the dynamic spawn tool for `agent_task` children.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/test/protocol.test.ts`,
  `packages/agent-runtime/src/index.ts`,
  `docs/_internal/project-map/modules/host.md`.
- Tests: `npm --workspace @sparkwright/host test --
test/protocol.test.ts -t "background agent through the real task_create"`;
  `npm --workspace @sparkwright/host test -- test/agent-task-runner.test.ts
test/spawn-agent.test.ts -t "agent task|task_create|background"`; `npm run
build --workspace @sparkwright/host`; `npm run check:dist-fresh`; real mini
  trace `session_mradiara7baut36j`.

- Status: Verified
- Date: 2026-07-07T15:21:23+0800
- Scope: host runtime hook assembly now includes the built-in partial
  sub-agent finality disclosure Stop hook; focused coverage verifies it
  advances once on omitted child-finality caveats, passes already-caveated final
  answers, and ignores ordinary truncated non-agent tool output.
- Read: `packages/host/src/workflow-hooks.ts`,
  `packages/host/src/runtime.ts`, `packages/host/src/index.ts`,
  `packages/host/test/workflow-hooks.test.ts`.
- Tests: `npm --workspace @sparkwright/host test --
test/workflow-hooks.test.ts`; `npm --workspace @sparkwright/host run
typecheck`.

- Status: Verified
- Date: 2026-07-07T14:43:43+0800
- Scope: host task revival notification hardening after real mini Agent +
  Skill QA: terminal task result summaries are now included in injected
  notification body text, complementing agent-runtime `task_create.nextAction`
  guidance.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/test/task-revival.test.ts`,
  `packages/agent-runtime/src/tasks/tools.ts`,
  `packages/agent-runtime/test/tasks.test.ts`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/modules/agent-runtime.md`,
  `docs/_internal/project-map/maps/capabilities/agents.md`.
- Tests: `npm --workspace @sparkwright/host test --
test/task-revival.test.ts`; `npm --workspace @sparkwright/host test --
test/task-revival.test.ts test/spawn-agent.test.ts`; `npm --workspace
@sparkwright/host run typecheck`; `npm run build --workspace
@sparkwright/host`; `npm --workspace @sparkwright/agent-runtime test --
test/tasks.test.ts`; `npm run check:dist-fresh`.

- Status: Verified
- Date: 2026-07-07T13:18:00+0800
- Scope: host-owned Skill mutation tool fix: `update_skill` now reuses the
  Skill body frontmatter normalization path used by `create_skill`, filling
  missing authored-body `description` while preserving the proposal-only
  boundary, run-scoped draft behavior, approval routing, and capability
  mutation reporting.
- Read: `packages/host/src/tools.ts`, `packages/host/test/tools.test.ts`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/modules/skills.md`,
  `docs/_internal/project-map/maps/capabilities/skill-evolution.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/tools.test.ts -t
"update_skill|create_skill|Skill"`; `npm --workspace @sparkwright/host
test -- test/tools.test.ts`; `npm --workspace @sparkwright/host run
typecheck`; `npm run build --workspace @sparkwright/host`; `npm run
check:dist-fresh`; `SPARKWRIGHT_REAL_MODEL=openai/gpt-5.4-mini
SPARKWRIGHT_KEEP_REAL_REGRESSION=1 npm run regression:real-skill-capabilities`.

- Status: Verified
- Date: 2026-07-07T00:55:52+0800
- Scope: workflow distill/shadow observation now filters failed or
  hook-blocked tool-call ids before deriving observed tools or `todo_write`
  evidence. Distill read-only drafts keep `read` as the baseline inspection
  tool and only add `grep`/`glob` when those tools were actually observed.
- Read: `packages/host/src/workflow-trace-observation.ts`,
  `packages/host/src/workflow-distill.ts`,
  `packages/host/src/workflow-shadow.ts`,
  `packages/host/test/workflow-distill.test.ts`,
  `packages/host/test/workflow-shadow.test.ts`,
  `packages/cli/src/cli.ts`.
- Tests: `npm --workspace @sparkwright/host test --
test/workflow-shadow.test.ts test/workflow-distill.test.ts`; `npm
--workspace @sparkwright/host run build`; real Sonnet trace
  `session_mr9fmua899dimnc2` replayed through `workflow shadow` and
  `workflow distill`, with blocked `glob` excluded.

- Status: Verified
- Date: 2026-07-06T23:31:01+0800
- Scope: workflow-runtime P4 regression fix: script/non-model drain into a
  narrowed model node now blocks parent-catalog tools against the actual active
  run registry, marks scoped workflow `tool_search`, refreshes workflow record
  episode metadata, and moves internal smoke assets out of builtin roots.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/host/src/workflow-trace-observation.ts`,
  `packages/host/test/workflows.test.ts`,
  `packages/host/test/workflow-distill.test.ts`,
  `packages/host/test/workflow-shadow.test.ts`,
  `packages/host/test/fixtures/workflows`,
  `packages/host/test/fixtures/skills`.
- Tests: `npm --workspace @sparkwright/host test --
test/workflows.test.ts test/workflow-distill.test.ts
test/workflow-shadow.test.ts`; `npm --workspace @sparkwright/host run
typecheck`.

- Status: Verified
- Date: 2026-07-06T21:18:25+0800
- Scope: C13-② post-acceptance fix: `prepareHostRunEnvironment()` now merges
  host-loaded `confidentialPaths`/`confidentialDefaults` with per-request
  protocol payloads before constructing start/resume/workflow-resume run
  policies, so TUI/ACP/SDK-style clients that omit those fields still honor
  workspace config.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/config-zod-schema.ts`,
  `packages/host/src/client-run.ts`,
  `packages/host/test/protocol.test.ts`,
  `packages/host/test/client-run.test.ts`,
  `docs/reference/HOST_PROTOCOL_CHANGELOG.md`,
  `docs/guides/CONFIGURATION.md`.
- Tests: `npm --workspace @sparkwright/host test --
test/client-run.test.ts`; `npm --workspace @sparkwright/host test --
test/protocol.test.ts -t "confidential"`; `npm run schema:generate`.

- Status: Verified
- Date: 2026-07-06T20:47:10+0800
- Scope: C13-② host config/protocol plumbing for read-confidentiality defaults:
  config accepts `confidentialDefaults`, host clients only serialize false as
  an explicit override, and runtime policies use core's resolver for
  start/resume/workflow-resume.
- Read: `packages/host/src/config.ts`,
  `packages/host/src/config-zod-schema.ts`,
  `packages/host/src/client-run.ts`, `packages/host/src/server.ts`,
  `packages/host/src/runtime.ts`, `packages/host/test/config.test.ts`,
  `packages/host/test/client-run.test.ts`.
- Tests: `npm --workspace @sparkwright/host test -- test/config.test.ts
test/client-run.test.ts`; `npm --workspace @sparkwright/host run build`.

- Status: Verified
- Date: 2026-07-06T19:48:49+0800
- Scope: C10 capability inspection: host runtime snapshots now report all
  resolved inline/file agent profiles in `agents.profiles`, while
  `agents.delegateTools` remains the separate callability/delegation descriptor
  list. The ACP `--session-root` path was checked in source and already existed.
- Read: `packages/host/src/runtime.ts`, `packages/host/test/protocol.test.ts`,
  `packages/acp-adapter/src/main.ts`, `packages/acp-adapter/src/session.ts`,
  `packages/acp-adapter/src/agent.ts`.
- Tests: `npm --workspace @sparkwright/host test --
test/protocol.test.ts -t "capability inspect|capability inspection"`;
  `npm --workspace @sparkwright/host run build`.

- Status: Read-only
- Date: 2026-07-06T19:24:51+0800
- Scope: C9 S1 cron persistence migration changed `CronStore.save()` to use
  the shared atomic writer. Host capability preparation, cron tool catalog
  exposure, session roots, and protocol payloads are unchanged.
- Read: `packages/cron/src/store.ts`,
  `docs/_internal/project-map/maps/capabilities/cron.md`,
  `docs/_internal/project-map/modules/host.md`.
- Tests: cron storage/schedule-focused `npm --workspace @sparkwright/cron test
-- test/schedule.test.ts`; host-specific tests not rerun for this persistence
  implementation-only change.

- Status: Verified
- Date: 2026-07-05T23:08:34+0800
- Scope: P10a D20 host hook assembly: configured result-producing `PreToolUse`
  actions run in the rewrite pass, configured static block/context actions and
  the workflow projection clamp run in governance, and active-workflow
  configured rewrites are no longer rejected before core staging.
- Read: `packages/host/src/workflow-hooks.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `packages/core/src/run.ts`, `packages/core/src/workflow-hooks.ts`,
  `docs/reference/EXTENSION_INTERFACES.md`,
  `docs/guides/CONFIGURATION.md`.
- Tests: `npm --workspace @sparkwright/core test --
test/workflow-hooks.test.ts -t "PreToolUse|workflowHooks"`; `npm
--workspace @sparkwright/core run typecheck`; `npm --workspace
@sparkwright/core run build`; `npm --workspace @sparkwright/host test --
test/workflow-hooks.test.ts -t "PreToolUse|blocks tools outside|configured
PreToolUse"`; `npm --workspace @sparkwright/host run typecheck`.

- Status: Verified
- Date: 2026-07-05T22:37:13+0800
- Scope: workflow-runtime-v1 P9a host boundary: fresh workflow runs now persist
  in workspace-level `.sparkwright/workflow-runs`, while list/resume continue to
  read legacy session-root stores. Resume carries the located store through the
  actor episode path; protocol/TUI payloads, notification outbox location,
  session trace/todo paths, and workflow_start remain unchanged.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/workspace-snapshot.ts`,
  `packages/host/test/workflows.test.ts`,
  `packages/host/test/tools.test.ts`,
  `packages/host/test/protocol.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/workflows.test.ts -t
"workflow"`; `npm --workspace @sparkwright/host test -- test/tools.test.ts -t
"runtime control-plane files"`; `npm --workspace @sparkwright/host test --
test/protocol.test.ts -t "workflow"`; `npm --workspace @sparkwright/host run
typecheck`.

- Status: Verified
- Date: 2026-07-05T22:20:59+0800
- Scope: workflow-runtime-v1 P8a host boundary: offline `workflow-shadow.ts`
  reads workflow assets and session traces, reuses
  `workflow-trace-observation.ts`, and emits coverage reports without starting
  runs, writing workflow state, mutating traces, or adding protocol/TUI/live
  hook behavior.
- Read: `packages/host/src/workflow-shadow.ts`,
  `packages/host/src/workflow-trace-observation.ts`,
  `packages/host/src/workflow-distill.ts`,
  `packages/host/src/index.ts`,
  `packages/host/test/workflow-shadow.test.ts`,
  `packages/host/test/workflow-distill.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test --
test/workflow-shadow.test.ts test/workflow-distill.test.ts`; `npm
--workspace @sparkwright/host run typecheck`; `npm --workspace
@sparkwright/host run build`.

- Status: Verified
- Date: 2026-07-05T22:04:23+0800
- Scope: workflow-runtime-v1 P7a host boundary: deterministic
  `workflow-distill.ts` reads session traces and renders review-first workflow
  markdown/JSON reports without writing assets, adding model-backed
  distillation, mutating traces, or changing runtime/protocol behavior.
- Read: `packages/host/src/workflow-distill.ts`,
  `packages/host/src/index.ts`,
  `packages/host/test/workflow-distill.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test --
test/workflow-distill.test.ts`; `npm --workspace @sparkwright/host run
typecheck`.

- Status: Verified
- Date: 2026-07-05T21:51:25+0800
- Scope: workflow-runtime-v1 P6b host boundary: `todo_clear` parser,
  projection evaluation, session todo provider wiring, pass/fail metadata, and
  missing-provider fail-closed behavior are host-owned. No workflow_start,
  FactLedger todo state, global invariant, or todo supervisor replacement was
  added.
- Read: `packages/host/src/workflows.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/test/workflows.test.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/workflows.test.ts -t
"todo_clear|P3 non-model nodes"`; `npm --workspace @sparkwright/host test --
test/workflow-hooks.test.ts -t "todo_clear|diff_scope"`; `npm --workspace
@sparkwright/host run typecheck`.

- Status: Verified
- Date: 2026-07-05T20:18:29+0800
- Scope: workflow-runtime-v1 P5 post-review hardening: host projection now
  requires explicit `parallel.onPass`, rejects pass edges into branch nodes,
  rejects branch-local `verify`, maps delegate_parallel infrastructure throws to
  branch `runtime_error`, and preserves branch diagnostics on runtime terminal
  failures. No workflow_start, scheduler, branch bus, or protocol surface was
  added.
- Read: `packages/host/src/workflow-projection.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`,
  `docs/_internal/proposals/workflow-runtime-p3-execution.md`.
- Tests: `npm --workspace @sparkwright/host test --
test/workflow-hooks.test.ts -t "parallel|join|delegate_parallel|branch
diagnostics"`; `npm --workspace @sparkwright/host test --
test/workflows.test.ts test/workflow-hooks.test.ts`.

- Status: Verified
- Date: 2026-07-05T18:02:15+0800
- Scope: workflow-runtime-v1 P5 host boundary: parser/projection/runtime now
  own bounded non-model branch fan-out, persisted branch state, join barriers,
  branch runtime-error fail-closed behavior, and `delegate_parallel` reuse
  without adding workflow_start or a second scheduler.
- Read: `packages/host/src/workflows.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/test/workflows.test.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/workflow-hooks.test.ts
-t "parallel|join|delegate_parallel"`; `npm --workspace @sparkwright/host
test -- test/workflows.test.ts test/workflow-hooks.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`.

- Status: Verified
- Date: 2026-07-05T15:31:20+0800
- Scope: workflow-runtime-v1 P4 host boundary: script node parsing,
  asset-local path pinning, stdio JSON-RPC execution, host node API method
  routing, shell-sandbox reuse, read-only write-capability fail-closed behavior,
  and shared process progress sampling are host-owned.
- Read: `packages/host/src/workflows.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/host/src/workflow-node-api.ts`,
  `packages/host/src/traced-process-runner.ts`,
  `packages/host/src/external-command-agent.ts`,
  `packages/host/test/workflows.test.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `packages/host/test/traced-process-runner.test.ts`.
- Tests: `npm --workspace @sparkwright/host test --
test/workflows.test.ts test/workflow-hooks.test.ts
test/traced-process-runner.test.ts test/external-command-agent.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`; `npm run
release:check`.

- Status: Verified
- Date: 2026-07-05T13:59:13+0800
- Scope: P3 review follow-up for Step 4b.1: worker-entry catalog narrowing now
  preserves deferred-tool loading by adding scoped `tool_search` only when the
  filtered catalog contains deferred tools, and only over that filtered catalog;
  the PreToolUse fallback now uses canonical tool-name comparison for legacy
  declarations.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/host/test/workflows.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host run typecheck`; `npm --workspace
@sparkwright/host test -- test/workflows.test.ts -t "narrows model worker
catalogs|keeps scoped tool_search"`; `npm --workspace @sparkwright/host test
-- test/workflow-hooks.test.ts -t "blocks tools outside|PreToolUse"`.

- Status: Verified
- Date: 2026-07-05T12:23:15+0800
- Scope: workflow-runtime-v1 P3 Step 4b.3 D11 decision: no model-facing
  `workflow_start` tool ships in P3; host keeps workflow instantiation on
  request/CLI surfaces and leaves model worker catalogs without that tool.
- Read: `packages/host/src/runtime.ts`, `packages/host/src/tool-catalog.ts`,
  `packages/host/src/tool-identities.ts`, `packages/host/src/tools.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`,
  `docs/_internal/proposals/workflow-runtime-p3-execution.md`.
- Tests: `rg -n "workflow_start" packages/host/src packages/host/test
packages/cli/test packages/protocol/src docs/reference`; `npm run
release:check`.

- Status: Verified
- Date: 2026-07-05T12:15:55+0800
- Scope: workflow-runtime-v1 P3 Step 4b.2 D6 worker-entry model/budget facts:
  active workflow model nodes can set `model` and `runBudget`; host resolves
  the node model adapter, applies the per-attempt budget to the worker episode,
  and records episode/usage metadata without claiming full retry escalation.
- Read: `packages/host/src/runtime.ts`, `packages/host/src/workflows.ts`,
  `packages/host/test/workflows.test.ts`,
  `packages/host/test/protocol.test.ts`,
  `packages/cli/test/cli.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host run typecheck`; `npm --workspace
@sparkwright/host test -- test/workflows.test.ts -t "node model and
budget|parses workflow folder|narrows model worker catalogs"`; `npm
--workspace @sparkwright/host test -- test/protocol.test.ts -t
"workflow|budget|model"`; `npm --workspace @sparkwright/cli test --
test/cli.test.ts -t "workflow projection acceptance ladder|resumes workflow
runs through the host actor episode driver|run resume through the host"`;
  `npm run schema:check`.

- Status: Verified
- Date: 2026-07-05T11:49:40+0800
- Scope: workflow-runtime-v1 P3 Step 4b.1 worker catalog narrowing: active
  model-node `tools` lists now physically filter the worker episode catalog at
  `createRun()` time while preserving PreToolUse clamp fallback behavior.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/host/test/workflows.test.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host run typecheck`; `npm --workspace
@sparkwright/host test -- test/workflows.test.ts -t "narrows model worker
catalogs|workflow"`; `npm --workspace @sparkwright/host test --
test/workflow-hooks.test.ts -t "blocks tools outside|PreToolUse"`.

- Status: Verified
- Date: 2026-07-05T11:36:37+0800
- Scope: workflow-runtime-v1 P3 Step 4a deletion landing: host runtime retired
  `startSupervisedRunChain()` and routes fresh run, run resume, and workflow
  resume through `startWorkflowActorEpisodeChain()`. Workflow records now expose
  `metadata.episodeDriver:"workflow_actor"` / `episodeKind`, and waiting input
  consumption occurs at the actor boundary before the next worker episode.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/test/workflows.test.ts`,
  `packages/host/test/protocol.test.ts`,
  `packages/cli/test/cli.test.ts`,
  `packages/agent-runtime/src/todo/supervisor.ts`,
  `packages/agent-runtime/src/workflows/run-chain.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`,
  `docs/_internal/proposals/workflow-runtime-p3-execution.md`.
- Tests: `npm --workspace @sparkwright/host run typecheck`; `npm --workspace
@sparkwright/host test -- test/workflows.test.ts`; `npm --workspace
@sparkwright/host test -- test/protocol.test.ts -t "resumes a
session-scoped checkpoint|fails orphaned in-process awaited tasks|legacy run
directory|workflow"`; `npm --workspace @sparkwright/cli test --
test/cli.test.ts -t "workflow|run resume through the host"`;
  `npm --workspace @sparkwright/agent-runtime test -- test/workflows.test.ts
test/todo.test.ts -t "runTodoSupervised|workflow run-chain"`.

- Status: Verified
- Date: 2026-07-05T11:21:09+0800
- Scope: workflow-runtime-v1 P3 Step 3 host waiting/human boundary:
  workflow assets parse `human` nodes, projection emits durable waiting
  snapshots and `workflow.waiting`, runtime uses a file-backed workflow actor
  outbox, `workflow.list` exposes waiting records, and `workflow.resume`
  records/consumes input waits before continuing from the next node.
- Read: `packages/host/src/workflows.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/test/workflows.test.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `packages/host/test/protocol.test.ts`,
  `packages/agent-runtime/src/workflows/notifications.ts`,
  `docs/reference/HOST_PROTOCOL.md`,
  `docs/reference/PROTOCOL.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/workflows.test.ts`;
  `npm --workspace @sparkwright/host test -- test/workflow-hooks.test.ts`;
  `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t
"workflow|waiting|resume|list"`; `npm --workspace @sparkwright/host run
typecheck`; `npm run schema:check`.

- Status: Verified
- Date: 2026-07-05T10:39:09+0800
- Scope: workflow-runtime-v1 P3 Step 2 host projection/parser boundary:
  workflow assets parse `command` / `delegate` / `task` node runners and
  `diff_scope` verifiers; selected workflow projections drain non-model nodes
  through host governed primitives until the next model boundary; runtime
  injects the main `task_create` tool for task nodes; actor-owned terminal
  episode handling remains out of this supervised slice.
- Read: `packages/host/src/workflows.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/test/workflows.test.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`,
  `docs/_internal/proposals/workflow-runtime-p3-execution.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/workflows.test.ts`;
  `npm --workspace @sparkwright/host test -- test/workflow-hooks.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`; `npm run schema:check`.

- Status: Verified
- Date: 2026-07-05T10:13:38+0800
- Scope: workflow-runtime-v1 P3 Step 1: host supervisor/run-chain behavior
  remains at `startSupervisedRunChain()` for active-run/session/lease/event
  glue, while the todo-continuation loop now delegates through
  `runTodoSupervised()` to the workflow-owned `runWorkflowRunChain()` driver.
  Fresh workflow runs, workflow resume, run resume, and todo continuation
  behavior were verified unchanged.
- Read: `packages/host/src/runtime.ts`,
  `packages/agent-runtime/src/todo/supervisor.ts`,
  `packages/agent-runtime/src/workflows/run-chain.ts`,
  `packages/host/test/workflows.test.ts`,
  `packages/host/test/protocol.test.ts`,
  `packages/host/test/workflow-hooks.test.ts`.
- Tests: `npm --workspace @sparkwright/host test -- test/workflows.test.ts`;
  `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t
"workflow|resume.*todo|unfinished todos|run.resume"`; `npm --workspace
@sparkwright/host test -- test/workflow-hooks.test.ts -t "workflow
projection|resume"`; `npm --workspace @sparkwright/host run typecheck`.

- Status: Verified
- Date: 2026-07-05T09:01:34+0800
- Scope: P2 post-review closure: fresh `run --workflow` now acquires the
  single-writer lease before record creation, workflow terminal finalization
  runs after the todo-supervised chain completes and supervisor rejects now
  fail the workflow record before releasing the lease, terminal records cannot
  be downgraded by later projection snapshots, completed/failed workflow actor
  notifications are drainable through the actor inbox, and resume
  re-verification only targets verifier nodes whose latest verdict passed.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/host/test/workflows.test.ts`,
  `packages/host/test/workflow-hooks.test.ts`.
- Tests: `npm --workspace @sparkwright/host test --
test/workflows.test.ts -t "workflow"`; `npm --workspace @sparkwright/host
test -- test/workflow-hooks.test.ts -t "resume|workflow
projection|projection"`; `npm --workspace @sparkwright/host run typecheck`;
  `npm run typecheck:test`.

- Status: Verified
- Date: 2026-07-05T00:42:02+0800
- Scope: workflow-runtime-v1 P2 host runtime: durable workflow records under
  session-root `workflow-runs/`, pinned definition resume, single-writer lease
  refresh/release, projection snapshot persistence, resume re-verification,
  workflow terminal actor notifications, and host protocol dispatch for
  `workflow.list` / `workflow.resume`.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/host/src/server.ts`,
  `packages/host/src/client-run.ts`,
  `packages/host/test/workflows.test.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `packages/host/test/protocol.test.ts`.
- Tests: `npm --workspace @sparkwright/host test --
test/workflows.test.ts test/workflow-hooks.test.ts -t "workflow"`;
  `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t
"workflow|task list|unexpected fields"`; `npm --workspace
@sparkwright/host run typecheck`; `npm --workspace @sparkwright/host run
build`.

- Status: Verified
- Date: 2026-07-04T22:20:04+0800
- Scope: workflow-runtime-v1 D25 host repair: verification profiles and
  documented-command checks now run as host-owned invariant projections,
  suggest mode is guidance-only, require mode is epoch-fresh with bounded
  retry evidence, `workflowActive` is limited to explicit workflow projections,
  in-process delegate children compile only profile-authored hooks, active-rule
  descriptors use invariant wording, and `afterWrites.frequency` is removed
  from strict config/schema.
- Read: `packages/host/src/invariant-projection.ts`,
  `packages/host/src/verification.ts`,
  `packages/host/src/documented-command-check.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/src/active-rules.ts`,
  `packages/host/src/config.ts`,
  `packages/host/src/config-zod-schema.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `packages/host/test/documented-command-check.test.ts`,
  `packages/host/test/config.test.ts`,
  `packages/host/test/tools.test.ts`,
  `packages/host/test/protocol.test.ts`.
- Tests: `npm --workspace @sparkwright/host test --
test/workflow-hooks.test.ts test/documented-command-check.test.ts
test/config.test.ts test/tools.test.ts test/protocol.test.ts -t
"createInvariantProjectionHooks|createVerificationWorkflowHooks|documented
command check|verification profiles|afterWrites frequency|runtime workflow
hook assembly|global verifier hooks|resolves profile workflow
hooks|workflow rules|configured verification"`; `npm --workspace
@sparkwright/host test -- test/protocol.test.ts -t "includes active workflow
rule descriptors"`; `npm --workspace @sparkwright/host run build`;
  `npm run check`; `npm run release:check`.

- Status: Verified
- Date: 2026-07-04T18:16:44+0800
- Scope: P1.5 closure after read-only review: host config/schema no longer
  accepts `capabilities.verification.stopGate`; documented-command retains only
  the rule matcher/checker used by the projection verifier; in-process delegate
  children now have focused coverage proving implicit verification and
  documented-command hooks compile through projection.
- Read: `packages/host/src/config.ts`,
  `packages/host/src/config-zod-schema.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/src/documented-command-check.ts`,
  `packages/host/src/index.ts`,
  `packages/host/test/config.test.ts`,
  `packages/host/test/protocol.test.ts`,
  `packages/host/test/tools.test.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `schemas/config.schema.json`,
  `docs/reference/PROTOCOL_CHANGELOG.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/config.test.ts -t
"verification profiles|invalid verification profile references"`; `npm
--workspace @sparkwright/host test -- test/documented-command-check.test.ts`;
  `npm --workspace @sparkwright/host test -- test/workflow-hooks.test.ts
test/documented-command-check.test.ts test/tools.test.ts test/config.test.ts
test/protocol.test.ts -t
"workflow|verification|documented-command|documented command|implicit verifier
hooks|profile workflow hooks|delegate_parallel child runs|resolves profile
workflow hooks|verification profiles|invalid verification profile
references"`; `npm run typecheck:test`; `npm run schema:check`.

- Status: Verified
- Date: 2026-07-04T16:47:47+0800
- Scope: workflow-runtime-v1 P1.5 host deletion payoff: workflow runtime gate
  removed, verification profiles and documented-command checks compile through
  projection, delegate child `workflowHooksForProfile` uses the same assembly,
  and active-rule descriptors reflect projection-backed verification rather than
  old gate names.
- Read: `packages/host/src/workflows.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/src/verification.ts`,
  `packages/host/src/documented-command-check.ts`,
  `packages/host/src/active-rules.ts`,
  `packages/host/src/index.ts`,
  `packages/host/test/workflows.test.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `packages/host/test/documented-command-check.test.ts`,
  `packages/host/test/protocol.test.ts`,
  `packages/host/test/tools.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test --
test/workflow-hooks.test.ts test/documented-command-check.test.ts
test/workflows.test.ts test/protocol.test.ts -t
"workflow|verification|documented-command|documented command"`;
  `npm --workspace @sparkwright/host test -- test/tools.test.ts -t
"profile workflow hooks|delegate_parallel child runs|resolves profile
workflow hooks"`; `npm --workspace @sparkwright/host run typecheck`;
  `npm run build --workspace @sparkwright/host`.

- Status: Verified
- Date: 2026-07-04T12:43:33+0800
- Scope: workflow-runtime-v1 S3 host event-trigger boundary:
  `run.budget.exceeded` was added to configured non-blocking event-hook
  trigger validation while workflow hook execution and verification hook
  assembly remain unchanged.
- Read: `packages/host/src/config-zod-schema.ts`,
  `packages/host/src/workflow-hooks.ts`,
  `packages/core/src/user-hooks.ts`,
  `schemas/config.schema.json`.
- Tests: `npm --workspace @sparkwright/host run typecheck`.

- Status: Verified
- Date: 2026-07-04T09:30:36+0800
- Scope: workflow-runtime-v1 S2 host consumer boundary: verification Stop gate
  now reads core FactLedger snapshots while verification hook assembly and the
  legacy `verification:` hookName protocol remain host-owned.
- Read: `packages/host/src/verification.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `packages/core/src/workflow-hooks.ts`,
  `packages/core/src/fact-ledger.ts`.
- Tests: `npm --workspace @sparkwright/host test --
test/workflow-hooks.test.ts`; `npm --workspace @sparkwright/host run
typecheck`.

- Status: Verified
- Date: 2026-07-04T08:12:53+0800
- Scope: workflow-runtime-v1 P0 host ownership: workflow folder asset parsing
  and inspection, capability snapshot summaries, CLI report plumbing, runtime
  workflow-hook assembly order guard, and Agent.md frontmatter migration onto
  the shared markdown-folder-asset primitive. No workflow runtime projection or
  run-loop behavior was added.
- Read: `packages/host/src/workflows.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/src/agent-profiles.ts`,
  `packages/host/test/workflows.test.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `packages/skills/src/markdown-folder-asset.ts`.
- Tests: `npm --workspace @sparkwright/host test --
test/workflows.test.ts test/workflow-hooks.test.ts -t
"workflow assets|runtime workflow hook assembly|pins configured advance"`;
  `npm --workspace @sparkwright/host run typecheck`.

- Status: Verified
- Date: 2026-07-04T00:29:16+0800
- Scope: tightened the model-facing `task_create(kind:"agent")` payload
  guidance for `maxSteps` after real mini underallocated a background child to
  one step. Runtime semantics did not change; host now shares the same
  read/search budget guidance between main and nested background agent task
  schemas.
- Read: `packages/host/src/tool-catalog.ts`,
  `packages/host/src/runtime.ts`, `packages/host/test/tools.test.ts`,
  `docs/_internal/test-map/runs/2026-07-03-real-mini-skill-background-agent-maxsteps.md`,
  `docs/_internal/test-map/failures/task-create-agent-maxsteps-underallocation.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/tools.test.ts -t
"main host tool catalog"`; `npm --workspace @sparkwright/host test --
test/spawn-agent.test.ts test/task-revival.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm run build --workspace @sparkwright/host`.

- Status: Verified
- Date: 2026-07-03T09:33:55+0800
- Scope: configured workflow hook action results now accept core
  `WorkflowHookResult.status: "advance"` from command `stdoutJson`, HTTP
  `responseJson`, or agent `workflowResult` paths, while host effect
  enforcement restricts advance to `ModelOutput` / `Stop`.
- Read: `packages/host/src/workflow-hooks.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `packages/core/src/workflow-hooks.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test --
test/workflow-hooks.test.ts -t "stdout JSON|workflow hook"`;
  `npm --workspace @sparkwright/host run typecheck`; `npm run build
--workspace @sparkwright/host`; `npm run check:dist-fresh`.

- Status: Verified
- Date: 2026-07-02T16:47:56+0800
- Scope: checked that the main host catalog preserves deferred `task` action
  schema constraints and that background-agent task runner/protocol slices still
  pass after the task monitor validation fix.
- Read: `packages/host/src/tool-catalog.ts`,
  `packages/host/test/tools.test.ts`,
  `packages/host/test/agent-task-runner.test.ts`,
  `packages/host/test/protocol.test.ts`,
  `packages/host/test/spawn-agent.test.ts`,
  `packages/agent-runtime/src/tasks/tools.ts`.
- Tests: `npm --workspace @sparkwright/host test -- test/tools.test.ts -t
"main host tool catalog"`; `npm --workspace @sparkwright/host test --
test/agent-task-runner.test.ts test/protocol.test.ts -t "background
agent|starts a background agent through the real task_create tool"`;
  `npm --workspace @sparkwright/host test -- test/spawn-agent.test.ts -t
"background|nested|promotes"`.

- Status: Verified
- Date: 2026-07-02T10:05:00+0800
- Scope: added host-facing `task.join`/`task.promote` controls and wired manual
  promote to the foreground task wait signal.
- Read: `packages/host/src/runtime.ts`, `packages/host/src/server.ts`,
  `packages/host/test/protocol.test.ts`,
  `docs/_internal/proposals/background-task-lifecycle.md`.
- Tests: `npm --workspace @sparkwright/host test --
test/protocol.test.ts -t "serves durable task list|get|output requests"`;
  `npm --workspace @sparkwright/host run typecheck`.

- Status: Verified
- Date: 2026-07-02T10:05:00+0800
- Scope: host task revival now uses a durable notification outbox and
  resume-time orphan fail-fast for pending/running in-process task records.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/test/protocol.test.ts`,
  `docs/_internal/proposals/background-task-lifecycle.md`.
- Tests: `npm --workspace @sparkwright/host test --
test/protocol.test.ts -t "fails orphaned in-process awaited tasks"`;
  `npm --workspace @sparkwright/host run typecheck`.

- Status: Verified
- Date: 2026-07-02T09:30:00+0800
- Scope: patched host task notification bridge so detached terminal task
  notifications are surfaced through the canonical notification source while
  `awaited` remains the keep-alive/revival predicate; refreshed focused
  spawn-agent bridge coverage.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/test/task-revival.test.ts`,
  `packages/host/test/spawn-agent.test.ts`,
  `docs/_internal/proposals/background-task-lifecycle.md`.
- Tests: `npm --workspace @sparkwright/host test --
test/task-revival.test.ts`; `npm --workspace @sparkwright/host test --
test/spawn-agent.test.ts -t "promotes slow dynamic|allows opt-in
depth-bounded|foreground-only background policy|bounded by maxDepth"`;
  `npm --workspace @sparkwright/host run typecheck`.

- Status: Verified
- Date: 2026-07-02T01:15:00+0800
- Scope: host now bridges task notifications into core revival, applies
  `backgroundTasks` governance to task/shell/spawn promotion, exposes awaited
  task snapshots, promotes slow dynamic `spawn_agent` children with preserved
  projection/ledger/cancellation, and supports opt-in depth-bounded nested
  background agent task creation.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/tool-catalog.ts`,
  `packages/host/src/shell.ts`,
  `packages/host/src/run-access.ts`,
  `packages/host/src/config.ts`,
  `packages/host/src/config-zod-schema.ts`,
  `packages/host/src/client-run.ts`,
  `packages/host/src/server.ts`,
  `packages/host/test/spawn-agent.test.ts`,
  `packages/host/test/run-access.test.ts`,
  `packages/host/test/config.test.ts`,
  `packages/host/test/protocol.test.ts`.
- Tests: `npm --workspace @sparkwright/host test --
test/spawn-agent.test.ts test/run-access.test.ts test/config.test.ts -t
"promotes slow dynamic|task cancellation stops|foreground-only background policy|depth-bounded sub-agents|bounded by maxDepth|backgroundTasks|background task policy|accessMode"`;
  `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t
"task|background agent|capability inspection|accessMode|backgroundTasks|spawn_agent"`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm run build --workspace @sparkwright/host`.

- Status: Verified
- Date: 2026-07-01T13:08:00+0800
- Scope: host main catalog `task_create(kind:"agent")` schema exposure for
  real-model background-agent task creation, plus downstream task runner
  execution coverage.
- Read: `packages/host/src/tool-catalog.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/test/tools.test.ts`,
  `packages/host/test/protocol.test.ts`,
  `packages/host/test/agent-task-runner.test.ts`,
  `packages/agent-runtime/src/tasks/tools.ts`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/modules/agent-runtime.md`,
  `docs/_internal/project-map/maps/capabilities/agents.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/tools.test.ts -t
"main host tool catalog"`; `npm --workspace @sparkwright/host test --
test/protocol.test.ts -t "starts a background agent through the real
task_create tool"`; `npm --workspace @sparkwright/host test --
test/agent-task-runner.test.ts`; `npm --workspace @sparkwright/host run
typecheck`; `npm run build --workspace @sparkwright/host`;
  `npm run check:dist-fresh`.

- Status: Verified
- Date: 2026-07-01T11:56:08+0800
- Scope: checked shared host background `agent` task runner helper, task-owned
  abort wiring, and literal path handling for host read.
- Read: `packages/host/src/runtime.ts`, `packages/host/src/tools.ts`,
  `packages/host/test/agent-task-runner.test.ts`,
  `packages/host/test/tools.test.ts`,
  `docs/_internal/project-map/modules/host.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/agent-task-runner.test.ts`;
  `npm --workspace @sparkwright/host test -- test/tools.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`.

- Status: Verified
- Date: 2026-06-30T23:59:00+0800
- Scope: host `agent` task kind runner now reuses dynamic spawn dependencies
  with a task-owned abort signal, closing the task manager registration path.
- Read: `packages/host/src/runtime.ts`,
  `packages/agent-runtime/src/index.ts`,
  `packages/agent-runtime/test/index.test.ts`,
  `packages/agent-runtime/test/tasks.test.ts`,
  `docs/_internal/project-map/modules/host.md`.
- Tests: `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/host test -- test/tools.test.ts`;
  `npm --workspace @sparkwright/agent-runtime test -- test/index.test.ts
test/tasks.test.ts`; `npm --workspace @sparkwright/agent-runtime run
typecheck`.

- Status: Verified
- Date: 2026-06-30T09:30:00+0800
- Scope: promoted shell task redesign: shell promotion returns the task id at
  handoff instead of waiting for completion, promoted shell traces emit
  `task.created` before `task.started`, task lifecycle payloads include
  `parentRunId`, and `task.list` remains workspace-scoped unless clients pass
  `parentRunId`.
- Read: `packages/shell-tool/src/tool.ts`,
  `packages/host/src/shell.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/src/server.ts`,
  `packages/host/test/tools.test.ts`,
  `packages/shell-tool/test/shell-tool.test.ts`,
  `docs/reference/STATE_AND_TRACE_MODEL.md`,
  `docs/reference/RUN_EVENTS.md`,
  `docs/reference/HOST_PROTOCOL.md`.
- Tests: `npm --workspace @sparkwright/shell-tool test --
test/shell-tool.test.ts`;
  `npm --workspace @sparkwright/host test -- test/tools.test.ts -t
"promotes long-running shell"`;
  `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t
"task"`;
  `npm --workspace @sparkwright/shell-tool run typecheck`;
  `npm --workspace @sparkwright/host run typecheck`.

- Status: Verified
- Date: 2026-06-30T01:07:00+0800
- Scope: host serves durable task inspection through protocol `task.*`
  requests, including task listing, single-record lookup, buffered output, stop
  attempts, request validation, advertised capabilities, and
  `task_not_found`.
- Read: `packages/host/src/runtime.ts`, `packages/host/src/server.ts`,
  `packages/host/test/protocol.test.ts`,
  `packages/protocol/src/index.ts`,
  `schemas/host-message.schema.json`,
  `docs/reference/HOST_PROTOCOL.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/protocol.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`.

- Prior verification — Date: 2026-06-29T23:05:00+0800
- Scope: deterministic demo model output now uses the active run goal and keeps
  adapter turn state isolated by run id, preserving configured-delegate
  diagnostics when a deterministic adapter is shared by model ref.
- Read: `packages/host/src/model-factory.ts`,
  `packages/host/test/model-factory.test.ts`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/maps/capabilities/agents.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/model-factory.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`.

- Status: Verified
- Date: 2026-06-29T17:40:00+0800
- Scope: host `read_file` pagination now returns structured `nextOffset` for
  valid line-window continuation, while preserving prose guidance and the
  non-recoverable long-line mid-cut behavior.
- Read: `packages/host/src/tools.ts`, `packages/host/test/tools.test.ts`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/maps/runtime/tool-orchestration.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/tools.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm run build --workspace @sparkwright/host`.

- Status: Verified
- Date: 2026-06-29T09:28:39+0800
- Scope: host catalog now owns canonical tool identity metadata, canonicalizes
  config aliases, defaults advanced tools to deferred discovery, and reports
  exposure tier separately from per-run loading in capability snapshots.
- Read: `packages/host/src/tool-identities.ts`,
  `packages/host/src/tool-catalog.ts`, `packages/host/src/tool-selectors.ts`,
  `packages/host/src/tools.ts`, `packages/host/src/runtime.ts`,
  `packages/host/src/config.ts`, `packages/host/test/tools.test.ts`,
  `packages/host/test/protocol.test.ts`.
- Tests: `npm --workspace @sparkwright/host test -- test/tools.test.ts test/protocol.test.ts test/config.test.ts`;
  `npm --workspace @sparkwright/host run build`; `npm run schema:check`.

- Status: Verified
- Date: 2026-06-28T20:30:50+0800
- Scope: `read_file` now declares explicit read-only governance metadata
  (`sideEffects: ["read"]`) with the coding-tools origin so core read-only
  approval policy can trust tool metadata instead of using a tool-name special
  case; catalog/capability origin snapshots remain stable.
- Read: `packages/host/src/tools.ts`,
  `packages/host/src/tool-catalog.ts`,
  `packages/host/test/tools.test.ts`,
  `packages/host/test/protocol.test.ts`,
  `packages/core/src/policy.ts`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/modules/coding-tools.md`,
  `docs/_internal/project-map/maps/runtime/tool-orchestration.md`,
  `docs/_internal/project-map/maps/capabilities/README.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/run-access.test.ts test/protocol.test.ts test/tools.test.ts`;
  `npm run build --workspace @sparkwright/host`; `npm run check:dist-fresh`.

- Status: Verified
- Date: 2026-06-28T17:59:14+0800
- Scope: profile hooks P2-b/P2-c/P2-d: Agent.md and config profile hooks now
  parse into `AgentProfile.hooks`, only `command`/`block`/`context`/`http`
  actions are accepted, in-process delegate/direct/indexed/parallel child runs
  compile fresh profile workflow hooks, ACP/external-command delegates are
  excluded, and JSON Schemas include `profiles[].hooks`.
- Read: `packages/agent-runtime/src/index.ts`,
  `packages/host/src/agent-profiles.ts`,
  `packages/host/src/config.ts`,
  `packages/host/src/config-zod-schema.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/test/agent-profiles.test.ts`,
  `packages/host/test/config.test.ts`,
  `packages/host/test/tools.test.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `packages/cli/test/config-schema.test.ts`,
  `schemas/agent-profile.schema.json`,
  `schemas/config.schema.json`,
  `docs/_internal/project-map/modules/agent-runtime.md`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/maps/capabilities/README.md`,
  `docs/_internal/project-map/maps/capabilities/agents.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime test -- test/index.test.ts`;
  `npm --workspace @sparkwright/agent-runtime run typecheck`;
  `npm --workspace @sparkwright/agent-runtime run build`;
  `npm --workspace @sparkwright/host test --
test/config.test.ts test/agent-profiles.test.ts test/tools.test.ts
test/workflow-hooks.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`; `npm run schema:check`;
  `npm --workspace @sparkwright/cli test -- test/config-schema.test.ts`.
- Prior verification — Date: 2026-06-28T17:51:42+0800
- Scope: Agent.md hooks P2-b/P2-c: markdown hooks now parse into
  `AgentProfile.hooks`, only `command`/`block`/`context`/`http` actions are
  accepted, and in-process delegate/direct/indexed/parallel child runs compile
  fresh profile workflow hooks while ACP/external-command delegates are excluded.
- Prior verification — Date: 2026-06-28T17:16:08+0800
- Scope: default-child agent authoring P0/P1: mode-less non-main profiles are
  delegate/index eligible, `id: main` and `mode: primary` remain excluded, and
  public/manual docs now lead with `use` plus optional `model` while treating
  `allowedTools` as advanced narrowing.
- Read: `packages/host/src/agent-constants.ts`,
  `packages/host/src/delegate-capability.ts`, `packages/host/src/runtime.ts`,
  `packages/host/test/agent-profiles.test.ts`, `docs/guides/AGENTS.md`,
  `docs/guides/CONFIGURATION.md`,
  `docs/guides/CAPABILITY_DESIGN_GUIDE.md`,
  `packages/host/builtin/skills/sparkwright-manual/references/configuration.md`,
  `packages/host/builtin/skills/sparkwright-manual/references/capabilities.md`,
  `packages/host/builtin/skills/sparkwright-manual/references/cli-and-tui.md`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/maps/capabilities/agents.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/agent-profiles.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npx prettier --check docs/guides/AGENTS.md docs/guides/CONFIGURATION.md
docs/guides/CAPABILITY_DESIGN_GUIDE.md
packages/host/builtin/skills/sparkwright-manual/references/configuration.md
packages/host/builtin/skills/sparkwright-manual/references/capabilities.md
packages/host/builtin/skills/sparkwright-manual/references/cli-and-tui.md
packages/host/src/agent-constants.ts packages/host/src/delegate-capability.ts
packages/host/src/runtime.ts packages/host/test/agent-profiles.test.ts`.
- Prior verification — Date: 2026-06-28T14:13:14+0800
- Scope: multi-model MVP added `capabilities.agents.spawnModel` and
  `delegateModel` raw refs, lazy child-scope adapter construction, and
  starter-config comments while preserving parent-model inheritance and
  process-boundary delegates.
- Prior verification — Date: 2026-06-28T13:34:37+0800
- Scope: replaced the process progress JSONL inbox with host-owned
  `stdio-v1` stderr token telemetry in `TracedProcessRunner`; covered raw child
  stderr, sandbox streaming collection, live `observeStreaming()`, workflow
  command hooks, external-command delegates, and debug/standard trace behavior.
- Read: `packages/host/src/traced-process-runner.ts`,
  `packages/host/src/workflow-hooks.ts`,
  `packages/host/src/external-command-agent.ts`,
  `packages/core/src/trace-codec.ts`, `packages/core/src/trace-store.ts`,
  `packages/host/test/traced-process-runner.test.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `packages/host/test/external-command-agent.test.ts`,
  `packages/host/test/skill-inline-shell.test.ts`,
  `packages/core/test/trace.test.ts`,
  `docs/reference/TRACE_EXTENSION_EVENTS.md`,
  `docs/reference/PROTOCOL.md`,
  `docs/guides/CONFIGURATION.md`.
- Tests: `npm --workspace @sparkwright/host test --
test/traced-process-runner.test.ts test/external-command-agent.test.ts
test/skill-inline-shell.test.ts test/workflow-hooks.test.ts`;
  `npm --workspace @sparkwright/core test --
test/trace.test.ts`; `npm --workspace @sparkwright/core run typecheck`;
  `npm --workspace @sparkwright/host run typecheck`.
- Prior verification — Date: 2026-06-28T12:05:59+0800
- Scope: documented the host hook execution/safety contracts and hardened HTTP
  hook address pinning/no-redirect behavior.
- Prior verification — Date: 2026-06-27T22:36:34+0800
- Scope: host workflow-hook config/compiler/runtime now use canonical lifecycle
  names only, expose event subscribers under `capabilities.hooks.events`, report
  workflow/event active-rule descriptors, and support command/http/agent hook
  actions without changing `RunHook` or `ValidationHook` executors.
- Read: `packages/host/src/active-rules.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/src/workflow-hooks.ts`,
  `packages/host/src/verification.ts`,
  `packages/host/src/documented-command-check.ts`,
  `packages/host/src/config.ts`,
  `packages/host/src/config-zod-schema.ts`,
  `packages/host/src/tool-catalog.ts`,
  `packages/protocol/src/index.ts`,
  `packages/cli/src/cli.ts`,
  `packages/tui/src/components/capabilities-panel.tsx`,
  `schemas/config.schema.json`,
  `docs/guides/CONFIGURATION.md`,
  `packages/host/builtin/skills/sparkwright-manual/references/configuration.md`,
  `docs/reference/EXTENSION_INTERFACES.md`,
  `docs/reference/PROTOCOL.md`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/maps/capabilities/README.md`.
- Tests: `npm --workspace @sparkwright/core test --
test/workflow-hooks.test.ts test/user-hooks.test.ts`;
  `npm --workspace @sparkwright/host test -- test/workflow-hooks.test.ts
test/config.test.ts test/protocol.test.ts -t "workflow|event|http|agent|stdoutJson|configured
workflow hooks|active workflow rule"`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/host run build`; `npm run schema:generate`;
  `npm run schema:check`.
- Prior verification — Date: 2026-06-27T21:06:53+0800
- Scope: documented-command now has an explicit host-owned built-in rule pack
  and shared activation metadata for capability inspection and active hook
  results; runtime still keeps conditional hook construction and existing
  workflow lifecycle names/actions.
- Tests: `npm --workspace @sparkwright/host test --
test/documented-command-check.test.ts test/protocol.test.ts -t "documented
command|documented-command|workflow rule"`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/protocol run build`;
  `npm --workspace @sparkwright/host run build`;
  `npm --workspace @sparkwright/cli test --
test/documented-command-check.test.ts`;
  `npm --workspace @sparkwright/cli test --
test/cli.test.ts -t "workflow rules in capability inspect"`;
  `npm --workspace @sparkwright/tui test --
test/capabilities-panel-render.test.tsx -t "workflow rule summaries"`;
  `npm --workspace @sparkwright/protocol run typecheck`;
  `npm --workspace @sparkwright/cli run typecheck`;
  `npm --workspace @sparkwright/tui run typecheck`.
- Prior verification — Date: 2026-06-27T20:24:22+0800
- Scope: added host-owned active workflow rule descriptors for capability
  inspection while keeping configured workflow hooks, verification hooks, and
  documented-command executors unchanged.
- Tests: `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t
"workflow rule|documented-command built-in"`;
  `npm --workspace @sparkwright/cli test --
test/cli.test.ts -t "workflow rules in capability inspect"`;
  `npm --workspace @sparkwright/tui test --
test/capabilities-panel-render.test.tsx -t "workflow rule summaries"`;
  `npm --workspace @sparkwright/protocol run typecheck`;
  `npm --workspace @sparkwright/cli run typecheck`;
  `npm --workspace @sparkwright/tui run typecheck`; `npm run schema:check`.
- Prior verification — Date: 2026-06-27T19:27:28+0800
- Scope: removed the dead `toolset.ts` compatibility wrapper, recorded
  source-aware shared markdown-agent discovery/reporting, preserved skill
  proposal review metadata across state transitions, and replaced server
  protocol enum duplicates with protocol constants.
- Read: `packages/host/src/agent-profiles.ts`,
  `packages/host/src/agent-report.ts`,
  `packages/host/src/delegate-capability.ts`,
  `packages/host/src/server.ts`,
  `packages/host/src/skill-evolution.ts`,
  `packages/host/src/tool-catalog.ts`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/modules/coding-tools.md`,
  `docs/_internal/project-map/maps/capabilities/README.md`,
  `docs/_internal/project-map/maps/capabilities/skill-evolution.md`,
  `docs/_internal/project-map/maps/capabilities/agents.md`.
- Tests: `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/host test --
test/agent-profiles.test.ts test/skill-evolution.test.ts
test/protocol.test.ts`; `npm --workspace @sparkwright/cli test --
test/cli.test.ts -t "filters proposals|agents|capabilities inspect"`.
- Prior verification — Date: 2026-06-27T18:53:34+0800
- Scope: documented configured in-process delegate `profile.model` runtime
  ownership while reconciling the multi-model design note with current source.
- Read: `packages/host/src/model-factory.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/src/delegate-capability.ts`,
  `packages/agent-runtime/src/index.ts`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/modules/agent-runtime.md`,
  `docs/_internal/project-map/designs/multi-model.md`,
  `docs/_internal/project-map/maps/capabilities/agents.md`.
- Tests: not run; documentation-only source reconciliation.
- Prior verification (indexed/generic delegation) — Date: 2026-06-27T16:43:38+0800
- Scope: indexed/generic agent delegation now honors `exposeAsDelegate: false`
  for automatic `delegate_agent` / `list_agents` / `delegate_parallel`
  targets unless an explicit delegate config exists; direct exposure filtering
  is shared between host runtime and CLI diagnostics; `delegate_parallel`
  rejects child tool sets with write/external governance side effects even when
  the tool name is not one of the built-in write tools.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/tool-catalog.ts`,
  `packages/host/src/delegate-capability.ts`,
  `packages/host/src/config.ts`,
  `packages/host/src/config-zod-schema.ts`,
  `packages/host/src/index.ts`,
  `packages/agent-runtime/src/index.ts`,
  `packages/cli/src/cli.ts`,
  `packages/host/test/agent-profiles.test.ts`,
  `packages/host/test/tools.test.ts`,
  `packages/host/test/protocol.test.ts`,
  `packages/host/test/config.test.ts`,
  `packages/cli/test/cli.test.ts`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/maps/capabilities/agents.md`,
  `docs/_internal/project-map/maps/runtime/tool-orchestration.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/config.test.ts test/tools.test.ts test/agent-profiles.test.ts test/protocol.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "agents|capabilities inspect|delegate|config"`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/cli run typecheck`;
  `npm run schema:check`;
  `npx prettier --check packages/agent-runtime/src/index.ts packages/host/src/delegate-capability.ts packages/host/src/index.ts packages/host/src/runtime.ts packages/cli/src/cli.ts packages/host/test/agent-profiles.test.ts packages/host/test/tools.test.ts packages/cli/test/cli.test.ts docs/guides/AGENTS.md docs/guides/CONFIGURATION.md packages/host/builtin/skills/sparkwright-manual/references/capabilities.md packages/host/builtin/skills/sparkwright-manual/references/configuration.md docs/_internal/project-map/modules/host.md docs/_internal/project-map/maps/capabilities/README.md docs/_internal/project-map/maps/capabilities/agents.md schemas/config.schema.json schemas/agent-profile.schema.json`;
  `npm --workspace @sparkwright/agent-runtime run build`;
  `npm --workspace @sparkwright/host run build`;
  `npm --workspace @sparkwright/cli run build`;
  `npm run check:dist-fresh`; `git diff --check`.
- Prior verification (shared delegation ledger) — Date: 2026-06-27T13:48:00+0800
- Scope: host wired normal configured delegates, `delegate_parallel`, and
  dynamic `spawn_agent` through the shared agent-runtime delegation ledger to
  avoid redundant child runs after an equivalent completed delegation.
- Read: `packages/host/src/runtime.ts`,
  `packages/agent-runtime/src/index.ts`,
  `packages/host/test/tools.test.ts`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/maps/capabilities/agents.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime run typecheck`;
  `npm --workspace @sparkwright/agent-runtime test -- test/index.test.ts`;
  `npm --workspace @sparkwright/agent-runtime run build`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/host test -- test/tools.test.ts`;
  `npm --workspace @sparkwright/host run build`;
  `npm --workspace @sparkwright/cli run typecheck`;
  `npm run check:dist-fresh`.
- Prior verification (delegate_parallel Phase 4a runtime) — Date: 2026-06-27T12:16:45+0800
- Scope: Phase 4a opt-in `delegate_parallel` is host-owned, foreground
  blocking, in-process/read-only only, and fail-closed on reserved tool-name
  collisions.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/tool-catalog.ts`,
  `packages/host/src/config.ts`, `packages/host/src/config-zod-schema.ts`,
  `packages/agent-runtime/src/index.ts`,
  `packages/host/test/tools.test.ts`,
  `packages/host/test/protocol.test.ts`,
  `docs/guides/AGENTS.md`, `docs/guides/CONFIGURATION.md`,
  `docs/reference/HOST_PROTOCOL.md`, `docs/reference/PROTOCOL.md`,
  `docs/reference/RUN_EVENTS.md`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/maps/capabilities/agents.md`,
  `docs/_internal/project-map/maps/runtime/tool-orchestration.md`,
  `docs/_internal/project-map/maps/trace/raw-trace.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime run typecheck`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm run schema:check`;
  `npm --workspace @sparkwright/host test -- test/tools.test.ts -t "delegate_parallel|foreground parallel|write-capable delegates"`;
  `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t "delegate_parallel|reserved by an existing delegate|reserved name"`;
  `npx prettier --check packages/agent-runtime/src/index.ts packages/host/src/config-zod-schema.ts packages/host/src/config.ts packages/host/src/tool-catalog.ts packages/host/src/runtime.ts packages/host/test/tools.test.ts packages/host/test/protocol.test.ts schemas/config.schema.json docs/guides/AGENTS.md docs/guides/CONFIGURATION.md docs/reference/PROTOCOL.md docs/reference/HOST_PROTOCOL.md docs/reference/RUN_EVENTS.md packages/host/builtin/skills/sparkwright-manual/references/capabilities.md packages/host/builtin/skills/sparkwright-manual/references/configuration.md`;
  `git diff --check`; `npm run check`.
- Prior verification (delegate routing) — Date: 2026-06-27T11:29:02+0800
- Read: `packages/host/src/agent-profiles.ts`,
  `packages/host/src/delegate-capability.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/src/config.ts`, `packages/host/src/config-zod-schema.ts`,
  `packages/host/test/protocol.test.ts`,
  `packages/host/test/agent-profiles.test.ts`,
  `packages/cli/src/cli.ts`,
  `packages/tui/src/components/capabilities-panel.tsx`,
  `schemas/agent-profile.schema.json`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/maps/capabilities/agents.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/agent-profiles.test.ts -t "routing|triggers"`;
  `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t "delegate routing"`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/cli run typecheck`;
  `npm run schema:check`.
- Prior verification (agent profile collision diagnostics) — Date: 2026-06-27T10:55:00+0800
- Read: `packages/host/src/agent-profiles.ts`,
  `packages/host/src/agent-report.ts`,
  `packages/host/src/delegate-capability.ts`,
  `packages/host/src/delegate-runner.ts`,
  `packages/host/src/runtime.ts`, `packages/host/src/tools.ts`,
  `packages/host/src/config.ts`, `packages/host/src/config-zod-schema.ts`,
  `packages/host/src/index.ts`,
  `packages/host/test/protocol.test.ts`,
  `packages/host/test/agent-profiles.test.ts`,
  `packages/cli/src/cli.ts`,
  `schemas/agent-profile.schema.json`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/modules/agent-runtime.md`,
  `docs/_internal/project-map/maps/capabilities/agents.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t "agent profile id collisions"`;
  `npm --workspace @sparkwright/host test -- test/agent-profiles.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/host run build`;
  `npm --workspace @sparkwright/cli run typecheck`;
  `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t "delegate|agents|capabilit"`;
  `npm run schema:check`.
- Prior verification (image input) — Date: 2026-06-27T01:06:46+0800
- Read: `packages/host/src/client-input.ts`, `packages/host/src/index.ts`,
  `packages/host/test/client-run.test.ts`, `packages/cli/src/cli.ts`,
  `packages/tui/src/state/run-controller.ts`,
  `packages/tui/test/sdk-cutover.test.ts`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/modules/cli.md`,
  `docs/_internal/project-map/modules/tui.md`.
- Tests: `npx prettier --check packages/host/src/client-input.ts packages/host/src/index.ts packages/host/test/client-run.test.ts packages/cli/src/cli.ts packages/tui/src/state/run-controller.ts packages/tui/test/sdk-cutover.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/host test -- test/client-run.test.ts`;
  `npm --workspace @sparkwright/host run build`;
  `npm --workspace @sparkwright/cli run typecheck`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "image attachments"`;
  `npm --workspace @sparkwright/tui run typecheck`;
  `npm --workspace @sparkwright/tui test -- test/sdk-cutover.test.ts -t "attaches local image"`.
- Prior verification (access mode) — Date: 2026-06-26T23:59:00+0800
- Read: `packages/core/src/access-mode.ts`,
  `packages/host/src/run-access.ts`, `packages/host/src/runtime.ts`,
  `packages/host/src/server.ts`, `packages/host/src/config.ts`,
  `packages/host/src/config-zod-schema.ts`, `packages/protocol/src/index.ts`,
  `packages/host/src/client-run.ts`, `packages/cli/src/cli.ts`,
  `packages/tui/src/lib/config.ts`, `packages/tui/src/state/run-controller.ts`,
  `packages/acp-adapter/src/main.ts`, `schemas/host-message.schema.json`,
  `schemas/config.schema.json`.
- Tests: `npm --workspace @sparkwright/core test -- test/access-mode.test.ts`;
  `npm --workspace @sparkwright/host test -- test/config.test.ts test/run-access.test.ts test/client-run.test.ts test/protocol.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts`;
  `npm --workspace @sparkwright/tui test -- test/config.test.ts test/permission.test.ts test/sdk-cutover.test.ts`;
  `npm --workspace @sparkwright/acp-adapter test -- test/round-trip.test.ts`;
  `npm run schema:check`; `npm run build`; `npm run check:dist-fresh`.
- Prior verification (delegates/tools) — Date: 2026-06-25T22:12:00+0800
- Read: `packages/host/src/tools.ts`,
  `packages/host/src/external-command-agent.ts`,
  `packages/host/src/acp-child-agent.ts`,
  `packages/host/src/delegate-runner.ts`,
  `packages/agent-runtime/src/index.ts`,
  `scripts/regression-real-agents.mjs`, `package.json`,
  `packages/host/test/tools.test.ts`,
  `packages/host/test/external-command-agent.test.ts`,
  `packages/host/test/acp-child-agent.test.ts`,
  `packages/host/test/protocol.test.ts`, `packages/cli/test/cli.test.ts`.
- Tests: `npm --workspace @sparkwright/host test -- test/tools.test.ts`;
  `npm --workspace @sparkwright/host test -- test/tools.test.ts -t "equivalent agent profile"`;
  `npm --workspace @sparkwright/host test -- test/external-command-agent.test.ts`;
  `npm --workspace @sparkwright/host test -- test/acp-child-agent.test.ts`;
  `npm --workspace @sparkwright/host test -- test/spawn-agent.test.ts test/external-command-agent.test.ts test/acp-child-agent.test.ts test/tools.test.ts test/protocol.test.ts -t "agent|delegate|subagent|create_agent"`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "runs a configured external command delegate directly"`;
  `npm run regression:real-agents`; `npm run check:dist-fresh`;
  `npm run typecheck`; `npm run typecheck:test`.

- Status: Verified
- Date: 2026-07-08T20:41:34+0800
- Scope: run access consolidation now has shared host/client helpers for
  resolving `accessMode`/legacy `permissionMode`/`shouldWrite`, and
  `capability.inspect` accepts optional access fields and returns an
  access-scoped snapshot summary. `ask` and `bypass` remain supported access
  presets; legacy `permissionMode` remains a compatibility input when
  `accessMode` is absent.
- Read: `packages/host/src/run-access.ts`,
  `packages/host/src/client-run.ts`, `packages/host/src/runtime.ts`,
  `packages/host/src/server.ts`, `packages/host/src/index.ts`,
  `packages/host/test/client-run.test.ts`,
  `packages/host/test/protocol.test.ts`,
  `packages/protocol/src/index.ts`, `schemas/host-message.schema.json`,
  `docs/reference/HOST_PROTOCOL.md`,
  `docs/_internal/project-map/modules/host.md`.
- Tests: `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/host test -- test/run-access.test.ts test/client-run.test.ts`;
  `npm --workspace @sparkwright/host test -- test/client-run.test.ts test/protocol.test.ts -t "capability inspect|capability inspection|capability inspect payloads"`;
  `npm --workspace @sparkwright/host run build`; `npm run schema:check`.
