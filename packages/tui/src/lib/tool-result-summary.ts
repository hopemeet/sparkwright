import { sanitizeAnsiForRender } from "./text.js";

export type ToolResultKind =
  | "file_read"
  | "anchored_read"
  | "workspace_write"
  | "skill_mutation"
  | "shell"
  | "agent"
  | "skill_load"
  | "list_dir"
  | "glob";

export function classifyToolResult(value: unknown): ToolResultKind | null {
  if (isFileReadResult(value)) return "file_read";
  if (isAnchoredReadResult(value)) return "anchored_read";
  if (isWorkspaceWriteToolResult(value)) return "workspace_write";
  if (isSkillMutationToolResult(value)) return "skill_mutation";
  if (isShellResult(value)) return "shell";
  if (isAgentToolResult(value)) return "agent";
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
    (typeof r.changed === "boolean" ||
      typeof r.hunksApplied === "number" ||
      typeof r.proposalId === "string") &&
    ("content" in r || "diff" in r || "summary" in r)
  );
}

export function isSkillMutationToolResult(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const r = value as Record<string, unknown>;
  if (typeof r.action !== "string" || typeof r.changed !== "boolean") {
    return false;
  }
  if (r.action === "create") {
    return typeof r.name === "string" && typeof r.path === "string";
  }
  if (r.action === "draft") {
    return (
      typeof r.proposalId === "string" && typeof r.proposalPath === "string"
    );
  }
  if (r.action === "apply") {
    return typeof r.proposalId === "string";
  }
  return false;
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
  const lines = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxLines);
  return { head, lines, timedOut };
}

/**
 * Recognise a sub-agent tool result envelope by its shape. Delegate tools and
 * dynamic `spawn_agent` outputs share this core terminal envelope.
 */
export function isAgentToolResult(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const r = value as Record<string, unknown>;
  return (
    typeof r.childRunId === "string" &&
    typeof r.signal === "string" &&
    "stopReason" in r
  );
}

export function isSkillLoadResult(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const r = value as Record<string, unknown>;
  if (r.status === "loaded") {
    return typeof r.name === "string" && typeof r.content === "string";
  }
  return r.status === "not_found" && typeof r.requestedName === "string";
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
