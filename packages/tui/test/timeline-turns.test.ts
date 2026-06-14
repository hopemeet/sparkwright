import { describe, expect, it } from "vitest";
import { extractTurns } from "../src/components/timeline-dialog.js";
import type { RunEvent } from "../src/lib/event-type.js";

function ev(type: string, sequence: number, payload?: unknown): RunEvent {
  return { type, sequence, payload };
}

/**
 * The fork picker forks at a host `run.started` sequence but labels the turn
 * with the goal. run.started.payload.goal is empty on some providers, so the
 * goal is paired from the preceding `tui.user` event (synthetic, negative seq).
 */
describe("extractTurns", () => {
  it("pairs each run.started sequence with the preceding tui.user goal", () => {
    const turns = extractTurns([
      ev("tui.user", -1, { goal: "first goal" }),
      ev("run.started", 10, {}),
      ev("tui.user", -2, { goal: "second goal" }),
      ev("run.started", 25, {}),
    ]);
    expect(turns).toEqual([
      { sequence: 10, goal: "first goal" },
      { sequence: 25, goal: "second goal" },
    ]);
  });

  it("prefers run.started.payload.goal when present", () => {
    const turns = extractTurns([
      ev("tui.user", -1, { goal: "from user event" }),
      ev("run.started", 10, { goal: "from run event" }),
    ]);
    expect(turns[0].goal).toBe("from run event");
  });

  it("falls back to (run) when no goal is available", () => {
    const turns = extractTurns([ev("run.started", 5, {})]);
    expect(turns).toEqual([{ sequence: 5, goal: "(run)" }]);
  });

  it("does not reuse a goal across two runs", () => {
    const turns = extractTurns([
      ev("tui.user", -1, { goal: "only goal" }),
      ev("run.started", 10, {}),
      ev("run.started", 20, {}),
    ]);
    expect(turns[0].goal).toBe("only goal");
    expect(turns[1].goal).toBe("(run)");
  });
});
