import type { EventEmitter, RunId } from "@sparkwright/core";
import type { InlineShellRunner } from "@sparkwright/skills";
import {
  createPlatformShellSandboxRuntime,
  ResolvedShellSandboxConfig,
  type ShellSandboxRuntime,
} from "@sparkwright/shell-sandbox";
import { runGovernedInlineShell } from "./governed-inline-shell.js";

export interface CreateSkillInlineShellRunnerOptions {
  emitter: EventEmitter;
  runId?: RunId;
  workspaceRoot?: string;
  sandbox?: ResolvedShellSandboxConfig;
  sandboxRuntime?: ShellSandboxRuntime;
}

export function createSkillInlineShellRunner(
  options: CreateSkillInlineShellRunnerOptions,
): InlineShellRunner {
  const sandboxRuntime =
    options.sandboxRuntime ?? createPlatformShellSandboxRuntime();
  return async ({
    command,
    cwd,
    skillName,
    sourcePath,
    timeoutMs,
    maxOutputChars,
  }) => {
    // `runId` is typically absent here: inline-shell expansion runs during
    // pre-run capability preparation (before `createRun` mints the run id),
    // emitting onto a buffered emitter that is flushed once the run exists.
    // Without a run id no output artifact is materialized — acceptable because
    // inline-shell output is already capped to `maxOutputChars` and inlined
    // into the skill body, so an artifact would only duplicate that capped text.
    const result = await runGovernedInlineShell({
      emitter: options.emitter,
      ...(options.runId ? { runId: options.runId } : {}),
      ...(options.workspaceRoot
        ? { workspaceRoot: options.workspaceRoot }
        : {}),
      ...(options.sandbox ? { sandbox: options.sandbox } : {}),
      sandboxRuntime,
      name: "skill-inline-shell",
      kind: "skill_script",
      command,
      ...(cwd ? { cwd } : {}),
      timeoutMs,
      maxOutputBytes: maxOutputChars,
    });

    if (result.timedOut || result.error || result.exitCode !== 0) {
      options.emitter.emit(
        "skill.failed",
        {
          name: skillName,
          source: sourcePath,
          message:
            result.error?.message ?? `Inline shell exited ${result.exitCode}`,
          status: "inline_shell_failed",
          errorCode: result.error?.code,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
        },
        {
          sourcePackage: "@sparkwright/skills",
          phase: "inline_shell",
          mode: "preprocess",
          kind: "skill_script",
        },
      );
    }

    if (result.timedOut || result.error || result.exitCode !== 0) {
      return inlineShellFailureMarker(result, timeoutMs);
    }
    const output =
      result.output.stdoutPreview || result.output.stderrPreview || "";
    if (output) {
      return normalizeInlineShellOutput(
        output,
        result.output.stdoutTruncated || result.output.stderrTruncated,
        maxOutputChars,
      );
    }
    return normalizeInlineShellOutput(
      output,
      result.output.stdoutTruncated || result.output.stderrTruncated,
      maxOutputChars,
    );
  };
}

function inlineShellFailureMarker(
  result: {
    exitCode: number | null;
    timedOut: boolean;
    error?: { code: string };
  },
  timeoutMs: number,
): string {
  if (result.timedOut) return `[inline-shell timeout after ${timeoutMs}ms]`;
  const code = result.error?.code ?? "PROCESS_FAILED";
  const exit =
    result.exitCode === null || result.exitCode === undefined
      ? ""
      : ` exitCode=${result.exitCode}`;
  return `[inline-shell error: ${code}${exit}]`;
}

function normalizeInlineShellOutput(
  output: string,
  truncated: boolean,
  maxOutputChars: number,
): string {
  let normalized = output.replace(/\n$/, "");
  if (normalized.length > maxOutputChars) {
    normalized = normalized.slice(0, maxOutputChars);
    truncated = true;
  }
  return truncated ? `${normalized}...[truncated]` : normalized;
}
