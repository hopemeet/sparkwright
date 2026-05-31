import { describe, expect, it } from "vitest";
import { CommandRegistry } from "../src/commands.js";

describe("CommandRegistry", () => {
  it("registers, lists, resolves, and dispatches commands", async () => {
    const registry = new CommandRegistry();
    registry.register({
      name: "compact",
      describe: "Compact the current run's context",
      aliases: ["c"],
      run: (ctx) => ({
        status: "ok",
        message: `compacted with args=${ctx.args.join(",")}`,
      }),
    });

    expect(registry.list().map((d) => d.name)).toEqual(["compact"]);

    const resolved = registry.resolve("/compact aggressive deep");
    expect(resolved?.definition.name).toBe("compact");
    expect(resolved?.context.args).toEqual(["aggressive", "deep"]);
    expect(resolved?.context.rest).toBe("aggressive deep");

    const aliased = registry.resolve("/c quick");
    expect(aliased?.definition.name).toBe("compact");

    const result = await registry.dispatch("/compact lite");
    expect(result.status).toBe("ok");
    expect(result.message).toContain("lite");
  });

  it("returns an error result for unknown commands", async () => {
    const registry = new CommandRegistry();
    const result = await registry.dispatch("/nope");
    expect(result.status).toBe("error");
  });

  it("rejects non-prefixed input when a prefix is set", () => {
    const registry = new CommandRegistry({ prefix: "/" });
    registry.register({
      name: "help",
      describe: "show help",
      run: () => ({ status: "ok" }),
    });
    expect(registry.resolve("help me")).toBeUndefined();
    expect(registry.resolve("/help")).toBeDefined();
  });

  it("rejects duplicate names and conflicting aliases", () => {
    const registry = new CommandRegistry();
    registry.register({
      name: "compact",
      describe: "",
      run: () => ({ status: "ok" }),
    });
    expect(() =>
      registry.register({
        name: "compact",
        describe: "",
        run: () => ({ status: "ok" }),
      }),
    ).toThrow();
    expect(() =>
      registry.register({
        name: "other",
        describe: "",
        aliases: ["compact"],
        run: () => ({ status: "ok" }),
      }),
    ).toThrow();
  });

  it("captures thrown errors from a command into a structured error result", async () => {
    const registry = new CommandRegistry();
    registry.register({
      name: "fail",
      describe: "",
      run: () => {
        throw new Error("nope");
      },
    });
    const result = await registry.dispatch("/fail");
    expect(result.status).toBe("error");
    expect(result.message).toBe("nope");
  });
});
