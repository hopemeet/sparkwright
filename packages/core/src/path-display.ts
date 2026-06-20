import { isAbsolute, relative } from "node:path";

export interface WorkspaceDisplayPathOptions {
  workspaceRoot?: string;
  maxCols?: number;
}

export function formatWorkspaceDisplayPath(
  path: string,
  options: WorkspaceDisplayPathOptions = {},
): string {
  const normalizedPath = normalizePathForDisplay(path);
  const normalizedRoot = options.workspaceRoot
    ? normalizePathForDisplay(options.workspaceRoot)
    : undefined;
  const display =
    normalizedRoot && isWithinWorkspace(path, options.workspaceRoot!)
      ? relativeDisplayPath(relative(options.workspaceRoot!, path))
      : isLikelyAbsolutePath(normalizedPath)
        ? compactExternalPath(normalizedPath)
        : normalizedPath;

  return options.maxCols === undefined
    ? display
    : middleEllipsisPath(display, options.maxCols);
}

export function middleEllipsisPath(path: string, maxCols: number): string {
  if (maxCols <= 0) return "";
  if (path.length <= maxCols) return path;
  if (maxCols === 1) return "…";

  const normalized = normalizePathForDisplay(path);
  const basename = finalPathSegment(normalized);
  if (basename.length + 1 >= maxCols) {
    return `…${basename.slice(-(maxCols - 1))}`;
  }

  const suffix = `/${basename}`;
  const prefixBudget = maxCols - suffix.length - 1;
  if (prefixBudget <= 0) {
    return `…${suffix.slice(-(maxCols - 1))}`;
  }
  return `${normalized.slice(0, prefixBudget)}…${suffix}`;
}

function isWithinWorkspace(path: string, workspaceRoot: string): boolean {
  const rel = relative(workspaceRoot, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function relativeDisplayPath(path: string): string {
  const normalized = normalizePathForDisplay(path);
  return normalized === "" ? "." : normalized;
}

function compactExternalPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const segments = trimmed.split("/").filter(Boolean);
  const tail = segments.slice(-2).join("/");
  return tail ? `…/${tail}` : "…";
}

function finalPathSegment(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

function normalizePathForDisplay(path: string): string {
  return path.replaceAll("\\", "/");
}

function isLikelyAbsolutePath(path: string): boolean {
  return (
    path.startsWith("/") ||
    path.startsWith("//") ||
    path.startsWith("file:/") ||
    /^[A-Za-z]:\//.test(path)
  );
}
