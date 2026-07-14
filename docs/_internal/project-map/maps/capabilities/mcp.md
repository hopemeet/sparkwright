# MCP Capability

## Purpose

MCP capability connects external MCP servers to SparkWright as tools, resources,
prompts, and diagnostic status.

See [../../modules/mcp-adapter.md](../../modules/mcp-adapter.md).

## Main Files

- `packages/mcp-adapter/src/index.ts`
- `packages/host/src/runtime.ts`
- `packages/cli/src/cli.ts`
- `packages/tui/src/lib/create-capability.ts`
- `docs/reference/EXTENSION_INTERFACES.md`

## Data Flow

```txt
host config MCP servers
  -> prepareMcpToolsForRun()
  -> mcp.server.prepared events/status
  -> wrapped SparkWright tools/resources/prompts
  -> normal run tool execution
```

## Contracts

- MCP tools must use normal tool policy and trace paths.
- Server startup and schema loading are configurable.
- ACP `session/new` may supply session-scoped MCP servers; those merge with
  configured user/project MCP servers for that session and are not written to
  config files.
- Stdio server launch consumes the Host-provided effective process sandbox.
  Read-only Host runs strengthen it to fail-closed no-write even when the
  configured main-Shell sandbox is off.
- Stdio sandbox availability/enforce/fallback and argv invocation compilation
  use the same shell-sandbox decision as Host JSON-RPC processes. MCP retains
  its own transport, neutral-cwd, stderr, close, and cleanup lifecycle.
- Capability inspect can optionally resolve MCP servers and tools.
- Stdio MCP servers without explicit `cwd` run from a neutral temporary
  directory, not the workspace. Servers that intentionally need project files
  must opt in with explicit `cwd`.
- TUI-created stdio MCP server configs omit `cwd` by default so newly created
  servers inherit the neutral-cwd behavior.
- Host run metadata records the names of configured stdio MCP servers whose
  explicit `cwd` resolves inside the workspace; CLI run summary uses that as a
  static disclosure. It is not a filesystem mutation detector.
- MCP tool calls use normal `tool.*` trace events. Workspace writes are counted
  only when they use managed `workspace.write.*` APIs.
- MCP preparation failures and lazy `call_tool` lookup failures carry
  actionable diagnostics without exposing sensitive paths or tokens:
  `category` / `errorCategory`, `phase`, `serverName`, `nextAction`, and
  `retryable`. Known categories are `command_not_found`, `connect_failed`,
  `list_tools_failed`, `timeout`, `sandbox_unavailable`, `tool_not_found`, and
  `prepare_denied`.
- `mcp.server.prepared` remains an audit fact emitted per server after
  preparation. Failure payloads keep existing `errorCode`/`errorPhase` fields
  and add diagnostic fields for renderers and trace analysis.
- Lazy server `call_tool` with an unknown tool should tell the model to call the
  matching list-tools wrapper first, and include only a bounded available-tool
  summary plus count.

## Consumers

- Host runtime.
- CLI `capabilities inspect --resolve-mcp`.
- TUI create-capability flow.
- Core run loop through wrapped tools.

## Change Checklist

- Check tool name sanitization and collision behavior.
- Check sandbox failure semantics.
- Check deferred schema behavior for context size.
- Check `mcp.server.prepared` payloads and capability snapshot fields.
- Check default stdio cwd isolation and explicit workspace-cwd disclosure.
- Check migration docs when changing MCP cwd semantics.

## Known Debts

- MCP status can be expensive or noisy if all schemas are eagerly loaded.
- Neutral cwd prevents accidental relative-path workspace writes, but it is not
  a sandbox. Absolute workspace paths or explicitly configured workspace cwd are
  trusted opt-ins and are not counted as managed workspace writes.

## Last Verified

- Status: Verified
- Date: 2026-07-14
- Scope: checked Host runtime source-attribution signature change; MCP
  preparation, transport, policy, and lifecycle contracts are unchanged.
- Tests: Host focused suites and typecheck passed.

- Status: Verified
- Date: 2026-07-14T14:35:00+0800
- Scope: P6 routed review; live MCP remains execution-scoped and was not moved
  into session query/compaction modules.
- Tests: Host full suite passed.

- Status: Verified (no MCP ownership change)
- Date: 2026-07-14
- Scope: reviewed retained IM executions; live MCP remains execution-scoped and
  is disposed by HostExecution, never the subscription/outbox control state.

- Status: Verified
- Date: 2026-07-14
- Scope: reviewed HostExecution resource ownership; live MCP clients remain
  execution-scoped, close idempotently, and are never pooled by lanes.

- Status: Verified
- Date: 2026-07-13T22:21:00+0800
- Scope: read-only Host run access now supplies stdio MCP with a fail-closed
  no-write sandbox while configured Shell status remains separately reported.
  Neutral cwd, transport lifecycle, and managed-write attribution are unchanged.
- Read: Host security plan/runtime and MCP adapter launch boundary.
- Tests: MCP adapter 34/34; Host focused 263/263; CLI inspect selection 11/11.

- Status: Read-only
- Date: 2026-07-13
- Scope: ACP child worker sandbox launch changed independently of MCP; MCP
  server merging, transport, neutral cwd, and tool behavior are unchanged.
- Read: Host delegate assembly and MCP runtime assembly boundary.
- Tests: no MCP behavior changed; prior Stage 3 MCP suite remained green.

- Status: Verified
- Date: 2026-07-13
- Scope: MCP stdio adopted the shared argv sandbox launch decision; neutral cwd
  and MCP transport semantics are unchanged.
- Read: MCP adapter and shell-sandbox launch compiler.
- Tests: MCP adapter 34/34; shell-sandbox 14/14; typechecks passed.

- Status: Read-only
- Date: 2026-07-13
- Scope: Host run and configured inspection now receive the same resolved
  sandbox input from the security plan. MCP startup, neutral cwd, optional CLI
  resolution, transport lifecycle, and tool policy behavior are unchanged.
- Read: Host runtime/security plan, CLI capability report, and MCP adapter
  boundary.
- Tests: Host tools/protocol focused tests and CLI capability-inspect tests
  passed; MCP-specific behavior did not change.

- Status: Read-only
- Date: 2026-07-12T20:12:00+0800
- Scope: checked host runtime Workflow layer change; MCP preparation and tool
  exposure are unchanged.
- Read: host runtime Workflow record creation and MCP capability map.
- Tests: focused Workflow tests passed; no MCP contract change.

- Status: Read-only
- Date: 2026-07-12
- Scope: checked Workflow run package-identity metadata; MCP capability behavior is unchanged.
- Tests: focused Workflow tests passed; release gate pending.

- Status: Read-only
- Date: 2026-07-12T16:36:08+0800
- Scope: checked host Workflow snapshot preparation; MCP contracts are unchanged.
- Tests: not run for MCP behavior; Phase 4 Workflow release gate passed.

- Status: Read-only
- Date: 2026-07-07T00:55:52+0800
- Scope: workflow nested help and offline workflow observation filtering do not
  change MCP preparation, wrapped MCP tool execution, server cwd handling,
  capability inspection, or diagnostic payloads.
- Read: `packages/cli/src/cli.ts`,
  `packages/host/src/workflow-trace-observation.ts`,
  `docs/_internal/project-map/maps/capabilities/mcp.md`.
- Tests: MCP-specific tests were not run; focused CLI/host workflow tests
  covered the changed paths.

- Status: Read-only
- Date: 2026-07-06T21:18:25+0800
- Scope: C13-② post-acceptance routed-page check: host-loaded confidential
  read config now feeds run policy construction, but MCP server preparation,
  wrapped tool execution, cwd handling, workspace-cwd disclosure, and
  diagnostic payloads are unchanged.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/config-zod-schema.ts`,
  `docs/_internal/project-map/maps/capabilities/mcp.md`.
- Tests: no MCP-specific tests run; host confidential protocol tests ran for
  the changed policy path.

- Status: Read-only
- Date: 2026-07-06T20:47:10+0800
- Scope: C13-② routed-page check: host runtime policy construction now carries
  `confidentialDefaults`, but MCP server preparation, wrapped tool execution,
  cwd handling, workspace-cwd disclosure, and diagnostic payloads are unchanged.
- Read: `packages/host/src/runtime.ts`, `packages/host/src/config.ts`,
  `packages/host/src/config-zod-schema.ts`,
  `docs/_internal/proposals/consolidation-agenda.md`.
- Tests: not run for MCP-specific behavior; C13 focused validation ran in
  core/host/CLI/protocol.

- Status: Read-only
- Date: 2026-07-06T20:12:52+0800
- Scope: C10 route check for HostRuntime capability-inspection profile
  inventory. MCP server preparation, tool execution wrapping, cwd handling,
  workspace-cwd disclosure, and diagnostic payloads are unchanged.
- Read: `packages/host/src/runtime.ts`, `packages/host/test/protocol.test.ts`,
  `docs/_internal/proposals/consolidation-agenda.md`.
- Tests: `npm --workspace @sparkwright/host test --
test/protocol.test.ts -t "inspect reports inline agent profiles"`;
  `npm --workspace @sparkwright/host run typecheck`; `npm --workspace
@sparkwright/host run build`; `npm run release:check`.

- Status: Read-only
- Date: 2026-07-05T23:09:50+0800
- Scope: workflow-runtime-v1 P9a D5 routed-page check: workspace-root workflow
  run storage does not change MCP preparation, wrapped tool execution, server
  cwd handling, workspace-cwd disclosure, or diagnostic payloads.
- Read: `packages/host/src/runtime.ts`,
  `packages/agent-runtime/src/workflows/store.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: not run for MCP-specific behavior; P9a made no MCP semantic change.

- Status: Read-only
- Date: 2026-07-05T16:03:27+0800
- Scope: workflow-runtime-v1 P5 routed-page check: bounded
  `parallel` / `join` does not change MCP preparation, wrapped tool execution,
  server cwd handling, or diagnostic payloads.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/workflow-projection.ts`,
  `docs/_internal/proposals/workflow-runtime-v1.md`.
- Tests: not run for MCP-specific behavior; P5 made no MCP semantic change.

- Status: Read-only
- Date: 2026-07-05T11:36:37+0800
- Scope: workflow-runtime-v1 P3 Step 4a routing check for
  `packages/host/src/runtime.ts`: actor episode driver inversion does not
  change MCP preparation, wrapped tool execution, workspace-cwd disclosure, or
  MCP diagnostic payloads.
- Read: `packages/host/src/runtime.ts`,
  `docs/_internal/project-map/maps/capabilities/mcp.md`.
- Tests: not run for MCP-specific behavior; Step 4a made no MCP semantic
  change.

- Status: Read-only
- Date: 2026-07-05T00:42:02+0800
- Scope: workflow-runtime-v1 P2 routing check for `packages/host/src/runtime.ts`:
  durable workflow records/list/resume do not change MCP server preparation,
  wrapped tool execution, workspace-cwd disclosure, or MCP diagnostic payloads.
- Read: `packages/host/src/runtime.ts`,
  `docs/_internal/project-map/maps/capabilities/mcp.md`.
- Tests: not run for MCP-specific behavior; P2 made no MCP semantic change.

- Status: Verified
- Date: 2026-06-30T23:59:00+0800
- Scope: MCP prepare and lazy-call diagnostics now include actionable
  category/phase/server/nextAction/retryable fields while retaining existing
  status and `mcp.server.prepared` semantics.
- Read: `packages/mcp-adapter/src/index.ts`,
  `packages/mcp-adapter/test/index.test.ts`,
  `docs/_internal/project-map/maps/capabilities/mcp.md`.
- Tests: `npm --workspace @sparkwright/mcp-adapter test -- test/index.test.ts`;
  `npm --workspace @sparkwright/mcp-adapter run typecheck`.

- Status: Verified
- Date: 2026-06-29T09:28:39+0800
- Scope: checked after built-in tool surface consolidation; MCP startup,
  schema loading, and tool execution contracts did not change.
- Read: `packages/host/src/runtime.ts`,
  `packages/host/src/tool-catalog.ts`,
  `packages/cli/src/cli.ts`,
  `docs/_internal/project-map/maps/capabilities/mcp.md`.
- Tests: `npm --workspace @sparkwright/host test -- test/protocol.test.ts test/config.test.ts`;
  `npm --workspace @sparkwright/cli test -- test/cli.test.ts test/config-schema.test.ts`.

- Status: Verified
- Date: 2026-06-26T23:59:00+0800
- Scope: checked accessMode/config changes; MCP server policy and startup
  contracts are unchanged.
- Read: `packages/mcp-adapter/src/index.ts`,
  `packages/mcp-adapter/test/index.test.ts`, `packages/host/src/runtime.ts`,
  `packages/host/src/config.ts`, `packages/cli/src/cli.ts`,
  `packages/cli/test/cli.test.ts`, `docs/guides/CONFIGURATION.md`.
- Tests: `npm --workspace @sparkwright/cli test -- test/cli.test.ts`;
  `npm --workspace @sparkwright/host test -- test/config.test.ts test/protocol.test.ts`;
  `npm run build`; `npm run check:dist-fresh`; `npm run schema:check`.
