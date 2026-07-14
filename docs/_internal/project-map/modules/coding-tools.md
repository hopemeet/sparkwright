# Coding Tools

## Purpose

Coding tools are the model-facing file, search, edit, bash, skill, task, agent,
MCP, and cron tools assembled for local repository automation.

See also [../maps/runtime/tool-orchestration.md](../maps/runtime/tool-orchestration.md), [../maps/safety/workspace-writes.md](../maps/safety/workspace-writes.md), and [../maps/safety/shell.md](../maps/safety/shell.md).

## Main Files

- `packages/host/src/tool-catalog.ts`
- `packages/host/src/tool-selectors.ts`
- `packages/host/src/tools.ts`
- `packages/host/src/shell.ts`
- `packages/project-context/src/index.ts`
- `packages/coding-tools/src/index.ts` — named public facade and tool factories
- `packages/coding-tools/src/unified-diff.ts` — pure unified-diff parsing and application leaf
- `packages/core/src/tools.ts`
- `packages/core/src/workspace.ts`
- `packages/core/src/anchored-edit.ts`

## Owns / Does Not Own

Owns:

- concrete tool definitions exposed by host and CLI paths
- host catalog classification for model-facing coding/search/edit tools
- validation of tool arguments near tool boundaries
- mapping managed capability mutations to safe tool surfaces
- shell tool wrapping and promotion behavior in host

Does not own:

- core policy decisions
- approval UX
- run loop scheduling
- trace file format

## Contracts

- Workspace mutation must go through core policy, approval, event, and artifact paths.
- Default public model-facing coding names are `read`, `write`, `edit`, `bash`,
  `glob`, and `grep`; implementation names are legacy aliases and should not
  appear in new prompt guidance or user docs.
- `write` is the whole-file create/replace surface for new files and nested
  paths; it uses the same workspace write path as anchored edits and patches
  and belongs to the `workspace.write` selector.
- `write`, `edit_anchored_text`, and `edit` mark their governance
  origin metadata with `managedWorkspaceWrite: true`; write-enabled runs use
  that marker to route mutations through the managed `workspace.write` diff
  approval path instead of treating the tool call itself as the write boundary.
- Shell is classified by `@sparkwright/shell-tool` and gated by policy/approval.
- Shell's only per-call foreground budget field is `foregroundTimeoutMs`;
  unknown legacy `timeoutMs` input fails the closed schema and no alias fields
  remain in the public result.
- Explicit background shell calls detach only after that gate, distinguish
  explicit origin from timeout promotion, support job/service lifecycle hints,
  and reuse an equivalent active explicit task before spawning a process.
- Shell embedders use the neutral `onBackground` handoff and new host records use
  `shell.background`; deprecated `onPromote` and active legacy
  `shell.promoted` records remain compatibility inputs.
- The handoff carries the resolved `{ awaited, lifetime }` policy, so hosts do
  not re-derive execution semantics from `backgroundOrigin`.
- `task_create` remains eager on the main host catalog, while existing-task
  control stays an advanced deferred capability loaded through `tool_search`.
  Shell returns the concrete task id and treats the task-start observation plus
  early output as launch confirmation; it points to wait/output/stop only when
  those operations are actually needed.
- Managed capability files should use dedicated tools instead of raw shell writes.
- Tool results should be compact enough for model context and trace summaries.
- Read/discovery/search tools should declare thin `resultPresentation` hints
  (`file_read`, `file_discovery`, `text_search`) plus factual output fields
  needed by observation formatters. `grep` owns text-search counts and scope
  facts (`filesScanned`, `filesMatched`, `matchesReturned`, truncation flags,
  and effective include/scope); `list_dir` owns discovery count/limit facts.
- Coding tools can implement `ToolDefinition.validateInput()` for semantic
  argument checks that should run after JSON schema validation and before
  policy/approval. The current migrated checks cover pure argument/path shape
  and normalization issues such as write/edit directory targets, invalid grep
  regexes, empty glob patterns, and shell argument shape. They must not probe a
  target file's existence or type directly before policy/approval; concrete
  paths containing `*`, `?`, or `[` are treated as literal paths and target
  filesystem errors are left to the workspace-backed execute path. Risk/security
  classification remains in `policyForArgs()` and policy.
- Optional glob arrays such as `grep.include` and `exclude` ignore blank
  string entries before normalization, so model-produced `include:[""]` does
  not collapse a search into a match-nothing filter. Required glob patterns
  still reject empty strings.
- Tool request previews belong on the concrete `ToolDefinition.previewArgs()`
  next to the argument schema. Read/search/write coding tools, shell, skills,
  and dynamic `spawn_agent` provide one-line previews that the core run loop
  copies to `tool.requested.payload.preview`.
- Project-context file-tool guidance tells the model to run relevant known
  verification after successful writes instead of re-reading just-written or
  unchanged files.
- Project-context `todo_planning` is the model-visible authority for when to
  use `todo_write`: it appears only when `todo_write` is in the live inventory,
  while the tool schema carries only structural/status/evidence rules.
- Main, dynamic child, configured delegate child, and CLI diagnostic coding
  tool exposure should flow through the host tool catalog before reaching
  runtime, direct-core/cron runs, and capability snapshots. Dynamic children
  default to read-only tools; managed write tools are present in the dynamic
  child catalog only for explicit spawn-time workspace-write grants and still
  flow through normal tool filtering.
- Top-level `tools.use` filters the catalog by source/capability selectors
  before model-facing descriptors are built; `tools.allowed` and
  `tools.disabled` then filter concrete tool names, and `tools.defer` only
  affects schema loading for the remaining tools.
- Coding-source tools must stay classified into exactly one workspace selector
  list (`workspace.read` or `workspace.write`) in `tool-selectors.ts`.

## Consumers

- Core tool orchestration.
- Host runtime tool catalog and assembly.
- CLI capability inspection, direct-core diagnostics, and cron runner setup.
- Trace summary/timeline diagnostics.

## Change Checklist

- Check policy metadata and side-effect declarations for new tools.
- Check trace payload size and result summarization.
- Check approval and workspace write events.
- Check CLI/TUI rendering for new tool event patterns.

## Known Debts

- Repeated tool calls and noisy reads are current trace pain points.
- Some tools live across multiple packages, so "tool behavior" is not one file; `tool-catalog.ts` is the routing point for host exposure, not the owner of each tool body.
- The retired direct-core `append_file` harness should stay retired; write
  smokes should use `write`, `edit_anchored_text`, or `edit`.

## Last Verified

- Status: Verified
- Date: 2026-07-15T07:31:13+0800
- Scope: mechanically moved unified-diff parsing and application into a pure
  implementation leaf. Public named exports, tool schemas, workspace write
  routing, containment, and policy behavior are unchanged.
- Read: `packages/coding-tools/src/index.ts`,
  `packages/coding-tools/src/unified-diff.ts`,
  `packages/coding-tools/test/index.test.ts`.
- Tests: coding-tools test/typecheck/build; Host tools downstream test; import,
  facade, package-boundary, deterministic repo-pilot, and map-drift gates.

- Status: Verified
- Date: 2026-07-14T14:35:00+0800
- Scope: P6 routed review; tool catalog behavior and coding-tool ownership are
  unchanged by the workspace lease import rename.
- Tests: Host tool catalog/full suite passed.

- Status: Verified
- Date: 2026-07-14
- Scope: reviewed Host tool catalog during execution refactor; coding-tool
  ownership and write admission remain unchanged.

- Status: Verified
- Date: 2026-07-14
- Scope: live Host catalogs now wrap managed coding mutation execution in the
  process-local workspace lease; tool-owned Core policy, containment, and
  `workspace.write.*` event semantics are unchanged.
- Read: Host catalog/coordinator wrapper and coding tool write boundaries.
- Tests: focused Host coding/Agent/coordinator suites, all workspace tests, and
  release smokes passed. Touched files are format-clean; the global format scan
  is blocked only by pre-existing dirty proposal docs outside this change.

- Status: Read-only
- Date: 2026-07-12T20:00:00+0800
- Scope: checked Markdown Agent write/remove compatibility; it uses the existing
  workspace capability-write boundary and does not change coding-tool ownership.
- Read: host Agent manager and capability mutation helper.
- Tests: focused host tools and full release gate; no module contract change.

- Status: Read-only
- Date: 2026-07-12
- Scope: checked Markdown Agent write routing; existing workspace-write tooling contract remains unchanged.
- Tests: focused host tool tests passed; release gate pending.

- Status: Verified
- Date: 2026-07-11T22:55:00+0800
- Scope: canonical shell foreground timeout contract and background launch
  confirmation guidance.
- Read: `packages/shell-tool/src/tool.ts`, shell/host integration tests.
- Tests: full `npm run release:check`.

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
- Scope: shell direct-background origin, service grace, approval-before-detach,
  and active-task deduplication.
- Read: `packages/shell-tool/src/tool.ts`, `packages/host/src/shell.ts`, focused
  shell tests.
- Tests: shell-tool and host focused suites; package typechecks.

- Status: Verified
- Date: 2026-07-08T14:42:08+0800
- Scope: dynamic child catalog now includes managed write tools for
  spawn-time grants while default dynamic child requests remain read-only and
  still pass through host tool filtering.
- Read: `packages/host/src/tool-catalog.ts`,
  `packages/host/src/agent-spawn-grants.ts`,
  `packages/host/src/runtime.ts`,
  `packages/coding-tools/src/index.ts`.
- Tests: `npm test -w @sparkwright/host -- tools.test.ts spawn-agent.test.ts`;
  `npm run typecheck -w @sparkwright/host`.

- Status: Verified
- Date: 2026-07-05T21:40:16+0800
- Scope: workflow-runtime-v1 P6a self-hosting todo doctrine: project-context's
  tool-gated `todo_planning` section is the single cadence source for
  `todo_write`; child/read-only inventories without `todo_write` do not receive
  the guidance.
- Read: `packages/project-context/src/index.ts`,
  `packages/project-context/test/index.test.ts`,
  `packages/agent-runtime/src/todo/tools.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: `npm --workspace @sparkwright/project-context test --
test/index.test.ts -t "todo-planning"`; `npm --workspace
@sparkwright/project-context run typecheck`.

- Status: Verified
- Date: 2026-07-01T22:09:33+0800
- Scope: real-model grep QA exposed `include:[""]`; optional glob array
  normalization now ignores blank entries while preserving required empty glob
  validation.
- Read: `packages/coding-tools/src/index.ts`,
  `packages/coding-tools/test/index.test.ts`,
  `docs/_internal/project-map/modules/coding-tools.md`.
- Tests: `npm --workspace @sparkwright/coding-tools test -- test/index.test.ts`;
  `npm --workspace @sparkwright/coding-tools run typecheck`;
  real CLI run with `openai/gpt-5.4-nano` on
  `/tmp/sparkwright-real-observation.lzEfXd`.

- Status: Verified
- Date: 2026-07-01T20:51:06+0800
- Scope: coding tools expose thin result-presentation hints and grep/list_dir
  output facts for observation/report consumers without changing policy or
  workspace effects.
- Read: `packages/coding-tools/src/index.ts`,
  `packages/coding-tools/test/index.test.ts`,
  `packages/core/src/tools.ts`,
  `docs/_internal/project-map/modules/coding-tools.md`.
- Tests: `npm --workspace @sparkwright/coding-tools test -- test/index.test.ts`;
  `npm --workspace @sparkwright/coding-tools run typecheck`;
  `npm --workspace @sparkwright/host run typecheck`.

- Status: Verified
- Date: 2026-07-01T11:56:08+0800
- Scope: rechecked semantic `validateInput()` boundaries for coding tools and
  host read after removing pre-policy target stat/glob-character rejection.
- Read: `packages/coding-tools/src/index.ts`,
  `packages/coding-tools/test/index.test.ts`, `packages/host/src/tools.ts`,
  `packages/host/test/tools.test.ts`,
  `docs/_internal/project-map/modules/coding-tools.md`.
- Tests: `npm --workspace @sparkwright/coding-tools test -- test/index.test.ts`;
  `npm --workspace @sparkwright/host test -- test/tools.test.ts`;
  `npm --workspace @sparkwright/coding-tools run typecheck`;
  `npm --workspace @sparkwright/host run typecheck`.

- Status: Verified
- Date: 2026-06-30T23:59:00+0800
- Scope: semantic `validateInput()` checks for coding tools and host read,
  with execute/approval left to the core run-loop ordering.
- Read: `packages/coding-tools/src/index.ts`,
  `packages/coding-tools/test/index.test.ts`, `packages/host/src/tools.ts`,
  `packages/host/test/tools.test.ts`,
  `docs/_internal/project-map/modules/coding-tools.md`.
- Tests: `npm --workspace @sparkwright/coding-tools test -- test/index.test.ts`;
  `npm --workspace @sparkwright/host test -- test/tools.test.ts`;
  `npm --workspace @sparkwright/coding-tools run typecheck`;
  `npm --workspace @sparkwright/host run typecheck`.

- Status: Verified
- Date: 2026-06-29T09:28:39+0800
- Scope: coding tool exposure consolidated to public `read`, `write`, `edit`,
  `bash`, `glob`, and `grep`; anchored verified edit remains an advanced
  deferred pair and legacy implementation names are aliases only.
- Read: `packages/host/src/tool-identities.ts`,
  `packages/host/src/tools.ts`, `packages/host/src/tool-catalog.ts`,
  `packages/host/src/tool-selectors.ts`,
  `packages/coding-tools/src/index.ts`,
  `packages/host/test/tools.test.ts`.
- Tests: `npm --workspace @sparkwright/host test -- test/tools.test.ts test/protocol.test.ts test/config.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts test/config-schema.test.ts`.

- Status: Verified
- Date: 2026-06-28T20:30:50+0800
- Scope: host-wrapped coding tool `read_file` now carries explicit read-only
  governance side effects while preserving the `local:@sparkwright/coding-tools`
  catalog origin and existing repeated-read behavior.
- Read: `packages/host/src/tools.ts`,
  `packages/host/src/tool-catalog.ts`,
  `packages/host/test/tools.test.ts`,
  `packages/core/src/policy.ts`,
  `docs/_internal/project-map/modules/coding-tools.md`,
  `docs/_internal/project-map/maps/runtime/tool-orchestration.md`,
  `docs/_internal/project-map/maps/capabilities/README.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/run-access.test.ts test/protocol.test.ts test/tools.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts test/config-schema.test.ts`;
  `npm run check:dist-fresh`.

- Status: Verified
- Date: 2026-06-27T19:27:28+0800
- Scope: removed the unreferenced `host/src/toolset.ts` compatibility wrapper;
  host tool exposure now routes directly through `tool-catalog.ts` and
  `catalogToolDefinitions()`.
- Read: `packages/host/src/tool-catalog.ts`,
  `packages/host/src/runtime.ts`,
  `packages/host/src/server.ts`,
  `docs/_internal/project-map/modules/coding-tools.md`,
  `docs/_internal/project-map/maps/runtime/tool-orchestration.md`,
  `docs/_internal/project-map/maps/capabilities/README.md`.
- Tests: `npm --workspace @sparkwright/host run typecheck`;
  `npm --workspace @sparkwright/host test --
test/agent-profiles.test.ts test/skill-evolution.test.ts
test/protocol.test.ts`.
- Prior verification — Date: 2026-06-25T10:14:24+0800
- Read: `packages/coding-tools/src/index.ts`,
  `packages/core/src/policy.ts`, `packages/core/src/run.ts`,
  `packages/host/src/tools.ts`, `packages/host/src/runtime.ts`,
  `packages/shell-tool/src/tool.ts`, `packages/host/src/tool-catalog.ts`.
- Tests: `npm --workspace @sparkwright/core test -- test/policy.test.ts test/run.test.ts`;
  `npm --workspace @sparkwright/tui test -- test/permission.test.ts test/sdk-cutover.test.ts`;
  `npm run schema:check`; `npm run release:check`.
