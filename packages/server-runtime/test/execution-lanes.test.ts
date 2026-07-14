import { describe, expect, it, vi } from "vitest";
import {
  ExecutionLaneCoordinator,
  type ExecutionDriver,
  type ExecutionHandle,
} from "../src/execution-lanes.js";

interface Input {
  name: string;
  fail?: boolean;
  waitStart?: Promise<void>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness() {
  const starts: string[] = [];
  const handles = new Map<
    string,
    ExecutionHandle<string, string> & {
      finish(): void;
      inject: ReturnType<typeof vi.fn>;
    }
  >();
  const driver: ExecutionDriver<Input, string, string> = {
    async start(input) {
      starts.push(input.name);
      await input.waitStart;
      if (input.fail) throw new Error(`failed ${input.name}`);
      const done = deferred<string>();
      const inject = vi.fn(() => "accepted" as const);
      const handle = {
        rootRunId: `run_${input.name}`,
        currentRunId: () => `run_${input.name}`,
        tryInject: inject,
        cancel: vi.fn(() => done.resolve("cancelled")),
        completion: done.promise,
        finish: () => done.resolve("completed"),
        inject,
      };
      handles.set(input.name, handle);
      return handle;
    },
  };
  return { starts, handles, driver };
}

function submit(
  coordinator: ExecutionLaneCoordinator<Input, string, string>,
  laneKey: string,
  name: string,
  extra: Partial<{
    idempotencyKey: string;
    digest: string;
    waitStart: Promise<void>;
    fail: boolean;
  }> = {},
) {
  return coordinator.submit({
    laneKey,
    sessionId: laneKey,
    idempotencyKey: extra.idempotencyKey,
    digest: extra.digest ?? name,
    input: { name, waitStart: extra.waitStart, fail: extra.fail },
  });
}

async function started(submission: ReturnType<typeof submit>) {
  if (submission.status !== "accepted") throw new Error(submission.message);
  return submission.result;
}

describe("ExecutionLaneCoordinator", () => {
  it("runs different lanes concurrently and serializes FIFO within one lane", async () => {
    const h = harness();
    const coordinator = new ExecutionLaneCoordinator(h.driver, {
      maxActiveExecutions: 2,
    });
    const a1 = submit(coordinator, "a", "a1");
    const a2 = submit(coordinator, "a", "a2");
    const b1 = submit(coordinator, "b", "b1");
    await Promise.all([started(a1), started(b1)]);
    expect(h.starts).toEqual(["a1", "b1"]);
    h.handles.get("a1")!.finish();
    await started(a2);
    expect(h.starts).toEqual(["a1", "b1", "a2"]);
  });

  it("admits runnable lane heads round-robin", async () => {
    const h = harness();
    const coordinator = new ExecutionLaneCoordinator(h.driver, {
      maxActiveExecutions: 1,
    });
    const a1 = submit(coordinator, "a", "a1");
    const a2 = submit(coordinator, "a", "a2");
    const b1 = submit(coordinator, "b", "b1");
    await started(a1);
    h.handles.get("a1")!.finish();
    await started(b1);
    h.handles.get("b1")!.finish();
    await started(a2);
    expect(h.starts).toEqual(["a1", "b1", "a2"]);
  });

  it("enforces per-lane and total queue bounds", async () => {
    const h = harness();
    const coordinator = new ExecutionLaneCoordinator(h.driver, {
      maxActiveExecutions: 1,
      maxQueuedPerLane: 1,
      maxQueuedTotal: 1,
    });
    submit(coordinator, "a", "a1");
    expect(submit(coordinator, "a", "a2").status).toBe("accepted");
    expect(submit(coordinator, "a", "a3").status).toBe("capacity");
    expect(submit(coordinator, "b", "b1").status).toBe("capacity");
  });

  it("coalesces duplicate async starts and rejects digest conflicts", async () => {
    const h = harness();
    const gate = deferred<void>();
    const coordinator = new ExecutionLaneCoordinator(h.driver);
    const first = submit(coordinator, "a", "a1", {
      idempotencyKey: "same",
      digest: "v1",
      waitStart: gate.promise,
    });
    const duplicate = submit(coordinator, "a", "ignored", {
      idempotencyKey: "same",
      digest: "v1",
    });
    const conflict = submit(coordinator, "a", "conflict", {
      idempotencyKey: "same",
      digest: "v2",
    });
    expect(duplicate).toBe(first);
    expect(conflict.status).toBe("conflict");
    gate.resolve();
    await started(first);
    expect(h.starts).toEqual(["a1"]);
  });

  it("routes injection to the active opaque handle", async () => {
    const h = harness();
    const coordinator = new ExecutionLaneCoordinator(h.driver);
    await started(submit(coordinator, "a", "a1"));
    expect(coordinator.tryInject({ laneKey: "a", message: "hello" })).toBe(
      "accepted",
    );
    expect(h.handles.get("a1")!.inject).toHaveBeenCalledWith("hello");
  });

  it("cancels active execution without deleting queued work", async () => {
    const h = harness();
    const coordinator = new ExecutionLaneCoordinator(h.driver, {
      maxActiveExecutions: 1,
    });
    const first = submit(coordinator, "a", "a1");
    const next = submit(coordinator, "a", "a2");
    const firstResult = await started(first);
    expect(coordinator.cancelExecution(firstResult.executionId)).toBe(true);
    await started(next);
    expect(h.starts).toEqual(["a1", "a2"]);
  });

  it("cancelLane cancels active and settles every queued command", async () => {
    const h = harness();
    const coordinator = new ExecutionLaneCoordinator(h.driver, {
      maxActiveExecutions: 1,
    });
    const active = submit(coordinator, "a", "a1");
    const queued = submit(coordinator, "a", "a2");
    await started(active);
    expect(coordinator.cancelLane("a")).toBe(2);
    await expect(started(queued)).resolves.toMatchObject({
      status: "cancelled",
    });
  });

  it("hands off after start failure and counts completion once", async () => {
    const h = harness();
    const coordinator = new ExecutionLaneCoordinator(h.driver, {
      maxActiveExecutions: 1,
    });
    const failed = submit(coordinator, "a", "bad", { fail: true });
    const next = submit(coordinator, "a", "next");
    await expect(started(failed)).resolves.toMatchObject({ status: "failed" });
    await started(next);
    h.handles.get("next")!.finish();
    h.handles.get("next")!.finish();
    await Promise.resolve();
    expect(coordinator.snapshot().active).toBe(0);
    expect(h.starts).toEqual(["bad", "next"]);
  });
});
