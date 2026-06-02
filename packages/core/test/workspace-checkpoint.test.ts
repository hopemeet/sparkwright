import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WorkspaceCheckpointStore,
  type WorkspaceCheckpointRestoreTarget,
} from "../src/workspace-checkpoint.js";
import { LocalWorkspace } from "../src/workspace.js";

describe("WorkspaceCheckpointStore", () => {
  // A restore target backed by a plain in-memory map.
  function memoryTarget(initial: Record<string, string>) {
    const files = new Map(Object.entries(initial));
    const target: WorkspaceCheckpointRestoreTarget = {
      async writeText(path, content) {
        files.set(path, content);
      },
      async removeFile(path) {
        files.delete(path);
      },
    };
    return { files, target };
  }

  let ids = 0;
  const newStore = () =>
    new WorkspaceCheckpointStore({ createId: () => `cp-${(ids += 1)}` });

  beforeEach(() => {
    ids = 0;
  });

  it("captures only the first touch of a path per checkpoint", () => {
    const store = newStore();
    store.openCheckpoint("turn-1");
    store.recordBeforeWrite({
      path: "a.txt",
      existedBefore: true,
      content: "v1",
    });
    store.recordBeforeWrite({
      path: "a.txt",
      existedBefore: true,
      content: "v2",
    });
    expect(store.listCheckpoints()).toEqual([
      {
        id: "cp-1",
        label: "turn-1",
        createdAt: expect.any(String),
        fileCount: 1,
      },
    ]);
  });

  it("auto-opens a checkpoint when a write is recorded with none open", () => {
    const store = newStore();
    store.recordBeforeWrite({ path: "a.txt", existedBefore: false });
    expect(store.listCheckpoints()).toHaveLength(1);
  });

  it("rolls back a checkpoint, restoring modified files and removing created ones", async () => {
    const store = newStore();
    const { files, target } = memoryTarget({ "keep.txt": "original" });

    store.openCheckpoint("turn-1");
    // Modify an existing file and create a new one.
    store.recordBeforeWrite({
      path: "keep.txt",
      existedBefore: true,
      content: "original",
    });
    files.set("keep.txt", "edited");
    store.recordBeforeWrite({ path: "new.txt", existedBefore: false });
    files.set("new.txt", "created");

    const result = await store.rollback("cp-1", target);

    expect(files.get("keep.txt")).toBe("original");
    expect(files.has("new.txt")).toBe(false);
    expect(result.restored).toEqual(["keep.txt"]);
    expect(result.removed).toEqual(["new.txt"]);
    expect(store.listCheckpoints()).toHaveLength(0); // rolled-back checkpoint dropped
  });

  it("rolls back to the state at the target checkpoint across later checkpoints", async () => {
    const store = newStore();
    const { files, target } = memoryTarget({ "f.txt": "v0" });

    store.openCheckpoint("turn-1");
    store.recordBeforeWrite({
      path: "f.txt",
      existedBefore: true,
      content: "v0",
    });
    files.set("f.txt", "v1");

    store.openCheckpoint("turn-2");
    store.recordBeforeWrite({
      path: "f.txt",
      existedBefore: true,
      content: "v1",
    });
    files.set("f.txt", "v2");

    // Roll back to turn-1: the earliest pre-image (v0) must win.
    await store.rollback("cp-1", target);
    expect(files.get("f.txt")).toBe("v0");
  });

  it("throws on an unknown checkpoint id", async () => {
    const store = newStore();
    const { target } = memoryTarget({});
    await expect(store.rollback("nope", target)).rejects.toThrow(
      "Unknown workspace checkpoint",
    );
  });

  it("prunes the oldest checkpoints past the retention limit", () => {
    const store = new WorkspaceCheckpointStore({
      maxCheckpoints: 2,
      createId: () => `cp-${(ids += 1)}`,
    });
    store.openCheckpoint("a");
    store.openCheckpoint("b");
    store.openCheckpoint("c");
    expect(store.listCheckpoints().map((c) => c.label)).toEqual(["b", "c"]);
  });

  describe("end-to-end against LocalWorkspace", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "sw-checkpoint-"));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("restores edited content and removes created files on rollback", async () => {
      await writeFile(join(dir, "existing.txt"), "before", "utf8");
      const workspace = new LocalWorkspace(dir);
      const store = newStore();

      store.openCheckpoint("turn-1");
      // Simulate a turn's writes, capturing pre-images first.
      store.recordBeforeWrite({
        path: "existing.txt",
        existedBefore: true,
        content: await workspace.readText("existing.txt"),
      });
      await workspace.writeText("existing.txt", "after");
      store.recordBeforeWrite({ path: "fresh.txt", existedBefore: false });
      await workspace.writeText("fresh.txt", "new content");

      expect(await workspace.readText("existing.txt")).toBe("after");
      expect(existsSync(join(dir, "fresh.txt"))).toBe(true);

      await store.rollback("cp-1", workspace);

      expect(await workspace.readText("existing.txt")).toBe("before");
      expect(existsSync(join(dir, "fresh.txt"))).toBe(false);
    });

    it("removeFile is contained to the workspace root", async () => {
      const workspace = new LocalWorkspace(dir);
      await mkdir(join(dir, "sub"), { recursive: true });
      await expect(workspace.removeFile("../escape.txt")).rejects.toThrow(
        /escapes workspace root/,
      );
    });
  });
});
