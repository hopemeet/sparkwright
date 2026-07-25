import { describe, expect, it } from "vitest";
import { LayerStack } from "../src/state/layer-stack.js";
import type { ApprovalViewModel } from "../src/lib/approval-view-model.js";

function approval(approvalId: string): ApprovalViewModel {
  return {
    approvalId,
    action: "tool.execute",
    kind: "tool.execute",
    risk: "medium",
    summary: "Run tool",
    exactScope: "exact arguments",
    subject: { kind: "one_shot", label: "Allow once" },
    principalKind: "main",
    principalScope: "session:test",
    executionKind: "main",
    runId: "run_1",
    sessionId: "session_1",
    queuePosition: 1,
    queueDepth: 1,
    resolving: false,
    createdAt: "2026-07-19T00:00:00.000Z",
  };
}

describe("LayerStack", () => {
  it("orders by priority — approval floats above ordinary panels", () => {
    const s = new LayerStack();
    s.push("help");
    s.push("approval", approval("a1"));
    const top = s.top();
    expect(top?.name).toBe("approval");
    if (top?.name !== "approval") throw new Error("approval should be top");
    expect(top.payload.approvalId).toBe("a1");
  });

  it("keeps approval above the detailed transcript", () => {
    const s = new LayerStack();
    s.push("details");
    s.push("approval", approval("a1"));
    expect(s.top()?.name).toBe("approval");
    s.pop("approval");
    expect(s.top()?.name).toBe("details");
  });

  it("pushing same name swaps payload instead of stacking", () => {
    const s = new LayerStack();
    s.push("approval", approval("a1"));
    s.push("approval", approval("a2"));
    expect(s.getSnapshot().length).toBe(1);
    const top = s.top();
    if (top?.name !== "approval") throw new Error("approval should be top");
    expect(top.payload.approvalId).toBe("a2");
  });

  it("pop by name removes only that layer", () => {
    const s = new LayerStack();
    s.push("activity", { tab: "events" });
    s.push("help");
    s.pop("activity");
    expect(s.getSnapshot().map((l) => l.name)).toEqual(["help"]);
  });

  it("toggle pushes then pops", () => {
    const s = new LayerStack();
    s.toggle("help");
    expect(s.has("help")).toBe(true);
    s.toggle("help");
    expect(s.has("help")).toBe(false);
  });
});
