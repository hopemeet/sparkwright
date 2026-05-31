import { describe, expect, it } from "vitest";
import { EventLog } from "../src/events.js";
import { createRunId } from "../src/ids.js";

describe("EventLog", () => {
  it("emits monotonically increasing sequence numbers", () => {
    const log = new EventLog(createRunId());

    const first = log.emit("run.created", {});
    const second = log.emit("run.started", {});

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(log.all().map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("notifies subscribers", () => {
    const log = new EventLog(createRunId());
    const seen: string[] = [];

    const unsubscribe = log.subscribe((event) => seen.push(event.type));
    log.emit("run.created", {});
    unsubscribe();
    log.emit("run.started", {});

    expect(seen).toEqual(["run.created"]);
  });
});
