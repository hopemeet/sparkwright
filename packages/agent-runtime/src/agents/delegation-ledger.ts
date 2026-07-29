import { createHash } from "node:crypto";
import type { RunHandle } from "@sparkwright/core";
import type {
  DelegationLedgerHit,
  DelegationLedgerKey,
  DelegationLedgerResult,
  ParentAgentResult,
} from "./types.js";
import { isReusableAgentResult, projectParentAgentResult } from "./result.js";

interface DelegationLedgerEntry {
  key: string;
  goal: string;
  goalFingerprint: string;
  result: DelegationLedgerResult;
}

const DELEGATION_LEDGER_MAX_RESULTS = 24;
const delegationLedgersByParent = new WeakMap<
  RunHandle,
  DelegationLedgerEntry[]
>();

export function findReusableDelegation(
  parent: RunHandle,
  key: DelegationLedgerKey,
  goal: string,
): DelegationLedgerHit | undefined {
  if (key.cacheable === false) return undefined;
  const entries = delegationLedgersByParent.get(parent) ?? [];
  const normalizedKey = delegationLedgerKeyString(parent, key);
  const goalFingerprint = delegationGoalFingerprint(goal);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const candidate = entries[i];
    if (!candidate || candidate.key !== normalizedKey) continue;
    if (candidate.goalFingerprint === goalFingerprint) {
      return { goal: candidate.goal, result: candidate.result };
    }
  }
  return undefined;
}

export function rememberReusableDelegation(
  parent: RunHandle,
  key: DelegationLedgerKey,
  goal: string,
  result: DelegationLedgerResult,
): boolean {
  if (key.cacheable === false) return false;
  if (!isReusableAgentResult(result)) return false;
  const entries = delegationLedgersByParent.get(parent) ?? [];
  entries.push({
    key: delegationLedgerKeyString(parent, key),
    goal,
    goalFingerprint: delegationGoalFingerprint(goal),
    result: { ...result },
  });
  delegationLedgersByParent.set(
    parent,
    entries.slice(-DELEGATION_LEDGER_MAX_RESULTS),
  );
  return true;
}

export function reusedDelegationResult(
  result: DelegationLedgerResult,
): ParentAgentResult {
  return projectParentAgentResult({
    result,
    workspace: result.output?.workspace ?? { writes: 0 },
    reused: true,
  });
}

function delegationLedgerKeyString(
  parent: RunHandle,
  key: DelegationLedgerKey,
): string {
  const allowedTools =
    key.allowedTools && key.allowedTools.length > 0
      ? [...new Set(key.allowedTools)].sort()
      : undefined;
  const metadata = parent.record?.metadata ?? {};
  return JSON.stringify({
    kind: key.kind,
    ...(key.agentProfileId ? { agentProfileId: key.agentProfileId } : {}),
    ...(key.delegateTool ? { delegateTool: key.delegateTool } : {}),
    ...(key.role ? { role: key.role } : {}),
    ...(key.context ? { context: key.context } : {}),
    ...(allowedTools ? { allowedTools } : {}),
    modelFingerprint:
      key.modelFingerprint ?? stableFingerprint(metadata.resolvedModel),
    capabilityFingerprint:
      key.capabilityFingerprint ?? parentCapabilityFingerprint(parent),
    promptFingerprint:
      key.promptFingerprint ??
      stableFingerprint({
        project: metadata.projectPromptFingerprint,
        profile: metadata.agentAssetIdentity,
      }),
    workspaceEpoch:
      key.workspaceEpoch ?? parent.getWorkspaceState?.()?.currentEpoch() ?? 0,
  });
}

function delegationGoalFingerprint(goal: string): string {
  return goal.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
}

function parentCapabilityFingerprint(parent: RunHandle): string {
  return stableFingerprint(
    (parent.tools?.list?.() ?? [])
      .filter((tool) => tool.delegation === "child")
      .map((tool) => ({
        name: tool.name,
        governance: tool.governance,
        terminal: tool.terminal?.kind,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  );
}

function stableFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(stableJson(value))
    .digest("hex")
    .slice(0, 24);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
