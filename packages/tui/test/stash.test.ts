import { describe, expect, it, beforeEach } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadStash,
  saveDraft,
  clearDraftOnSubmit,
  MIN_DRAFT_CHARS,
  type StashFile,
} from "../src/lib/stash.js";

describe("prompt stash", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "spark-stash-"));
  });

  it("starts empty", async () => {
    const s = await loadStash(root);
    expect(s).toEqual({ current: null, list: [] });
  });

  it("saves a draft above the threshold as current", async () => {
    const text = "x".repeat(MIN_DRAFT_CHARS);
    const next = await saveDraft(root, text, { current: null, list: [] });
    expect(next.current?.text).toBe(text);
    const reloaded = await loadStash(root);
    expect(reloaded.current?.text).toBe(text);
  });

  it("does not stash short drafts", async () => {
    const next = await saveDraft(root, "hi", { current: null, list: [] });
    expect(next.current).toBeNull();
  });

  it("archives the previous current when draft shrinks below threshold", async () => {
    const long = "y".repeat(MIN_DRAFT_CHARS + 5);
    const withCurrent: StashFile = {
      current: { text: long, ts: Date.now() },
      list: [],
    };
    const next = await saveDraft(root, "", withCurrent);
    expect(next.current).toBeNull();
    expect(next.list.at(-1)?.text).toBe(long);
  });

  it("clearDraftOnSubmit drops current but keeps list", async () => {
    const state: StashFile = {
      current: { text: "z".repeat(30), ts: 1 },
      list: [{ text: "old", ts: 0 }],
    };
    const next = await clearDraftOnSubmit(root, state);
    expect(next.current).toBeNull();
    expect(next.list).toEqual([{ text: "old", ts: 0 }]);
    const onDisk = JSON.parse(
      await readFile(join(root, ".sparkwright/tui-stash.json"), "utf8"),
    );
    expect(onDisk.current).toBeNull();
  });
});
