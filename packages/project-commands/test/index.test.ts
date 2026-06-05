import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildStartRunIntent,
  createSafetyGatedShellRunner,
  discoverProjectCommands,
  hasShellInterpolation,
  interpolateCommandTemplate,
  parseCommandFile,
  parseCommandTemplate,
  splitFrontmatter,
} from "../src/index.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sparkwright-project-commands-"));
}

async function writeCommand(
  dir: string,
  name: string,
  contents: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.md`), contents, "utf8");
}

describe("frontmatter", () => {
  it("parses description, model, and boolean subtask", () => {
    const { frontmatter, body } = splitFrontmatter(
      [
        "---",
        "description: do a thing",
        "model: openai/m",
        "subtask: true",
        "---",
        "the body",
      ].join("\n"),
    );
    expect(frontmatter).toEqual({
      description: "do a thing",
      model: "openai/m",
      subtask: true,
    });
    expect(body).toBe("the body");
  });

  it("treats a file with no frontmatter as all body", () => {
    const { frontmatter, body } = splitFrontmatter("just a prompt");
    expect(frontmatter).toEqual({});
    expect(body).toBe("just a prompt");
  });

  it("strips quotes and tolerates a BOM", () => {
    const { frontmatter } = splitFrontmatter(
      ["﻿---", 'description: "quoted"', "---", "b"].join("\n"),
    );
    expect(frontmatter.description).toBe("quoted");
  });
});

describe("template parsing", () => {
  it("splits literals, $ARGUMENTS, positional args, and shell", () => {
    const segments = parseCommandTemplate(
      "hi $ARGUMENTS then $2 and !`git diff` end",
    );
    expect(segments).toEqual([
      { kind: "literal", text: "hi " },
      { kind: "arguments" },
      { kind: "literal", text: " then " },
      { kind: "arg", index: 2 },
      { kind: "literal", text: " and " },
      { kind: "shell", command: "git diff" },
      { kind: "literal", text: " end" },
    ]);
  });

  it("detects shell interpolation", () => {
    expect(hasShellInterpolation(parseCommandTemplate("no shell here"))).toBe(
      false,
    );
    expect(hasShellInterpolation(parseCommandTemplate("x !`ls`"))).toBe(true);
  });
});

describe("interpolation", () => {
  it("substitutes $ARGUMENTS with rest and $1 with positional", async () => {
    const segments = parseCommandTemplate(
      "all=[$ARGUMENTS] first=[$1] miss=[$3]",
    );
    const out = await interpolateCommandTemplate(segments, {
      args: ["a", "b"],
      rest: "a b",
    });
    expect(out).toBe("all=[a b] first=[a] miss=[]");
  });

  it("throws when a shell segment exists but no runner is provided", async () => {
    const segments = parseCommandTemplate("x !`git status`");
    await expect(
      interpolateCommandTemplate(segments, { args: [], rest: "" }),
    ).rejects.toThrow(/no shell runner/);
  });

  it("calls the runner for shell segments", async () => {
    const segments = parseCommandTemplate("diff:\n!`git diff`");
    const out = await interpolateCommandTemplate(segments, {
      args: [],
      rest: "",
      runShell: async (cmd) => `<<${cmd}>>`,
    });
    expect(out).toBe("diff:\n<<git diff>>");
  });
});

describe("safety-gated shell runner", () => {
  it("denies destructive commands without executing", async () => {
    const execute = vi.fn();
    const runner = createSafetyGatedShellRunner({ execute });
    await expect(runner("rm -rf /")).rejects.toThrow(/denied/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("executes allow-listed commands and trims stdout", async () => {
    const runner = createSafetyGatedShellRunner({
      execute: async () => ({ stdout: "output\n", exitCode: 0 }),
    });
    expect(await runner("git diff")).toBe("output");
  });

  it("requires approval for unknown commands; throws without an approver", async () => {
    const execute = vi.fn();
    const runner = createSafetyGatedShellRunner({ execute });
    await expect(runner("frobnicate --all")).rejects.toThrow(
      /requires approval/,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("runs an approved require-approval command", async () => {
    const runner = createSafetyGatedShellRunner({
      execute: async () => ({ stdout: "ok", exitCode: 0 }),
      approve: async () => true,
    });
    expect(await runner("frobnicate")).toBe("ok");
  });

  it("throws on a non-zero exit", async () => {
    const runner = createSafetyGatedShellRunner({
      execute: async () => ({ stdout: "", exitCode: 2 }),
    });
    await expect(runner("git diff")).rejects.toThrow(/exited with code 2/);
  });
});

describe("discovery + precedence", () => {
  it("project files shadow user files of the same name", async () => {
    const root = await tempDir();
    const userDir = join(root, "userconf", "command");
    const projectDir = join(root, ".sparkwright", "command");
    await writeCommand(userDir, "commit", "user version");
    await writeCommand(
      projectDir,
      "commit",
      "---\ndescription: proj\n---\nproject version",
    );
    await writeCommand(userDir, "onlyuser", "from user");

    const shadowed: string[] = [];
    const cmds = await discoverProjectCommands({
      cwd: root,
      userCommandDir: userDir,
      onShadowed: (i) => shadowed.push(`${i.name}:${i.shadowedBy}`),
    });

    const commit = cmds.find((c) => c.name === "commit");
    expect(commit?.source).toBe("project");
    expect(commit?.description).toBe("proj");
    expect(cmds.map((c) => c.name)).toEqual(["commit", "onlyuser"]);
    expect(shadowed).toContain("commit:project");
  });

  it("config-reserved names shadow files entirely", async () => {
    const root = await tempDir();
    const projectDir = join(root, ".sparkwright", "command");
    await writeCommand(projectDir, "commit", "body");

    const shadowed: string[] = [];
    const cmds = await discoverProjectCommands({
      cwd: root,
      reservedNames: ["commit"],
      onShadowed: (i) => shadowed.push(`${i.name}:${i.shadowedBy}`),
    });

    expect(cmds).toHaveLength(0);
    expect(shadowed).toEqual(["commit:config"]);
  });

  it("returns empty when no command dirs exist", async () => {
    const root = await tempDir();
    expect(await discoverProjectCommands({ cwd: root })).toEqual([]);
  });
});

describe("start_run intent", () => {
  it("carries the interpolated prompt, model, and subtask", async () => {
    const desc = parseCommandFile(
      "commit",
      "/x/commit.md",
      "project",
      "---\nmodel: openai/m\nsubtask: true\n---\nCommit: $ARGUMENTS",
    );
    const intent = await buildStartRunIntent(desc, {
      args: ["msg"],
      rest: "msg",
    });
    expect(intent).toEqual({
      kind: "start_run",
      prompt: "Commit: msg",
      model: "openai/m",
      subtask: true,
    });
  });
});
