import { formatToolRequestPreview, oneLine } from "./tool-request-preview.js";
import {
  classifyToolResult,
  summarizeGlobResult,
  summarizeListDir,
  summarizeShellResult,
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

  if (resultKind === "file_read") {
    if (input.mode === "live") return { kind: "hidden", reason: "file_read" };
    const path = str(r.path) || input.toolName || "read_file";
    const lines =
      typeof r.totalLines === "number"
        ? `${r.totalLines} line${r.totalLines === 1 ? "" : "s"}`
        : "";
    const bytes = typeof r.bytes === "number" ? `${r.bytes} bytes` : "";
    return summary(`read_file ${path}`, [lines, bytes], "muted");
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

  if (resultKind === "skill_mutation") {
    return summarizeSkillMutation(r);
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
    const message = str(r.message).trim();
    if (!message) return { kind: "hidden", reason: "agent_empty" };
    return { kind: "markdown", text: message, details: [], tone: "normal" };
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

function summarizeSkillMutation(r: Record<string, unknown>): ToolResultDisplay {
  const action = str(r.action) || "skill";
  const name = str(r.name);
  const proposalId = str(r.proposalId);
  const changed = r.changed === false ? "unchanged" : "changed";
  const path = compactMutationPath(str(r.path) || str(r.proposalPath));
  const label =
    action === "draft"
      ? "skill proposal"
      : action === "apply"
        ? "skill proposal applied"
        : "skill mutation";
  return summary(
    `${label} ${proposalId || name || action}`,
    [
      changed,
      path,
      action === "draft" ? "draft only; original Skill package unchanged" : "",
    ],
    "success",
  );
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

  const bodyChars = str(r.content).length;
  const resources = Array.isArray(r.resourceFiles) ? r.resourceFiles.length : 0;
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
