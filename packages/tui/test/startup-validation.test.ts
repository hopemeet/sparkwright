import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTui } from "../src/index.js";

describe("runTui startup validation", () => {
  let tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
    tempDirs = [];
  });

  it("rejects an invalid permission mode", async () => {
    const stderr = captureStderr();
    try {
      const result = await runTui(["--permission-mode", "root"]);

      expect(result.exitCode).toBe(1);
      expect(stderr.text()).toContain("--permission-mode must be one of");
    } finally {
      stderr.restore();
    }
  });

  it("rejects a missing permission mode value", async () => {
    const stderr = captureStderr();
    try {
      const result = await runTui(["--permission-mode"]);

      expect(result.exitCode).toBe(1);
      expect(stderr.text()).toContain("--permission-mode requires a value");
    } finally {
      stderr.restore();
    }
  });

  it("rejects unknown options", async () => {
    const stderr = captureStderr();
    try {
      const result = await runTui(["--definitely-not-real"]);

      expect(result.exitCode).toBe(1);
      expect(stderr.text()).toContain("Unknown option: --definitely-not-real");
    } finally {
      stderr.restore();
    }
  });

  it("prints help without rendering the app", async () => {
    const stdout = captureStdout();
    try {
      const result = await runTui(["--help"]);

      expect(result.exitCode).toBe(0);
      expect(stdout.text()).toContain("Usage: sparkwright tui");
    } finally {
      stdout.restore();
    }
  });

  it("rejects an explicit missing workspace", async () => {
    const base = await mkdtemp(join(tmpdir(), "sparkwright-tui-"));
    tempDirs.push(base);
    const missingWorkspace = join(base, "missing");
    const stderr = captureStderr();
    try {
      const result = await runTui(["--workspace", missingWorkspace]);

      expect(result.exitCode).toBe(1);
      expect(stderr.text()).toContain("Workspace does not exist");
    } finally {
      stderr.restore();
    }
  });
});

function captureStderr() {
  const original = process.stderr.write;
  let text = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    text += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  return {
    text: () => text,
    restore: () => {
      process.stderr.write = original;
    },
  };
}

function captureStdout() {
  const original = process.stdout.write;
  let text = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    text += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  return {
    text: () => text,
    restore: () => {
      process.stdout.write = original;
    },
  };
}
