import { describe, expect, it, vi } from "vitest";
import { parseCommandFile } from "@sparkwright/project-commands";
import {
  resolveProjectCommandIntent,
  toTuiProjectCommands,
} from "../src/lib/project-commands.js";

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

  it("fills $ARGUMENTS and runs an allow-listed shell interpolation", async () => {
    const desc = parseCommandFile(
      "demo",
      "/x/demo.md",
      "project",
      "args=[$ARGUMENTS] shell=[!`echo hi`]",
    );
    const intent = await resolveProjectCommandIntent(
      desc,
      "a b",
      process.cwd(),
    );
    expect(intent.kind).toBe("start_run");
    expect(intent.prompt).toBe("args=[a b] shell=[hi]");
  });

  it("fails the command when shell interpolation is denied", async () => {
    const desc = parseCommandFile(
      "danger",
      "/x/danger.md",
      "project",
      "!`rm -rf /`",
    );
    await expect(
      resolveProjectCommandIntent(desc, "", process.cwd()),
    ).rejects.toThrow(/denied/);
  });
});
