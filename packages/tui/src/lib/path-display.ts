import {
  formatWorkspaceDisplayPath as formatCoreWorkspaceDisplayPath,
  middleEllipsisPath as coreMiddleEllipsisPath,
  type WorkspaceDisplayPathOptions,
} from "@sparkwright/host";

export function middleEllipsisPath(path: string, maxCols: number): string {
  return coreMiddleEllipsisPath(path, maxCols);
}

export function formatWorkspaceDisplayPath(
  path: string,
  options: WorkspaceDisplayPathOptions = {},
): string {
  return formatCoreWorkspaceDisplayPath(path, options);
}
