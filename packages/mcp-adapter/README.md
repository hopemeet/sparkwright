# @sparkwright/mcp-adapter

Experimental MCP ingress helpers for Sparkwright.

This package discovers MCP tools and normalizes them into Sparkwright
`ToolDefinition` values. The core run loop still owns validation, policy,
approval, execution lifecycle, trace, and tool result observations.

## API

```ts
import { prepareMcpToolsForRun } from "@sparkwright/mcp-adapter";

const mcp = await prepareMcpToolsForRun({
  servers: [
    {
      type: "stdio",
      name: "repo-tools",
      command: "node",
      args: ["./server.js"],
    },
  ],
});

try {
  const run = createRun({
    goal,
    model,
    tools: [...normalTools, ...mcp.tools],
    approvalResolver,
    metadata: {
      mcpStatuses: mcp.statuses,
      mcpToolNameMap: mcp.toolNameMap,
    },
  });
} finally {
  await mcp.close();
}
```

## Policy

MCP tools default to risky and approval-gated:

```ts
policy: {
  risk: "risky",
  requiresApproval: true,
}
```

Callers can pass a different policy, but MCP tools should stay governed like
any other external side effect.

For per-tool policy, pass a mapper:

```ts
await prepareMcpToolsForRun({
  servers,
  policy({ mcpToolName }) {
    return mcpToolName.startsWith("read_")
      ? { risk: "safe" }
      : { risk: "risky", requiresApproval: true };
  },
});
```

Policy and approval apply when the tools execute through `createRun`. Calling
`tool.execute(...)` directly is useful for unit tests, but it bypasses the
run-level gate.

MCP server startup is also policy-checkable before any stdio process is spawned
or HTTP connection is opened:

```ts
await prepareMcpToolsForRun({
  servers,
  serverPolicy: {
    decide({ action, resource, metadata }) {
      if (action === "mcp.server.prepare" && resource?.uri === "stdio:node") {
        return {
          action,
          decision: "allow",
          reason: "Node MCP servers are allowed.",
          metadata: metadata ?? {},
        };
      }

      return {
        action,
        decision: "deny",
        reason: "MCP server is not on the allowlist.",
        metadata: metadata ?? {},
      };
    },
  },
});
```

## Tool Names

MCP tool names are namespaced by default:

```txt
mcp_<server>_<tool>
```

`toolNameMap` records the mapping back to the MCP server and original MCP tool
name for trace, audit, and debugging.

## Boundaries

MCP is a capability source, not a privileged execution path.

This package should not bypass Sparkwright policy, approval, or normalized tool
results. Future resource and prompt support should enter as context candidates,
not hidden prompt injection.
