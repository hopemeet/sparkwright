import { describe, expect, it, vi } from "vitest";
import { CommandRegistry } from "../src/lib/commands.js";

describe("CommandRegistry", () => {
  it("resolves by name and alias", () => {
    const reg = new CommandRegistry();
    const run = vi.fn();
    reg.register({
      name: "quit",
      title: "Quit",
      description: "Exit.",
      category: "system",
      aliases: ["q", "exit"],
      run,
    });
    expect(reg.resolve("quit")?.name).toBe("quit");
    expect(reg.resolve("q")?.name).toBe("quit");
    expect(reg.resolve("EXIT")?.name).toBe("quit");
    expect(reg.resolve("nope")).toBeUndefined();
  });

  it("list() dedupes alias entries", () => {
    const reg = new CommandRegistry();
    reg.register({
      name: "help",
      title: "Help",
      description: "x",
      category: "view",
      aliases: ["h", "?"],
      run: () => {},
    });
    expect(reg.list().map((c) => c.name)).toEqual(["help"]);
  });

  it("search ranks name-prefix matches first", () => {
    const reg = new CommandRegistry();
    reg.register({
      name: "session",
      title: "Sessions",
      description: "list",
      category: "session",
      run: () => {},
    });
    reg.register({
      name: "new",
      title: "Start a new session",
      description: "fresh id",
      category: "session",
      run: () => {},
    });
    const results = reg.search("sess");
    expect(results[0].name).toBe("session");
  });
});
