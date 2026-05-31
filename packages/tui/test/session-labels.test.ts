import { describe, expect, it, beforeEach } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSessionLabels } from "../src/lib/session-labels.js";

describe("session labels", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "spark-labels-"));
  });

  it("returns empty when file missing", async () => {
    const labels = await loadSessionLabels(root);
    expect(labels.get()).toEqual({});
    expect(labels.getOne("s1")).toBeUndefined();
  });

  it("sets, persists, and reloads", async () => {
    const labels = await loadSessionLabels(root);
    await labels.set("s1", "deploy fix");
    expect(labels.getOne("s1")).toBe("deploy fix");

    const reloaded = await loadSessionLabels(root);
    expect(reloaded.getOne("s1")).toBe("deploy fix");
    const onDisk = JSON.parse(
      await readFile(join(root, ".sparkwright/session-labels.json"), "utf8"),
    );
    expect(onDisk).toEqual({ s1: "deploy fix" });
  });

  it("clearing with empty string deletes the entry", async () => {
    const labels = await loadSessionLabels(root);
    await labels.set("s1", "x");
    await labels.set("s1", "");
    expect(labels.getOne("s1")).toBeUndefined();
    expect(labels.get()).toEqual({});
  });

  it("truncates labels longer than 80 chars", async () => {
    const labels = await loadSessionLabels(root);
    await labels.set("s1", "x".repeat(200));
    expect(labels.getOne("s1")?.length).toBe(80);
  });
});
