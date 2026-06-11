import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import {
  createContextItemId,
  type ContextItem,
  type WorkflowHook,
  type WorkflowHookInput,
  type WorkflowHookResult,
} from "@sparkwright/core";
import type {
  CapabilityHookActionConfig,
  CapabilityWorkflowHookConfig,
} from "./config.js";

export interface CreateConfiguredWorkflowHooksOptions {
  hooks?: CapabilityWorkflowHookConfig[];
  workspaceRoot: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
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
          });
        },
      };
    });
}

interface RunConfiguredHookActionOptions {
  hookName: string;
  workspaceRoot: string;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
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

  const result = await runCommandAction(action, options);
  const metadata = {
    hookName: options.hookName,
    hook: input.hook,
    command: action.command,
    args: action.args ?? [],
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
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
}

function runCommandAction(
  action: Extract<CapabilityHookActionConfig, { type: "command" }>,
  options: RunConfiguredHookActionOptions,
): Promise<CommandResult> {
  const cwd = action.cwd
    ? isAbsolute(action.cwd)
      ? action.cwd
      : resolve(options.workspaceRoot, action.cwd)
    : options.workspaceRoot;
  const maxOutputBytes = action.maxOutputBytes ?? 32_000;
  const child = spawn(action.command, action.args ?? [], {
    cwd,
    env: sanitizeEnv(options.env),
    stdio: ["ignore", "pipe", "pipe"],
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
      });
    };
    const timer =
      action.timeoutMs && action.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, action.timeoutMs)
        : undefined;

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
