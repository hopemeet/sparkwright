import type { WorkflowRunSnapshot } from "@sparkwright/protocol";

export function shortWorkflowId(id: string): string {
  if (id.length <= 18) return id;
  const parts = id.split("_");
  const suffix = parts[parts.length - 1] ?? id;
  return suffix.length >= 8 ? suffix.slice(0, 12) : id.slice(-12);
}

export function latestWorkflowVerdict(
  workflow: WorkflowRunSnapshot,
): string | undefined {
  const latest = workflow.latestVerdict;
  if (!latest) return undefined;
  const verdictRecord = latest.verdict;
  const status =
    typeof verdictRecord.status === "string"
      ? verdictRecord.status
      : typeof verdictRecord.result === "string"
        ? verdictRecord.result
        : undefined;
  const node = latest.nodeId.trim() ? latest.nodeId : undefined;
  return [node, status].filter(Boolean).join(": ") || undefined;
}

export function formatWorkflowSummary(workflow: WorkflowRunSnapshot): string {
  const id = shortWorkflowId(workflow.id);
  const node = workflow.currentNodeId ? ` node=${workflow.currentNodeId}` : "";
  const wait = workflow.wait
    ? ` wait=${workflow.wait.kind}${workflow.wait.reason ? `:${workflow.wait.reason}` : ""}`
    : "";
  const failure = workflow.failure
    ? ` failure=${workflow.failure.kind}:${workflow.failure.code}`
    : "";
  const active = workflow.activeRunId ? " live" : "";
  return `${id} ${workflow.status} ${workflow.assetName}${node}${wait}${failure}${active}`;
}

export function formatWorkflowListNotice(
  workflows: readonly WorkflowRunSnapshot[],
): string {
  if (workflows.length === 0) return "workflow list: no workflow jobs found";
  const rows = workflows.slice(0, 20).map(formatWorkflowSummary);
  const more =
    workflows.length > rows.length ? `\n... ${workflows.length - rows.length} more` : "";
  return `workflow list:\n${rows.join("\n")}${more}`;
}
