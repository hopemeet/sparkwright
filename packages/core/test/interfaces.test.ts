import { describe, expect, it } from "vitest";
import type { Compactor, ContextHints } from "../src/context.js";
import type { MemoryEntry, MemoryStore } from "../src/memory.js";
import { asSessionId, type Session, type SessionStore } from "../src/index.js";
import type { RunStore, TraceSink } from "../src/storage.js";
import { FileRunStore, MemoryTrace } from "../src/trace.js";
import type { ContextItem, RunRecord, RunResult } from "../src/types.js";
import type { RunId } from "../src/ids.js";
import type { SparkwrightEvent } from "../src/events.js";

// Compile-time assertion helper.
function assignable<T>(_value: T): void {
  void _value;
}

describe("extension interfaces (compile-time)", () => {
  it("FileRunStore satisfies RunStore", () => {
    const run: RunRecord = {
      id: "run_iface_test" as unknown as RunId,
      goal: "iface",
      state: "created",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    };
    const store = new FileRunStore(run, {
      rootDir: ".sparkwright/test-iface-runs",
    });
    assignable<RunStore>(store);
    expect(typeof store.append).toBe("function");
    expect(typeof store.finish).toBe("function");
  });

  it("MemoryTrace satisfies TraceSink", () => {
    const sink: TraceSink = new MemoryTrace();
    const evt = {
      id: "evt_x",
      runId: "run_x" as unknown as RunId,
      type: "run.created",
      payload: {},
      metadata: {},
      timestamp: new Date().toISOString(),
    } as unknown as SparkwrightEvent;
    sink.write(evt);
    expect(true).toBe(true);
  });

  it("Compactor / MemoryStore / SessionStore shapes are usable", async () => {
    const compactor: Compactor = {
      async compact(items: ContextItem[], _hints: ContextHints) {
        return items;
      },
    };
    const memory: MemoryStore = {
      async remember(entry) {
        const e: MemoryEntry = {
          id: "m1",
          createdAt: new Date().toISOString(),
          ...entry,
        };
        return e;
      },
      async recall() {
        return [];
      },
      async forget() {},
    };
    const session: Session = {
      id: asSessionId("s1"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      runIds: [],
    };
    const sessions: SessionStore = {
      async create() {
        return session;
      },
      async get() {
        return null;
      },
      async append() {
        return session;
      },
      async list() {
        return [];
      },
    };

    const result: RunResult = {
      signal: "completed",
      state: "completed",
      metadata: {},
    };

    expect(await compactor.compact([], {})).toEqual([]);
    expect((await memory.remember({ key: "k", value: 1 })).id).toBe("m1");
    expect(await sessions.get("x")).toBeNull();
    expect(result.signal).toBe("completed");
  });
});
