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
- Stdio server launch can be sandboxed.
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
