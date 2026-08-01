import { createId } from "./ids.js";
import type { SparkwrightEvent } from "./events.js";
import type { FactLedgerSnapshot } from "./fact-ledger.js";
import { isRecord } from "./record-utils.js";
import type { RunAssessment } from "./run-assessment.js";
import type { RunRecord, RuntimeNotice } from "./types.js";

export interface RuntimeStateEvaluation {
  status: "completed" | "partial";
  notices: RuntimeNotice[];
}

interface ChildBlockerFact {
  childRunId: string;
  status: "partial" | "blocked";
  summary?: string;
  blockerCode: string;
}

/**
 * Passive terminal projection over recorded runtime evidence.
 *
 * Ordinary Agent completion is model-owned: child outcomes, approvals, and
 * verification evidence remain visible as immutable notices but do not reopen
 * the ReAct loop or override a natural final answer. Only runtime-owned budget
 * exhaustion can downgrade an otherwise normal terminal projection here.
 * Explicit Workflow verifiers keep their hard gate in the Host Stop-hook path.
 */
export function evaluateRuntimeState(input: {
  run: RunRecord;
  events: readonly SparkwrightEvent[];
  factLedger: FactLedgerSnapshot;
  assessment?: RunAssessment;
}): RuntimeStateEvaluation {
  const notices: RuntimeNotice[] = [];
  const incomplete = input.factLedger.budgetExceeded.length > 0;
  const add = (notice: Omit<RuntimeNotice, "id" | "sourceRunId">): void => {
    const duplicate = notices.some(
      (existing) =>
        existing.code === notice.code &&
        existing.childRunId === notice.childRunId &&
        existing.message === notice.message,
    );
    if (duplicate) return;
    notices.push({
      id: createId("runtime_notice"),
      sourceRunId: input.run.id,
      ...notice,
    });
  };

  const childFacts = collectChildBlockerFacts(input.events);
  for (const fact of childFacts) {
    add({
      code: fact.status === "blocked" ? "child_blocked" : "child_partial",
      severity: "warning",
      message:
        fact.summary ?? `A child agent ended with ${fact.status} status.`,
      childRunId: fact.childRunId,
      metadata: {
        status: fact.status,
        blockerCode: fact.blockerCode,
      },
    });
  }

  for (const event of input.events) {
    const payload = isRecord(event.payload) ? event.payload : {};
    if (
      (event.type === "subagent.completed" ||
        event.type === "subagent.failed") &&
      payload.stepLimitReached === true
    ) {
      add({
        code: "child_step_limit",
        severity: "warning",
        message: "A child agent reached its step limit.",
        ...(stringValue(payload.childRunId)
          ? { childRunId: stringValue(payload.childRunId) }
          : {}),
      });
    }
    if (event.type === "approval.resolved" && payload.decision === "denied") {
      add({
        code: "approval_denied",
        severity: "warning",
        message:
          stringValue(payload.message) ??
          "A runtime approval request was denied.",
      });
    }
  }

  const receipts = input.factLedger.verificationReceipts;
  for (const receipt of receipts) {
    if (receipt.status === "failed" || receipt.status === "timed_out") {
      add({
        code: "verification_failed",
        severity: "error",
        message: receipt.command
          ? `Verification failed: ${receipt.command}`
          : "A required verification receipt failed.",
        metadata: {
          receiptId: receipt.id,
          level: receipt.level,
          status: receipt.status,
        },
      });
    } else if (receipt.status === "stale") {
      add({
        code: "verification_receipt_stale",
        severity: "warning",
        message: receipt.command
          ? `Verification is stale after later writes: ${receipt.command}`
          : "A verification receipt became stale after later writes.",
        metadata: { receiptId: receipt.id, level: receipt.level },
      });
    }
  }

  for (const verification of input.assessment?.verification ?? []) {
    if (
      verification.status !== "failed" &&
      verification.status !== "timed_out" &&
      verification.status !== "stale"
    ) {
      continue;
    }
    add({
      code:
        verification.status === "stale"
          ? "verification_receipt_stale"
          : "verification_failed",
      severity: verification.status === "stale" ? "warning" : "error",
      message: verification.command
        ? `Verification ${verification.status}: ${verification.command}`
        : `Verification ${verification.status}.`,
      metadata: {
        verificationId: verification.id,
        status: verification.status,
      },
    });
  }

  if (input.factLedger.budgetExceeded.length > 0) {
    add({
      code: "budget_exhausted",
      severity: "warning",
      message: "A runtime continuation budget was exhausted.",
      metadata: {
        facts: input.factLedger.budgetExceeded.map((fact) => ({
          source: fact.source,
          used: fact.used,
          limit: fact.limit,
        })),
      },
    });
  }

  return {
    status: incomplete ? "partial" : "completed",
    notices,
  };
}

/** @deprecated Use RuntimeStateEvaluation. */
export type CompletionEvaluation = RuntimeStateEvaluation;

/** @deprecated Use evaluateRuntimeState. */
export const evaluateCompletion = evaluateRuntimeState;

function collectChildBlockerFacts(
  events: readonly SparkwrightEvent[],
): ChildBlockerFact[] {
  const facts: ChildBlockerFact[] = [];
  for (const event of events) {
    if (
      event.type !== "subagent.completed" &&
      event.type !== "subagent.failed"
    ) {
      continue;
    }
    const payload = isRecord(event.payload) ? event.payload : {};
    const status =
      payload.status === "blocked"
        ? "blocked"
        : payload.status === "partial" || event.type === "subagent.failed"
          ? "partial"
          : undefined;
    const childRunId = stringValue(payload.childRunId);
    if (!status || !childRunId) continue;
    const blockers = Array.isArray(payload.blockers)
      ? payload.blockers.filter(isRecord)
      : [];
    if (blockers.length === 0) {
      facts.push({
        childRunId,
        status,
        ...(stringValue(payload.summary)
          ? { summary: stringValue(payload.summary) }
          : {}),
        blockerCode: "CHILD_OUTCOME_INCOMPLETE",
      });
      continue;
    }
    for (const blocker of blockers) {
      facts.push({
        childRunId,
        status,
        ...(stringValue(payload.summary)
          ? { summary: stringValue(payload.summary) }
          : {}),
        blockerCode: stringValue(blocker.code) ?? "CHILD_BLOCKER",
      });
    }
  }
  return facts;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
