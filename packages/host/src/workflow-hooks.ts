import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import {
  createContextItemId,
  type ContextItem,
  type ShellStreamingResult,
  type WorkflowHook,
  type WorkflowHookInput,
  type WorkflowHookResult,
} from "@sparkwright/core";
import {
  ShellSandboxExecutor,
  createPlatformShellSandboxRuntime,
  resolveShellSandboxConfig,
  type ResolvedShellSandboxConfig,
  type ShellSandboxConfig,
  type ShellSandboxRuntime,
} from "@sparkwright/shell-sandbox";
import type {
  CapabilityHookActionConfig,
  CapabilityWorkflowHookConfig,
} from "./config.js";

export interface CreateConfiguredWorkflowHooksOptions {
  hooks?: CapabilityWorkflowHookConfig[];
  workspaceRoot: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  sandbox?: ShellSandboxConfig | ResolvedShellSandboxConfig;
  sandboxRuntime?: ShellSandboxRuntime;
  skillRoots?: readonly string[];
  configPaths?: readonly string[];
}

export function createConfiguredWorkflowHooks(
  options: CreateConfiguredWorkflowHooksOptions,
): WorkflowHook[] {
  return (options.hooks ?? [])
    .filter((config) => config.enabled !== false)
    .map((config) => {
      const seenTurns = new Set<string>();
      return {
        name: config.name,
        description: config.description,
        hook: config.hook,
        matcher: config.matcher,
        onError: config.onError,
        handle: (input) => {
          if (config.frequency === "oncePerTurn") {
            const turnKey = `${input.run.id}:${input.step ?? "no-step"}`;
            if (seenTurns.has(turnKey)) {
              return {
                status: "skipped" as const,
                reason: "configured hook already ran for this turn",
              };
            }
            seenTurns.add(turnKey);
          }
          return runConfiguredHookAction(config.action, input, {
            hookName: config.name,
            workspaceRoot: options.workspaceRoot,
            env: options.env ?? process.env,
            sandboxConfig:
              options.sandbox && "forcedDenyWrite" in options.sandbox
                ? options.sandbox
                : resolveShellSandboxConfig({
                    workspaceRoot: options.workspaceRoot,
                    config: options.sandbox,
                    skillRoots: options.skillRoots,
                    extraForcedDenyWrite: options.configPaths,
                  }),
            sandboxRuntime:
              options.sandboxRuntime ?? createPlatformShellSandboxRuntime(),
          });
        },
      };
    });
}

interface RunConfiguredHookActionOptions {
  hookName: string;
  workspaceRoot: string;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  sandboxConfig: ResolvedShellSandboxConfig;
  sandboxRuntime: ShellSandboxRuntime;
}

async function runConfiguredHookAction(
  action: CapabilityHookActionConfig,
  input: WorkflowHookInput,
  options: RunConfiguredHookActionOptions,
): Promise<WorkflowHookResult> {
  if (action.type === "block") {
    return { status: "block", reason: action.reason };
  }

  if (action.type === "context") {
    return {
      status: "continue",
      context: [
        createHookContextItem({
          hookName: options.hookName,
          hook: input.hook,
          content: action.content,
          type: action.contextType ?? "summary",
        }),
      ],
    };
  }

  const result = await runCommandAction(action, input, options);
  const metadata = {
    hookName: options.hookName,
    hook: input.hook,
    command: action.command,
    args: action.args ?? [],
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    sandbox: result.sandbox,
  };
  const failed = result.timedOut || result.exitCode !== 0;
  if (action.blockOnFailure === true && failed) {
    return {
      status: "block",
      reason: `Command hook "${options.hookName}" failed with exit code ${result.exitCode}.`,
      metadata,
    };
  }
  if (!shouldInjectCommandOutput(action.injectOutput ?? "always", failed)) {
    return { status: "continue", metadata };
  }
  const content = JSON.stringify(metadata);
  return {
    status: "continue",
    context: [
      createHookContextItem({
        hookName: options.hookName,
        hook: input.hook,
        content,
        type: "summary",
      }),
    ],
  };
}

function shouldInjectCommandOutput(
  policy: "always" | "onFailure" | "never",
  failed: boolean,
): boolean {
  if (policy === "never") return false;
  if (policy === "onFailure") return failed;
  return true;
}

function createHookContextItem(input: {
  hookName: string;
  hook: string;
  content: string;
  type: Extract<ContextItem["type"], "system" | "user" | "summary">;
}): ContextItem {
  return {
    id: createContextItemId(),
    type: input.type,
    source: { kind: "extension", uri: `workflow-hook:${input.hookName}` },
    content: input.content,
    metadata: {
      layer: "working",
      stability: "turn",
      workflowHook: input.hook,
      hookName: input.hookName,
      configured: true,
    },
  };
}

interface CommandResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  sandbox?: {
    sandboxed: boolean;
    mode?: string;
    runtime?: string;
    networkMode?: string;
    unavailable?: string;
    available?: boolean;
    fallbackReason?: string;
    enforced?: boolean;
  };
}

async function runCommandAction(
  action: Extract<CapabilityHookActionConfig, { type: "command" }>,
  input: WorkflowHookInput,
  options: RunConfiguredHookActionOptions,
): Promise<CommandResult> {
  const cwd = action.cwd
    ? isAbsolute(action.cwd)
      ? action.cwd
      : resolve(options.workspaceRoot, action.cwd)
    : options.workspaceRoot;
  const maxOutputBytes = action.maxOutputBytes ?? 32_000;
  const stdin =
    action.stdin === "json"
      ? `${JSON.stringify(commandHookStdin(input))}\n`
      : undefined;
  let fallbackSandbox: CommandResult["sandbox"] =
    options.sandboxConfig.mode === "off"
      ? {
          sandboxed: false,
          mode: options.sandboxConfig.mode,
          networkMode: options.sandboxConfig.network.mode,
          available: false,
          enforced: false,
        }
      : undefined;

  if (options.sandboxConfig.mode !== "off") {
    const sandbox = new ShellSandboxExecutor(options.sandboxRuntime);
    const result = await sandbox.execute(
      {
        command: shellCommand([action.command, ...(action.args ?? [])]),
        cwd,
        env: sanitizeEnv(options.env),
        stdin,
        timeoutMs: action.timeoutMs,
        metadata: {
          workflowHook: options.hookName,
          sandboxMode: options.sandboxConfig.mode,
          sandboxNetworkMode: options.sandboxConfig.network.mode,
          sandboxAvailable: true,
          sandboxEnforced: options.sandboxConfig.failIfUnavailable,
        },
      },
      options.sandboxConfig,
    );
    if (result.status === "started") {
      return collectSandboxedCommandResult(result.result, maxOutputBytes);
    }
    if (options.sandboxConfig.failIfUnavailable) {
      return {
        exitCode: null,
        timedOut: false,
        stdout: "",
        stderr: result.reason,
        sandbox: {
          sandboxed: false,
          mode: options.sandboxConfig.mode,
          runtime: result.runtimeId,
          networkMode: options.sandboxConfig.network.mode,
          unavailable: result.reason,
          available: false,
          fallbackReason: result.reason,
          enforced: true,
        },
      };
    }
    fallbackSandbox = {
      sandboxed: false,
      mode: options.sandboxConfig.mode,
      runtime: result.runtimeId,
      networkMode: options.sandboxConfig.network.mode,
      unavailable: result.reason,
      available: false,
      fallbackReason: result.reason,
      enforced: false,
    };
  }

  const child = spawn(action.command, action.args ?? [], {
    cwd,
    env: sanitizeEnv(options.env),
    stdio: [action.stdin === "json" ? "pipe" : "ignore", "pipe", "pipe"],
    shell: false,
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let settled = false;

  return new Promise<CommandResult>((resolvePromise) => {
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise({
        exitCode,
        timedOut,
        stdout,
        stderr,
        sandbox: fallbackSandbox,
      });
    };
    const timer =
      action.timeoutMs && action.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, action.timeoutMs)
        : undefined;

    if (stdin !== undefined) {
      child.stdin?.on("error", () => undefined);
      try {
        child.stdin?.end(stdin);
      } catch (error) {
        stderr = appendLimited(
          stderr,
          error instanceof Error ? error.message : String(error),
          maxOutputBytes,
        );
        child.kill("SIGTERM");
        finish(127);
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendLimited(stdout, chunk.toString("utf8"), maxOutputBytes);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendLimited(stderr, chunk.toString("utf8"), maxOutputBytes);
    });
    child.on("error", (error) => {
      stderr = appendLimited(stderr, error.message, maxOutputBytes);
      finish(127);
    });
    child.on("close", (code) => {
      finish(code);
    });
  });
}

async function collectSandboxedCommandResult(
  streaming: ShellStreamingResult,
  maxOutputBytes: number,
): Promise<CommandResult> {
  let stdout = "";
  let stderr = "";
  const stdoutDrain = (async () => {
    for await (const chunk of streaming.handle.stdout()) {
      stdout = appendLimited(stdout, chunk, maxOutputBytes);
    }
  })();
  const stderrDrain = (async () => {
    for await (const chunk of streaming.handle.stderr()) {
      stderr = appendLimited(stderr, chunk, maxOutputBytes);
    }
  })();
  const final = await streaming.completed;
  await Promise.allSettled([stdoutDrain, stderrDrain]);
  return {
    exitCode: final.exitCode,
    timedOut:
      typeof final.metadata?.timedOut === "boolean"
        ? final.metadata.timedOut
        : false,
    stdout: stdout || final.stdout,
    stderr: stderr || final.stderr,
    sandbox: {
      sandboxed: final.metadata?.sandboxed === true,
      ...(typeof final.metadata?.sandboxMode === "string"
        ? { mode: final.metadata.sandboxMode }
        : {}),
      ...(typeof final.metadata?.sandboxRuntime === "string"
        ? { runtime: final.metadata.sandboxRuntime }
        : {}),
      ...(typeof final.metadata?.sandboxNetworkMode === "string"
        ? { networkMode: final.metadata.sandboxNetworkMode }
        : {}),
      ...(typeof final.metadata?.sandboxUnavailable === "string"
        ? { unavailable: final.metadata.sandboxUnavailable }
        : {}),
      ...(typeof final.metadata?.sandboxAvailable === "boolean"
        ? { available: final.metadata.sandboxAvailable }
        : {}),
      ...(typeof final.metadata?.sandboxFallbackReason === "string"
        ? { fallbackReason: final.metadata.sandboxFallbackReason }
        : {}),
      ...(typeof final.metadata?.sandboxEnforced === "boolean"
        ? { enforced: final.metadata.sandboxEnforced }
        : {}),
    },
  };
}

function shellCommand(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function commandHookStdin(input: WorkflowHookInput): Record<string, unknown> {
  return {
    hook: input.hook,
    run: input.run,
    step: input.step,
    payload: input.payload,
    metadata: input.metadata,
  };
}

function appendLimited(
  current: string,
  next: string,
  maxBytes: number,
): string {
  const combined = current + next;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
  return combined.slice(0, maxBytes) + "\n[truncated]";
}

function sanitizeEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
