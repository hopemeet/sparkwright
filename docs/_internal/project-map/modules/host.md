# Host

## Purpose

`@sparkwright/host` is the composition boundary around core. It loads config,
providers, skills, MCP servers, agent profiles, shell settings, workflow hooks,
session stores, and protocol-facing runtime methods.

See also [../maps/runtime/run-loop.md](../maps/runtime/run-loop.md) and
[../maps/capabilities/README.md](../maps/capabilities/README.md).

## Main Files

- `packages/host/src/runtime.ts`
- `packages/host/src/server.ts`
- `packages/host/src/connection.ts`
- `packages/host/src/tool-catalog.ts`
- `packages/host/src/tool-identities.ts`
- `packages/host/src/tools.ts`
- `packages/host/src/shell.ts`
- `packages/host/src/workspace-snapshot.ts`
- `packages/host/src/workflow-hooks.ts`
- `packages/host/src/invariant-projection.ts`
- `packages/host/src/workflows.ts`
- `packages/host/src/workflow-projection.ts`
- `packages/host/src/workflow-node-api.ts`
- `packages/host/src/active-rules.ts`
- `packages/host/src/traced-process-runner.ts`
- `packages/host/src/acp-child-agent.ts`
- `packages/host/src/skill-inline-shell.ts`
- `packages/host/src/external-command-agent.ts`
- `packages/host/src/delegate-capability.ts`
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
- host-level approval resolver and pending approval routing
- host-client approval helpers used by frontends that must not import core directly
- session diagnostics bundle composition

Does not own:

- core state machine semantics
- event envelope schema
- TUI rendering state
- CLI argument parsing

## Contracts

- One active run per host connection.
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
  lists are derived from `tool-catalog.ts`; dynamic `spawn_agent` uses the
  read-only child catalog, while configured in-process delegates use a separate
  profile-aware child catalog for workspace read/write coding tools plus
  `bash` when selected. Catalog entries keep tool definition, source, and
  stable identity metadata; callers that need bare `ToolDefinition[]` flatten
  catalog entries with `catalogToolDefinitions()`.
- The main host catalog exposes `task_create` as an eager task tool when the
  background task surface is enabled. Host owns the `agent` kind descriptor and
  its model-facing payload schema (`goal`, `role`, `prompt`, optional
  `allowedTools`, `maxSteps`, `metadata`); execution still dispatches through
  the `TaskManager` runner registered by `HostRuntime`. The `maxSteps` payload
  guidance mirrors dynamic `spawn_agent`: omit it to inherit the parent run's
  effective step budget, and allocate enough turns for read/search plus final
  synthesis instead of using very low caps.
- The main host catalog preserves the shared deferred `task` action schema from
  agent-runtime, including action-specific non-empty id constraints, so
  `tool_search select:task` gives the provider the same guidance the runtime
  validates.
- Host wires the shared `TaskManager` notification sink into a durable
  `FileTaskNotificationOutbox` that backs per-run core notification/revival
  sources. All terminal task notifications for the run can be injected through
  `run.notification.injected`; only awaited tasks wake core's internal
  `waiting_tasks` state. Host does not synthesize a new user turn. On
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
- P2 workflow runs are durable host-orchestrated records. Host acquires the
  workflow run's single-writer lease before fresh record creation or resume, then
  writes a `FileWorkflowStore` record under
  `<sessionRoot>/<sessionId>/workflow-runs/`, pins the compiled workflow
  definition snapshot, persists projection snapshots into current node,
  attempts, verdict/transition logs, and run/fact evidence refs, refreshes a
  single-writer lease while the run chain is active, and releases the lease on
  terminal/rejected paths. `workflow resume` uses the pinned definition, not
  the live asset folder, and `verifyOnResume` re-runs verifier nodes whose
  latest stored verdict is passed before trusting the stored position.
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
  keeps the PreToolUse clamp as a fallback for mid-run transitions, but stands
  down when the actor's current worker catalog does not contain the requested
  tool so core can surface `TOOL_NOT_FOUND`. If the narrowed catalog contains
  deferred tools, host appends a scoped `tool_search` whose descriptor source is
  the narrowed catalog only; PreToolUse allows that available infrastructure
  tool without reopening the parent catalog. The clamp compares allowed tool
  names canonically, so legacy declarations such as `tools: [read_file]` still
  allow the canonical worker tool `read`.
- P3 Step 4b.2 routes active model-node `model` and `runBudget` at worker
  entry: `workflows.ts` parses the node fields, `runtime.ts` resolves model
  refs through the configured model-tier surface, passes the selected adapter
  and per-attempt budget to `createRun()`, and records `workflowEpisode`,
  per-episode usage snapshots, and aggregate `workflowUsage` on
  `WorkflowRunRecord.metadata`. Retry escalation inside one core run is not
  implemented until model-node boundaries become separate worker episodes.
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
  re-running branches. `parallel` preserves branch `runtime_error` as a
  fail-closed node verdict; `join` requires each waited branch to have one
  producer and rejects stale `sourceNodeId` state. Branch-local transitions are
  not interpreted in P5; only the `parallel` / `join` node verdicts advance
  through `advanceWorkflowState()`. All-delegate fan-out must call the existing
  `delegate_parallel` tool and is batched by `maxConcurrency`; P5 does not add a
  workflow scheduler, branch cancellation bus, nested parallel, human/model
  branches, or `workflow_start`.
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
- Controlled nested background agent tasks are opt-in through
  `capabilities.agents.allowNestedBackgroundTasks`. When enabled, host registers
  child runs for task parenting, gives child dynamic-spawn catalogs a bounded
  `task_create(kind:"agent")`, forwards child notification/revival sources, and
  keeps depth bounded by `capabilities.agents.maxDepth` (or a conservative host
  default when the user opted in without a ceiling).
- Background `agent` tasks use the shared `runHostAgentTask()` helper. The task
  controller signal is the child run's abort owner, so `task_stop` cancels the
  child lifecycle independently of the foreground parent turn.
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
  primitives used by shell mutation rollback.
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
  Read/write external command delegates emit
  `workspace.write.untracked_access_granted` when direct workspace access is
  granted; this is a boundary marker, not a managed write event.
  Parent-visible lifecycle metadata uses parent `agentId`, inherited
  `sessionId`, plus `childAgentId`/`agentProfileId` for the external profile
  identity so direct CLI JSON output and persisted trace attribution agree.
- Promoted shell tasks adopt the already-started shell stream through
  `TracedProcessRunner.observeStreaming`, keep `task.*` as the lifecycle, emit
  `task.created` before opening the task span with `task.started`, write full
  stdout/stderr to `TaskStore`, and mirror bounded progress/output into the run
  trace as `task.output` under the task span. The foreground shell tool returns
  the promoted `taskId` at the handoff point rather than waiting for the task to
  complete. Promotion is an untracked write-capable boundary rather than a
  per-file attribution point: promoted tasks emit
  `workspace.write.untracked_access_granted` with
  `protocol: "promoted_shell"` and sandbox status, and do not run the
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

## Last Verified

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
