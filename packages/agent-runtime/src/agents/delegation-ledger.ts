import type { RunHandle } from "@sparkwright/core";
import type {
  DelegationLedgerHit,
  DelegationLedgerKey,
  DelegationLedgerResult,
} from "./types.js";

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

/**
 * Compatibility name retained for callers. Reuse is exact after conservative
 * normalization; this function no longer performs fuzzy similarity matching.
 */
export function findSimilarSuccessfulDelegation(
  parent: RunHandle,
  key: DelegationLedgerKey,
  goal: string,
): DelegationLedgerHit | undefined {
  const entries = delegationLedgersByParent.get(parent) ?? [];
  const normalizedKey = delegationLedgerKeyString(key);
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

export function rememberSuccessfulDelegation(
  parent: RunHandle,
  key: DelegationLedgerKey,
  goal: string,
  result: DelegationLedgerResult,
): boolean {
  if (!isReusableDelegationResult(result)) return false;
  const entries = delegationLedgersByParent.get(parent) ?? [];
  entries.push({
    key: delegationLedgerKeyString(key),
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

export function withAlreadyCompletedNote(
  result: DelegationLedgerResult,
): DelegationLedgerResult {
  return {
    ...result,
    alreadyCompleted: true,
    note: "A similar delegation already completed in this parent run; summarize the previous child result instead of spawning another child agent.",
  };
}

function isReusableDelegationResult(result: DelegationLedgerResult): boolean {
  return (
    result.signal === "completed" &&
    result.stepLimitReached !== true &&
    result.truncated !== true
  );
}

function delegationLedgerKeyString(key: DelegationLedgerKey): string {
  const allowedTools =
    key.allowedTools && key.allowedTools.length > 0
      ? [...new Set(key.allowedTools)].sort()
      : undefined;
  return JSON.stringify({
    kind: key.kind,
    ...(key.agentProfileId ? { agentProfileId: key.agentProfileId } : {}),
    ...(key.delegateTool ? { delegateTool: key.delegateTool } : {}),
    ...(key.role ? { role: key.role } : {}),
    ...(key.prompt ? { prompt: key.prompt } : {}),
    ...(allowedTools ? { allowedTools } : {}),
  });
}

function delegationGoalFingerprint(goal: string): string {
  return goal.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
}
