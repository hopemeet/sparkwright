import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireFileDocumentLease,
  appendJsonDocumentLog,
  atomicWriteText,
  atomicWriteTextSync,
  publishExclusiveJsonDocument,
  readJsonDocumentDir,
  readJsonDocumentLog,
  writeJsonDocument,
} from "../src/index.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sparkwright-doc-store-"));
}

describe("doc-store primitives", () => {
  it("durably publishes an immutable JSON document exactly once", async () => {
    const root = await tempDir();
    const path = join(root, "journal", "000001.json");

    const results = await Promise.all([
      publishExclusiveJsonDocument(path, { writer: "a" }),
      publishExclusiveJsonDocument(path, { writer: "b" }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(["a", "b"]).toContain(
      JSON.parse(await readFile(path, "utf8")).writer,
    );
    expect(await readdir(join(root, "journal"))).toEqual(["000001.json"]);
  });

  it("atomically writes text documents and cleans up temporary siblings", async () => {
    const root = await tempDir();
    const path = join(root, "records", "one.json");

    await atomicWriteText(path, "one\n");
    atomicWriteTextSync(path, "two\n");

    expect(await readFile(path, "utf8")).toBe("two\n");
    expect((await readdir(join(root, "records"))).sort()).toEqual(["one.json"]);
  });

  it("scans JSON document directories while reporting corrupt entries", async () => {
    const root = await tempDir();
    const dir = join(root, "entries");
    await mkdir(dir, { recursive: true });
    await writeJsonDocument(join(dir, "good.json"), { value: 1 });
    await writeFile(join(dir, "bad-json.json"), "{", "utf8");
    await writeJsonDocument(join(dir, "bad-shape.json"), { value: "nope" });
    await writeJsonDocument(join(dir, ".tmp-leftover.json"), { value: 2 });
    await writeFile(join(dir, "ignore.txt"), "{}", "utf8");

    const result = await readJsonDocumentDir<{ value: number }>({
      dir,
      parse: (raw) => {
        if (
          typeof raw !== "object" ||
          raw === null ||
          typeof (raw as { value?: unknown }).value !== "number"
        ) {
          throw new Error("value must be a number");
        }
        return raw as { value: number };
      },
    });

    expect(result.entries).toMatchObject([
      {
        id: "good",
        value: { value: 1 },
      },
    ]);
    expect(result.invalidEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringContaining("bad-json.json"),
          code: "invalid_json",
        }),
        expect.objectContaining({
          path: expect.stringContaining("bad-shape.json"),
          code: "invalid_document",
          reason: "value must be a number",
        }),
      ]),
    );
  });

  it("appends and scans JSON document logs while skipping corrupt rows", async () => {
    const root = await tempDir();
    const path = join(root, "events.jsonl");
    await appendJsonDocumentLog(path, { event: "created", count: 1 });
    await appendJsonDocumentLog(path, { event: "updated", count: 2 });
    await writeFile(path, '{"event":\n', { flag: "a" });

    const result = await readJsonDocumentLog<{ event: string; count: number }>({
      path,
      parse: (raw) => {
        if (
          typeof raw !== "object" ||
          raw === null ||
          typeof (raw as { event?: unknown }).event !== "string" ||
          typeof (raw as { count?: unknown }).count !== "number"
        ) {
          throw new Error("event and count are required");
        }
        return raw as { event: string; count: number };
      },
    });

    expect(result.entries).toMatchObject([
      { sequence: 0, line: 1, value: { event: "created", count: 1 } },
      { sequence: 1, line: 2, value: { event: "updated", count: 2 } },
    ]);
    expect(result.invalidEntries).toEqual([
      expect.objectContaining({ line: 3, code: "invalid_json" }),
    ]);
  });

  it("enforces a single-writer lease and releases by token", async () => {
    const root = await tempDir();
    const path = join(root, "workflow-runs", "run.lock");
    const first = await acquireFileDocumentLease({
      path,
      owner: "worker-a",
      ttlMs: 60_000,
      now: () => new Date("2026-07-04T00:00:00.000Z"),
    });
    expect(first).not.toBeNull();

    const second = await acquireFileDocumentLease({
      path,
      owner: "worker-b",
      ttlMs: 60_000,
      now: () => new Date("2026-07-04T00:00:01.000Z"),
    });
    expect(second).toBeNull();

    expect(await first?.release()).toBe(true);
    const afterRelease = await acquireFileDocumentLease({
      path,
      owner: "worker-b",
      ttlMs: 60_000,
      now: () => new Date("2026-07-04T00:00:02.000Z"),
    });
    expect(afterRelease?.owner).toBe("worker-b");
    expect(await first?.release()).toBe(false);
    await afterRelease?.release();
  });

  it("allows expired leases to be adopted by a new writer", async () => {
    const root = await tempDir();
    const path = join(root, "workflow-runs", "run.lock");
    const first = await acquireFileDocumentLease({
      path,
      owner: "worker-a",
      ttlMs: 1_000,
      now: () => new Date("2026-07-04T00:00:00.000Z"),
    });
    expect(first).not.toBeNull();

    const adopted = await acquireFileDocumentLease({
      path,
      owner: "worker-b",
      ttlMs: 1_000,
      now: () => new Date("2026-07-04T00:00:02.000Z"),
    });

    expect(adopted?.owner).toBe("worker-b");
    expect(await first?.refresh()).toBe(false);
    expect(await adopted?.release()).toBe(true);
  });

  it("refreshes leases using the original ttl", async () => {
    const root = await tempDir();
    const path = join(root, "workflow-runs", "run.lock");
    let now = new Date("2026-07-04T00:00:00.000Z");
    const lease = await acquireFileDocumentLease({
      path,
      owner: "worker-a",
      ttlMs: 1_000,
      now: () => now,
    });
    expect(lease).not.toBeNull();

    now = new Date("2026-07-04T00:00:00.500Z");
    expect(await lease?.refresh()).toBe(true);
    expect(lease?.record().expiresAt).toBe("2026-07-04T00:00:01.500Z");

    now = new Date("2026-07-04T00:00:01.250Z");
    const contender = await acquireFileDocumentLease({
      path,
      owner: "worker-b",
      ttlMs: 1_000,
      now: () => now,
    });
    expect(contender).toBeNull();
    expect(await lease?.release()).toBe(true);
  });

  it("allows only one concurrent lease claimant to win", async () => {
    const root = await tempDir();
    const path = join(root, "workflow-runs", "run.lock");
    const now = () => new Date("2026-07-04T00:00:00.000Z");
    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        acquireFileDocumentLease({
          path,
          owner: `worker-${index}`,
          ttlMs: 60_000,
          now,
        }),
      ),
    );
    const winners = attempts.filter((lease) => lease !== null);
    expect(winners).toHaveLength(1);
    expect(await winners[0]?.release()).toBe(true);
  });
});
