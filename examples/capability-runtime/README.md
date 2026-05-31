# Capability Runtime Example

This example shows the extension composition path:

```txt
@sparkwright/skills       -> ContextItem[] and optional tools
@sparkwright/mcp-adapter  -> ToolDefinition[]
@sparkwright/agent-runtime -> Policy
@sparkwright/core         -> run lifecycle, tools, policy, trace
```

Capabilities are declared in `capabilities.json` and validated against
`schemas/capability-runtime-config.schema.json` before the run starts.

Run from the repository root after installing dependencies:

```bash
npm run build --workspaces
node examples/capability-runtime/dist/run.js
```

The MCP server is intentionally disabled. It demonstrates the metadata and
lifecycle shape without requiring a real external MCP server.
