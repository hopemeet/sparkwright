import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultCronRoot } from "@sparkwright/cron";
import { createCapability } from "../src/lib/create-capability.js";

describe("createCapability", () => {
  let tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
    tempDirs = [];
  });

  it("routes generic Skill creation through the managed proposal service", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-tui-create-"));
    tempDirs.push(workspace);

    const result = await createCapability(
      {
        kind: "skill",
        name: "code-reviewer",
        description: "Review code changes",
      },
      workspace,
    );

    expect(result).toMatchObject({
      kind: "skill",
      message: expect.stringContaining("Prepared Skill code-reviewer"),
      path: expect.stringContaining("skill-evolution/proposals/skillprop_"),
    });
    await expect(
      access(join(workspace, ".sparkwright", "skills", "code-reviewer")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(result.path!, "metadata.json"), "utf8"),
    ).resolves.toContain('"contentMode": "template"');
  });

  it("omits cwd when creating stdio MCP servers", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-tui-create-"));
    tempDirs.push(workspace);

    await createCapability(
      {
        kind: "mcp",
        name: "notes",
        serverType: "stdio",
        commandOrUrl: "node",
        args: ["server.mjs"],
      },
      workspace,
    );

    const config = JSON.parse(
      await readFile(join(workspace, ".sparkwright", "config.json"), "utf8"),
    );
    expect(config.capabilities.mcp.servers).toEqual([
      {
        type: "stdio",
        name: "notes",
        command: "node",
        args: ["server.mjs"],
        enabled: true,
      },
    ]);
  });

  it("creates cron jobs through the shared cron command service", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-tui-create-"));
    const state = await mkdtemp(join(tmpdir(), "sparkwright-tui-cron-state-"));
    tempDirs.push(workspace, state);
    const previousState = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = state;
    try {
      const result = await createCapability(
        {
          kind: "cron",
          name: "daily-readme",
          schedule: "every 1d",
          prompt: "Read README.md",
        },
        workspace,
      );

      const jobs = JSON.parse(
        await readFile(join(defaultCronRoot(), "jobs.json"), "utf8"),
      ) as { jobs: Array<{ name: string; scheduleDisplay: string }> };
      expect(result).toMatchObject({
        kind: "cron",
        message: "Created cron job daily-readme",
      });
      expect(jobs.jobs).toMatchObject([
        { name: "daily-readme", scheduleDisplay: "every 1d" },
      ]);
    } finally {
      if (previousState === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousState;
    }
  });

  it("mentions the adjusted name when creating a duplicate cron job", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-tui-create-"));
    const state = await mkdtemp(join(tmpdir(), "sparkwright-tui-cron-state-"));
    tempDirs.push(workspace, state);
    const previousState = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = state;
    try {
      const draft = {
        kind: "cron" as const,
        name: "daily-readme",
        schedule: "every 1d",
        prompt: "Read README.md",
      };

      const first = await createCapability(draft, workspace);
      const second = await createCapability(draft, workspace);
      const jobs = JSON.parse(
        await readFile(join(defaultCronRoot(), "jobs.json"), "utf8"),
      ) as { jobs: Array<{ name: string }> };

      expect(first.message).toBe("Created cron job daily-readme");
      expect(second.message).toBe(
        "Created cron job daily-readme 2 (daily-readme already existed)",
      );
      expect(jobs.jobs.map((job) => job.name)).toEqual([
        "daily-readme",
        "daily-readme 2",
      ]);
    } finally {
      if (previousState === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousState;
    }
  });
});
