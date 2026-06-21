import { describe, expect, it } from "vitest";
import type { SparkwrightEvent } from "@sparkwright/core";
import {
  createLiveEventFormatter,
  shouldPrintLiveEvent,
} from "../src/event-format.js";

function event(type: string): SparkwrightEvent {
  return {
    id: `evt_${type}`,
    runId: "run_test",
    type,
    timestamp: "2026-06-20T00:00:00.000Z",
    monotonicUs: 1,
    sequence: 1,
    payload: {},
  } as SparkwrightEvent;
}

describe("event-format live output filtering", () => {
  it("suppresses high-volume stream chunks from live CLI output", () => {
    expect(shouldPrintLiveEvent(event("model.stream.chunk"))).toBe(false);
    expect(shouldPrintLiveEvent(event("run.budget.checked"))).toBe(false);
    expect(shouldPrintLiveEvent(event("model.stream.started"))).toBe(true);
    expect(shouldPrintLiveEvent(event("model.stream.completed"))).toBe(true);
    expect(shouldPrintLiveEvent(event("tool.requested"))).toBe(true);
  });

  it("prints debug-noise events in verbose live CLI output", () => {
    expect(
      shouldPrintLiveEvent(event("model.stream.chunk"), { verbose: true }),
    ).toBe(true);
    expect(
      shouldPrintLiveEvent(event("run.budget.checked"), { verbose: true }),
    ).toBe(true);
  });

  it("aggregates suppressed live debug events", () => {
    const formatter = createLiveEventFormatter();
    expect(formatter.format(event("run.budget.checked"))).toEqual([]);
    expect(formatter.format(event("model.stream.chunk"))).toEqual([]);

    expect(formatter.format(event("model.completed"))).toEqual([
      "[1] live.debug.suppressed 2 event(s): run.budget.checked=1 model.stream.chunk=1",
      "[1] model.completed step=? adapter= tokens= toolCalls=0",
    ]);
    expect(formatter.flush()).toEqual([]);
  });
});
