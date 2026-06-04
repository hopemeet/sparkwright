// AI maintenance note: TUI-side adapter for file-authored slash commands. The
// discovery/parsing/interpolation contract lives in @sparkwright/project-commands;
// this module only binds it to the TUI: it derives the user command dir, supplies
// a safety-gated local shell executor, and maps descriptors onto TUI `Command`s.
// Shell runs here are user-initiated (the user typed `/name`) and still pass the
// shell-tool safety floor: deny/unknown commands are blocked, not executed.

import { exec } from "node:child_process";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { userConfigPath } from "@sparkwright/host";
import {
  buildStartRunIntent,
  createSafetyGatedShellRunner,
  discoverProjectCommands,
  type ProjectCommandDescriptor,
  type StartRunIntent,
} from "@sparkwright/project-commands";
import type { Command } from "./commands.js";

const execAsync = promisify(exec);
const SHELL_TIMEOUT_MS = 30_000;
const SHELL_MAX_BUFFER = 1024 * 1024;

/** Discover project + user command markdown for a workspace. */
export async function loadProjectCommands(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  reservedNames?: Iterable<string>,
): Promise<ProjectCommandDescriptor[]> {
  const userCommandDir = join(dirname(userConfigPath(env)), "command");
  return discoverProjectCommands({
    cwd: workspaceRoot,
    userCommandDir,
    reservedNames,
  });
}

function splitArgs(rest: string): string[] {
  const trimmed = rest.trim();
  return trimmed.length > 0 ? trimmed.split(/\s+/) : [];
}

function errorExitCode(error: unknown): number {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "number") return code;
  }
  return 1;
}

function errorStdout(error: unknown): string {
  if (typeof error === "object" && error !== null && "stdout" in error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    if (typeof stdout === "string") return stdout;
  }
  return "";
}

/** Interpolate a command into a runnable prompt, gating any `` !`shell` ``. */
export async function resolveProjectCommandIntent(
  descriptor: ProjectCommandDescriptor,
  rest: string,
  workspaceRoot: string,
): Promise<StartRunIntent> {
  const runShell = createSafetyGatedShellRunner({
    execute: async (command) => {
      try {
        const { stdout } = await execAsync(command, {
          cwd: workspaceRoot,
          timeout: SHELL_TIMEOUT_MS,
          maxBuffer: SHELL_MAX_BUFFER,
        });
        return { stdout, exitCode: 0 };
      } catch (error) {
        return { stdout: errorStdout(error), exitCode: errorExitCode(error) };
      }
    },
  });
  return buildStartRunIntent(descriptor, {
    args: splitArgs(rest),
    rest: rest.trim(),
    runShell,
  });
}

/** Map descriptors onto TUI commands; `onRun` receives the descriptor + rest-of-line. */
export function toTuiProjectCommands(
  descriptors: readonly ProjectCommandDescriptor[],
  onRun: (descriptor: ProjectCommandDescriptor, rest: string) => void,
): Command[] {
  return descriptors.map((descriptor) => ({
    name: descriptor.name,
    title: descriptor.description || `Run /${descriptor.name}`,
    description:
      descriptor.description || `File-authored command (${descriptor.source}).`,
    category: "session" as const,
    run: () => onRun(descriptor, ""),
    runRaw: (rest: string) => onRun(descriptor, rest),
  }));
}
