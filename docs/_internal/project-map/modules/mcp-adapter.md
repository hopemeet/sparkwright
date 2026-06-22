# MCP Adapter

## Purpose

`@sparkwright/mcp-adapter` connects configured MCP servers to SparkWright tools,
resources, prompts, status metadata, and trace-visible preparation events.

See also [../maps/capabilities/mcp.md](../maps/capabilities/mcp.md) and [../maps/safety/shell.md](../maps/safety/shell.md).

## Main Files

- `packages/mcp-adapter/src/index.ts`
- `packages/mcp-adapter/test/index.test.ts`
- `packages/host/src/runtime.ts`
- `packages/cli/src/cli.ts`

## Owns / Does Not Own

Owns:

- MCP server preparation and tool wrapping
- MCP tool name mapping
- MCP resource/prompt conversion to context-like capability material
- `mcp.server.prepared` event emission

Does not own:

- host config loading
- shell sandbox implementation
- core tool execution semantics
- CLI/TUI command UX

## Contracts

- MCP startup may be lazy or eager depending on config.
- Tool schemas may be loaded or deferred depending on config.
- Stdio MCP servers can be launched under the configured shell sandbox.
- Stdio MCP servers without explicit `cwd` are launched from a neutral
  temporary cwd and clean it up when the transport closes.
- Wrapped MCP tools must remain normal SparkWright tools for policy, trace, and result handling.

## Consumers

- Host runtime capability preparation.
- CLI `capabilities inspect --resolve-mcp`.
- Core run loop through normal tool execution.

## Change Checklist

- Check sandbox behavior for stdio servers.
- Check neutral cwd behavior when `cwd` is omitted.
- Check name collision handling and tool name maps.
- Check capability inspection output.
- Check trace event payloads for server status and tool counts.

## Known Debts

- MCP tool payloads and schemas can become large; deferred schema loading is important for context size.
- Neutral cwd is not a sandbox; explicit cwd, absolute paths, and tool inputs
  can still give a trusted MCP server project access.

## Last Verified

- Status: Verified
- Date: 2026-06-20
- Read: `packages/mcp-adapter/src/index.ts`, `packages/mcp-adapter/test/index.test.ts`, `packages/host/src/runtime.ts`, `packages/cli/src/cli.ts`.
- Tests: `npm --workspace @sparkwright/mcp-adapter test -- test/index.test.ts`; `npm --workspace @sparkwright/mcp-adapter run build`.
