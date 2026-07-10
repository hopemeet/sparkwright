# Design: Hooks Control Plane Refactor

> Proposed design with P0 active-rule inspection plus the first P1/P2
> compatibility slices implemented. This is not the active routing map. Current
> hook contracts still live in
> [../modules/core.md](../modules/core.md),
> [../modules/host.md](../modules/host.md),
> [../maps/runtime/run-loop.md](../maps/runtime/run-loop.md),
> [../maps/runtime/tool-orchestration.md](../maps/runtime/tool-orchestration.md),
> `packages/core/src/workflow-hooks.ts`,
> `packages/core/src/hooks.ts`, `packages/core/src/validation.ts`,
> `packages/core/src/user-hooks.ts`, and `packages/host/src/workflow-hooks.ts`.

## 1. Problem Statement

SparkWright has accumulated several hook-like extension surfaces:

- `RunHook`: low-level in-process run middleware for embedders and
  instrumentation.
- `ValidationHook`: stage-scoped validation for workspace writes, final output,
  pre-terminal gates, and post-sampling checks.
- `WorkflowHook`: deterministic project-facing lifecycle rules with matcher,
  block/rewrite/context semantics, and `workflow_hook.*` trace events.
- `UserHookRunner`: host-owned event subscribers for user-configurable
  side-effects, traced through `user_hook.*`.

The code comments already explain the intended split, but the product and
configuration model still asks maintainers to reason across four overlapping
concepts. Adding more lifecycle names or handler types before reducing this
conceptual load would make the system harder to operate, harder to document,
and easier to regress in trace, TUI, CLI, config, or verification flows.

The original design had naming drift:

- `SessionStart` and `SessionEnd` were run-level hook points in the run loop,
  not true session lifecycle hooks.
- `UserPromptSubmit` fired before each turn's prompt/model boundary, not only
  when a user submitted a prompt.
- `RunHook.beforeToolCall` can skip a tool call, which overlaps with
  `WorkflowHook` `PreToolUse` blocking.
- `ValidationHook.pre_terminal` overlaps with `WorkflowHook` `Stop`, and
  `ValidationHook.post_sampling` overlaps with non-blocking `ModelOutput`
  observation.
- `UserHookRunner` and configured command workflow hooks both represented
  user/host automation, but one was event-subscription shaped and one was
  lifecycle-rule shaped.

The first implementation pass made active rules inspectable. The follow-up
checkpoint applied the clean pre-adoption decision: remove legacy lifecycle
values instead of carrying compatibility, move non-blocking subscribers to a
separate `capabilities.hooks.events` lane, keep trace payloads to one canonical
`hook` field, and add the concrete `http` and `agent` action transports.

## 2. Goals

- Make one project-facing rule system the default mental model.
- Keep core responsible for lifecycle, matcher evaluation, result semantics,
  and event contracts.
- Keep host responsible for external execution such as shell commands, HTTP
  calls, and delegate-agent actions.
- Preserve project integrity during the clean rename: update config/schema,
  trace docs, capability inspection, CLI/TUI consumers, and focused tests
  together.
- Clarify lifecycle semantics in docs and inspection output using the canonical
  names directly.
- Reduce future feature work to adding actions/matchers to one control plane,
  not adding parallel hook systems.

## 3. Non-Goals

- Do not remove `RunHook`, `ValidationHook`, or `UserHookRunner` in the first
  implementation phase.
- Do not rename persisted event families in the first phase.
- Do not change tool approval, workspace write, or verification semantics while
  introducing the control plane.
- Do not keep legacy lifecycle aliases or dual trace fields after the clean
  rename checkpoint.
- Do not add prompt actions, a `PostToolBatch` lifecycle, or a separate
  non-blocking workflow observe mode in this checkpoint.
- Do not introduce a large lifecycle vocabulary. Prefer richer matchers and
  payload metadata over new hook names.

## 4. Current Source Facts

Verified by reading source during the design pass:

- `packages/core/src/workflow-hooks.ts` defines lifecycle names, matchers,
  `WorkflowHookResult`, rewrite patches, error behavior, and emits
  `workflow_hook.started|completed|blocked|failed`.
- `packages/host/src/workflow-hooks.ts` compiles configured workflow hooks into
  core hooks and implements `block`, `context`, `command`, `http`, and `agent`
  actions. Command actions run through `TracedProcessRunner`; event hooks are
  bound through `bindUserHooks()`.
- `packages/host/src/config-zod-schema.ts` is the generated config schema
  source for workflow hook names, matcher fields, action types, and allowed
  nested keys.
- `packages/core/src/run.ts` invokes workflow hooks at `RunStart`,
  `TurnStart`, `ModelOutput`, `PreToolUse`, `PostToolUse`, `Stop`, `RunEnd`,
  and `RuntimeSignal` points.
- `packages/core/src/hooks.ts` still supports `RunHook.beforeToolCall` skip
  decisions, but its own maintenance note says project policy should prefer
  workflow hooks.
- `packages/core/src/validation.ts` still owns `ValidationHook` stages including
  `workspace_write`, `pre_terminal`, `final_output`, and `post_sampling`.
- `packages/core/src/workspace.ts` calls validation hooks directly for
  workspace write proposals. That path cannot be deleted casually.
- `packages/core/src/user-hooks.ts` defines a host-runner event subscription
  model and emits `user_hook.*` events; it is non-blocking by design.
- `packages/host/src/verification.ts` already compiles verification profiles
  into workflow hooks, including post-write command checks and a Stop gate.
- `packages/host/src/documented-command-check.ts` creates a built-in Stop hook
  using goal-sensitive heuristics.
- TUI/CLI capability inspection displays host-owned `rules.workflow` and
  `rules.events` descriptors; TUI event formatting still gives
  `workflow_hook.*` payloads special treatment.

## 5. Target Model

Use `WorkflowHook` as the project-facing awaited control plane. Current wire,
SDK, and config lifecycle names are canonical-only:

- `RunStart` (run-level start; not true session lifecycle)
- `TurnStart` (per-turn pre-model/prompt boundary)
- `ModelOutput`
- `PreToolUse`
- `PostToolUse`
- `Stop`
- `RunEnd` (run-level terminal notification; currently fire-and-forget)
- `RuntimeSignal`

Legacy lifecycle values are deleted rather than accepted as aliases. Trace
payloads carry only the canonical `hook` lifecycle field.

`WorkflowHookResult` remains the unified result protocol:

- `continue`: optionally inject context and metadata.
- `block`: asks the current lifecycle point to stop, redirect, or report a
  failure. The runtime effect is lifecycle-specific; see the effect table below.
- `rewrite`: mutates supported inputs, currently `PreToolUse` arguments.
- `skipped`: records an intentional no-op.

Command, HTTP, and agent actions compile into this same result protocol instead
of creating new hook result envelopes. Prompt actions remain out of scope.

### Lifecycle Effect Table

The result protocol is shared, but lifecycle effects are not identical. Any new
action or adapter must preserve these effects unless a separate semantic change
is explicitly designed.

| Lifecycle       | `block` effect                                                                                                                    | `rewrite` effect                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `RunStart`      | Fails the run with `hook_stopped` / `WORKFLOW_HOOK_BLOCKED`.                                                                      | No current effect.                                                            |
| `TurnStart`     | Fails the run with `hook_stopped` / `WORKFLOW_HOOK_BLOCKED`.                                                                      | No current effect.                                                            |
| `ModelOutput`   | Adds continuation context and advances to another model turn.                                                                     | No current effect.                                                            |
| `PreToolUse`    | Synthesizes a failed `ToolResult` (`TOOL_BLOCKED_BY_WORKFLOW_HOOK`) and lets the run continue.                                    | Rewrites requested tool arguments before budget/repeat/policy/tool execution. |
| `PostToolUse`   | Adds continuation context after the completed/failed tool result; it does not undo the tool result.                               | No current effect.                                                            |
| `Stop`          | Adds continuation context and advances to another model turn instead of completing.                                               | No current effect.                                                            |
| `RunEnd`        | Current call site is fire-and-forget; a block can emit hook lifecycle events but does not change the already-terminal run result. | No current effect.                                                            |
| `RuntimeSignal` | Can fail/stop the run when called from an awaited runtime-signal gate.                                                            | No current effect.                                                            |

This table is the contract that makes the shared result protocol honest: it
unifies how handlers report intent, not how every lifecycle applies that intent.

## 6. Ownership Boundaries

Core owns:

- workflow lifecycle names;
- matcher evaluation;
- `WorkflowHookResult` normalization;
- lifecycle execution order;
- `workflow_hook.*` event emission and payload hygiene;
- compatibility adapters from low-level in-process hook surfaces where needed.

Host owns:

- config loading and schema validation;
- command execution through `TracedProcessRunner`;
- HTTP and delegate-agent hook action implementations;
- rule-pack compilation such as verification and documented-command checks;
- capability inspection for configured and built-in rules.

CLI/TUI/protocol own:

- display and wire compatibility for existing event families;
- run/capability inspect output that explains which rules are active.

## 7. Migration Plan

### P0: Active Rule Inspection, No Lifecycle Rename

- Done: created a host-owned active-rule descriptor model that can describe
  configured workflow hooks, verification invariants,
  documented-command
  built-ins, and future rule packs without changing their executors.
- Done: exposed rule source (`config`, `verification`, `builtin`, later `user`),
  lifecycle, matcher summary, action kind, blocking potential, enabled/active
  status, and disable/configuration hints where available.
- Keep existing workflow lifecycle wire/config names unchanged. Use clearer
  display labels in inspect output instead of adding aliases.
- Done: surfaced active rules through capability inspection and CLI/TUI consumers
  that already consume capability snapshots.
- Done: added tests for the descriptor model and inspect output without changing
  run behavior, trace payloads, or config schemas.

### P1: Make Built-In Rules Explicit

- Done: converted the documented-command Stop hook into a host-owned,
  inspectable built-in rule pack with constants and activation evaluation; P1.5
  now compiles it as a degenerate verifier instead of using a compatibility
  Stop-hook wrapper.
- Done: chose the compatibility fallback for now. Host still only constructs
  the Stop hook when the existing goal/write heuristic is active, avoiding new
  `workflow_hook.*` events for runs where the guard was previously absent.
- Done: kept the old heuristic as the activation default and annotated active
  hook results with `source: "builtin"`, rule name, activation reason, and issue
  counts.
- Done: active-rule inspection now consumes the host-owned built-in rule
  metadata so CLI/TUI users can see:
  - whether it is enabled;
  - whether it is currently active or only available under conditions;
  - which lifecycle it runs at;
  - whether it can block;
  - how to disable or configure it.

### P2: Document And Demote Overlapping Low-Level Surfaces

- Done: keep `RunHook` for SDK/plugin/telemetry, but stop recommending
  `RunHook.beforeToolCall.skip` for project policy.
- Done: keep `ValidationHook` for SDK and workspace-write internals, and
  document it as a lower-level surface. New project-facing validation should
  compile into workflow rules or rule packs.
- Still true: keep `workspace_write` validation in place unless a specific
  write-proposal workflow hook is designed and proven against approvals/write
  guardrails.
- Done: updated reference docs with the lifecycle effect table and replaced the
  old session-shaped names with `RunStart`, `TurnStart`, and `RunEnd`.

### P3: Canonical Name Checkpoint

- Done as a clean rename, not a compatibility alias slice. Core and host now use
  `RunStart`, `TurnStart`, `ModelOutput`, `PreToolUse`, `PostToolUse`, `Stop`,
  `RunEnd`, and `RuntimeSignal`.
- Done: old lifecycle values were removed from core types, run-loop call sites,
  config schema/loader paths, inspection descriptors, trace docs, and tests.
- Done: `workflow_hook.*` payloads carry one canonical lifecycle field,
  `hook`; old configured/alias/mode payload fields were removed.

### P4: Add A Non-Blocking Event Lane

- Done: non-blocking configured subscribers live under
  `capabilities.hooks.events`, separate from awaited
  `capabilities.hooks.workflow` entries.
- Done: event rules bind through `bindUserHooks()` / `UserHookRunner`, emit
  `user_hook.*` and action evidence, report `blockingPotential: false` in
  capability inspection, and do not block, rewrite, or inject workflow context.
- Still future: broader user-hook fusion and richer event-trigger vocabulary.
  The `user_hook.*` event family remains.

### P5: Add New Actions Only After The Control Plane Is Stable

- Done: extended command actions with `resultMode: "stdoutJson"` so a successful
  command can return a JSON `WorkflowHookResult` (`continue`, `block`,
  `rewrite`, or `skipped`).
- Done: added HTTP actions with status/injection behavior and
  `resultMode: "responseJson"` for workflow result parsing.
- Done: added agent actions targeting configured delegate agents by `agentId` or
  `toolName`, with `resultMode: "workflowResult"` for workflow result parsing.
- Still future: prompt actions and lifecycle additions such as `PostToolBatch`.
  Agent hook actions cannot prompt for delegate-spawn approval; targets that
  require approval fail closed through hook error handling.

## 8. Deletions And Deprecations

Because this project had not been adopted yet, the clean checkpoint deletes
redundant compatibility instead of keeping aliases:

- Removed lifecycle values:
  - `SessionStart` -> `RunStart`
  - `UserPromptSubmit` -> `TurnStart`
  - `SessionEnd` -> `RunEnd`
- Removed workflow-hook `mode` and the in-workflow observe lane; use
  `capabilities.hooks.events` instead.
- Removed duplicate trace payload lifecycle fields; use `hook`.
- Deprecated recommendation, not API:
  - `RunHook.beforeToolCall.skip` for project policy.
- Frozen lower-level surface:
  - `ValidationHook` for new project-facing config semantics.
- Long-term event subscriber executor:
  - `UserHookRunner` as the host event lane behind `capabilities.hooks.events`.

## 9. Test Strategy

Focused tests:

- active-rule descriptors include configured workflow hooks, configured event
  hooks, verification hooks, and documented-command built-ins without changing
  existing run-loop behavior;
- capability inspect / CLI / TUI surfaces show rule source, lifecycle, action,
  matcher summary, blocking potential, enabled/active status, and disable hints
  where available;
- documented-command built-in rule inspectability and compatibility default;
- block/rewrite/context effect table is reflected in reference docs;
- `RunHook.beforeToolCall.skip` and `ValidationHook.workspace_write` remain
  supported but are not recommended for new project-facing policy;
- generated config schema reflects canonical lifecycle names,
  `capabilities.hooks.events`, and command/http/agent action keys;
- verification after-write and Stop gate behavior unchanged;
- CLI trace formatting for workflow hooks and verification hooks remains
  compatible;
- TUI event formatting for existing payloads remains compatible;
- trace diagnostics and run-outcome logic still recognize verification hook
  completions;
- trace payload fixtures use the single canonical `hook` lifecycle field.

Suggested focused commands:

```bash
npm --workspace @sparkwright/core test -- test/workflow-hooks.test.ts
npm --workspace @sparkwright/host test -- test/protocol.test.ts
npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "workflow and event rules"
npm --workspace @sparkwright/tui test -- test/capabilities-panel-render.test.tsx -t "workflow rule summaries"
npm run typecheck
npm run schema:check
```

Broader change gates should include the project-map drift script and, for
cross-package changes, `npm run release:check`.

## 10. Risks

- Event compatibility: the project accepted a clean break before adoption.
  Downstream CLI/TUI/trace/schema consumers must be updated in lockstep because
  old lifecycle values and duplicate payload fields are gone.
- Config compatibility: old lifecycle names and `mode: "observe"` are invalid.
  Migrate non-blocking subscribers to `capabilities.hooks.events`.
- Workspace writes: validation hooks are still wired directly into write
  proposals; replacing them prematurely risks bypassing write guardrails.
- Verification semantics: verification profiles are already implemented as
  workflow hooks; canonical lifecycle names and metadata normalization must not
  break stop gates.
- Hidden rules: making built-ins explicit can change perceived behavior even if
  runtime behavior stays the same. Inspect output and trace metadata should make
  the transition understandable.
- Executor semantics: `UserHookRunner` is non-blocking while workflow hooks are
  generally awaited. Keep `capabilities.hooks.events` visibly separate from
  awaited workflow gates.
- Scope creep: prompt actions, broad event-trigger vocabularies, and batch
  lifecycle points remain separate design work.

## 11. Open Questions

- Should non-blocking event observation expand beyond the current run/model/tool
  and budget triggers to include `approval.*`, `workspace.write.*`,
  `artifact.*`, or `interaction.*` triggers?
- Should non-blocking observation rules keep emitting `user_hook.*` forever?
  Current decision: yes; no `workflow_hook.*` mode field.
- Is a dedicated write-proposal workflow hook worth adding, or should
  `ValidationHook.workspace_write` remain the permanent low-level gate?

## Review Prompt

Use this prompt in a fresh review window after this checkpoint:

```text
Use the map-driven-dev skill. Continue from the proposed internal design at
docs/_internal/project-map/designs/hooks-control-plane-refactor.md.

Goal: review or extend the completed P3/P4/P5 hooks control-plane checkpoint.
The current contract is canonical-only workflow lifecycle names, no old
lifecycle aliases, `workflow_hook.*` payloads with one `hook` lifecycle field,
non-blocking subscribers under `capabilities.hooks.events`, and command/http/agent
actions in the host-owned hook action runner.

Expected implementation shape:
1. Read the project map and source files listed below.
2. Identify the existing capability.inspect snapshot shape and CLI/TUI
   consumers before changing descriptor shape.
3. Preserve the host-owned active-rule descriptor model with source,
   lifecycle/trigger, matcher/action summary, blocking potential,
   enabled/active status, and disable/configuration hints where available.
4. Preserve descriptor coverage for:
   - configured capabilities.hooks.workflow entries;
   - configured capabilities.hooks.events entries;
   - capabilities.verification generated hooks/rules;
   - documented-command built-in rule availability/activation.
5. Update CLI/TUI/protocol/schema consumers only as needed.
6. Add focused tests for host capability inspection, CLI output, TUI formatting,
   and any new action transport touched.
7. Update the relevant project-map pages in the same change. Remember
   docs/_internal is gitignored, so stage internal docs with git add -f if
   committing.

Do not implement:
- legacy lifecycle compatibility aliases;
- a new `resolveWorkflowHookName` alias-normalization path;
- prompt actions;
- a workflow-hook `mode` or non-blocking observe lane;
- new hook actions beyond a concrete feature's need;
- rewiring UserHookRunner or ValidationHook executors.

Start by reading:
- docs/_internal/project-map/README.md
- docs/_internal/project-map/designs/hooks-control-plane-refactor.md
- docs/_internal/project-map/modules/core.md
- docs/_internal/project-map/modules/host.md
- docs/_internal/project-map/maps/runtime/run-loop.md
- docs/_internal/project-map/maps/runtime/tool-orchestration.md
- docs/_internal/project-map/maps/trace/raw-trace.md
- packages/core/src/workflow-hooks.ts
- packages/core/src/hooks.ts
- packages/core/src/validation.ts
- packages/core/src/user-hooks.ts
- packages/core/src/run.ts
- packages/core/src/workspace.ts
- packages/host/src/workflow-hooks.ts
- packages/host/src/config-zod-schema.ts
- packages/host/src/config.ts
- packages/host/src/runtime.ts
- packages/host/src/verification.ts
- packages/host/src/documented-command-check.ts
- packages/host/src/tool-catalog.ts
- packages/cli/src/cli.ts
- packages/tui/src/components/capabilities-panel.tsx
- packages/tui/src/lib/format-event.ts
- packages/protocol/src/index.ts
- schemas/config.schema.json
- schemas/host-message.schema.json
```

## Last Verified

- Status: Verified
- Date: 2026-07-04T22:20:04+0800
- Scope: workflow-runtime-v1 D25 active-rule/control-plane wording:
  verification and documented-command are described as built-in run-level
  invariants, not user-authored workflow nodes, while configured workflow hooks
  and explicit workflow projections remain separate producers.
- Read: `packages/host/src/active-rules.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/src/verification.ts`,
  `packages/host/src/documented-command-check.ts`,
  `packages/host/test/workflow-hooks.test.ts`,
  `packages/host/test/protocol.test.ts`,
  `packages/cli/test/cli.test.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/host test --
test/workflow-hooks.test.ts test/protocol.test.ts -t
"runtime workflow hook assembly|includes active workflow rule descriptors"`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "shows
workflow and event rules in capability inspect text output"`; `npm run check`;
  `npm run release:check`.

- Status: Verified
- Date: 2026-06-27T22:36:34+0800
- Scope: P3/P4/P5 clean checkpoint was implemented. P3 removed legacy lifecycle
  values and duplicate trace fields, P4 split non-blocking subscribers into
  `capabilities.hooks.events`, and P5 added command/http/agent action paths.
  Prompt actions, expanded event trigger vocabulary, batch lifecycles, and
  executor rewiring remain future work.
- Read: `docs/_internal/project-map/README.md`,
  `docs/_internal/project-map/maintenance/doc-maintenance.md`,
  `docs/_internal/project-map/modules/core.md`,
  `docs/_internal/project-map/modules/host.md`,
  `docs/_internal/project-map/modules/cli.md`,
  `docs/_internal/project-map/modules/tui.md`,
  `docs/_internal/project-map/modules/protocol.md`,
  `docs/_internal/project-map/maps/capabilities/README.md`,
  `docs/_internal/project-map/maps/runtime/run-loop.md`,
  `docs/_internal/project-map/maps/runtime/tool-orchestration.md`,
  `docs/_internal/project-map/maps/trace/raw-trace.md`,
  `packages/core/src/user-hooks.ts`,
  `packages/core/src/workflow-hooks.ts`,
  `packages/host/src/active-rules.ts`,
  `packages/host/src/workflow-hooks.ts`,
  `packages/host/src/config-zod-schema.ts`, `packages/host/src/config.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/src/verification.ts`,
  `packages/host/src/documented-command-check.ts`,
  `packages/host/src/tool-catalog.ts`, `packages/cli/src/cli.ts`,
  `packages/tui/src/components/capabilities-panel.tsx`,
  `packages/protocol/src/index.ts`, `schemas/config.schema.json`,
  `schemas/host-message.schema.json`,
  `docs/reference/EXTENSION_INTERFACES.md`, `docs/reference/PROTOCOL.md`,
  `docs/guides/CONFIGURATION.md`,
  `packages/host/builtin/skills/sparkwright-manual/references/configuration.md`.
- Tests: `npm --workspace @sparkwright/core test --
test/workflow-hooks.test.ts test/user-hooks.test.ts`;
  `npm --workspace @sparkwright/host test -- test/workflow-hooks.test.ts
test/config.test.ts test/protocol.test.ts -t "workflow|event|http|agent|stdoutJson|configured
workflow hooks|active workflow rule"`; `npm --workspace @sparkwright/core run
typecheck`; `npm --workspace @sparkwright/protocol run build`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/host run build`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "workflow and event rules"`;
  `npm --workspace @sparkwright/tui test --
test/capabilities-panel-render.test.tsx -t "workflow rule summaries"`;
  `npm --workspace @sparkwright/cli run typecheck`;
  `npm --workspace @sparkwright/tui run typecheck`; `npm run schema:generate`;
  `npm run schema:check`.
- Prior verification — Date: 2026-06-27T21:06:53+0800
- Scope: P1/P2 compatibility slices were implemented after P0. The
  documented-command guard is now an explicit built-in rule pack with shared
  inspection metadata and active hook result metadata; reference docs now carry
  the workflow lifecycle effect table and low-level hook guidance. Lifecycle
  names, aliases, actions, executor wiring, and inactive built-in hook
  registration remain unchanged.
- Tests: `npm --workspace @sparkwright/host test --
test/documented-command-check.test.ts test/protocol.test.ts -t "documented
command|documented-command|workflow rule"`; `npm --workspace @sparkwright/host
run typecheck`; `npm --workspace @sparkwright/protocol run typecheck`;
  `npm --workspace @sparkwright/protocol run build`;
  `npm --workspace @sparkwright/host run build`;
  `npm --workspace @sparkwright/cli test -- test/documented-command-check.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "workflow
rules in capability inspect"`; `npm --workspace @sparkwright/tui test --
test/capabilities-panel-render.test.tsx -t "workflow rule summaries"`;
  `npm --workspace @sparkwright/cli run typecheck`;
  `npm --workspace @sparkwright/tui run typecheck`.
- Prior verification — Date: 2026-06-27T20:24:22+0800
- Scope: P0 active-rule inspection was implemented through host-owned
  workflow-rule descriptors on `CapabilitySnapshot.rules.workflow`, with CLI/TUI
  display and focused tests; lifecycle names, aliases, actions, and executors
  were left unchanged.
- Tests: `npm --workspace @sparkwright/host test --
test/protocol.test.ts -t "workflow rule|documented-command built-in"`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts -t "workflow
rules in capability inspect"`; `npm --workspace @sparkwright/tui test --
test/capabilities-panel-render.test.tsx -t "workflow rule summaries"`;
  `npm --workspace @sparkwright/protocol run typecheck`;
  `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/cli run typecheck`;
  `npm --workspace @sparkwright/tui run typecheck`; `npm run schema:check`.
