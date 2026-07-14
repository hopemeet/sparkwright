import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface OutputCapture {
  stdout: { write(chunk: string | Uint8Array): boolean };
  stderr: { write(chunk: string | Uint8Array): boolean };
  stdoutText(): string;
  stderrText(): string;
}

export class CleanupStack {
  readonly #callbacks: Array<() => void | Promise<void>> = [];

  defer(callback: () => void | Promise<void>): void {
    this.#callbacks.push(callback);
  }

  async dispose(): Promise<void> {
    const errors: unknown[] = [];
    for (const callback of this.#callbacks.reverse()) {
      try {
        await callback();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#callbacks.length = 0;
    if (errors.length > 0)
      throw new AggregateError(errors, "CLI test cleanup failed");
  }
}

export function createCliTestHarness(): {
  cleanup: CleanupStack;
  env(
    overrides?: Record<string, string | undefined>,
  ): Record<string, string | undefined>;
  tempDir(prefix?: string): Promise<string>;
  tempWorkspace(readme: string): Promise<string>;
  installProcessEnv(overrides: Record<string, string | undefined>): void;
} {
  const cleanup = new CleanupStack();
  return {
    cleanup,
    env: (overrides = {}) => ({ ...process.env, ...overrides }),
    async tempDir(prefix = "sparkwright-cli-") {
      const directory = await mkdtemp(join(tmpdir(), prefix));
      cleanup.defer(() =>
        rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        }),
      );
      return directory;
    },
    async tempWorkspace(readme) {
      const workspace = await this.tempDir("sparkwright-cli-");
      await writeFile(join(workspace, "README.md"), readme, "utf8");
      return workspace;
    },
    installProcessEnv(overrides) {
      const previous = new Map<string, string | undefined>();
      for (const [name, value] of Object.entries(overrides)) {
        previous.set(name, process.env[name]);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      cleanup.defer(() => {
        for (const [name, value] of previous) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      });
    },
  };
}

export function createOutputCapture(): OutputCapture {
  let stdout = "";
  let stderr = "";
  return {
    stdout: { write: (chunk) => ((stdout += String(chunk)), true) },
    stderr: { write: (chunk) => ((stderr += String(chunk)), true) },
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}

export async function withHttpServer(listener: RequestListener): Promise<{
  server: Server;
  baseURL: string;
  close(): Promise<void>;
}> {
  const server = createServer(listener);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    server,
    baseURL: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      ),
  };
}

export async function createProviderMock(): Promise<{
  baseURL: string;
  requests: Array<{
    method: string | undefined;
    url: string | undefined;
    authorization: string;
  }>;
  close(): Promise<void>;
}> {
  const requests: Array<{
    method: string | undefined;
    url: string | undefined;
    authorization: string;
  }> = [];
  const http = await withHttpServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: req.url,
        authorization:
          typeof req.headers.authorization === "string"
            ? req.headers.authorization
            : "",
      });
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "mock provider rejected request",
            type: "invalid_request_error",
          },
        }),
      );
    });
  });
  return { baseURL: `${http.baseURL}/v1`, requests, close: http.close };
}

export function mcpEchoServerConfig(
  name: string,
  options: {
    prelude?: string;
    toolRegistrations?: string[];
    cwd?: string;
  } = {},
) {
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
  const script = [
    options.prelude ?? "",
    `import { McpServer } from ${JSON.stringify(pathToFileURL(mcpPath).href)};`,
    `import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(transportPath).href)};`,
    `import { z } from ${JSON.stringify(pathToFileURL(zodPath).href)};`,
    "const server = new McpServer({ name: 'cli-test-mcp', version: '0.0.1' });",
    "server.registerTool('echo', { description: 'Echo text.', inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: 'text', text }] }));",
    ...(options.toolRegistrations ?? []),
    "await server.connect(new StdioServerTransport());",
  ].join("\n");
  return {
    type: "stdio" as const,
    name,
    command: process.execPath,
    args: ["--input-type=module", "-e", script],
    enabled: true,
    timeoutMs: 15_000,
    ...(options.cwd ? { cwd: options.cwd } : {}),
  };
}

export function mcpFixtureShellConfig() {
  return {
    sandbox: {
      filesystem: {
        allowRead: [join(findRepoRoot(process.cwd()), "node_modules")],
      },
    },
  };
}

export function findRepoRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    if (
      existsSync(join(current, "packages", "cli", "test", "cli.test.ts")) &&
      existsSync(join(current, "tools", "demo-mcp.mjs"))
    ) {
      return current;
    }
    const parent = resolve(current, "..");
    if (parent === current) return resolve(start);
    current = parent;
  }
}

export async function writeWorkflowAsset(
  workspace: string,
  name: string,
  workflow: string,
): Promise<void> {
  const directory = join(workspace, ".sparkwright", "workflows", name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "workflow.md"), workflow, "utf8");
}

export function traceEvent(
  sequence: number,
  runId: string,
  type: string,
  payload: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
): string {
  return `${JSON.stringify({
    id: `evt_${sequence}`,
    runId,
    type,
    timestamp: `2026-06-13T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    sequence,
    payload,
    metadata,
  })}\n`;
}

export async function readTrace(
  tracePath: string | undefined,
): Promise<
  Array<{ type: string; runId?: string; payload?: Record<string, unknown> }>
> {
  if (!tracePath) throw new Error("Missing trace path.");
  const content = await readFile(tracePath, "utf8");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function checkpointJson(input: { runId: string; goal: string }): string {
  return JSON.stringify(
    {
      schemaVersion: "run-checkpoint.v1",
      run: {
        id: input.runId,
        goal: input.goal,
        state: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:30.000Z",
        metadata: { source: "seed" },
      },
      loop: {
        step: 1,
        turnCount: 0,
        context: [],
        repeatedToolCallCount: 0,
        transition: { reason: "next_turn" },
      },
      model: { activeIndex: 0, fallbackCount: 0 },
      recovery: { outputRecoveriesUsed: 0, maxOutputRecoveries: 3 },
      budget: {
        usage: {
          elapsedMs: 0,
          modelCalls: 0,
          toolCalls: 0,
          tokens: 0,
          costUsd: 0,
        },
      },
      queues: {
        commandCount: 0,
        pendingPrefetch: false,
        pendingSummary: false,
      },
      resumability: { complete: true, reasons: [] },
      createdAt: "2026-01-01T00:00:30.500Z",
      metadata: { snapshotReason: "test" },
    },
    null,
    2,
  );
}
