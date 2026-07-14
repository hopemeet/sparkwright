import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskManager } from "@sparkwright/agent-runtime";
import { createRun, defineTool } from "@sparkwright/core";
import {
  WorkspaceLeaseCoordinator,
  WorkspaceLeaseLostError,
  WorkspaceLeaseRunChainConflictError,
  withWorkspaceMutationLease,
} from "../src/workspace-lease-coordinator.js";

afterEach(() => vi.useRealTimers());

describe("WorkspaceLeaseCoordinator", () => {
  it("coalesces symlink aliases onto the real workspace root", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-agent-arbiter-"));
    const alias = `${root}-alias`;
    try {
      await symlink(root, alias, "dir");
      const arbiter = new WorkspaceLeaseCoordinator();
      const writer = await arbiter.acquire({
        workspaceRoot: root,
        ownerId: "writer",
        mode: "write",
      });
      const waiting = arbiter.acquire({
        workspaceRoot: alias,
        ownerId: "reader",
        mode: "read",
      });
      expect(arbiter.inspect(alias).queued).toEqual([
        { ownerId: "reader", mode: "read" },
      ]);
      writer.release();
      (await waiting).release();
    } finally {
      await rm(alias, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shares reads and wakes one queued writer after readers release", async () => {
    const arbiter = new WorkspaceLeaseCoordinator();
    const first = await arbiter.acquire({
      workspaceRoot: "/tmp/workspace",
      ownerId: "reader-1",
      mode: "read",
    });
    const second = await arbiter.acquire({
      workspaceRoot: "/tmp/workspace/.",
      ownerId: "reader-2",
      mode: "read",
    });
    let writerResolved = false;
    const writerPromise = arbiter
      .acquire({
        workspaceRoot: "/tmp/workspace",
        ownerId: "writer",
        mode: "write",
      })
      .then((lease) => {
        writerResolved = true;
        return lease;
      });

    await Promise.resolve();
    expect(writerResolved).toBe(false);
    expect(arbiter.inspect("/tmp/workspace").readers).toHaveLength(2);
    first.release();
    expect(writerResolved).toBe(false);
    second.release();
    const writer = await writerPromise;
    expect(writerResolved).toBe(true);
    expect(arbiter.inspect("/tmp/workspace").writer?.ownerId).toBe("writer");
    writer.release();
  });

  it("does not starve a queued writer with later readers", async () => {
    const arbiter = new WorkspaceLeaseCoordinator();
    const reader = await arbiter.acquire({
      workspaceRoot: "/tmp/workspace",
      ownerId: "reader-1",
      mode: "read",
    });
    const order: string[] = [];
    const writerPromise = arbiter
      .acquire({
        workspaceRoot: "/tmp/workspace",
        ownerId: "writer",
        mode: "write",
      })
      .then((lease) => {
        order.push("writer");
        return lease;
      });
    const laterReaderPromise = arbiter
      .acquire({
        workspaceRoot: "/tmp/workspace",
        ownerId: "reader-2",
        mode: "read",
      })
      .then((lease) => {
        order.push("reader-2");
        return lease;
      });

    reader.release();
    const writer = await writerPromise;
    expect(order).toEqual(["writer"]);
    writer.release();
    const laterReader = await laterReaderPromise;
    expect(order).toEqual(["writer", "reader-2"]);
    laterReader.release();
  });

  it("expires abandoned leases and allows waiter takeover", async () => {
    vi.useFakeTimers();
    const arbiter = new WorkspaceLeaseCoordinator();
    await arbiter.acquire({
      workspaceRoot: "/tmp/workspace",
      ownerId: "stuck-writer",
      mode: "write",
      ttlMs: 1_000,
      autoRenew: false,
    });
    const nextPromise = arbiter.acquire({
      workspaceRoot: "/tmp/workspace",
      ownerId: "next-writer",
      mode: "write",
      ttlMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(1_001);
    const next = await nextPromise;
    expect(arbiter.inspect("/tmp/workspace").writer?.ownerId).toBe(
      "next-writer",
    );
    next.release();
  });

  it("auto-renews a live lease and releases idempotently", async () => {
    vi.useFakeTimers();
    const arbiter = new WorkspaceLeaseCoordinator();
    const lease = await arbiter.acquire({
      workspaceRoot: "/tmp/workspace",
      ownerId: "writer",
      mode: "write",
      ttlMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_600);
    expect(arbiter.inspect("/tmp/workspace").writer?.ownerId).toBe("writer");
    expect(lease.release()).toBe(true);
    expect(lease.release()).toBe(false);
  });

  it("removes an aborted waiter without disturbing the holder", async () => {
    const arbiter = new WorkspaceLeaseCoordinator();
    const holder = await arbiter.acquire({
      workspaceRoot: "/tmp/workspace",
      ownerId: "holder",
      mode: "write",
    });
    const abort = new AbortController();
    const waiting = arbiter.acquire({
      workspaceRoot: "/tmp/workspace",
      ownerId: "waiting",
      mode: "write",
      signal: abort.signal,
    });
    abort.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(arbiter.inspect("/tmp/workspace").queued).toEqual([]);
    expect(arbiter.inspect("/tmp/workspace").writer?.ownerId).toBe("holder");
    holder.release();
  });

  it("reenters for one owner and releases only after the final reference", async () => {
    const arbiter = new WorkspaceLeaseCoordinator();
    const outer = await arbiter.acquire({
      workspaceRoot: "/tmp/workspace",
      ownerId: "run_child",
      mode: "write",
    });
    const inner = await arbiter.acquire({
      workspaceRoot: "/tmp/workspace",
      ownerId: "run_child",
      mode: "write",
    });
    expect(inner.id).toBe(outer.id);
    expect(arbiter.inspect("/tmp/workspace").writer?.references).toBe(2);
    outer.release();
    expect(arbiter.inspect("/tmp/workspace").writer?.ownerId).toBe("run_child");
    inner.release();
    expect(arbiter.inspect("/tmp/workspace").writer).toBeUndefined();
  });

  it("fails fast when a descendant would wait on an ancestor owner", async () => {
    const arbiter = new WorkspaceLeaseCoordinator();
    const ancestor = await arbiter.acquire({
      workspaceRoot: "/tmp/workspace",
      ownerId: "run_parent",
      mode: "write",
    });
    await expect(
      arbiter.acquire({
        workspaceRoot: "/tmp/workspace",
        ownerId: "run_child",
        ancestorOwnerIds: ["run_parent"],
        mode: "write",
      }),
    ).rejects.toBeInstanceOf(WorkspaceLeaseRunChainConflictError);
    ancestor.release();
  });

  it("notifies a revoked holder before granting the next writer", async () => {
    const arbiter = new WorkspaceLeaseCoordinator();
    const losses: string[] = [];
    const holder = await arbiter.acquire({
      workspaceRoot: "/tmp/workspace",
      ownerId: "holder",
      mode: "write",
      onLost: (loss) => losses.push(loss.reason),
    });
    const waiting = arbiter.acquire({
      workspaceRoot: "/tmp/workspace",
      ownerId: "waiting",
      mode: "write",
    });

    expect(arbiter.revoke("/tmp/workspace", "holder")).toBe(true);
    await expect(holder.lost).resolves.toMatchObject({ reason: "revoked" });
    expect(losses).toEqual(["revoked"]);
    const next = await waiting;
    expect(arbiter.inspect("/tmp/workspace").writer?.ownerId).toBe("waiting");
    next.release();
  });

  it("serializes mutating tools from different parent runs", async () => {
    const arbiter = new WorkspaceLeaseCoordinator();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const tool = withWorkspaceMutationLease(
      defineTool<{ owner: string }, string>({
        name: "mutate",
        description: "mutate",
        inputSchema: { type: "object" },
        governance: { sideEffects: ["write"] },
        async execute(args) {
          order.push(`start:${args.owner}`);
          if (args.owner === "first") await firstGate;
          order.push(`end:${args.owner}`);
          return args.owner;
        },
      }),
      { coordinator: arbiter, workspaceRoot: "/tmp/workspace" },
    );
    const firstRun = testRun("first");
    const secondRun = testRun("second");
    const first = tool.execute({ owner: "first" }, { run: firstRun.record });
    await vi.waitFor(() => expect(order).toEqual(["start:first"]));
    const second = tool.execute({ owner: "second" }, { run: secondRun.record });
    await Promise.resolve();
    expect(order).toEqual(["start:first"]);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([
      "first",
      "second",
    ]);
    expect(order).toEqual([
      "start:first",
      "end:first",
      "start:second",
      "end:second",
    ]);
  });

  it("aborts a mutating tool when its lease is revoked", async () => {
    const arbiter = new WorkspaceLeaseCoordinator();
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const tool = withWorkspaceMutationLease(
      defineTool({
        name: "mutate",
        description: "mutate",
        inputSchema: { type: "object" },
        governance: { sideEffects: ["write"] },
        execute(_args, ctx) {
          started();
          return new Promise((_resolve, reject) => {
            ctx.abortSignal?.addEventListener(
              "abort",
              () => reject(ctx.abortSignal?.reason),
              { once: true },
            );
          });
        },
      }),
      { coordinator: arbiter, workspaceRoot: "/tmp/workspace" },
    );
    const run = testRun("lease-loss");
    const execution = tool.execute({}, { run: run.record });
    await didStart;
    expect(arbiter.revoke("/tmp/workspace", String(run.record.id))).toBe(true);
    await expect(execution).rejects.toBeInstanceOf(WorkspaceLeaseLostError);
  });

  it("retains a background shell-style lease until its task is terminal", async () => {
    const arbiter = new WorkspaceLeaseCoordinator();
    const manager = new TaskManager();
    let finishTask!: () => void;
    const taskGate = new Promise<void>((resolve) => {
      finishTask = resolve;
    });
    const run = testRun("background");
    const tool = withWorkspaceMutationLease(
      defineTool({
        name: "shell",
        description: "shell",
        inputSchema: { type: "object" },
        governance: { sideEffects: ["write", "external"] },
        execute() {
          const handle = manager.spawn({
            parentRunId: run.record.id,
            kind: "test",
            runner: async () => {
              await taskGate;
              return { ok: true };
            },
          });
          return {
            background: true,
            taskId: String(handle.record.id),
          };
        },
      }),
      {
        coordinator: arbiter,
        workspaceRoot: "/tmp/workspace",
        backgroundTaskManager: manager,
      },
    );

    const output = await tool.execute({}, { run: run.record });
    expect(output).toMatchObject({ background: true });
    expect(arbiter.inspect("/tmp/workspace").writer?.ownerId).toBe(
      String(run.record.id),
    );
    finishTask();
    const taskId = (output as { taskId: string }).taskId;
    await manager.handle(taskId as TaskId)!.wait();
    await vi.waitFor(() =>
      expect(arbiter.inspect("/tmp/workspace").writer).toBeUndefined(),
    );
  });
});
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskId } from "@sparkwright/agent-runtime";

function testRun(goal: string) {
  return createRun({
    goal,
    model: {
      async complete() {
        return { message: goal };
      },
    },
    maxSteps: 1,
  });
}
