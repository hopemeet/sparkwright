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
- Date: 2026-06-20
- Read: `packages/mcp-adapter/src/index.ts`, `packages/mcp-adapter/test/index.test.ts`, `packages/host/src/runtime.ts`, `packages/core/src/run.ts`, `packages/core/src/trace.ts`, `packages/cli/src/run-outcome.ts`, `packages/cli/test/cli.test.ts`, `packages/tui/src/lib/create-capability.ts`, `packages/tui/test/create-capability.test.ts`, `docs/guides/CONFIGURATION.md`.
- Tests: `npm --workspace @sparkwright/mcp-adapter test -- test/index.test.ts`; `npm --workspace @sparkwright/cli test -- test/cli.test.ts`; `npm --workspace @sparkwright/tui test -- test/create-capability.test.ts`; `npm --workspace @sparkwright/host run build`; `npm --workspace @sparkwright/cli run build`.
