import { resolve } from "node:path";
import type {
  EventEmitter,
  ProcessInvocationBase,
  RunId,
} from "@sparkwright/core";
import {
  createPlatformShellSandboxRuntime,
  enforceNoWriteShellSandbox,
  extendShellSandboxReadAccess,
  type ResolvedShellSandboxConfig,
  type ShellSandboxRuntime,
} from "@sparkwright/shell-sandbox";
import {
  TracedProcessRunner,
  type TracedProcessResult,
} from "./traced-process-runner.js";

export interface GovernedInlineShellOptions {
  emitter: EventEmitter;
  runId?: RunId;
  workspaceRoot?: string;
  sandbox?: ResolvedShellSandboxConfig;
  sandboxRuntime?: ShellSandboxRuntime;
  name: string;
  kind: ProcessInvocationBase["kind"];
  command: string;
  cwd?: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

/**
 * Run fixed, capability-authored shell through the Host process lifecycle.
 *
 * Inline expansion is always read-only, including for write-enabled parent
 * runs. Callers still own domain-specific admission (for example command
 * safety classification); this function owns sandboxing, bounded output, and
 * extension.process.* trace events.
 */
export async function runGovernedInlineShell(
  options: GovernedInlineShellOptions,
): Promise<TracedProcessResult> {
  const sandboxRuntime =
    options.sandboxRuntime ?? createPlatformShellSandboxRuntime();
  const processCwd = resolve(
    options.cwd ?? options.workspaceRoot ?? process.cwd(),
  );
  const restrictedSandbox = options.sandbox
    ? await enforceNoWriteShellSandbox(options.sandbox, {
        runtime: sandboxRuntime,
        denyWriteRoots: options.workspaceRoot ? [options.workspaceRoot] : [],
      })
    : undefined;
  const sandbox = restrictedSandbox
    ? await extendShellSandboxReadAccess(restrictedSandbox, [processCwd])
    : undefined;

  return new TracedProcessRunner().run({
    emitter: options.emitter,
    ...(options.runId ? { runId: options.runId } : {}),
    name: options.name,
    kind: options.kind,
    runtime: "shell",
    command: "bash",
    args: ["-c", options.command],
    cwd: processCwd,
    ...(options.workspaceRoot ? { cwdBase: options.workspaceRoot } : {}),
    timeoutMs: options.timeoutMs,
    ...(sandbox ? { sandbox } : {}),
    sandboxRuntime,
    outputLimits: {
      previewBytes: options.maxOutputBytes,
      artifactBytes: options.maxOutputBytes,
      maxStdoutBytes: options.maxOutputBytes,
      maxStderrBytes: options.maxOutputBytes,
    },
  });
}
