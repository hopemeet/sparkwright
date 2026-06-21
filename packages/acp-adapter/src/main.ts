import { stdin, stdout } from "node:process";
import { resolve } from "node:path";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import {
  isPermissionMode,
  isTraceLevel,
  type PermissionMode,
  type TraceLevel,
} from "@sparkwright/protocol";
import { createSparkwrightAcpAgentFactory } from "./agent.js";

export interface AcpMainOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

interface ParsedArgs {
  workspaceRoot: string;
  sessionRootDir?: string;
  model?: string;
  permissionMode: PermissionMode;
  traceLevel: TraceLevel;
  shouldWrite: boolean;
}

export async function runAcpMain(
  argv: string[],
  options: AcpMainOptions = {},
): Promise<void> {
  const args = parseArgs(argv, options.cwd ?? process.cwd());
  const input = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        stdout.write(chunk, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  });
  const output = new ReadableStream<Uint8Array>({
    start(controller) {
      stdin.on("data", (chunk: Buffer) => controller.enqueue(chunk));
      stdin.on("end", () => controller.close());
      stdin.on("error", (error) => controller.error(error));
    },
  });

  const stream = ndJsonStream(input, output);
  const agents: SparkwrightAcpAgentHandle[] = [];
  const connection = new AgentSideConnection((conn) => {
    const agent = createSparkwrightAcpAgentFactory({
      defaultWorkspaceRoot: args.workspaceRoot,
      defaultSessionRootDir: args.sessionRootDir,
      defaultModel: args.model,
      defaultPermissionMode: args.permissionMode,
      defaultTraceLevel: args.traceLevel,
      defaultShouldWrite: args.shouldWrite,
    })(conn);
    agents.push(agent as SparkwrightAcpAgentHandle);
    return agent;
  }, stream);

  connection.signal.addEventListener("abort", () => {
    for (const agent of agents) agent.closeAll?.();
  });
  stdin.resume();
  await connection.closed;
}

type SparkwrightAcpAgentHandle = { closeAll?: () => void };

function parseArgs(argv: string[], cwd: string): ParsedArgs {
  let workspaceRoot = resolve(cwd);
  let sessionRootDir: string | undefined;
  let model: string | undefined;
  let permissionMode: PermissionMode = "default";
  let traceLevel: TraceLevel = "standard";
  let shouldWrite = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--workspace" && argv[i + 1]) {
      workspaceRoot = resolve(cwd, argv[++i]!);
    } else if (arg === "--session-root" && argv[i + 1]) {
      sessionRootDir = resolve(cwd, argv[++i]!);
    } else if (arg === "--model" && argv[i + 1]) {
      model = argv[++i];
    } else if (arg === "--write") {
      shouldWrite = true;
    } else if (arg === "--permission-mode" && argv[i + 1]) {
      const value = argv[++i];
      if (isPermissionMode(value)) permissionMode = value;
    } else if (arg === "--trace-level" && argv[i + 1]) {
      const value = argv[++i];
      if (isTraceLevel(value)) traceLevel = value;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return {
    workspaceRoot,
    sessionRootDir,
    model,
    permissionMode,
    traceLevel,
    shouldWrite,
  };
}

function printHelp(): void {
  process.stderr.write(
    [
      "sparkwright acp — ACP agent server",
      "",
      "USAGE:",
      "  sparkwright acp [--workspace .]",
      "",
      "OPTIONS:",
      "  --workspace <path>         default workspace root (default: cwd)",
      "  --session-root <path>      session artifact root (default: <workspace>/.sparkwright/sessions)",
      '  --model <ref>              model reference "provider/model" (or "deterministic")',
      "  --write                    allow approval-gated workspace writes",
      "  --permission-mode <mode>   plan | default | accept_edits | dont_ask | bypass_permissions",
      "  --trace-level <level>      standard | debug",
      "",
    ].join("\n"),
  );
}
