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
  else if (isVerificationHook(p)) color = verificationHookColor(t, p);
  else if (isWorkflowHook(t)) color = workflowHookColor(t, p);
  else if (t.startsWith("approval.")) color = "yellow";
  else if (t.startsWith("tool.")) color = "cyan";
  else if (t.startsWith("skill.")) color = "blue";
  else if (t.startsWith("capability.")) color = "red";
  else if (t.startsWith("mcp.")) color = "cyan";
  else if (t.startsWith("agent.") || t.startsWith("subagent."))
    color = t.endsWith(".failed") ? "red" : "magenta";
  else if (t.startsWith("workspace.write")) color = "magenta";
  else if (t === "run.completed") color = "green";
  else if (t.startsWith("run.")) color = "white";
  if (t === "mcp.server.prepared" && p?.status === "failed") color = "red";

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
    else if (t === "capability.mutation.completed") {
      detail = [str(p.action), compactCapabilityPath(str(p.path))]
        .filter(Boolean)
        .join(" ");
    } else if (isVerificationHook(p)) detail = verificationHookDetail(t, p);
    else if (isWorkflowHook(t)) detail = workflowHookDetail(t, p);
    else if (t === "skill.indexed") detail = `${p.count ?? 0} skills`;
    else if (t === "skill.failed") detail = str(p.source ?? p.message);
    else if (t === "skill.loaded") detail = str(p.name);
    else if (t === "capability.index.failed") {
      detail = [str(p.kind), str(p.code), str(p.source)]
        .filter(Boolean)
        .join(" ");
    } else if (t === "mcp.server.prepared") {
      const name = str(p.name);
      const status = str(p.status);
      const errorCode = str(p.errorCode);
      detail = [name, status, errorCode].filter(Boolean).join(" ");
    } else if (t === "agent.profile.derived") {
      detail = [str(p.parentAgentId), str(p.childAgentId)]
        .filter(Boolean)
        .join(" → ");
    } else if (t.startsWith("subagent.")) {
      detail = str(p.agentName) || str(p.goal) || str(p.childRunId);
    }
  }

  return {
    color,
    label: isVerificationHook(p)
      ? "verification"
      : isWorkflowHook(t)
        ? "workflow hook"
        : t,
    detail,
  };
}

function compactCapabilityPath(path: string): string {
  if (!path) return "";
  const normalized = path.replaceAll("\\", "/");
  const idx = normalized.indexOf("/.sparkwright/");
  if (idx >= 0) return normalized.slice(idx + 1);
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 4) return normalized;
  return `…/${parts.slice(-4).join("/")}`;
}

function isVerificationHook(payload: Record<string, unknown> | null): boolean {
  return str(payload?.hookName).startsWith("verification:");
}

function isWorkflowHook(type: string): boolean {
  return type.startsWith("workflow_hook.");
}

function verificationHookColor(
  type: string,
  payload: Record<string, unknown> | null,
): string {
  if (type.endsWith(".started")) return "gray";
  return verificationHookPassed(payload) ? "green" : "red";
}

function workflowHookColor(
  type: string,
  payload: Record<string, unknown> | null,
): string {
  if (type.endsWith(".started")) return "gray";
  const status = hookStatus(type, payload);
  if (status === "blocked" || status.startsWith("failed")) return "red";
  if (status === "ok" || status === "passed") return "green";
  return "gray";
}

function verificationHookPassed(payload: Record<string, unknown> | null) {
  const result = rec(payload?.result);
  if (result?.status === "continue" && !rec(result.metadata)) return true;
  if (result?.status === "block") return false;
  const metadata = rec(result?.metadata);
  if (!metadata) return false;
  if (!("exitCode" in metadata)) return result?.status === "continue";
  return metadata.exitCode === 0 && metadata.timedOut !== true;
}

function verificationHookStatus(
  type: string,
  payload: Record<string, unknown> | null,
) {
  return hookStatus(type, payload);
}

function hookStatus(type: string, payload: Record<string, unknown> | null) {
  if (type.endsWith(".started")) return "started";
  const result = rec(payload?.result);
  const metadata = rec(result?.metadata);
  if (metadata?.timedOut === true) return "timed out";
  if (metadata && "exitCode" in metadata) {
    return metadata.exitCode === 0
      ? "passed"
      : `failed exitCode=${String(metadata.exitCode)}`;
  }
  if (result?.status === "block") return "blocked";
  if (result?.status === "continue") return "ok";
  return "unknown";
}

function verificationHookDetail(
  type: string,
  payload: Record<string, unknown> | null,
) {
  const hookName = str(payload?.hookName);
  const [, profile, ...idParts] = hookName.split(":");
  const id = idParts.join(":");
  const status = verificationHookStatus(type, payload);
  return [profile, id, status].filter(Boolean).join(" ");
}

function workflowHookDetail(
  type: string,
  payload: Record<string, unknown> | null,
) {
  const hookName = str(payload?.hookName) || str(payload?.hook);
  const status = hookStatus(type, payload);
  return [hookName, status].filter(Boolean).join(" ");
}
