import { describe, expect, it, vi } from "vitest";
import { parseCommandFile } from "@sparkwright/project-commands";
import { toTuiProjectCommands } from "../src/lib/project-commands.js";

describe("tui project-command adapter", () => {
  it("maps descriptors to commands with run + runRaw", () => {
    const desc = parseCommandFile(
      "greet",
      "/x/greet.md",
      "project",
      "---\ndescription: say hi\n---\nHello $ARGUMENTS",
    );
    const onRun = vi.fn();
    const [cmd] = toTuiProjectCommands([desc], onRun);
    expect(cmd?.name).toBe("greet");
    expect(cmd?.title).toBe("say hi");
    cmd?.run();
    cmd?.runRaw?.("world");
    expect(onRun).toHaveBeenNthCalledWith(1, desc, "");
    expect(onRun).toHaveBeenNthCalledWith(2, desc, "world");
  });
});
