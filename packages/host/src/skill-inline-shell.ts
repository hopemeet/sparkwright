import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { EventEmitter, RunId } from "@sparkwright/core";
import type { InlineShellRunner } from "@sparkwright/skills";
import type {
  ResolvedShellSandboxConfig,
  ShellSandboxRuntime,
} from "@sparkwright/shell-sandbox";
import { TracedProcessRunner } from "./traced-process-runner.js";

export interface CreateSkillInlineShellRunnerOptions {
  emitter: EventEmitter;
  runId?: RunId;
  sandbox?: ResolvedShellSandboxConfig;
  sandboxRuntime?: ShellSandboxRuntime;
}

export function createSkillInlineShellRunner(
  options: CreateSkillInlineShellRunnerOptions,
): InlineShellRunner {
  const runner = new TracedProcessRunner();
  return async ({ command, cwd, timeoutMs, maxOutputChars }) => {
    const processCwd = cwd ? resolve(cwd) : process.cwd();
    const result = await runner.run({
      emitter: options.emitter,
      runId: options.runId,
      name: "skill-inline-shell",
      kind: "skill_script",
      runtime: "shell",
      command: "bash",
      args: ["-c", command],
      cwd: processCwd,
      timeoutMs,
      sandbox: await sandboxWithSkillRead(options.sandbox, processCwd),
      sandboxRuntime: options.sandboxRuntime,
      outputLimits: {
        previewBytes: maxOutputChars,
        artifactBytes: maxOutputChars,
        maxStdoutBytes: maxOutputChars,
        maxStderrBytes: maxOutputChars,
      },
    });

    if (result.timedOut) {
      return `[inline-shell timeout after ${timeoutMs}ms: ${command}]`;
    }
    if (result.error?.code === "PROCESS_COMMAND_NOT_FOUND") {
      return `[inline-shell error: ${result.error.message}]`;
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
    if (result.error) {
      return `[inline-shell error: ${result.error.message}]`;
    }
    return normalizeInlineShellOutput(
      output,
      result.output.stdoutTruncated || result.output.stderrTruncated,
      maxOutputChars,
    );
  };
}

async function sandboxWithSkillRead(
  sandbox: ResolvedShellSandboxConfig | undefined,
  skillDir: string,
): Promise<ResolvedShellSandboxConfig | undefined> {
  if (!sandbox) return undefined;
  const allowRead = [...sandbox.filesystem.allowRead, resolve(skillDir)];
  try {
    allowRead.push(await realpath(skillDir));
  } catch {
    /* Missing directories fail later in the process runner. */
  }
  return {
    ...sandbox,
    filesystem: {
      ...sandbox.filesystem,
      allowRead: uniquePaths(allowRead),
    },
  };
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

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    const resolved = resolve(path);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}
