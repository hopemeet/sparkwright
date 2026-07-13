import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceAgentArbiter } from "../src/workspace-agent-arbiter.js";

afterEach(() => vi.useRealTimers());

describe("WorkspaceAgentArbiter", () => {
  it("coalesces symlink aliases onto the real workspace root", async () => {
    const root = await mkdtemp(join(tmpdir(), "sparkwright-agent-arbiter-"));
    const alias = `${root}-alias`;
    try {
      await symlink(root, alias, "dir");
      const arbiter = new WorkspaceAgentArbiter();
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
    const arbiter = new WorkspaceAgentArbiter();
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
    const arbiter = new WorkspaceAgentArbiter();
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
    const arbiter = new WorkspaceAgentArbiter();
    await arbiter.acquire({
      workspaceRoot: "/tmp/workspace",
      ownerId: "stuck-writer",
      mode: "write",
      ttlMs: 1_000,
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

  it("renews a live lease and releases idempotently", async () => {
    vi.useFakeTimers();
    const arbiter = new WorkspaceAgentArbiter();
    const lease = await arbiter.acquire({
      workspaceRoot: "/tmp/workspace",
      ownerId: "writer",
      mode: "write",
      ttlMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(800);
    expect(lease.renew(1_000)).toBe(true);
    await vi.advanceTimersByTimeAsync(800);
    expect(arbiter.inspect("/tmp/workspace").writer?.ownerId).toBe("writer");
    expect(lease.release()).toBe(true);
    expect(lease.release()).toBe(false);
    expect(lease.renew()).toBe(false);
  });

  it("removes an aborted waiter without disturbing the holder", async () => {
    const arbiter = new WorkspaceAgentArbiter();
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
});
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
