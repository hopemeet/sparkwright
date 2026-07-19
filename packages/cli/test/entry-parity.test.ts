import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentSideConnection,
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
} from "@agentclientprotocol/sdk";
import { runCli } from "../src/cli.js";
import { createSparkwrightAcpAgentFactory } from "../../acp-adapter/src/index.js";
import { EventStore } from "../../tui/src/state/event-store.js";
import { RunController } from "../../tui/src/state/run-controller.js";

const GOAL =
  "Inspect README.md and package.json, then summarize the project purpose and list two runtime risks. Do not modify files.";

describe("entry parity smoke", () => {
  let tempDirs: string[] = [];
  let prevXdg: string | undefined;
  let prevHostSource: string | undefined;

  beforeEach(async () => {
    tempDirs = [];
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevHostSource = process.env.SPARKWRIGHT_HOST_SOURCE;
    const xdg = await tempDir("sparkwright-entry-xdg-");
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.SPARKWRIGHT_HOST_SOURCE = "1";
  });

  afterEach(async () => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevHostSource === undefined)
      delete process.env.SPARKWRIGHT_HOST_SOURCE;
    else process.env.SPARKWRIGHT_HOST_SOURCE = prevHostSource;
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("keeps CLI, TUI, and ACP deterministic read-only tool behavior aligned", async () => {
    const cli = await runCliEntry();
    const tui = await runTuiEntry();
    const acp = await runAcpEntry();

    for (const summary of [cli, tui, acp]) {
      expect(summary.resolvedAdapterIds).toEqual(["deterministic"]);
      expect(summary.toolRequests).toEqual(["list_dir"]);
      expect(summary.approvalRequests).toBe(0);
      expect(summary.workspaceWrites).toBe(0);
      expect(summary.failedTools).toBe(0);
      expect(summary.completedReason).toBe("final_answer");
      expect(summary.runMetadata).toMatchObject({
        traceLevel: "debug",
        accessMode: expect.any(String),
      });
      expect(summary.runMetadata?.capabilitySnapshot).toMatchObject({
        tools: expect.any(Number),
      });
    }

    expect(cli.source).toBe("cli");
    expect(cli.runMetadata).toMatchObject({ accessMode: "read-only" });
    expect(tui.source).toBe("tui");
    expect(tui.runMetadata).toMatchObject({ accessMode: "ask" });
    expect(tui.runMetadata).not.toHaveProperty("allowWorkspaceWriteApproval");
    expect(acp.source).toBe("acp");
    expect(acp.runMetadata).toMatchObject({ accessMode: "read-only" });
  }, 45_000);

  async function runCliEntry(): Promise<EntrySummary> {
    const workspace = await createWorkspace("cli");
    const output = createOutputCapture();
    const result = await runCli(
      [
        "run",
        GOAL,
        "--workspace",
        workspace,
        "--model",
        "deterministic",
        "--trace-level",
        "debug",
      ],
      {
        io: {
          stdout: output.stdout,
          stderr: output.stderr,
          stdinIsTTY: false,
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBeTruthy();
    return summarizeEntry({
      source: "cli",
      workspace,
      sessionId: result.sessionId!,
    });
  }

  async function runTuiEntry(): Promise<EntrySummary> {
    const workspace = await createWorkspace("tui");
    const store = new EventStore();
    const controller = new RunController({
      workspaceRoot: workspace,
      modelName: "deterministic",
      modelNameSource: "request",
      traceLevel: "debug",
      store,
    });
    try {
      await controller.start(GOAL);
      await waitForDone(store);
      return summarizeEntry({
        source: "tui",
        workspace,
        sessionId: controller.getSessionId(),
      });
    } finally {
      controller.shutdown();
    }
  }

  async function runAcpEntry(): Promise<EntrySummary> {
    const workspace = await createWorkspace("acp");
    const child = createAcpConnection(workspace);
    try {
      const initialized = await child.clientConnection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      expect(initialized.agentInfo?.name).toBe("SparkWright");
      const session = await child.clientConnection.newSession({
        cwd: workspace,
        mcpServers: [],
      });
      const response = await child.clientConnection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: GOAL }],
      });
      expect(response.stopReason).toBe("end_turn");
      await child.clientConnection.closeSession({
        sessionId: session.sessionId,
      });
      return summarizeEntry({
        source: "acp",
        workspace,
        sessionId: session.sessionId,
      });
    } finally {
      child.agentConnection.signal.throwIfAborted?.();
    }
  }

  async function createWorkspace(label: string): Promise<string> {
    const workspace = await tempDir(`sparkwright-entry-${label}-`);
    await writeFile(
      join(workspace, "README.md"),
      "# SparkWright\n\nRuntime substrate for governed agent execution.\n",
      "utf8",
    );
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify({ name: `entry-${label}`, private: true }, null, 2),
      "utf8",
    );
    return workspace;
  }

  async function tempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }
});

interface EntrySummary {
  source: "cli" | "tui" | "acp";
  resolvedAdapterIds: string[];
  toolRequests: string[];
  approvalRequests: number;
  workspaceWrites: number;
  failedTools: number;
  completedReason?: string;
  runMetadata?: Record<string, unknown>;
}

async function summarizeEntry(input: {
  source: EntrySummary["source"];
  workspace: string;
  sessionId: string;
}): Promise<EntrySummary> {
  const trace = await readTrace(
    join(
      input.workspace,
      ".sparkwright",
      "sessions",
      input.sessionId,
      "trace.jsonl",
    ),
  );
  const runMetadata = await readFirstRunMetadata(
    input.workspace,
    input.sessionId,
  );
  return {
    source: input.source,
    resolvedAdapterIds: unique(
      trace
        .filter((event) => event.type === "run.started")
        .map((event) =>
          nestedString(event.payload, "resolvedModel", "adapterId"),
        ),
    ),
    toolRequests: trace
      .filter((event) => event.type === "tool.requested")
      .map((event) => stringValue(event.payload?.toolName))
      .filter((name): name is string => Boolean(name)),
    approvalRequests: trace.filter(
      (event) => event.type === "approval.requested",
    ).length,
    workspaceWrites: trace.filter((event) =>
      event.type.startsWith("workspace.write."),
    ).length,
    failedTools: trace.filter((event) => event.type === "tool.failed").length,
    completedReason: stringValue(
      trace.find((event) => event.type === "run.completed")?.payload?.reason,
    ),
    runMetadata,
  };
}

async function readFirstRunMetadata(
  workspace: string,
  sessionId: string,
): Promise<Record<string, unknown> | undefined> {
  const runsDir = join(
    workspace,
    ".sparkwright",
    "sessions",
    sessionId,
    "agents",
    "main",
    "runs",
  );
  const runIds = await readdir(runsDir);
  const runJson = JSON.parse(
    await readFile(join(runsDir, runIds[0]!, "run.json"), "utf8"),
  ) as { metadata?: Record<string, unknown> };
  return runJson.metadata;
}

async function readTrace(path: string): Promise<
  Array<{
    type: string;
    payload?: Record<string, unknown>;
  }>
> {
  const raw = await readFile(path, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          type: string;
          payload?: Record<string, unknown>;
        },
    );
}

function createAcpConnection(workspace: string): {
  agentConnection: AgentSideConnection;
  clientConnection: ClientSideConnection;
} {
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
      defaultWorkspaceRoot: workspace,
      defaultModel: "deterministic",
      defaultTraceLevel: "debug",
    }),
    ndJsonStream(agentToClient.writable, clientToAgent.readable),
  );
  return {
    agentConnection,
    clientConnection: new ClientSideConnection(
      () => client,
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    ),
  };
}

function createOutputCapture() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: {
      write(chunk: string | Uint8Array) {
        stdout += String(chunk);
        return true;
      },
    },
    stderr: {
      write(chunk: string | Uint8Array) {
        stderr += String(chunk);
        return true;
      },
    },
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}

async function waitForDone(store: EventStore): Promise<void> {
  const current = store.getSnapshot();
  if (current.status === "done") return;
  if (current.status === "error") throw new Error(current.lastError ?? "error");
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsub();
      reject(new Error("Timed out waiting for TUI run completion."));
    }, 30_000);
    const unsub = store.subscribe(() => {
      const state = store.getSnapshot();
      if (state.status !== "done" && state.status !== "error") return;
      clearTimeout(timeout);
      unsub();
      if (state.status === "error")
        reject(new Error(state.lastError ?? "error"));
      else resolve();
    });
  });
}

function unique(values: Array<string | undefined>): string[] {
  return [
    ...new Set(values.filter((value): value is string => Boolean(value))),
  ];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nestedString(
  value: unknown,
  first: string,
  second: string,
): string | undefined {
  if (!isRecord(value)) return undefined;
  const nested = value[first];
  if (!isRecord(nested)) return undefined;
  return stringValue(nested[second]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
