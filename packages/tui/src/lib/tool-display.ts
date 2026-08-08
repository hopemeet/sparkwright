import { formatToolRequestPreview, oneLine } from "./tool-request-preview.js";
import {
  classifyToolResult,
  summarizeGlobResult,
  summarizeListDir,
  summarizeShellResult,
  displayArrayLength,
  displayStringLength,
} from "./tool-result-summary.js";
import { sanitizeAnsiForRender } from "./text.js";

export { formatToolRequestPreview, oneLine };

export type ToolDisplayMode = "live" | "export";
export type ToolDisplayTone =
  | "muted"
  | "success"
  | "warning"
  | "error"
  | "normal";

export type ToolResultDisplay =
  | { kind: "hidden"; reason: string }
  | {
      kind: "summary";
      head: string;
      details: string[];
      tone: ToolDisplayTone;
    }
  | {
      kind: "markdown";
      text: string;
      details: string[];
      tone: ToolDisplayTone;
    };

export function summarizeToolResultForDisplay(input: {
  toolName?: string;
  result: unknown;
  mode: ToolDisplayMode;
  maxFallbackChars?: number;
}): ToolResultDisplay {
  const resultKind = classifyToolResult(input.result);
  const r = rec(input.result);

  if (isTaskToolName(input.toolName)) {
    return summarizeTaskToolResult(input.toolName ?? "task", r);
  }

  if (input.toolName === "spawn_agent" && isAsyncTaskReceipt(r)) {
    return summarizeSpawnAgentReceipt(r);
  }

  if (resultKind === "file_read") {
    if (input.mode === "live") return { kind: "hidden", reason: "file_read" };
    const path = str(r.path) || input.toolName || "read";
    const lines =
      typeof r.totalLines === "number"
        ? `${r.totalLines} line${r.totalLines === 1 ? "" : "s"}`
        : "";
    const bytes = typeof r.bytes === "number" ? `${r.bytes} bytes` : "";
    return summary(`read ${path}`, [lines, bytes], "muted");
  }

  if (resultKind === "anchored_read") {
    if (input.mode === "live") {
      return { kind: "hidden", reason: "anchored_read" };
    }
    const path = str(r.path) || input.toolName || "read_anchored_text";
    const count =
      typeof r.lineCount === "number"
        ? `${r.lineCount} anchored line${r.lineCount === 1 ? "" : "s"}`
        : "";
    return summary(`read_anchored_text ${path}`, [count], "muted");
  }

  if (resultKind === "workspace_write") {
    if (input.mode === "live") {
      return { kind: "hidden", reason: "workspace_write" };
    }
    const path = str(r.path) || input.toolName || "workspace write";
    const changed = r.changed === false ? "unchanged" : "changed";
    const hunks =
      typeof r.hunksApplied === "number"
        ? `${r.hunksApplied} hunk${r.hunksApplied === 1 ? "" : "s"}`
        : "";
    return summary(
      `${input.toolName ?? "write"} ${path}`,
      [changed, hunks],
      "success",
    );
  }

  if (resultKind === "shell") {
    const { head, lines, timedOut } = summarizeShellResult(input.result);
    return {
      kind: "summary",
      head,
      details: lines,
      tone: timedOut ? "warning" : "muted",
    };
  }

  if (resultKind === "agent") {
    const report = str(r.report).trim();
    if (!report) return { kind: "hidden", reason: "agent_empty" };
    return { kind: "markdown", text: report, details: [], tone: "normal" };
  }

  if (resultKind === "skill_load") {
    return summarizeSkillLoad(r);
  }

  if (resultKind === "list_dir") {
    const { head, detail } = summarizeListDir(input.result);
    return summary(head, [detail], "muted");
  }

  if (resultKind === "glob") {
    const { head, detail } = summarizeGlobResult(input.result);
    return summary(head, [detail], "muted");
  }

  const text = sanitizeAnsiForRender(
    typeof input.result === "string"
      ? input.result
      : oneLine(input.result, input.maxFallbackChars ?? 200),
  );
  const lines = text.split("\n").slice(0, 6);
  const truncated = text.split("\n").length > 6;
  return {
    kind: "summary",
    head: "",
    details: truncated ? [...lines, "…"] : lines,
    tone: "muted",
  };
}

function summarizeSkillLoad(r: Record<string, unknown>): ToolResultDisplay {
  if (r.status === "not_found") {
    const available = Array.isArray(r.availableSkills)
      ? r.availableSkills.filter(isString).join(", ")
      : "";
    return summary(
      `skill_load ${str(r.requestedName)} -> not found`,
      [available ? `available: ${available}` : ""],
      "error",
    );
  }

  const bodyChars = displayStringLength(r.content) ?? 0;
  const resources = displayArrayLength(r.resourceFiles) ?? 0;
  const version = str(r.version);
  return summary(
    `skill_load ${str(r.name)} -> loaded`,
    [
      `body ${bodyChars} chars · ${resources} resource file${
        resources === 1 ? "" : "s"
      }${version ? " · v" + version : ""}`,
    ],
    "success",
  );
}

function summarizeTaskToolResult(
  toolName: string,
  r: Record<string, unknown>,
): ToolResultDisplay {
  if (Array.isArray(r.tasks)) {
    const tasks = r.tasks.filter(isRecord);
    const total = tasks.length;
    const detail = tasks
      .slice(0, 6)
      .map((task) =>
        [
          shortId(str(task.id)),
          str(task.status),
          str(task.kind),
          str(task.title),
        ]
          .filter(Boolean)
          .join(" "),
      )
      .filter(Boolean)
      .join(" · ");
    const more = total > 6 ? ` · +${total - 6} more` : "";
    return summary(
      `task list -> ${total} task${total === 1 ? "" : "s"}`,
      [detail ? `${detail}${more}` : ""],
      "muted",
    );
  }

  if (Array.isArray(r.chunks)) {
    const chunks = r.chunks.filter(isRecord);
    const taskId = shortId(str(r.taskId) || str(chunks[0]?.taskId));
    const status = str(r.status);
    const complete = r.complete === true ? "complete" : "open";
    const lines = chunks
      .slice(-4)
      .map((chunk) => {
        const channel = str(chunk.channel);
        const data = sanitizeAnsiForRender(str(chunk.data)).trim();
        return [channel === "stderr" ? "stderr:" : "", data]
          .filter(Boolean)
          .join(" ");
      })
      .filter(Boolean);
    return summary(
      `task output ${taskId || ""}`.trim(),
      [
        `${chunks.length} chunk${chunks.length === 1 ? "" : "s"} · ${status || complete}`,
        ...lines,
      ],
      status === "failed" ? "error" : "muted",
    );
  }

  if (str(r.id) && str(r.status)) {
    const result = rec(r.result);
    const exit =
      typeof result.exitCode === "number" ? `exit ${result.exitCode}` : "";
    const chunks =
      typeof r.outputChunks === "number"
        ? `${r.outputChunks} chunk${r.outputChunks === 1 ? "" : "s"}`
        : "";
    return summary(
      `task ${shortId(str(r.id))} -> ${str(r.status)}`,
      [str(r.kind), exit, chunks, str(r.title)],
      str(r.status) === "failed" ? "error" : "muted",
    );
  }

  if (typeof r.cancelled === "boolean") {
    return summary(
      `${toolName} -> ${r.cancelled ? "cancelled" : "not cancelled"}`,
      [],
      r.cancelled ? "warning" : "muted",
    );
  }

  if (str(r.taskId)) {
    const actualMode = str(r.actualMode);
    const mode = actualMode || str(r.mode);
    return summary(
      `task ${str(r.taskId)}${mode ? ` · ${mode}` : ""}`,
      [
        r.promoted === true ? "promoted from foreground" : "",
        r.deduplicated === true ? "reused an already-running task" : "",
      ],
      "muted",
    );
  }

  return summary(`${toolName} completed`, [], "muted");
}

function isAsyncTaskReceipt(r: Record<string, unknown>): boolean {
  return (
    Boolean(str(r.taskId)) &&
    (r.actualMode === "awaited" || r.actualMode === "detached") &&
    typeof r.parentWillWait === "boolean"
  );
}

function summarizeSpawnAgentReceipt(
  r: Record<string, unknown>,
): ToolResultDisplay {
  const taskId = str(r.taskId);
  const actualMode = str(r.actualMode);
  const role = str(r.role);
  const childRunId = shortId(str(r.childRunId));
  const foregroundTimeoutMs =
    typeof r.foregroundTimeoutMs === "number"
      ? `${r.foregroundTimeoutMs}ms foreground budget`
      : "";
  return summary(
    `spawn_agent → ${actualMode} task ${taskId}`,
    [
      [role, childRunId ? `child ${childRunId}` : ""]
        .filter(Boolean)
        .join(" · "),
      r.promoted === true
        ? `promoted${foregroundTimeoutMs ? ` after ${foregroundTimeoutMs}` : ""}`
        : "",
    ],
    "muted",
  );
}

function summary(
  head: string,
  details: Array<string | undefined>,
  tone: ToolDisplayTone,
): ToolResultDisplay {
  return {
    kind: "summary",
    head,
    details: details.filter((line): line is string => Boolean(line)),
    tone,
  };
}

export function compactMutationPath(path: string): string {
  if (!path) return "";
  const sep = path.includes("\\") ? "\\" : "/";
  const marker = `${sep}.sparkwright${sep}`;
  const idx = path.indexOf(marker);
  if (idx >= 0) return path.slice(idx + 1);
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 4) return path;
  return `…/${parts.slice(-4).join("/")}`;
}

function rec(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isTaskToolName(name: string | undefined): boolean {
  return Boolean(name && (name === "task" || name.startsWith("task_")));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shortId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 9)}...${id.slice(-6)}` : id;
}
