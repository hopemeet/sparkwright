import type { ApprovalSubject } from "./session-approval.js";

export type ApprovalKind =
  | "workspace.write"
  | "skill.apply"
  | "tool.execute"
  | "shell.execute"
  | "unknown";

export type ApprovalRisk = "low" | "medium" | "high" | "unknown";

export interface ApprovalDiffSummary {
  files: readonly string[];
  additions: number;
  deletions: number;
}

/** Presentation-only projection. It deliberately contains no Host Client. */
export interface ApprovalViewModel {
  approvalId: string;
  action: string;
  kind: ApprovalKind;
  risk: ApprovalRisk;
  summary: string;
  reason?: string;
  policyReason?: string;
  toolReason?: string;
  safetyReason?: string;
  exactScope: string;
  subject: ApprovalSubject;
  principalKind: "main" | "dynamic_child" | "configured_delegate";
  principalScope: string;
  /** @reserved Runtime principal display text consumed by approval renderers. */
  principalLabel?: string;
  executionKind: "main" | "workflow";
  runId: string;
  workflowId?: string;
  sessionId: string;
  queuePosition: number;
  queueDepth: number;
  resolving: boolean;
  submittedChoice?: "allow-once" | "allow-session" | "deny";
  error?: string;
  path?: string;
  diff?: string;
  diffSummary?: ApprovalDiffSummary;
  toolName?: string;
  toolArgs?: unknown;
  command?: string;
  cwd?: string;
  details?: Record<string, unknown>;
  createdAt: string;
}

export function defaultApprovalChoice(
  view: ApprovalViewModel,
): "allow-once" | "deny" {
  if (
    view.kind === "unknown" ||
    view.risk === "high" ||
    view.risk === "unknown"
  ) {
    return "deny";
  }
  return "allow-once";
}

export function summarizeApprovalDiff(
  diff: string | undefined,
): ApprovalDiffSummary | undefined {
  if (!diff) return undefined;
  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).replace(/^b\//u, "").trim();
      if (path && path !== "/dev/null") files.add(path);
      continue;
    }
    if (line.startsWith("--- ")) {
      const path = line.slice(4).replace(/^a\//u, "").trim();
      if (path && path !== "/dev/null") files.add(path);
      continue;
    }
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { files: [...files], additions, deletions };
}
