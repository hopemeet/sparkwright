import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";

const server = new McpServer({
  name: "sparkwright-demo-mcp",
  version: "0.0.1",
});

server.registerTool(
  "echo",
  {
    description: "Echo input text for SparkWright MCP smoke tests.",
    inputSchema: {
      text: z.string().describe("Text to echo back."),
    },
  },
  async ({ text }) => ({
    content: [{ type: "text", text: `echo: ${text}` }],
  }),
);

await server.connect(new StdioServerTransport());
