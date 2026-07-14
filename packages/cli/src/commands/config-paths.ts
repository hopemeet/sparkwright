import { join } from "node:path";
import {
  projectConfigCandidatePaths,
  userConfigCandidatePaths,
  userConfigPath,
} from "@sparkwright/host";

export function projectConfigPathForWorkspace(workspaceRoot: string): string {
  return join(workspaceRoot, ".sparkwright", "config.json");
}

export function defaultTaskRoot(workspaceRoot: string): string {
  return join(workspaceRoot, ".sparkwright", "tasks");
}

export function preferredUserConfigPath(
  env: Record<string, string | undefined>,
): string {
  return userConfigCandidatePaths(env)[1] ?? userConfigPath(env);
}

export function preferredProjectConfigPathForWorkspace(
  workspaceRoot: string,
): string {
  return (
    projectConfigCandidatePaths(workspaceRoot)[1] ??
    projectConfigPathForWorkspace(workspaceRoot)
  );
}
