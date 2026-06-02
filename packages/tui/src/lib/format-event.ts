import type { RunEvent } from "./event-type.js";

export interface FormattedEvent {
  color: string;
  label: string;
  detail: string;
}

function rec(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function formatEvent(event: RunEvent): FormattedEvent {
  const t = event.type;
  const p = rec(event.payload);

  let color = "gray";
  if (t.endsWith(".failed") || t.endsWith(".rejected") || t.endsWith(".denied"))
    color = "red";
  else if (t.startsWith("approval.")) color = "yellow";
  else if (t.startsWith("tool.")) color = "cyan";
  else if (t.startsWith("skill.")) color = "blue";
  else if (t.startsWith("mcp.")) color = "cyan";
  else if (t.startsWith("agent.") || t.startsWith("subagent."))
    color = t.endsWith(".failed") ? "red" : "magenta";
  else if (t.startsWith("workspace.write")) color = "magenta";
  else if (t === "run.completed") color = "green";
  else if (t.startsWith("run.")) color = "white";

  let detail = "";
  if (p) {
    if (
      t === "tool.requested" ||
      t === "tool.started" ||
      t === "tool.completed"
    )
      detail = str(p.toolName);
    else if (t === "approval.requested") detail = str(p.summary);
    else if (t === "workspace.write.requested") detail = str(p.path);
    else if (t === "run.completed" || t === "run.failed")
      detail = str(p.reason ?? p.stopReason);
    else if (t === "skill.indexed") detail = `${p.count ?? 0} skills`;
    else if (t === "skill.loaded") detail = str(p.name);
    else if (t === "mcp.server.prepared")
      detail = `${str(p.name)} ${str(p.status)}`.trim();
    else if (t === "agent.profile.derived") {
      detail = [str(p.parentAgentId), str(p.childAgentId)]
        .filter(Boolean)
        .join(" → ");
    } else if (t.startsWith("subagent.")) {
      detail = str(p.agentName) || str(p.goal) || str(p.childRunId);
    }
  }

  return { color, label: t, detail };
}
