# Capability Maps

## Purpose

Capability maps explain how optional power enters a run: skills, MCP, agents,
cron, shell/task tools, and capability inspection.

## Main Files

- `packages/host/src/runtime.ts`
- `packages/host/src/active-rules.ts`
- `packages/host/src/tool-catalog.ts`
- `packages/host/src/tools.ts`
- `packages/host/src/workflows.ts`
- `packages/host/src/workflow-node-api.ts`
- `packages/skills/src/*`
- `packages/mcp-adapter/src/index.ts`
- `packages/agent-runtime/src/*`
- `packages/cron/src/*`

## Data Flow

```txt
config + workspace capability roots
  -> host capability preparation
  -> host tool catalog
  -> CLI diagnostic catalog profile for direct-core/cron runs
  -> tools/context/events/snapshot
  -> run context and capability.inspect
```

## Contracts

- Capabilities affect model input, tool availability, policy, or side effects and must be trace-visible.
- Capability inspection is diagnostic; it does not replace run trace.
- `CapabilitySnapshot.rules.workflow` and `rules.events` are diagnostic only.
  Host builds workflow descriptors from configured workflow hooks, verification
  invariants, and documented-command built-in invariants, and event descriptors
  from `capabilities.hooks.events`, so CLI/TUI can explain active/available
  rules without changing run behavior. The documented-command built-in is
  represented as a host rule pack but remains conditionally constructed, so
  availability inspection does not add inactive hook executions.
  Event subscribers report `blockingPotential: false`. Command-action progress
  uses the host process stderr `SPARKWRIGHT_EVENT:` observation protocol and
  does not change whether a workflow rule is blocking or an event rule is
  non-blocking.
- File-authored capabilities use builtin/user/project roots; config-declared
  capabilities such as MCP servers, ACP delegates, external-command delegates,
  hooks, and verification remain in config rather than directory discovery.
  Verification config now exposes profiles plus `afterWrites.profile` and
  `afterWrites.injectOutput`; P1.5/D25 removed the old `stopGate` and
  `afterWrites.frequency` sub-surfaces in favor of write-epoch invariant
  verifier results.
- Workflow assets are file-authored capabilities discovered from
  builtin/user/project workflow roots by host. Capability inspection and
  `sparkwright workflow *` remain inspection surfaces; P1/P1.5 also lets
  `sparkwright run --workflow <name>` / `run.start.workflow` instantiate a
  selected asset without the former experimental workflow runtime gate.
  P2 durable workflow run records are session state, not capabilities:
  `sparkwright workflow list` may show both workflow assets and workflow run
  records, but `capability.inspect.workflows` remains the asset inventory.
  P3 Step 4b.1 per-episode workflow catalog narrowing filters worker
  `ToolDefinition[]` at run creation; it does not change capability.inspect's
  asset inventory. A scoped `tool_search` may be added inside a filtered worker
  episode only to discover deferred tools already present in that filtered
  catalog; it is runtime infrastructure, not a capability inventory expansion.
  Canonical PreToolUse comparison keeps legacy node allowlists aligned with
  canonical worker tools without changing public capability inventory.
  P3 Step 4b.2 model-node `model` / `runBudget` routing is also a runtime
  episode-entry concern: it uses configured model refs/tiers and ordinary run
  budgets, not a new capability inventory surface.
  P3 Step 4b.3 does not add a `workflow_start` tool or capability field;
  workflow assets remain request-selected capabilities rather than
  model-spawned tasks.
  P4 `script` nodes are asset-authored declarations executed only by the host
  projection. Their declared capabilities map to host access clamps at
  instantiation time; scripts do not receive capability objects, do not write
  trace, and can perform side effects only by calling host node API methods over
  stdio JSON-RPC. Built-in dogfood workflows are ordinary workflow assets and
  should not be special-cased by capability inventory consumers.
  P5 `parallel` / `join` nodes extend the workflow asset grammar and durable
  workflow run state, not capability inventory. All-delegate workflow fan-out
  reuses the existing opt-in `delegate_parallel` tool when available and is
  batched by `parallel.maxConcurrency`; delegate_parallel transport crashes are
  projection runtime errors while ordinary delegate child failures remain branch
  failed verdicts. Mixed non-model branches use their existing governed
  primitives (`command`, `delegate`, `task`, `script`). P5 also requires
  explicit `parallel.onPass` and rejects branch-local `verify` declarations in
  projection validation. P5 still does not add `workflow_start`, branch-local
  model-facing tools, branch verifier execution, or a second configured-delegate
  fan-out surface.
- Config-declared capabilities can live in JSON or YAML config files. Host owns
  parsing, same-layer conflict diagnostics, and serialization helpers; CLI/TUI
  and managed capability tools should reuse those helpers when mutating config.
- `capability.inspect` should report runtime tools from the host catalog so sources/deferred flags match the actual run surface.
- `CapabilitySnapshot.model.pricing` reports the selected model's cost
  availability before a run finishes. Host model resolution owns the status:
  explicit provider `cost` wins, built-in pricing is second, and otherwise
  `missing_pricing` is surfaced as a warning-only diagnostic.
- Host `capability.inspect` can resolve the snapshot's model summary against an
  active runtime model supplied by a protocol client. CLI `capabilities inspect
--model` and TUI `/capabilities` under a request-sourced model override use
  this path so capability surfaces agree with the model that would run next.
- `CapabilitySnapshot.shell` and CLI `capabilities inspect` expose the
  effective shell foreground budget and promotion availability alongside sandbox
  status, so timeout/promotion diagnostics do not require reading a run trace.
- `backgroundTasks` is a run-shaping capability policy accepted from config and
  protocol requests. Host clamps it with project ceilings and applies it to
  task creation, shell promotion, and dynamic `spawn_agent` promotion.
- Background `task_create(kind:"agent")` payload descriptors are host-owned
  capability guidance. Their `maxSteps` prose should stay aligned with dynamic
  `spawn_agent`: omitted child budgets inherit the parent effective maxSteps,
  while explicit low caps can make otherwise healthy read/search tasks partial.
- Workspace-write capability includes public `write` and `edit` plus the
  advanced anchored verified edit pair; capability inventories and selector
  filtering should expose canonical model-facing names.
- Host tool catalog entries keep source metadata and stable tool identity
  metadata. `defaultExposureTier` is product classification; `effectiveLoading`
  is per-run schema loading state.
- CLI `capabilities inspect` derives its `tools.available` diagnostic inventory from the host runtime snapshot, with delegate/MCP labels layered on top for display.
- Direct-core and cron non-host runs use the host CLI diagnostic catalog profile for concrete tool definitions, so capability config (`disabled`/`defer`) applies consistently there too.
- Top-level `tools.use`, `tools.allowed`, `tools.disabled`, and `tools.defer`
  are the active tool configuration fields; legacy `capabilities.tools` is
  rejected at config validation. `use` keeps high-level selector groups,
  `allowed` keeps only listed concrete tool names, `disabled` removes concrete
  names even if otherwise selected, and `defer` only changes schema loading for
  tools that remain.
- `capabilities inspect` displays configured selectors and the final runtime
  inventory, so selector filtering must happen before snapshots and diagnostic
  inventories are built.
- Public/business capability displays hide infrastructure tools such as
  `tool_search` and `skill_load`, while mechanism views still report them.
- Agent profiles can also carry `use` selectors; configured and dynamic
  delegate tools must derive child catalogs from the intersected profile/tool
  selectors and enforce `capabilities.agents.maxDepth` before starting nested
  work.
- `capabilities.agents.allowNestedBackgroundTasks` is an explicit opt-in that
  lets child dynamic agents receive a bounded `task_create(kind:"agent")`
  surface. It depends on depth limits and task notification revival; default
  child agents cannot create nested background tasks.
- Agent model defaults are capability config too:
  `capabilities.agents.spawnModel` applies to dynamic `spawn_agent` children,
  while `capabilities.agents.delegateModel` applies to configured in-process
  delegates after profile `model`; unset values inherit the parent model.
- Agent profile hooks are capability-owned child-run guardrails. Agent.md
  `hooks` and `capabilities.agents.profiles[].hooks` compile only for configured
  in-process delegate children and do not affect the main run, dynamic
  `spawn_agent`, ACP delegates, or external-command delegates.
- Agent delegation defaults to an indexed surface: `delegate_agent` addresses
  non-opted-out configured child/all profiles by `agentId`, while direct
  `delegate_*` aliases appear only when exposure config asks for them.
  Capability inventories should distinguish the agents delegate index from the
  actual model-facing tool list.
- `capabilities.agents.enableParallelDelegates` is opt-in and adds the
  foreground `delegate_parallel` tool to the `agents` surface after host
  capability preparation. Eligibility remains enforced at tool-call time, so an
  enabled-but-ineligible configuration produces a diagnostic rather than a
  hidden or silently empty surface.
- Regression and smoke scripts must not recreate removed tool allowlists; use
  the default tool surface or top-level negative filters.
- Real-model skill capability regression preserves JSON/YAML config layers,
  recognizes top-level `providers` and grouped `identity.providers`, and should
  use `capabilities inspect` evidence rather than a local hard-coded tool list.
  Prompt canaries should ask for current tool catalog names and treat recovered
  model/tool retries as passable only when the final run outcome is not failing
  and the intended capability effect is present.
- Cron tick model construction is per due job, not per tick invocation, so
  diagnostic/stateful adapters cannot leak model-call state across jobs.
- Capability roots and generated state have different persistence rules.
- Source-install/path changes are covered by `npm run source:install-smoke`,
  which verifies package install layout, `doctor paths`, installed CLI/TUI/ACP
  entrypoints, deterministic run behavior, and uninstall boundaries.
- IM gateway config/state use XDG paths only; `~/.sparkwright` is reserved for
  source-installed program files.
- Cron state and host crash logs are user state under XDG state, not project
  capability roots.

## Consumers

- Host runtime.
- CLI `capabilities inspect`.
- TUI capabilities panel and create flows.
- Trace timeline for capability events.

## Change Checklist

- Read the relevant child page: [skills.md](skills.md), [mcp.md](mcp.md), [agents.md](agents.md), or [cron.md](cron.md).

## Known Debts

- Capability layering and self-evolution are evolving; keep stable runtime behavior separate from design proposals.
- CLI `tools list` has been removed; use `capabilities inspect` for tool inventory and `tools allow|disable|defer` for config writes.
- Do not add one-off direct-core/cron tools for capability smokes; exercise the same coding tools used by host runs.

## Last Verified

- Status: Verified
- Date: 2026-07-05T20:18:29+0800
- Scope: workflow-runtime-v1 P5 capability boundary after post-review
  hardening: explicit parallel transitions, branch-verifier rejection, and
  delegate_parallel crash handling remain workflow projection validation/runtime
  behavior. Capability inventory still gains no workflow_start, branch-local
  tool surface, or second delegate fan-out capability.
- Read: `packages/host/src/workflow-projection.ts`,
  `packages/host/src/workflows.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test --
  test/workflow-hooks.test.ts -t "parallel|join|delegate_parallel|branch
  diagnostics"`; `npm --workspace @sparkwright/host test --
  test/workflows.test.ts test/workflow-hooks.test.ts`.

- Status: Verified
- Date: 2026-07-05T18:02:15+0800
- Scope: workflow-runtime-v1 P5 capability boundary: `parallel` / `join`
  remain workflow asset declarations plus host projection behavior; all-delegate
  fan-out reuses existing `delegate_parallel` with workflow-side
  `maxConcurrency` batching, and capability inspection still does not gain
  `workflow_start` or a branch scheduler surface.
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
- Scope: workflow-runtime-v1 P4 capability boundary: script nodes are
  workflow-asset declarations with host-side capability clamps and stdio node
  API governance; capability.inspect inventory remains the workflow asset
  surface and does not gain `workflow_start`.
- Read: `packages/host/src/workflows.ts`,
  `packages/host/src/workflow-node-api.ts`,
  `packages/host/test/workflows.test.ts`,
  `packages/cli/test/cli.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/workflows.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "workflow
  assets"`; `npm run release:check`.

- Status: Verified
- Date: 2026-07-05T13:59:13+0800
- Scope: P3 Step 4b.1 review fix: scoped `tool_search` for workflow deferred
  worker tools is runtime infrastructure over an already-filtered catalog and
  does not change capability.inspect inventory; canonical PreToolUse comparison
  keeps legacy node allowlists aligned with canonical worker tools.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/workflow-projection.ts`,
  `docs/_internal/project-map/maps/capabilities/README.md`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/workflows.test.ts -t
  "narrows model worker catalogs|keeps scoped tool_search"`.

- Status: Verified
- Date: 2026-07-05T12:23:15+0800
- Scope: workflow-runtime-v1 P3 Step 4b.3 capability boundary:
  `workflow_start` remains absent from host tool/capability inventory in P3;
  workflow instantiation is still selected by CLI/config/protocol request.
- Read: `packages/host/src/tool-catalog.ts`,
  `packages/host/src/tool-identities.ts`, `packages/host/src/runtime.ts`,
  `docs/_internal/project-map/maps/capabilities/README.md`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `rg -n "workflow_start" packages/host/src packages/host/test
  packages/cli/test packages/protocol/src docs/reference`; `npm run
  release:check`.

- Status: Verified
- Date: 2026-07-05T12:15:55+0800
- Scope: workflow-runtime-v1 P3 Step 4b.2 capability boundary: model-node
  `model`/`runBudget` routing is resolved by host runtime at worker entry and
  does not add workflow asset or capability.inspect inventory fields.
- Read: `packages/host/src/runtime.ts`, `packages/host/src/workflows.ts`,
  `docs/_internal/project-map/maps/capabilities/README.md`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/workflows.test.ts -t
  "node model and budget|parses workflow folder"`.

- Status: Verified
- Date: 2026-07-05T11:49:40+0800
- Scope: workflow-runtime-v1 P3 Step 4b.1 capability boundary: workflow
  worker-entry catalog narrowing is a per-run tool list filter and does not
  change workflow asset discovery or capability.inspect workflow inventory.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/workflow-projection.ts`,
  `docs/_internal/project-map/maps/capabilities/README.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/workflows.test.ts -t
  "narrows model worker catalogs|workflow"`.

- Status: Read-only
- Date: 2026-07-05T11:36:37+0800
- Scope: workflow-runtime-v1 P3 Step 4a routing check for
  `packages/host/src/runtime.ts`: actor episode driver inversion does not
  change capability discovery, capability.inspect snapshots, or workflow asset
  inventory semantics. Workflow run records remain session state, not
  capabilities.
- Read: `packages/host/src/runtime.ts`,
  `packages/cli/test/cli.test.ts`,
  `docs/_internal/project-map/maps/capabilities/README.md`.
- Tests: `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t
  "workflow|run resume through the host"`.

- Status: Verified
- Date: 2026-07-05T00:42:02+0800
- Scope: workflow-runtime-v1 P2 capability boundary: durable workflow run
  records/list/resume are session-state surfaces, while
  `CapabilitySnapshot.workflows` remains the host-discovered asset inventory.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/workflows.ts`,
  `packages/cli/src/cli.ts`,
  `packages/host/test/workflows.test.ts`,
  `packages/cli/test/cli.test.ts`.
- Tests: `npm --workspace @sparkwright/host test -- test/workflows.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "workflow"`.

- Status: Verified
- Date: 2026-07-04T22:20:04+0800
- Scope: workflow-runtime-v1 D25 capability surface: capability inspection
  reports verification/documented-command as run-level invariant rules, config
  schema rejects `afterWrites.frequency`, and documented-command availability
  remains conditional on goal/write context.
- Read: `packages/host/src/active-rules.ts`,
  `packages/host/src/config-zod-schema.ts`,
  `packages/host/test/config.test.ts`,
  `packages/host/test/protocol.test.ts`,
  `packages/cli/test/cli.test.ts`,
  `schemas/config.schema.json`.
- Tests: `npm --workspace @sparkwright/host test --
  test/config.test.ts -t "verification profiles|afterWrites frequency"`;
  `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t
  "includes active workflow rule descriptors"`; `npm --workspace
  @sparkwright/cli test -- test/cli.test.ts -t "shows workflow and event rules
  in capability inspect text output"`; `npm run schema:check`; `npm run check`;
  `npm run release:check`.

- Status: Verified
- Date: 2026-07-04T18:16:44+0800
- Scope: P1.5 closure after read-only review: capability/config surface no
  longer includes `capabilities.verification.stopGate`, while workflow rules
  continue to expose projection-backed verification/documented-command
  descriptors.
- Read: `packages/host/src/config.ts`,
  `packages/host/src/config-zod-schema.ts`,
  `packages/host/src/active-rules.ts`,
  `packages/host/src/runtime.ts`,
  `schemas/config.schema.json`,
  `schemas/fixtures/host-message.capability-snapshot.json`,
  `docs/reference/PROTOCOL_CHANGELOG.md`.
- Tests: `npm run schema:check`; `npm --workspace @sparkwright/host test --
  test/protocol.test.ts -t
  "workflow|verification|documented-command|capability.inspect"`.

- Status: Verified
- Date: 2026-07-04T16:47:47+0800
- Scope: workflow-runtime-v1 P1.5 capability boundary: workflow assets remain
  host-discovered file capabilities, runtime instantiation is no longer behind
  the experimental gate, and `rules.workflow` descriptors show
  projection-backed verification/documented-command checks.
- Read: `packages/host/src/workflows.ts`,
  `packages/host/src/workflow-projection.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/src/active-rules.ts`,
  `schemas/fixtures/host-message.capability-snapshot.json`,
  `packages/cli/src/cli.ts`,
  `packages/host/test/workflows.test.ts`,
  `packages/cli/test/cli.test.ts`.
- Tests: `npm --workspace @sparkwright/host test -- workflows.test.ts`;
  `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t
  "capability.inspect"`; `npm --workspace @sparkwright/cli test --
  test/cli.test.ts -t "workflow|--workflow"`.

- Status: Verified
- Date: 2026-07-04T08:16:19+0800
- Scope: added host-discovered workflow assets to capability inspection and CLI
  workflow inspection while keeping workflow assets diagnostic-only and outside
  run-loop capability behavior.
- Read: `packages/host/src/workflows.ts`, `packages/host/src/runtime.ts`,
  `packages/cli/src/cli.ts`, `packages/protocol/src/index.ts`,
  `packages/host/test/workflows.test.ts`, `packages/cli/test/cli.test.ts`,
  `docs/_internal/project-map/maps/capabilities/README.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/workflows.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t
  "workflow assets|lists and inspects workflow assets|capability inspect"`;
  focused host/cli typechecks.

- Status: Verified
- Date: 2026-07-04T00:29:16+0800
- Scope: recorded host-owned capability guidance for
  `task_create(kind:"agent")` `maxSteps`, keeping main/nested background agent
  task descriptors aligned with dynamic `spawn_agent` after a real mini
  underallocation canary.
- Read: `packages/host/src/tool-catalog.ts`,
  `packages/host/src/runtime.ts`, `packages/host/test/tools.test.ts`,
  `docs/_internal/project-map/maps/capabilities/agents.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/tools.test.ts -t
  "main host tool catalog"`; `npm --workspace @sparkwright/host test --
  test/spawn-agent.test.ts test/task-revival.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm run build --workspace @sparkwright/host`.

- Status: Verified
- Date: 2026-07-02T01:15:00+0800
- Scope: capability policy now includes `backgroundTasks` for task/shell/spawn
  promotion and `capabilities.agents.allowNestedBackgroundTasks` for opt-in
  depth-bounded child background agent tasks. Capability inspection shape did
  not gain a new top-level snapshot section.
- Read: `packages/host/src/config.ts`,
  `packages/host/src/config-zod-schema.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/src/tool-catalog.ts`,
  `packages/protocol/src/index.ts`,
  `schemas/config.schema.json`,
  `docs/_internal/project-map/maps/capabilities/README.md`,
  `docs/_internal/project-map/maps/capabilities/agents.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/config.test.ts
  test/run-access.test.ts test/spawn-agent.test.ts -t
  "backgroundTasks|background task policy|depth-bounded sub-agents|bounded by maxDepth"`;
  `npm run schema:check`.

- Status: Verified
- Date: 2026-06-29T09:28:39+0800
- Scope: capability inspection now exposes separate product classification
  (`defaultExposureTier`) and mechanism facts (`source`, `governance`,
  `effectiveLoading`) while public displays hide infrastructure tools.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/tool-identities.ts`,
  `packages/cli/src/cli.ts`,
  `packages/tui/src/components/capabilities-panel.tsx`,
  `packages/protocol/src/index.ts`,
  `schemas/host-message.schema.json`.
- Tests: `npm --workspace @sparkwright/host test -- test/protocol.test.ts test/config.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts test/config-schema.test.ts`;
  `npm --workspace @sparkwright/tui test -- test/capabilities-panel-render.test.tsx test/tool-request-preview.test.ts test/format-event.test.ts`;
  `npm run schema:check`.

- Status: Verified
- Date: 2026-06-28T20:30:50+0800
- Scope: capability/tool inventory origin semantics remain stable after adding
  explicit read-only governance to host `read_file`; the descriptor still
  reports `local:@sparkwright/coding-tools`, and read-only approval behavior is
  driven by governance side effects.
- Read: `packages/host/src/tools.ts`,
  `packages/host/src/tool-catalog.ts`,
  `packages/host/test/tools.test.ts`,
  `packages/host/test/protocol.test.ts`,
  `packages/core/src/policy.ts`,
  `docs/_internal/project-map/maps/capabilities/README.md`,
  `docs/_internal/project-map/modules/coding-tools.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/run-access.test.ts test/protocol.test.ts test/tools.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts test/config-schema.test.ts`;
  `npm run check:dist-fresh`.

- Status: Verified
- Date: 2026-06-28T17:59:14+0800
- Scope: Agent.md/config profile hooks now parse and compile as child-run
  guardrails for configured in-process delegates/direct/indexed/parallel
  entrypoints; JSON Schemas accept the restricted hook shape while capability
  inspection/tool inventory shape remains unchanged.
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
  `docs/_internal/project-map/maps/capabilities/README.md`,
  `docs/_internal/project-map/maps/capabilities/agents.md`,
  `docs/_internal/project-map/modules/host.md`.
- Tests: `npm --workspace @sparkwright/agent-runtime test -- test/index.test.ts`;
  `npm --workspace @sparkwright/agent-runtime run typecheck`;
  `npm --workspace @sparkwright/agent-runtime run build`;
  `npm --workspace @sparkwright/host test --
  test/config.test.ts test/agent-profiles.test.ts test/tools.test.ts
  test/workflow-hooks.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`; `npm run schema:check`;
  `npm --workspace @sparkwright/cli test -- test/config-schema.test.ts`.
- Prior verification — Date: 2026-06-28T17:51:42+0800
- Scope: Agent.md profile hooks now parse and compile as child-run guardrails for
  configured in-process delegates/direct/indexed/parallel entrypoints; capability
  inspection/tool inventory shape remains unchanged.
- Prior verification — Date: 2026-06-28T14:13:14+0800
- Scope: agents capability config now includes optional raw model defaults for
  dynamic spawn and configured in-process delegates; capability inspection model
  shape and tool inventory behavior remain unchanged.
- Tests: `npm --workspace @sparkwright/host test --
test/config.test.ts test/tools.test.ts test/protocol.test.ts`;
  `npm --workspace @sparkwright/host run typecheck`; `npm run schema:check`.
- Prior verification — Date: 2026-06-28T13:34:37+0800
- Scope: capability hook descriptors remain diagnostic-only while command
  action progress moved to the host process stderr token protocol; no tool
  inventory or blocking-potential semantics changed.
- Prior verification — Date: 2026-06-27T22:36:34+0800
- Scope: capability inspection described canonical workflow rules and
  independent event rules, including command/http/agent action summaries and
  blocking potential, without changing tool inventory behavior.
- Prior verification — Date: 2026-06-27T21:06:53+0800
- Scope: documented-command capability inspection now consumes host-owned
  built-in rule metadata shared with the active Stop hook, while preserving the
  existing conditional construction and tool inventory behavior.
- Tests: `npm --workspace @sparkwright/host test --
test/documented-command-check.test.ts test/protocol.test.ts -t "documented
command|documented-command|workflow rule"`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/protocol run typecheck`;
  `npm --workspace @sparkwright/protocol run build`;
  `npm --workspace @sparkwright/host run build`;
  `npm --workspace @sparkwright/cli test --
test/documented-command-check.test.ts`;
  `npm --workspace @sparkwright/cli test --
test/cli.test.ts -t "workflow rules in capability inspect"`;
  `npm --workspace @sparkwright/tui test --
test/capabilities-panel-render.test.tsx -t "workflow rule summaries"`;
  `npm --workspace @sparkwright/cli run typecheck`;
  `npm --workspace @sparkwright/tui run typecheck`.
- Prior verification — Date: 2026-06-27T20:24:22+0800
- Scope: recorded capability inspection ownership for
  `CapabilitySnapshot.rules.workflow` active-rule summaries; tool inventory and
  execution behavior remain unchanged.
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
- Scope: removed `toolset.ts` from capability routing and kept capability tool
  inventory anchored on host catalog entries.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/tool-catalog.ts`,
  `packages/host/src/delegate-capability.ts`,
  `packages/host/src/agent-profiles.ts`,
  `packages/host/src/agent-report.ts`,
  `docs/_internal/project-map/maps/capabilities/README.md`,
  `docs/_internal/project-map/maps/capabilities/agents.md`.
- Tests: `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/host test --
test/agent-profiles.test.ts test/skill-evolution.test.ts
test/protocol.test.ts`; `npm --workspace @sparkwright/cli test --
test/cli.test.ts -t "filters proposals|agents|capabilities inspect"`.
- Prior verification — Date: 2026-06-27T16:43:38+0800
- Scope: capability overview records indexed agent delegation as
  `delegate_agent` over non-opted-out child/all profiles, filtered direct
  delegate aliases from the shared host helper, and opt-in `delegate_parallel`
  with read-only eligibility derived from effective child tool governance.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/tool-catalog.ts`,
  `packages/host/src/delegate-capability.ts`,
  `packages/host/src/config.ts`, `packages/host/src/config-zod-schema.ts`,
  `packages/cli/src/cli.ts`,
  `packages/host/test/agent-profiles.test.ts`,
  `packages/host/test/tools.test.ts`,
  `packages/host/test/protocol.test.ts`,
  `packages/cli/test/cli.test.ts`,
  `docs/_internal/project-map/maps/capabilities/README.md`,
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
- Prior verification (delegate_parallel Phase 4a runtime) — Date: 2026-06-27T12:16:45+0800
- Scope: capability overview now routes `enableParallelDelegates` to the agents
  map and records that `delegate_parallel` appears as an opt-in tool surface
  with eligibility enforced at call time.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/tool-catalog.ts`,
  `packages/host/src/config.ts`, `packages/host/src/config-zod-schema.ts`,
  `packages/host/test/protocol.test.ts`,
  `docs/_internal/project-map/maps/capabilities/README.md`,
  `docs/_internal/project-map/maps/capabilities/agents.md`.
- Tests: `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/host test -- test/protocol.test.ts -t "delegate_parallel|reserved by an existing delegate|reserved name"`;
  `npm run schema:check`; `npm run check`.
- Prior verification (access mode) — Date: 2026-06-26T23:59:00+0800
- Read: `packages/host/src/runtime.ts`, `packages/host/src/server.ts`,
  `packages/host/src/client-run.ts`, `packages/cli/src/cli.ts`,
  `packages/cron/src/runner.ts`,
  `scripts/regression-real-skill-capabilities.mjs`,
  `packages/tui/src/state/run-controller.ts`,
  `packages/tui/src/components/capabilities-panel.tsx`,
  `packages/host/src/config.ts`, `packages/host/src/config-zod-schema.ts`,
  `packages/protocol/src/index.ts`, `schemas/host-message.schema.json`.
- Tests: `npm --workspace @sparkwright/host test -- test/config.test.ts test/client-run.test.ts test/protocol.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts`;
  `npm --workspace @sparkwright/tui test -- test/sdk-cutover.test.ts`;
  `npm run build`; `npm run check:dist-fresh`; `npm run schema:check`.
