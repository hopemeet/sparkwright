import { isAbsolute, resolve } from "node:path";
import {
  createContextItemId,
  createBufferedEmitter,
  type ContextItem,
  type ProcessOutputSummary,
  type SandboxSummary,
  type WorkflowHook,
  type WorkflowHookInput,
  type WorkflowHookResult,
} from "@sparkwright/core";
import {
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
import {
  TracedProcessRunner,
  inferProcessRuntime,
} from "./traced-process-runner.js";

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
    output: result.output,
    sandbox: result.sandbox,
    progressCount: result.progressCount,
    progressDropped: result.progressDropped,
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
  output: ProcessOutputSummary;
  sandbox?: SandboxSummary;
  progressCount: number;
  progressDropped: number;
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
  const runner = new TracedProcessRunner();
  const result = await runner.run({
    emitter: input.events ?? createBufferedEmitter(),
    runId: input.run.id,
    name: options.hookName,
    kind: "workflow_hook",
    runtime: inferProcessRuntime(action.command),
    command: action.command,
    args: action.args ?? [],
    cwd,
    env: options.env,
    stdin,
    timeoutMs: action.timeoutMs,
    sandbox: options.sandboxConfig,
    sandboxRuntime: options.sandboxRuntime,
    outputLimits: {
      previewBytes: maxOutputBytes,
      artifactBytes: action.maxOutputBytes ?? 32_000,
      maxStdoutBytes: action.maxOutputBytes ?? 32_000,
      maxStderrBytes: action.maxOutputBytes ?? 32_000,
    },
  });
  return {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: result.output.stdoutPreview ?? "",
    stderr: result.output.stderrPreview ?? "",
    output: result.output,
    sandbox: result.sandbox,
    progressCount: result.progressCount,
    progressDropped: result.progressDropped,
  };
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
