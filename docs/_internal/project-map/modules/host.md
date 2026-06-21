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
- `packages/host/src/toolset.ts`
- `packages/host/src/tools.ts`
- `packages/host/src/shell.ts`
- `packages/host/src/workspace-snapshot.ts`
- `packages/host/src/workflow-hooks.ts`
- `packages/host/src/traced-process-runner.ts`
- `packages/host/src/acp-child-agent.ts`
- `packages/host/src/skill-inline-shell.ts`
- `packages/host/src/external-command-agent.ts`
- `packages/host/src/delegate-capability.ts`
- `packages/host/src/agent-profiles.ts`
- `packages/host/src/crash-log.ts`
- `packages/host/src/config.ts`
- `packages/host/src/config-zod-schema.ts`
- `packages/host/test/protocol.test.ts`
- `packages/host/test/tools.test.ts`

## Owns / Does Not Own

Owns:

- host protocol method implementations such as `run.start`, `run.resume`, `session.inspect`, `session.compact`, and `capability.inspect`
- provider/model construction for local host runs
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
  `permissionMode` also consumes the Zod source while preserving host loader
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
- TUI approval auto-policy goes through `@sparkwright/host` helpers; TUI source
  must not import `@sparkwright/core` directly.
- Legacy `capabilities.tools` config is rejected; top-level `tools.use`,
  `tools.allowed`, `tools.disabled`, and `tools.defer` are the supported tool
  filters. `tools.use` is a selector whitelist expanded at the host catalog
  layer where source metadata is still available, `allowed`/`disabled` trim the
  prepared catalog by concrete name, and `defer` only changes schema loading
  for tools that remain.
- Main, dynamic-spawn child, configured-delegate child, and diagnostic tool
  lists are derived from `tool-catalog.ts`; dynamic `spawn_agent` uses the
  read-only child catalog, while configured in-process delegates use a separate
  profile-aware child catalog for workspace read/write coding tools plus
  `shell` when selected. Catalog entries keep only tool definition plus source
  metadata, while `toolset.ts` remains a compatibility wrapper returning bare
  `ToolDefinition[]`.
- Dynamic `spawn_agent` output includes child identity/finality facts for the
  parent (`childRunId`, `role`, `stepLimitReached`, `truncated`, and
  `finality`). A child answer produced on the last allowed step remains a
  completed tool transport result, but host marks the answer `partial` and
  prefixes the message with a warning.
- Core coding catalog exposes `write_file` as a `workspace.write` tool alongside
  `edit_anchored_text` and `apply_patch`; read-only child catalogs intentionally
  omit it.
- `tool-selectors.ts` owns the selector vocabulary (`workspace.read`,
  `workspace.write`, `shell`, `planning`, `skills`, `agents`, `tasks`, `cron`,
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
  derived discovery infrastructure. Parent/child profile selector intersections
  use the same `mcp`/`mcp:<server>` semantics as top-level `tools.use`.
- Configured in-process delegate child runs receive the host approval resolver
  so workspace-write and shell approval requests route through the parent run's
  CLI/TUI approval path; they do not receive an interaction channel.
- Configured in-process delegate descriptors report profile-selected write/shell
  potential plus conditional approval facts
  (`approvalRequiredUnderCurrentRun`, `approvalReasons`,
  `approvalRunOptions`). They use `gatedByRunWrite` when the parent run has not
  enabled workspace writes.
- `capability.inspect` describes ACP, external-command, and configured
  in-process delegates in `agents.delegateTools`; CLI and TUI consume that
  snapshot descriptor instead of maintaining a local in-process delegate
  inventory.
- `create_agent` returns callability feedback for create/duplicate-create
  results. A profile is only callable by the main agent when an effective
  delegate tool targets a child/all profile; primary profiles are inspectable
  main-run templates, not configured child delegates.
- `capabilities.agents.maxDepth` is enforced before dynamic spawn, LLM child
  delegates, ACP delegates, and external-command delegates start; sub-agent
  events carry `subagentDepth` metadata so nested runs share one depth budget.
  The CLI `delegates run` path loads the same effective agents policy and keeps
  `undefined` `maxDepth` as no configured ceiling.
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
  exposes only a constrained JSONL progress inbox to child processes, and lets
  callers override progress routing (for example, task progress to
  `task.output`) without hard-coding business event families in the runner.
- Configured workflow command hooks keep their `workflow_hook.*` lifecycle and
  use `TracedProcessRunner` internally for process spans, output summaries, and
  artifact materialization.
- External command delegates keep `subagent.*` as the parent-visible lifecycle
  and reuse `TracedProcessRunner` with `emitLifecycle: false` so process output,
  sandbox fallback, timeout, and artifact handling stay consistent without
  duplicating lifecycle rows. Their constrained `SPARKWRIGHT_TRACE_EVENTS`
  progress inbox is collected into bounded `progressCount` / `progressDropped`
  / `progressHead` / `progressTail` summaries on the delegate tool result and
  `subagent.completed.payload.result`, not routed as `extension.process.*`.
  Read/write external command delegates emit
  `workspace.write.untracked_access_granted` when direct workspace access is
  granted; this is a boundary marker, not a managed write event.
- Promoted shell tasks adopt the already-started shell stream through
  `TracedProcessRunner.observeStreaming`, keep `task.*` as the lifecycle, write
  full stdout/stderr to `TaskStore`, and mirror bounded progress/output into the
  run trace as `task.output` under the task span.
- Skill inline shell preprocessing is host-owned when enabled by
  `capabilities.skills.inlineShell.enabled`: runtime injects an
  `inlineShellRunner` into `prepareSkillsForRun`, the runner uses
  `TracedProcessRunner` with `kind: skill_script`, and pre-run process events
  are buffered until the real run event log is available.

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
- Date: 2026-06-21
- Read: `packages/host/src/runtime.ts`, `packages/host/src/server.ts`,
  `packages/host/src/external-command-agent.ts`,
  `packages/host/src/traced-process-runner.ts`,
  `packages/core/src/session-compaction.ts`, `packages/core/src/session.ts`,
  `packages/protocol/src/index.ts`, `packages/host/test/protocol.test.ts`,
  `packages/host/test/external-command-agent.test.ts`,
  `packages/tui/src/state/run-controller.ts`, `packages/cli/src/cli.ts`.
- Tests: `npm --workspace @sparkwright/host test -- protocol.test.ts`;
  `npm --workspace @sparkwright/host test -- external-command-agent.test.ts`;
  `npm --workspace @sparkwright/cli test -- cli.test.ts`;
  `npm --workspace @sparkwright/tui test -- sdk-cutover.test.ts`;
  `npm run release:check`.
