import type { EventEmitter } from "@sparkwright/core";
import {
  buildStartRunIntent,
  createSafetyGatedShellRunner,
  discoverProjectCommands,
  hasShellInterpolation,
} from "@sparkwright/project-commands";
import type { ProjectCommandReference } from "@sparkwright/protocol";
import type {
  ResolvedShellSandboxConfig,
  ShellSandboxRuntime,
} from "@sparkwright/shell-sandbox";
import { runGovernedInlineShell } from "./governed-inline-shell.js";
import { resolveCapabilityDirs } from "./layers.js";

const PROJECT_COMMAND_TIMEOUT_MS = 30_000;
const PROJECT_COMMAND_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface ResolvedHostProjectCommand {
  goal: string;
  metadata: {
    name: string;
    source: "project" | "user";
    shellInterpolation: boolean;
  };
}

export interface ResolveHostProjectCommandOptions {
  command: ProjectCommandReference;
  workspaceRoot: string;
  emitter: EventEmitter;
  sandbox: ResolvedShellSandboxConfig;
  sandboxRuntime?: ShellSandboxRuntime;
  env?: Record<string, string | undefined>;
  includeProject?: boolean;
}

export class ProjectCommandTrustRequiredError extends Error {
  readonly name = "ProjectCommandTrustRequiredError";
}

/** Resolve a client-supplied command identity from Host-owned capability roots. */
export async function resolveHostProjectCommand(
  options: ResolveHostProjectCommandOptions,
): Promise<ResolvedHostProjectCommand> {
  const userCommandDir = resolveCapabilityDirs("command", {
    cwd: options.workspaceRoot,
    ...(options.env ? { env: options.env } : {}),
  }).find((entry) => entry.layer === "user")?.dir;
  const descriptors = await discoverProjectCommands({
    cwd: options.workspaceRoot,
    userCommandDir,
  });
  const descriptor = descriptors.find(
    (candidate) => candidate.name === options.command.name,
  );
  if (!descriptor) {
    throw new Error(
      `Project command "/${options.command.name}" was not found.`,
    );
  }
  if (descriptor.source === "project" && options.includeProject === false) {
    throw new ProjectCommandTrustRequiredError(
      `Project command "/${options.command.name}" requires trust for the commands capability manifest.`,
    );
  }

  const runShell = createSafetyGatedShellRunner({
    execute: async (command) => {
      const result = await runGovernedInlineShell({
        emitter: options.emitter,
        workspaceRoot: options.workspaceRoot,
        sandbox: options.sandbox,
        ...(options.sandboxRuntime
          ? { sandboxRuntime: options.sandboxRuntime }
          : {}),
        name: `project-command:${descriptor.name}`,
        kind: "custom",
        command,
        cwd: options.workspaceRoot,
        timeoutMs: PROJECT_COMMAND_TIMEOUT_MS,
        maxOutputBytes: PROJECT_COMMAND_MAX_OUTPUT_BYTES,
      });
      if (result.timedOut) {
        throw new Error(
          `Shell interpolation timed out after ${PROJECT_COMMAND_TIMEOUT_MS}ms.`,
        );
      }
      if (result.error) throw new Error(result.error.message);
      if (result.output.stdoutTruncated || result.output.stderrTruncated) {
        throw new Error(
          `Shell interpolation output exceeded ${PROJECT_COMMAND_MAX_OUTPUT_BYTES} bytes.`,
        );
      }
      return {
        stdout: result.output.stdoutPreview ?? "",
        exitCode: result.exitCode ?? 1,
      };
    },
  });
  const rest = options.command.rest?.trim() ?? "";
  const intent = await buildStartRunIntent(descriptor, {
    args: rest.length > 0 ? rest.split(/\s+/) : [],
    rest,
    runShell,
  });
  return {
    goal: intent.prompt,
    metadata: {
      name: descriptor.name,
      source: descriptor.source,
      shellInterpolation: hasShellInterpolation(descriptor.segments),
    },
  };
}
