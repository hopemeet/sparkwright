import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentSideConnection,
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import {
  createSparkwrightAcpAgentFactory,
  SparkwrightAcpAgent,
} from "../src/index.js";

describe("ACP round trip", () => {
  const previousScript = process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const previousXdgStateHome = process.env.XDG_STATE_HOME;

  afterEach(() => {
    if (previousScript === undefined) {
      delete process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON;
    } else {
      process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = previousScript;
    }
    if (previousXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
    }
    if (previousXdgStateHome === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = previousXdgStateHome;
    }
  });

  it("runs a deterministic SparkWright turn over ACP", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sparkwright-acp-roundtrip-"));
    isolateRuntimeEnv(cwd);
    await writeFile(join(cwd, "README.md"), "# Demo\n", "utf8");
    const clientToAgent = new TransformStream<Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array>();
    const updates: SessionNotification[] = [];
    const client: Client = {
      async requestPermission(params) {
        return {
          outcome: {
            outcome: "selected",
            optionId: params.options.at(-1)?.optionId ?? "reject",
          },
        };
      },
      async sessionUpdate(params) {
        updates.push(params);
      },
    };

    const agentConnection = new AgentSideConnection(
      createSparkwrightAcpAgentFactory({
        defaultWorkspaceRoot: cwd,
        defaultModel: "deterministic",
        defaultTraceLevel: "debug",
      }),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );
    const clientConnection = new ClientSideConnection(
      () => client,
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );

    const initialized = await clientConnection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const session = await clientConnection.newSession({
      cwd,
      mcpServers: [],
    });
    const capabilities = await clientConnection.extMethod(
      "sparkwright/capabilities",
      { sessionId: session.sessionId },
    );
    const response = await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "inspect this repo" }],
    });

    expect(initialized.agentInfo?.name).toBe("SparkWright");
    expect(response.stopReason).toBe("end_turn");
    expect(
      updates.some(
        (update) =>
          update.update.sessionUpdate === "agent_message_chunk" &&
          update.update.content.type === "text" &&
          update.update.content.text.includes("Done"),
      ),
    ).toBe(true);
    expect(
      updates.some((update) => update.update.sessionUpdate === "tool_call"),
    ).toBe(true);
    expect(Array.isArray(capabilities.tools)).toBe(true);
    const runsDir = join(
      cwd,
      ".sparkwright",
      "sessions",
      session.sessionId,
      "agents",
      "main",
      "runs",
    );
    const runIds = await readdir(runsDir);
    const runJson = JSON.parse(
      await readFile(join(runsDir, runIds[0]!, "run.json"), "utf8"),
    ) as { metadata?: Record<string, unknown> };
    const tracePointer = JSON.parse(
      await readFile(join(runsDir, runIds[0]!, "trace-pointer.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(runJson.metadata).toMatchObject({
      source: "acp",
      traceLevel: "debug",
      accessMode: "read-only",
      workspaceRoot: cwd,
    });
    expect(runJson.metadata?.capabilitySnapshot).toMatchObject({
      tools: expect.any(Number),
    });
    expect(tracePointer).toMatchObject({
      schemaVersion: "trace-pointer.v1",
      sessionId: session.sessionId,
      agentId: "main",
      tracePath: "../../../../trace.jsonl",
      agentTracePath: "../../trace.jsonl",
    });

    agentConnection.signal.throwIfAborted?.();
    await clientConnection.closeSession({ sessionId: session.sessionId });
  });

  it("does not resolve the prompt before queued ACP updates are delivered", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sparkwright-acp-order-"));
    isolateRuntimeEnv(cwd);
    await writeFile(join(cwd, "README.md"), "# Demo\n", "utf8");
    let releaseBlockedUpdate!: () => void;
    const blockedUpdate = new Promise<void>((resolve) => {
      releaseBlockedUpdate = resolve;
    });
    let blockedAgentUpdate = false;
    let promptResolved = false;
    const client: Client = {
      async requestPermission(params) {
        return {
          outcome: {
            outcome: "selected",
            optionId: params.options.at(-1)?.optionId ?? "reject",
          },
        };
      },
      async sessionUpdate(params) {
        if (
          !blockedAgentUpdate &&
          params.update.sessionUpdate === "agent_message_chunk"
        ) {
          blockedAgentUpdate = true;
          await blockedUpdate;
        }
      },
    };
    const agent = new SparkwrightAcpAgent(client, {
      defaultWorkspaceRoot: cwd,
      defaultModel: "deterministic",
      defaultTraceLevel: "debug",
    });

    await agent.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const session = await agent.newSession({
      cwd,
      mcpServers: [],
    });
    const promptPromise = agent
      .prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "inspect this repo" }],
      })
      .then((response) => {
        promptResolved = true;
        return response;
      });

    try {
      await waitFor(() => blockedAgentUpdate);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(promptResolved).toBe(false);
      releaseBlockedUpdate();

      const response = await promptPromise;
      expect(response.stopReason).toBe("end_turn");
    } finally {
      releaseBlockedUpdate();
      agent.closeAll();
    }
  });

  it("returns over ACP transport after queueing updates to the stream", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sparkwright-acp-order-"));
    isolateRuntimeEnv(cwd);
    await writeFile(join(cwd, "README.md"), "# Demo\n", "utf8");
    const clientToAgent = new TransformStream<Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array>();
    const client: Client = {
      async requestPermission(params) {
        return {
          outcome: {
            outcome: "selected",
            optionId: params.options.at(-1)?.optionId ?? "reject",
          },
        };
      },
      async sessionUpdate() {},
    };

    const agentConnection = new AgentSideConnection(
      createSparkwrightAcpAgentFactory({
        defaultWorkspaceRoot: cwd,
        defaultModel: "deterministic",
        defaultTraceLevel: "debug",
      }),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );
    const clientConnection = new ClientSideConnection(
      () => client,
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );

    await clientConnection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const session = await clientConnection.newSession({
      cwd,
      mcpServers: [],
    });
    const response = await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "inspect this repo" }],
    });
    expect(response.stopReason).toBe("end_turn");

    agentConnection.signal.throwIfAborted?.();
    await clientConnection.closeSession({ sessionId: session.sessionId });
  });

  it("honors session-scoped MCP servers from ACP with concrete deferred tools", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sparkwright-acp-mcp-"));
    isolateRuntimeEnv(cwd);
    await writeFile(join(cwd, "README.md"), "# Demo\n", "utf8");
    await mkdir(join(cwd, ".sparkwright"), { recursive: true });
    await writeFile(
      join(cwd, ".sparkwright", "config.json"),
      JSON.stringify({
        shell: {
          sandbox: {
            filesystem: {
              allowRead: [join(findRepoRoot(process.cwd()), "node_modules")],
            },
          },
        },
      }),
      "utf8",
    );
    const markerPath = join(cwd, "mcp-started.txt");
    process.env.SPARKWRIGHT_SCRIPTED_MODEL_JSON = JSON.stringify([
      {
        toolCalls: [
          {
            toolName: "tool_search",
            arguments: { query: "select:mcp_qa_echo" },
          },
        ],
      },
      {
        message: "mcp listed",
      },
    ]);

    const clientToAgent = new TransformStream<Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array>();
    const updates: SessionNotification[] = [];
    const client: Client = {
      async requestPermission(params) {
        return {
          outcome: {
            outcome: "selected",
            optionId: params.options.at(-1)?.optionId ?? "reject",
          },
        };
      },
      async sessionUpdate(params) {
        updates.push(params);
      },
    };

    const agentConnection = new AgentSideConnection(
      createSparkwrightAcpAgentFactory({
        defaultWorkspaceRoot: cwd,
        defaultModel: "scripted",
        defaultTraceLevel: "debug",
        // This fixture writes a workspace marker when the MCP process starts;
        // opt into a write run so the test exercises ACP MCP injection rather
        // than the read-only extension-process guard.
        defaultAccessMode: "ask",
      }),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );
    const clientConnection = new ClientSideConnection(
      () => client,
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );

    const initialized = await clientConnection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const session = await clientConnection.newSession({
      cwd,
      mcpServers: [
        {
          name: "qa",
          command: process.execPath,
          args: ["--input-type=module", "-e", mcpEchoScript(markerPath)],
          env: [],
        },
      ],
    });
    const capabilities = (await clientConnection.extMethod(
      "sparkwright/capabilities",
      { sessionId: session.sessionId },
    )) as {
      tools?: Array<{ name?: string }>;
      mcp?: { statuses?: Array<{ serverName?: string; status?: string }> };
    };

    expect(initialized.agentCapabilities?.mcpCapabilities).toMatchObject({
      http: true,
      sse: true,
    });
    expect(
      capabilities.tools?.some((tool) => tool.name === "mcp_qa_echo"),
    ).toBe(true);
    expect(
      capabilities.mcp?.statuses?.find((status) => status.serverName === "qa"),
    ).toMatchObject({
      status: "connected",
    });
    await expect(readFile(markerPath, "utf8")).resolves.toBe("started");

    const response = await clientConnection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "list the injected MCP tools" }],
    });

    expect(response.stopReason).toBe("end_turn");
    expect(await readFileWhenReady(markerPath, "started")).toBe("started");
    expect(
      updates.some(
        (update) =>
          update.update.sessionUpdate === "tool_call" &&
          update.update.title === "tool_search",
      ),
    ).toBe(true);
    const tracePath = join(
      cwd,
      ".sparkwright",
      "sessions",
      session.sessionId,
      "trace.jsonl",
    );
    const traceEvents = (await readFile(tracePath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; payload?: unknown });
    expect(
      traceEvents.some(
        (event) =>
          event.type === "mcp.server.prepared" &&
          (event.payload as { name?: string; status?: string }).name === "qa" &&
          (event.payload as { name?: string; status?: string }).status ===
            "connected",
      ),
    ).toBe(true);

    agentConnection.signal.throwIfAborted?.();
    await clientConnection.closeSession({ sessionId: session.sessionId });
  }, 20_000);

  it("rejects ACP-transport MCP servers instead of silently ignoring them", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sparkwright-acp-mcp-acp-"));
    isolateRuntimeEnv(cwd);
    const clientToAgent = new TransformStream<Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array>();
    const client: Client = {
      async requestPermission(params) {
        return {
          outcome: {
            outcome: "selected",
            optionId: params.options.at(-1)?.optionId ?? "reject",
          },
        };
      },
      async sessionUpdate() {},
    };

    const agentConnection = new AgentSideConnection(
      createSparkwrightAcpAgentFactory({
        defaultWorkspaceRoot: cwd,
        defaultModel: "deterministic",
      }),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );
    const clientConnection = new ClientSideConnection(
      () => client,
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );
    await clientConnection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });

    await expect(
      clientConnection.newSession({
        cwd,
        mcpServers: [{ type: "acp", name: "remote", id: "mcp-remote" }],
      }),
    ).rejects.toMatchObject({
      message: "Invalid params",
      data: {
        message: "ACP MCP transport is not supported yet: remote",
      },
    });

    agentConnection.signal.throwIfAborted?.();
    await rm(cwd, { recursive: true, force: true });
  });
});

async function readFileWhenReady(
  path: string,
  expected: string,
  timeoutMs = 12000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const content = await readFile(path, "utf8");
      if (content === expected) return content;
    } catch {
      // The MCP server writes this marker asynchronously during startup.
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${path} to be ${JSON.stringify(expected)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function isolateRuntimeEnv(root: string): void {
  process.env.XDG_CONFIG_HOME = join(root, "xdg-config");
  process.env.XDG_STATE_HOME = join(root, "xdg-state");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1000) {
      throw new Error("Timed out waiting for ACP round-trip condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function mcpEchoScript(markerPath: string): string {
  const repoRoot = findRepoRoot(process.cwd());
  const mcpPath = resolve(
    repoRoot,
    "node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js",
  );
  const transportPath = resolve(
    repoRoot,
    "node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js",
  );
  const zodPath = resolve(repoRoot, "node_modules/zod/v4/index.js");
  return [
    "import { writeFileSync } from 'node:fs';",
    `import { McpServer } from ${JSON.stringify(pathToFileURL(mcpPath).href)};`,
    `import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(transportPath).href)};`,
    `import { z } from ${JSON.stringify(pathToFileURL(zodPath).href)};`,
    `writeFileSync(${JSON.stringify(markerPath)}, "started", "utf8");`,
    "const server = new McpServer({ name: 'acp-test-mcp', version: '0.0.1' });",
    "server.registerTool('echo', { description: 'Echo text.', inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: 'text', text }] }));",
    "await server.connect(new StdioServerTransport());",
  ].join("\n");
}

function findRepoRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    if (
      existsSync(
        join(
          current,
          "node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js",
        ),
      )
    ) {
      return current;
    }
    const parent = resolve(current, "..");
    if (parent === current) return resolve(start);
    current = parent;
  }
}
