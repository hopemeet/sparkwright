import { sanitizeAnsiForRender } from "./text.js";

export type ToolResultKind =
  | "file_read"
  | "anchored_read"
  | "workspace_write"
  | "shell"
  | "agent"
  | "skill_load"
  | "list_dir"
  | "glob";

export function classifyToolResult(value: unknown): ToolResultKind | null {
  if (isFileReadResult(value)) return "file_read";
  if (isAnchoredReadResult(value)) return "anchored_read";
  if (isWorkspaceWriteToolResult(value)) return "workspace_write";
  if (isShellResult(value)) return "shell";
  if (isParentAgentResult(value)) return "agent";
  if (isSkillLoadResult(value)) return "skill_load";
  if (isListDirResult(value)) return "list_dir";
  if (isGlobResult(value)) return "glob";
  return null;
}

/**
 * Recognise a `read` result envelope by its shape: a record carrying a
 * string `path`, a string `content`, and numeric `totalLines`/`bytes`.
 */
export function isFileReadResult(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const r = value as Record<string, unknown>;
  return (
    typeof r.path === "string" &&
    typeof r.content === "string" &&
    typeof r.totalLines === "number" &&
    typeof r.bytes === "number"
  );
}

export function isAnchoredReadResult(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const r = value as Record<string, unknown>;
  return (
    typeof r.path === "string" &&
    typeof r.content === "string" &&
    typeof r.anchorSetId === "string" &&
    typeof r.lineCount === "number" &&
    Array.isArray(r.lines)
  );
}

export function isWorkspaceWriteToolResult(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const r = value as Record<string, unknown>;
  return (
    typeof r.path === "string" &&
    (typeof r.changed === "boolean" || typeof r.hunksApplied === "number") &&
    ("content" in r || "diff" in r || "summary" in r)
  );
}

export function isShellResult(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const r = value as Record<string, unknown>;
  return (
    typeof r.stdout === "string" &&
    typeof r.stderr === "string" &&
    (typeof r.exitCode === "number" || r.exitCode === null) &&
    typeof r.timedOut === "boolean"
  );
}

export function summarizeShellResult(
  value: unknown,
  maxLines = 4,
): { head: string; lines: string[]; timedOut: boolean } {
  const r = value as Record<string, unknown>;
  const timedOut = r.timedOut === true;
  const taskId = typeof r.taskId === "string" ? r.taskId : "";
  const exitCode = typeof r.exitCode === "number" ? String(r.exitCode) : "";
  const head =
    r.promoted === true && taskId
      ? `shell promoted -> ${taskId}`
      : timedOut
        ? `shell timed out${exitCode ? ` exit ${exitCode}` : ""}`
        : exitCode
          ? `shell exit ${exitCode}`
          : "shell completed";
  const stdout = sanitizeAnsiForRender(str(r.stdout));
  const stderr = sanitizeAnsiForRender(str(r.stderr));
  const combined = [stdout, stderr ? `stderr: ${stderr}` : ""]
    .filter(Boolean)
    .join("\n");
  const allLines = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const limit = Math.max(1, Math.floor(maxLines));
  const lines =
    allLines.length <= limit
      ? allLines
      : (() => {
          const headCount = Math.ceil(limit / 2);
          const tailCount = Math.floor(limit / 2);
          const omitted = allLines.length - headCount - tailCount;
          return [
            ...allLines.slice(0, headCount),
            `… ${omitted} line${omitted === 1 ? "" : "s"} omitted …`,
            ...(tailCount > 0 ? allLines.slice(-tailCount) : []),
          ];
        })();
  return { head, lines, timedOut };
}

/** Recognise the compact report returned to a parent by an Agent tool. */
export function isParentAgentResult(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const r = value as Record<string, unknown>;
  const workspace =
    typeof r.workspace === "object" &&
    r.workspace !== null &&
    !Array.isArray(r.workspace)
      ? (r.workspace as Record<string, unknown>)
      : undefined;
  return (
    typeof r.childRunId === "string" &&
    (r.status === "completed" ||
      r.status === "partial" ||
      r.status === "blocked") &&
    typeof r.report === "string" &&
    r.report.trim().length > 0 &&
    workspace !== undefined &&
    typeof workspace.writes === "number"
  );
}

export function isSkillLoadResult(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const r = value as Record<string, unknown>;
  if (r.status === "loaded") {
    return (
      typeof r.name === "string" && displayStringLength(r.content) !== undefined
    );
  }
  return r.status === "not_found" && typeof r.requestedName === "string";
}

/** Length of a live value or its bounded persisted-trace envelope. */
export function displayStringLength(value: unknown): number | undefined {
  if (typeof value === "string") return value.length;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return record.type === "string" &&
    typeof record.length === "number" &&
    Number.isFinite(record.length)
    ? record.length
    : undefined;
}

/** Length of a live array or its bounded persisted-trace envelope. */
export function displayArrayLength(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return record.type === "array" &&
    typeof record.length === "number" &&
    Number.isFinite(record.length)
    ? record.length
    : undefined;
}

export function isListDirResult(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const r = value as Record<string, unknown>;
  if (typeof r.path !== "string" || !Array.isArray(r.entries)) return false;
  return r.entries.every(
    (e) =>
      typeof e === "object" &&
      e !== null &&
      typeof (e as Record<string, unknown>).name === "string" &&
      typeof (e as Record<string, unknown>).type === "string",
  );
}

export function summarizeListDir(
  value: unknown,
  maxNames = 8,
): { head: string; detail: string } {
  const r = value as { path?: unknown; entries?: unknown };
  const path = typeof r.path === "string" && r.path ? r.path : ".";
  const entries = Array.isArray(r.entries) ? r.entries : [];
  const head = `list_dir ${path} → ${entries.length} ${
    entries.length === 1 ? "entry" : "entries"
  }`;
  const names = entries.slice(0, maxNames).map((e) => {
    const rec = e as Record<string, unknown>;
    const name = String(rec.name ?? "");
    return rec.type === "directory" ? `${name}/` : name;
  });
  const more = entries.length - names.length;
  const detail = names.join(" · ") + (more > 0 ? ` · +${more} more` : "");
  return { head, detail };
}

export function isGlobResult(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const r = value as Record<string, unknown>;
  return (
    Array.isArray(r.patterns) &&
    r.patterns.every(isString) &&
    Array.isArray(r.paths) &&
    r.paths.every(isString)
  );
}

export function summarizeGlobResult(
  value: unknown,
  maxPaths = 8,
): { head: string; detail: string } {
  const r = value as {
    paths?: unknown;
    totalPaths?: unknown;
  };
  const paths = Array.isArray(r.paths) ? r.paths.filter(isString) : [];
  const totalPaths =
    typeof r.totalPaths === "number" ? r.totalPaths : paths.length;
  const head = `glob → ${totalPaths} ${totalPaths === 1 ? "path" : "paths"}`;
  const shown = paths.slice(0, maxPaths);
  const hidden = Math.max(0, totalPaths - shown.length);
  const detail = shown.join(" · ") + (hidden > 0 ? ` · +${hidden} more` : "");
  return { head, detail };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
