import { describe, expect, it } from "vitest";
import { InMemorySessionStore, forkSessionFromEvent } from "../src/session.js";
import { createRunId } from "../src/ids.js";

describe("forkSessionFromEvent", () => {
  it("clones the full session when no fork point is given", async () => {
    const store = new InMemorySessionStore();
    const source = await store.create();
    const runA = createRunId();
    const runB = createRunId();
    await store.append(source.id, runA);
    await store.append(source.id, runB);

    const result = await forkSessionFromEvent({
      sourceSessionId: source.id,
      store,
    });

    expect(result.forked.id).not.toBe(source.id);
    expect(result.forked.runIds).toEqual([runA, runB]);
    expect(result.forked.metadata?.forkedFrom).toBe(source.id);
  });

  it("truncates at the supplied sequence", async () => {
    const store = new InMemorySessionStore();
    const source = await store.create();
    const runA = createRunId();
    const runB = createRunId();
    await store.append(source.id, runA);
    await store.append(source.id, runB);

    // Two run_appended events (seq 2 and 3) plus the initial created event
    // (seq 1). Forking at seq 2 should keep only runA.
    const result = await forkSessionFromEvent({
      sourceSessionId: source.id,
      forkAtSequence: 2,
      store,
    });

    expect(result.forked.runIds).toEqual([runA]);
    expect(result.truncatedAtSequence).toBe(2);
  });

  it("throws when the source session is missing", async () => {
    const store = new InMemorySessionStore();
    await expect(
      forkSessionFromEvent({ sourceSessionId: "missing", store }),
    ).rejects.toThrow(/not found/);
  });
});
