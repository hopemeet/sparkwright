# Agents Capability

## Purpose

Agent capability lets host-configured profiles, delegate tools, and dynamic
spawned agents participate in a run while preserving parent policy, trace, and
session attribution.

See [../../modules/agent-runtime.md](../../modules/agent-runtime.md) and [../../modules/host.md](../../modules/host.md).

## Main Files

- `packages/host/src/runtime.ts`
- `packages/host/src/agent-profiles.ts`
- `packages/host/src/delegate-runner.ts`
- `packages/host/src/delegate-capability.ts`
- `packages/host/src/config.ts`
- `packages/host/src/config-zod-schema.ts`
- `packages/host/src/external-command-agent.ts`
- `packages/host/src/traced-process-runner.ts`
- `packages/agent-runtime/src/index.ts`
- `packages/agent-runtime/src/concurrency/*`

## Data Flow

```txt
configured profiles/delegates
  -> host derives agent profiles
  -> delegate/spawn tools
  -> child run store factory
  -> session/agent trace attribution
```

## Contracts

- Child/delegate runs must remain trace-visible.
- Parent policy and approval rules shape child workspace/tool access.
- Parent-visible `subagent.*` metadata separates trace ownership from child
  identity: `agentId` names the parent/trace actor being persisted by the run
  store, `childAgentId` names the spawned/delegate child, and
  `agentProfileId` names the configured profile when one exists. Session-scoped
  runs also carry `sessionId` on both parent-visible lifecycle metadata and the
  spawned child run metadata before persistence so stdout/event-stream views,
  child EventLog output, and `trace.jsonl` agree.
- Delegate tools are capability surface, not a hidden second runtime.
- Markdown-authored profiles are recursively discovered from layered
  `.sparkwright/agents` roots, parsed as YAML frontmatter plus prompt body, and
  folded under config profiles by id. Markdown aliases `tools` and
  `disallowedTools` map to `allowedTools` and `deniedTools`.
  Runtime discovery and CLI/capability reports share the same source-aware
  scanner so recursive walk, parse, and same-layer collision behavior stay in
  one place.
- Same-layer markdown profile id collisions fail closed (first discovered file
  is kept, later colliders are dropped) and are surfaced by both
  `capabilities inspect` diagnostics and `agents validate` validation errors.
  Runtime run preparation also emits a buffered
  `capability.index.failed` warning with `kind: "agent_profile"` and
  `code: "AGENT_PROFILE_ID_COLLISION"` before continuing with the kept profile.
  Cross-layer duplicates remain legitimate shadows.
- Inline profile `delegateTool` hints are converted into the same delegate
  config shape as `capabilities.agents.delegateTools`; explicit delegate config
  wins for the same profile id or tool name. Host runtime, capability inspect,
  direct external delegate runner, and delegate descriptors consume the resolved
  list.
- Delegate tool-name collisions fail closed: only the first owner remains
  callable, CLI `capabilities inspect` reports `delegateToolCollisions`, runtime
  preparation emits warning-severity `capability.index.failed`, and direct
  `delegates run` fails clearly when the requested tool name is ambiguous.
- Agent profile create/update/replace/remove tools are managed capability
  mutations and emit `capability.mutation.completed` when the project config
  change is applied. Mutation action names distinguish
  `create_agent_profile`, `update_agent_profile`, and `replace_agent_profile`.
- `create_agent` create results include a `callable` boolean and `callability`
  detail object. Profiles without an effective delegate tool are inspectable but
  not callable through a direct alias unless exposed separately; mode-less
  non-main profiles are still indexed child/delegate targets by default.
  `id=main` and `mode=primary` profiles shape the main run and are not eligible
  configured child delegates.
- The model-facing `create_agent` schema does not advertise legacy `force`.
  Equivalent repeated creates are idempotent. Different existing profiles must
  use `action:"update"` for patch semantics or `action:"replace"` with a
  non-empty `replaceReason`; replace removes stale delegate tools for the
  profile before optionally adding a new delegate. These managed writes preserve
  sibling `capabilities.agents` policy fields such as `maxDepth`.
- External ACP and external-command delegates are config-declared agent profile
  metadata exposed through inline profile `delegateTool` or
  `capabilities.agents.delegateTools`.
- Configured in-process delegates are also exposed through
  `capabilities.agents.delegateTools` with `protocol: "in_process"`, so host
  snapshots, CLI inspect, and TUI capability views use one descriptor source.
  Their descriptor reports the effective spawn policy (`risk: "safe"` by
  default), conditional approval facts (`approvalRequiredUnderCurrentRun`,
  `approvalReasons`, `approvalRunOptions`), profile-selected potential
  capability, and `gatedByRunWrite` when workspace-write or shell access is
  still behind the parent `--write` gate.
- Agent profile `triggers` and `when.keywords` are deterministic routing hints
  only. During run preparation the host evaluates those keywords against the
  current goal with the skill matcher, sorts matching delegates ahead of
  unmatched routed delegates, labels them `relevant` / `low`, and emits
  `agent.routing.evaluated`. The first implementation never hides a delegate or
  changes permissions based on routing.
- Delegation target discovery is broader than direct tool exposure. Host builds
  a resolved target list for non-opted-out non-`main`, non-`mode: primary`
  profiles with `mode` omitted, `mode: child`, or `mode: all`, plus
  explicit/inline delegate configs; the main model gets `delegate_agent` for a
  single target by `agentId` and may get direct `delegate_*` aliases only when
  `capabilities.agents.exposure` / `pinnedDelegates` / `exposeAsDelegate`
  request them. Default exposure is indexed, so new child profiles no longer
  create one model-facing tool each.
- `capabilities.agents.enableParallelDelegates` exposes the opt-in
  `delegate_parallel` main-run tool. It fans out across configured in-process
  delegates only, targets them by `agentId` (preferred) or legacy `toolName`,
  rejects ACP/external-command delegates, rejects any delegate whose effective
  child tool set implies workspace write or shell access, and runs as a
  foreground blocking tool with a bounded delegate list. Each child uses the
  same profile policy/model/run-budget/approval/run-store plumbing as a normal
  configured in-process delegate, with
  `entrypoint: "delegate_parallel"` and `parallelIndex` metadata for trace
  stitching. The built-in tool name is reserved when the flag is on; if a
  directly exposed delegate already owns `delegate_parallel`, the built-in is
  dropped fail-closed and runtime emits a warning diagnostic.
- CLI `capabilities inspect` also reports this reserved-name collision in
  `agents.delegateToolCollisions` so the fail-closed drop is visible without
  starting a run.
- TUI capability views exclude the built-in primary `main` profile from the
  configured-agent count/list; child/configured profiles and delegate tools
  remain visible.
- Dynamic `spawn_agent` children stay read-only and use the read-only child
  catalog (`read_file`, `glob`, `grep`, `list_dir`).
- Dynamic `spawn_agent` runs foreground by default and may promote to an
  awaited background task after the foreground budget when
  `backgroundTasks=enabled`. Promotion preserves the same spawned child run,
  parent-visible `subagent.*` events, usage rollup, run-store attribution,
  terminal/finality projection, cancellation path, and delegation ledger.
- Background `agent` tasks call the same dynamic-spawn path through
  `runHostAgentTask()`, with the task controller signal bound to the child run
  so `task_stop` cancels the background child instead of only stopping the
  foreground parent turn.
- Main-run `task_create` advertises the host-registered `agent` kind and its
  required child-agent payload fields so real models can create background
  agent tasks without guessing runner kind names from roles. Post-create task
  monitoring remains a separate prompt/model-sensitive behavior. Its
  model-facing `maxSteps` guidance intentionally matches `spawn_agent`: omit
  the field to inherit the parent run's effective budget, and use enough turns
  for read/search plus final synthesis.
- Deferred `task` monitoring of background agent tasks advertises
  action-specific non-empty id requirements and is runtime-validated before
  policy/approval/execution. Empty same-turn placeholders can be recovered in
  diagnostics only after a later concrete same-action monitor call succeeds.
- Dynamic `spawn_agent` inherits the parent run's effective `maxSteps` when the
  tool call omits `maxSteps`; explicit child values are honored without the old
  16-step cap. Nested fan-out is controlled by `capabilities.agents.maxDepth`,
  not by silently shrinking child step budgets.
- Dynamic `spawn_agent` output keeps parent-visible child identity and
  finality separate from tool transport status. A child that reaches its step
  budget after producing an answer can still return a completed tool result, but
  the output must carry `stepLimitReached: true`, `truncated: true`,
  `finality: "partial"`, and a warning-prefixed message so the parent and
  context compaction do not treat the child answer as complete.
- Raw child finality is audit evidence and must not be overwritten because the
  parent later succeeded. Trace report can downgrade `SUBAGENT_INCOMPLETE`
  severity only as a derived finding when it records `verifiedAfterChildWrite`
  evidence from ordered raw events; the underlying `subagent.*` payload remains
  partial/truncated.
- Configured in-process delegates are stable profile-backed children. Host
  expands their `AgentProfile.use` selectors against the configured delegate
  child catalog (workspace read/write coding tools plus `shell` when selected
  in the current runtime surface), intersects inherited selectors and concrete
  `allowedTools`, and passes only the resulting effective tools to the child run
  so prompt descriptors and runtime callability use one tool set.
- Configured in-process delegate child runs share the host approval resolver
  with the parent run for workspace write and shell gates, but keep
  `interactionChannel` unset so delegates do not gain free-form user
  interaction.
- Configured in-process delegates inherit the parent run's effective `maxSteps`
  when neither the delegate nor the child profile sets one. Delegate/profile
  overrides remain explicit product choices, while run depth remains governed by
  `assertSubagentDepthAllowed`.
- Dynamic `spawn_agent` children use `capabilities.agents.spawnModel` when set
  and otherwise inherit the parent adapter. Configured in-process delegates
  select the child profile's raw `model` string first, then
  `capabilities.agents.delegateModel`, then the parent adapter. Host resolves
  configured child-scope refs lazily on the tool call through the same model
  factory as the main run, so a bad delegate default fails the delegate call
  rather than run preparation. Deterministic child-scope adapters may still be
  shared by model ref, but the demo adapter keeps per-run turn state and reads
  each active child's `run.goal` for diagnostics. ACP/external-command delegates
  resolve their own model outside the parent process.
- Agent-runtime `spawnSubAgent` can carry host-supplied `WorkflowHook[]` into the
  child `CreateRunOptions.workflowHooks`. Host remains responsible for compiling
  Agent.md/config workflow hooks and selecting only hooks scoped to in-process
  child runs.
- Profile `hooks` from Agent.md frontmatter or
  `capabilities.agents.profiles[].hooks` are host-parsed workflow guardrails
  carried on `AgentProfile.hooks`. The authoring surface intentionally accepts
  only `command`, `block`, `context`, and `http` actions; `agent` actions are
  excluded from profile hooks to avoid nested delegate semantics inside a child
  guardrail. `createInProcessDelegateHooksResolver` mirrors the in-process model
  resolver's ACP/external-command discrimination and compiles fresh hooks for
  direct configured delegates, indexed `delegate_agent` calls, and
  `delegate_parallel` children.
- Completed configured-delegate and dynamic-spawn child results share the
  parent-run delegation ledger owned by `@sparkwright/agent-runtime`. Direct
  `delegate_*` aliases, generic `delegate_agent`, `delegate_parallel`, and
  dynamic `spawn_agent` all read and write this ledger so a later equivalent
  delegation can return the previous child result with `alreadyCompleted: true`
  instead of spawning a duplicate child. The ledger does not reuse failed,
  step-limited, or truncated children.
- In-process delegate workspace writes are surfaced to the parent run-end
  summary by rolling up the child run's own `workspace.write.completed` events
  onto the parent-visible `subagent.completed`/`subagent.failed` payload
  (`workspaceWrites` count), bridged in `spawnSubAgent`. This replaced an earlier
  parent-side full-workspace filesystem snapshot diff: rollup keeps a single
  source of truth (the child's write events), attributes writes to the actor
  that made them (no time-window misattribution under concurrency), and avoids
  representing one change as two event families. It is sound because the delegate
  child catalog has no untracked writer — `shell` rolls back unmanaged file
  mutations and the child catalog excludes MCP; if MCP is ever added to the
  delegate child catalog, wrap those MCP tools inside the child instead.
  The CLI summary counts `workspaceWrites` via `summarizeWorkspaceMutations`
  (`subagentWrites`).
- `capabilities.agents.maxDepth` is a global nested-spawn ceiling enforced
  before dynamic children, LLM child delegates, ACP delegates, and
  external-command delegates start, including the CLI `delegates run`
  entrypoint. Undefined `maxDepth` still means no configured ceiling.
  Sub-agent lifecycle metadata carries `subagentDepth`, parent `agentId`,
  `sessionId`, `childAgentId`, optional `agentProfileId`, `delegateTool`,
  `entrypoint`, and consistent parent/child run ids for the shared depth budget
  and trace tree.
- `capabilities.agents.allowNestedBackgroundTasks` is the explicit opt-in for
  child dynamic agents to create background agent tasks. Host exposes only a
  bounded `task_create(kind:"agent")` surface to those children, registers child
  runs for parent-task lookup, forwards child notification/revival sources, and
  applies the same depth ceiling to avoid unbounded revival recursion.
- External command delegates keep `subagent.*` as their parent-facing lifecycle
  and use `TracedProcessRunner` with `emitLifecycle: false` for shared process
  output, sandbox fallback, timeout, and artifact handling. Their constrained
  stderr `SPARKWRIGHT_EVENT:` token progress is summarized back onto the
  delegate tool result and `subagent.completed.payload.result` as
  `progressCount`, `progressDropped`, `progressHead`, and `progressTail`; it
  does not create `extension.process.*` lifecycle rows. When a read/write
  external command delegate is granted direct workspace access it emits an
  untracked write-capable marker, not managed write events.

## Consumers

- Host runtime.
- CLI delegates/capability inspection.
- Trace/session diagnostics.

## Change Checklist

- Check parent-child trace attribution and run store paths.
- Check approval-on-spawn and workspace access rules.
- Check capability snapshot and CLI output.
- Check session consistency for subagent lifecycles.

## Known Debts

- Multi-agent semantics are still edge/composition behavior, not fully absorbed core primitives.
- Audited MCP and shell filesystem snapshots remain O(tree) when enabled (the
  in-process delegate path no longer snapshots — it rolls up child write
  events); MCP stdio servers outside the workspace skip snapshots unless args
  reference workspace paths, but large repositories may still need scoped roots
  or mtime prefilters.

## Last Verified

- Status: Read-only
- Date: 2026-07-05T11:36:37+0800
- Scope: workflow-runtime-v1 P3 Step 4a routing check for
  `packages/host/src/runtime.ts`: actor episode driver inversion does not
  change agent profile discovery, delegate tool exposure, dynamic
  `spawn_agent`, or child-run policy/model routing. Workflow actor worker
  episodes still use the normal host tool/delegate setup.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/agent-profiles.ts`,
  `docs/_internal/project-map/maps/capabilities/agents.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/workflows.test.ts`;
  no agent-specific behavior changed.

- Status: Read-only
- Date: 2026-07-05T00:42:02+0800
- Scope: workflow-runtime-v1 P2 routing check: durable workflow records and
  workflow resume do not change agent/delegate capability contracts, child-run
  workflow hook forwarding, delegation ledger behavior, or subagent trace
  attribution.
- Read: `packages/agent-runtime/src/workflows/types.ts`,
  `packages/agent-runtime/src/workflows/store.ts`,
  `packages/host/src/runtime.ts`,
  `docs/_internal/project-map/maps/capabilities/agents.md`.
- Tests: not run for agent capability behavior; P2 made no agent/delegate
  semantic change.

- Status: Read-only
- Date: 2026-07-04T23:10:33+0800
- Scope: routed S1 document-store check for `packages/agent-runtime/src/*`;
  agent capability contracts remain unchanged because the behavioral migration
  is limited to `FileTaskStore` record persistence using the new shared
  doc-store atomic writer.
- Read: `packages/agent-runtime/src/doc-store/index.ts`,
  `packages/agent-runtime/src/tasks/file-store.ts`,
  `docs/_internal/project-map/modules/agent-runtime.md`,
  `docs/_internal/project-map/maps/capabilities/agents.md`.
- Tests: not run for host/agent capability flows; storage-focused coverage was
  `npm --workspace @sparkwright/agent-runtime test -- test/doc-store.test.ts
  test/tasks.test.ts` and `npm --workspace @sparkwright/agent-runtime run
  typecheck`; plus full `npm --workspace @sparkwright/agent-runtime test` and
  `npm --workspace @sparkwright/agent-runtime run build`.

- Status: Verified
- Date: 2026-07-04T00:29:16+0800
- Scope: aligned main and nested `task_create(kind:"agent")` `maxSteps`
  payload guidance with dynamic `spawn_agent` after real mini selected
  `maxSteps:1` for a read-and-answer background child. The fix is descriptor
  guidance only; task lifecycle, notification revival, and child finality
  semantics remain unchanged.
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
- Date: 2026-07-02T16:47:56+0800
- Scope: refreshed background agent task monitoring after real mini empty-id
  placeholder QA: `task` monitor schema/validation now requires concrete ids
  and trace outcome recovery handles later concrete same-action monitoring.
- Read: `packages/agent-runtime/src/tasks/tools.ts`,
  `packages/core/src/run-outcome.ts`,
  `packages/host/src/tool-catalog.ts`,
  `packages/agent-runtime/test/tasks.test.ts`,
  `packages/core/test/run-outcome.test.ts`,
  `packages/core/test/trace.test.ts`,
  `packages/host/test/tools.test.ts`,
  `docs/_internal/test-map/runs/2026-07-02-task-action-empty-id-fix-verification.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
  test/tasks.test.ts`; `npm --workspace @sparkwright/core test --
  test/run-outcome.test.ts test/trace.test.ts`; `npm --workspace
  @sparkwright/host test -- test/tools.test.ts -t "main host tool catalog"`;
  real `openai/gpt-5.4-mini` background task rerun with clean trace/report.

- Status: Verified
- Date: 2026-07-02T01:15:00+0800
- Scope: dynamic `spawn_agent` promotion now preserves parent-visible
  projection, terminal finality, usage/run-store attribution, cancellation, and
  delegation ledger; nested background agent tasks are depth-bounded and
  opt-in through `capabilities.agents.allowNestedBackgroundTasks`.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/config.ts`,
  `packages/host/src/config-zod-schema.ts`,
  `packages/agent-runtime/src/index.ts`,
  `packages/agent-runtime/src/tasks/tools.ts`,
  `packages/host/test/spawn-agent.test.ts`,
  `packages/agent-runtime/test/index.test.ts`.
- Tests: `npm --workspace @sparkwright/host test --
  test/spawn-agent.test.ts -t "promotes slow dynamic|task cancellation stops|depth-bounded sub-agents|bounded by maxDepth"`;
  `npm --workspace @sparkwright/agent-runtime test -- test/index.test.ts -t
  "subagent|spawnSubAgent|usage"`;
  host and agent-runtime typecheck/build.

- Status: Verified
- Date: 2026-07-01T13:08:00+0800
- Scope: model-facing `task_create(kind:"agent")` contract for background
  agent task creation, distinguishing the fixed payload schema from the
  remaining parent-side task-monitoring loop seen in real mini QA.
- Read: `packages/host/src/tool-catalog.ts`,
  `packages/host/src/runtime.ts`,
  `packages/agent-runtime/src/tasks/tools.ts`,
  `packages/agent-runtime/src/tasks/manager.ts`,
  `packages/host/test/tools.test.ts`,
  `packages/host/test/protocol.test.ts`,
  `docs/_internal/test-map/runs/2026-07-01-real-mini-background-task-qa.md`,
  `docs/_internal/test-map/failures/task-create-agent-kind-payload-contract.md`,
  `docs/_internal/project-map/maps/capabilities/agents.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime test --
  test/index.test.ts test/tasks.test.ts`; `npm --workspace
  @sparkwright/agent-runtime run typecheck`; `npm run build --workspace
  @sparkwright/agent-runtime`; `npm --workspace @sparkwright/host test --
  test/tools.test.ts -t "main host tool catalog"`; `npm --workspace
  @sparkwright/host test -- test/protocol.test.ts -t "starts a background
  agent through the real task_create tool"`; `npm --workspace @sparkwright/host
  test -- test/agent-task-runner.test.ts`; `npm --workspace @sparkwright/host
  run typecheck`; `npm run build --workspace @sparkwright/host`;
  `npm run check:dist-fresh`.

- Status: Verified
- Date: 2026-07-01T11:56:08+0800
- Scope: checked shared background `agent` task runner helper and task-owned
  child abort behavior.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/test/agent-task-runner.test.ts`,
  `docs/_internal/project-map/maps/capabilities/agents.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/agent-task-runner.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`.

- Status: Verified
- Date: 2026-06-29T23:05:00+0800
- Scope: checked deterministic child-scope model diagnostics after the demo
  adapter stopped leaking parent construction goal text and shared turn state
  across child runs.
- Read: `packages/host/src/model-factory.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/test/model-factory.test.ts`,
  `docs/_internal/project-map/maps/capabilities/agents.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/model-factory.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`.

- Status: Verified
- Date: 2026-06-28T17:59:14+0800
- Scope: profile hooks P2-b/P2-c/P2-d: Agent.md/config profile hook sugar now
  parses into `AgentProfile.hooks`, host compiles fresh workflow hooks for
  in-process configured delegates/direct/indexed/parallel entrypoints,
  ACP/external-command delegates remain excluded, and config/agent-profile JSON
  Schemas accept the restricted hook shape.
- Read: `packages/agent-runtime/src/index.ts`,
  `packages/agent-runtime/test/index.test.ts`,
  `packages/core/src/workflow-hooks.ts`,
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
- Scope: Agent.md hooks P2-b/P2-c: profile hook sugar now parses into
  `AgentProfile.hooks`, host compiles fresh workflow hooks for in-process
  configured delegates/direct/indexed/parallel entrypoints, and
  ACP/external-command delegates remain excluded.
- Prior verification — Date: 2026-06-28T17:33:27+0800
- Scope: P2-a hook plumbing: agent-runtime can now carry host-supplied
  `WorkflowHook[]` into spawned child `CreateRunOptions.workflowHooks`; Agent.md
  hook parsing/compilation remains host-owned follow-up work.
- Prior verification — Date: 2026-06-28T17:16:08+0800
- Scope: default-child authoring slice: `resolveAgentDelegateTools` now treats
  mode-less non-main profiles as child/delegate eligible while keeping `id: main`
  and `mode: primary` excluded from `delegate_agent`/direct auto exposure; docs
  now recommend `use` plus optional `model` and demote `allowedTools` to
  advanced narrowing.
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
- Scope: multi-model MVP now routes dynamic spawn and configured in-process
  delegate children through optional raw model defaults with lazy on-call
  adapter construction.
- Prior verification — Date: 2026-06-28T13:43:52+0800
- Scope: external-command delegates still suppress `extension.process.*` and
  summarize child progress on `subagent.completed`, but progress now comes from
  host-parsed stderr `SPARKWRIGHT_EVENT:` token lines rather than a JSONL inbox.
- Prior verification — Date: 2026-06-27T19:27:28+0800
- Scope: recorded shared source-aware markdown-agent discovery/reporting and
  narrowed dead delegate helper exports without changing delegate behavior.
- Prior verification — Date: 2026-06-27T18:53:34+0800
- Scope: documented configured in-process delegate `profile.model` routing and
  reconciled the agents capability map with the updated multi-model design note.
- Read: `packages/host/src/model-factory.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/src/delegate-capability.ts`,
  `packages/agent-runtime/src/index.ts`,
  `docs/_internal/project-map/maps/capabilities/agents.md`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/modules/agent-runtime.md`,
  `docs/_internal/project-map/designs/multi-model.md`.
- Tests: not run; documentation-only source reconciliation.
- Prior verification (indexed/generic delegation) — Date: 2026-06-27T16:43:38+0800
- Scope: indexed/generic agent delegation remains the default surface, but
  automatic targets now respect `exposeAsDelegate: false` across
  `delegate_agent`, `list_agents`, and `delegate_parallel` unless an explicit
  delegate config exists. Direct `delegate_*` aliases are filtered by the shared
  exposure helper, and `delegate_parallel` rejects effective child tool sets
  that carry mutating governance side effects.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/delegate-capability.ts`,
  `packages/host/src/tool-catalog.ts`,
  `packages/host/src/config.ts`,
  `packages/host/src/config-zod-schema.ts`,
  `packages/host/src/index.ts`,
  `packages/agent-runtime/src/index.ts`,
  `packages/cli/src/cli.ts`,
  `packages/host/test/agent-profiles.test.ts`,
  `packages/host/test/tools.test.ts`,
  `packages/host/test/protocol.test.ts`,
  `packages/cli/test/cli.test.ts`,
  `docs/_internal/project-map/maps/capabilities/agents.md`.
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
- Scope: shared delegation ledger prevents redundant child runs across normal
  configured delegate calls, `delegate_parallel`, and dynamic `spawn_agent`.
- Read: `packages/host/src/runtime.ts`,
  `packages/agent-runtime/src/index.ts`,
  `packages/host/test/tools.test.ts`,
  `docs/_internal/project-map/maps/capabilities/agents.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime run typecheck`;
  `npm --workspace @sparkwright/agent-runtime test -- test/index.test.ts`;
  `npm --workspace @sparkwright/agent-runtime run build`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/host test -- test/tools.test.ts`;
  `npm --workspace @sparkwright/host run build`;
  `npm --workspace @sparkwright/cli run typecheck`;
  `npm run check:dist-fresh`.
- Prior verification (delegate collisions) — Date: 2026-06-27T12:31:56+0800
- Scope: delegate tool-name collisions are now visible in runtime warning
  events, CLI capability inspection, and direct delegate-run diagnostics.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/tool-catalog.ts`,
  `packages/host/src/config.ts`, `packages/host/src/config-zod-schema.ts`,
  `packages/host/src/delegate-capability.ts`,
  `packages/host/src/delegate-runner.ts`,
  `packages/cli/src/cli.ts`, `packages/cli/test/cli.test.ts`,
  `packages/agent-runtime/src/index.ts`,
  `packages/host/test/tools.test.ts`,
  `packages/host/test/protocol.test.ts`,
  `docs/_internal/project-map/maps/capabilities/agents.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime run typecheck`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm run schema:check`;
  `npm --workspace @sparkwright/host test -- test/tools.test.ts -t "delegate_parallel|foreground parallel|write-capable delegates"`;
  `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t "delegate_parallel|reserved by an existing delegate|reserved name"`;
  `npm --workspace @sparkwright/cli run typecheck`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "delegate_parallel reserved-name|surfaces in-process delegate tools|fails direct delegate runs"`;
  `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t "delegate tool-name collisions|delegate_parallel|reserved by an existing delegate|reserved name"`.
- Prior verification (Phase 4a runtime) — Date: 2026-06-27T12:16:45+0800
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/tool-catalog.ts`,
  `packages/host/src/config.ts`, `packages/host/src/config-zod-schema.ts`,
  `packages/host/src/delegate-capability.ts`,
  `packages/agent-runtime/src/index.ts`,
  `packages/host/test/tools.test.ts`,
  `packages/host/test/protocol.test.ts`,
  `docs/_internal/project-map/maps/capabilities/agents.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime run typecheck`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm run schema:check`;
  `npm --workspace @sparkwright/host test -- test/tools.test.ts -t "delegate_parallel|foreground parallel|write-capable delegates"`;
  `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t "delegate_parallel|reserved by an existing delegate|reserved name"`;
  `npm run check`.
- Prior verification (delegate routing) — Date: 2026-06-27T11:29:02+0800
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/agent-profiles.ts`,
  `packages/host/src/delegate-capability.ts`,
  `packages/host/test/agent-profiles.test.ts`,
  `packages/host/test/protocol.test.ts`, `packages/cli/src/cli.ts`,
  `packages/cli/src/event-format.ts`, `packages/cli/test/cli.test.ts`,
  `packages/cli/test/event-format.test.ts`,
  `packages/tui/src/lib/format-event.ts`,
  `packages/tui/test/format-event.test.ts`,
  `packages/tui/src/components/capabilities-panel.tsx`,
  `packages/tui/test/capabilities-panel-render.test.tsx`,
  `docs/_internal/project-map/maps/capabilities/agents.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/agent-profiles.test.ts -t "routing|triggers"`;
  `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t "delegate routing"`;
  `npm --workspace @sparkwright/cli test -- test/event-format.test.ts`;
  `npm --workspace @sparkwright/tui test -- test/format-event.test.ts test/capabilities-panel-render.test.tsx`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/cli run typecheck`;
  `npm --workspace @sparkwright/tui run typecheck`;
  `npm run schema:check`.
- Prior verification (agent profile collision diagnostics) — Date: 2026-06-27T10:55:00+0800
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/agent-profiles.ts`,
  `packages/host/test/protocol.test.ts`, `packages/cli/src/event-format.ts`,
  `packages/cli/test/event-format.test.ts`,
  `packages/tui/src/lib/format-event.ts`,
  `packages/tui/test/format-event.test.ts`,
  `packages/cli/src/cli.ts`, `packages/cli/test/cli.test.ts`,
  `packages/host/src/agent-report.ts`,
  `docs/_internal/project-map/maps/capabilities/agents.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t "agent profile id collisions"`;
  `npm --workspace @sparkwright/cli test -- test/event-format.test.ts`;
  `npm --workspace @sparkwright/tui test -- test/format-event.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/cli run typecheck`;
  `npm --workspace @sparkwright/tui run typecheck`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "markdown agent id collisions|creates, lists, and validates workspace agents|reports agent validation errors"`;
  `npx prettier --check packages/cli/src/cli.ts packages/cli/test/cli.test.ts`;
  `git diff --check`.
- Prior verification (agent profile discovery/delegates) — Date: 2026-06-27T01:25:26+0800
- Read: `packages/agent-runtime/src/index.ts`,
  `packages/host/src/agent-profiles.ts`,
  `packages/host/src/agent-report.ts`,
  `packages/host/src/delegate-capability.ts`,
  `packages/host/src/delegate-runner.ts`,
  `packages/host/src/runtime.ts`, `packages/host/src/tools.ts`,
  `packages/host/src/config.ts`, `packages/host/src/config-zod-schema.ts`,
  `packages/host/test/agent-profiles.test.ts`, `packages/cli/src/cli.ts`,
  `schemas/agent-profile.schema.json`.
- Tests: `npm --workspace @sparkwright/agent-runtime run typecheck`;
  `npm --workspace @sparkwright/agent-runtime run build`;
  `npm --workspace @sparkwright/host test -- test/agent-profiles.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/host run build`;
  `npm --workspace @sparkwright/cli run typecheck`;
  `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t "delegate|agents|capabilit"`;
  `npm run schema:check`.
- Prior verification — Date: 2026-06-25T23:14:11+0800
- Read: `packages/agent-runtime/src/index.ts`,
  `packages/agent-runtime/test/index.test.ts`.
- Tests: `npm --workspace @sparkwright/agent-runtime test -- test/index.test.ts`;
  `npm --workspace @sparkwright/agent-runtime run typecheck`;
  `npx prettier --check packages/agent-runtime/src/index.ts packages/agent-runtime/test/index.test.ts packages/cron/src/service.ts packages/cron/test/schedule.test.ts packages/cli/src/cli.ts packages/cli/test/cli.test.ts packages/tui/src/lib/create-capability.ts packages/tui/test/create-capability.test.ts`.
