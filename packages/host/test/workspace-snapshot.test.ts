import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  diffWorkspaceSnapshots,
  rollbackWorkspaceSnapshot,
  snapshotWorkspace,
} from "../src/workspace-snapshot.js";

describe("workspace snapshot symlink safety", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("detects and removes a created symlink without following its target", async () => {
    const workspace = await temporaryRoot("snapshot-workspace-");
    const outside = await temporaryRoot("snapshot-outside-");
    const target = join(outside, "keep.txt");
    await writeFile(target, "keep\n");
    const before = await snapshotWorkspace(workspace);
    await symlink(target, join(workspace, "link.txt"));
    const after = await snapshotWorkspace(workspace);

    expect(diffWorkspaceSnapshots(before, after)).toEqual([
      { path: "link.txt", kind: "created" },
    ]);
    await expect(
      rollbackWorkspaceSnapshot(workspace, before, after),
    ).resolves.toMatchObject({ removed: ["link.txt"], failed: [] });
    await expect(readFile(target, "utf8")).resolves.toBe("keep\n");
    await expect(readFile(join(workspace, "link.txt"))).rejects.toThrow();
  });

  it("removes a replaced parent symlink before restoring captured files", async () => {
    const workspace = await temporaryRoot("snapshot-workspace-");
    const outside = await temporaryRoot("snapshot-outside-");
    await mkdir(join(workspace, "docs"));
    await writeFile(join(workspace, "docs", "note.txt"), "before\n");
    const before = await snapshotWorkspace(workspace);

    await rm(join(workspace, "docs"), { recursive: true });
    await symlink(outside, join(workspace, "docs"));
    const after = await snapshotWorkspace(workspace);
    const rollback = await rollbackWorkspaceSnapshot(workspace, before, after);

    expect(rollback).toMatchObject({
      removed: ["docs"],
      restored: ["docs/note.txt"],
      failed: [],
      incomplete: [],
    });
    await expect(
      readFile(join(workspace, "docs", "note.txt"), "utf8"),
    ).resolves.toBe("before\n");
    await expect(readFile(join(outside, "note.txt"))).rejects.toThrow();
  });

  it("restores captured binary content without UTF-8 conversion", async () => {
    const workspace = await temporaryRoot("snapshot-workspace-");
    const original = Buffer.from([0x00, 0xff, 0x80, 0x41]);
    const path = join(workspace, "asset.bin");
    await writeFile(path, original);
    const before = await snapshotWorkspace(workspace);
    await writeFile(path, Buffer.from([0x42]));
    const after = await snapshotWorkspace(workspace);

    await expect(
      rollbackWorkspaceSnapshot(workspace, before, after),
    ).resolves.toMatchObject({ restored: ["asset.bin"], failed: [] });
    await expect(readFile(path)).resolves.toEqual(original);
  });

  async function temporaryRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    roots.push(root);
    return root;
  }
});
