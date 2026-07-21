import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttentionManager } from "../src/lib/attention.js";

describe("AttentionManager", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("notifies only while blurred and rate-limits the same signal", () => {
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream & {
      isTTY: boolean;
    };
    stdout.isTTY = true;
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    const manager = new AttentionManager({
      stdin,
      stdout,
      rateLimitMs: 5000,
    });

    manager.enable();
    expect(manager.notify("approval needed", "approval:one")).toBe(false);
    stdin.emit("data", "\x1b[O");
    expect(manager.notify("approval needed", "approval:one")).toBe(true);
    expect(manager.notify("approval needed", "approval:one")).toBe(false);
    expect(output.split("\x07")).toHaveLength(3);

    vi.advanceTimersByTime(5000);
    expect(manager.notify("approval needed", "approval:one")).toBe(true);
    expect(output.split("\x07")).toHaveLength(5);

    stdin.emit("data", "\x1b[I");
    expect(manager.notify("approval needed", "approval:one")).toBe(false);
    manager.disable();
    stdin.destroy();
    stdout.destroy();
  });
});
