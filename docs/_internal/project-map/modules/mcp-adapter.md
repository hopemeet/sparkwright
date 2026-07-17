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
- Stdio MCP servers can be launched under the Host-provided effective process
  sandbox. For read-only Host runs this is strengthened to fail-closed
  no-write, even when the configured shell sandbox is off; the adapter does not
  derive run access itself.
- Stdio MCP delegates sandbox availability/enforce/fallback and concrete argv
  invocation compilation to `shell-sandbox`, while MCP adapter retains neutral
  cwd creation, SDK transport selection, stderr draining, connection shutdown,
  and combined cleanup ownership.
- Stdio MCP servers without explicit `cwd` are launched from a neutral
  temporary cwd and clean it up when the transport closes.
- Wrapped MCP tools must remain normal SparkWright tools for policy, trace, and result handling.
- Failed server preparation status includes `category`, `serverName`,
  `nextAction`, and `retryable` alongside `errorCode`, `phase`, timing, and
  sanitized error text. `mcp.server.prepared` emits the same diagnostics while
  preserving existing audit payload fields.
- Lazy `call_tool` unknown-tool failures use `MCP_TOOL_NOT_FOUND` with
  `phase: "call_tool"`, `category: "tool_not_found"`, bounded
  `availableTools`, `availableToolCount`, and a next action to call the
  server's list-tools wrapper before retrying.

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

- Status: Read-only
- Date: 2026-07-17T17:24:00+0800
- Scope: checked after durable Workflow package-identity convergence. MCP
  preparation, wrapped tool identity, stdio sandboxing, and trace contracts do
  not consume Workflow run records or their package pins.
- Read: MCP adapter ownership, Host Workflow preparation boundary, and routed
  capability/session maps.
- Tests: no MCP-specific gate required; affected Workflow and repository
  typecheck gates passed.

- Status: Verified
- Date: 2026-07-13T22:21:00+0800
- Scope: Host read-only security plans now pass a fail-closed no-write process
  sandbox to stdio MCP preparation while capability inspection continues to
  report the configured main-Shell sandbox status.
- Read: Host security-plan/runtime assembly and MCP adapter input boundary.
- Tests: Host security-plan/protocol/tools/workflows 263/263; MCP adapter 34/34;
  CLI capability-inspect selection 11/11.

- Status: Verified
- Date: 2026-07-13
- Scope: MCP stdio now consumes the shared argv sandbox launch decision without
  merging its transport lifecycle into the Host process runner.
- Read: MCP adapter transport construction and shell-sandbox launch compiler.
- Tests: MCP adapter 34/34 and typecheck passed after shell-sandbox build.

- Status: Verified
- Date: 2026-06-30T23:59:00+0800
- Scope: actionable prepare and lazy-call diagnostics, including list-tools
  failure classification and unknown-tool recovery guidance.
- Read: `packages/mcp-adapter/src/index.ts`,
  `packages/mcp-adapter/test/index.test.ts`,
  `docs/_internal/project-map/modules/mcp-adapter.md`.
- Tests: `npm --workspace @sparkwright/mcp-adapter test -- test/index.test.ts`;
  `npm --workspace @sparkwright/mcp-adapter run typecheck`.

- Status: Verified
- Date: 2026-06-20
- Read: `packages/mcp-adapter/src/index.ts`, `packages/mcp-adapter/test/index.test.ts`, `packages/host/src/runtime.ts`, `packages/cli/src/cli.ts`.
- Tests: `npm --workspace @sparkwright/mcp-adapter test -- test/index.test.ts`; `npm --workspace @sparkwright/mcp-adapter run build`.
