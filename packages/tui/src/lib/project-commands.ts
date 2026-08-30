// AI maintenance note: TUI-side adapter for file-authored slash commands. The
// discovery/parsing contract lives in @sparkwright/project-commands. The TUI
// only lists commands and sends their identity to the Host; interpolation and
// any shell execution belong to the Host-governed run preparation path.

import {
  isProjectScopeTrusted,
  ProjectTrustManager,
  resolveCapabilityDirs,
} from "@sparkwright/host";
import {
  discoverProjectCommands,
  type ProjectCommandDescriptor,
} from "@sparkwright/project-commands";
import type { Command } from "./commands.js";

/** Discover project + user command markdown for a workspace. */
export async function loadProjectCommands(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  reservedNames?: Iterable<string>,
): Promise<ProjectCommandDescriptor[]> {
  const trust = await new ProjectTrustManager({ env }).inspect(workspaceRoot);
  const userCommandDir = resolveCapabilityDirs("command", {
    cwd: workspaceRoot,
    env,
  }).find((dir) => dir.layer === "user")?.dir;
  return discoverProjectCommands({
    cwd: workspaceRoot,
    userCommandDir,
    reservedNames,
    includeProject: isProjectScopeTrusted(trust, "commands"),
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
