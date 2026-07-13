import type { RunHandle } from "@sparkwright/core";
import { describe, expect, it } from "vitest";
import {
  findSimilarSuccessfulDelegation,
  rememberSuccessfulDelegation,
  withAlreadyCompletedNote,
} from "../src/agents/delegation-ledger.js";
import type {
  DelegationLedgerKey,
  DelegationLedgerResult,
} from "../src/agents/types.js";

const key: DelegationLedgerKey = {
  kind: "configured_delegate",
  agentProfileId: "reviewer",
  allowedTools: ["grep", "read"],
};

const completed: DelegationLedgerResult = {
  childRunId: "run_child",
  spanId: "span_child",
  signal: "completed",
  stopReason: "final_answer",
  tokens: 10,
  costUsd: 0,
  toolCalls: 1,
  modelCalls: 1,
};

describe("delegation ledger", () => {
  it("reuses only exact goals after conservative normalization", () => {
    const parent = {} as RunHandle;
    expect(
      rememberSuccessfulDelegation(
        parent,
        key,
        "List packages/core files",
        completed,
      ),
    ).toBe(true);

    expect(
      findSimilarSuccessfulDelegation(
        parent,
        { ...key, allowedTools: ["read", "grep", "read"] },
        "  LIST   packages/core files  ",
      ),
    ).toEqual({ goal: "List packages/core files", result: completed });
    expect(
      findSimilarSuccessfulDelegation(parent, key, "List packages/host files"),
    ).toBeUndefined();
  });

  it.each([
    { signal: "failed" as const },
    { stepLimitReached: true },
    { truncated: true },
  ])("does not remember non-reusable result %#", (override) => {
    const parent = {} as RunHandle;
    expect(
      rememberSuccessfulDelegation(parent, key, "Inspect runtime", {
        ...completed,
        ...override,
      }),
    ).toBe(false);
    expect(
      findSimilarSuccessfulDelegation(parent, key, "Inspect runtime"),
    ).toBeUndefined();
  });

  it("marks a reused result without mutating the stored result", () => {
    expect(withAlreadyCompletedNote(completed)).toEqual({
      ...completed,
      alreadyCompleted: true,
      note: "A similar delegation already completed in this parent run; summarize the previous child result instead of spawning another child agent.",
    });
    expect(completed).not.toHaveProperty("alreadyCompleted");
  });
});
