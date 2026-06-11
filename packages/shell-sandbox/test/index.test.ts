import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBubblewrapInvocation,
  buildMacOSSandboxProfile,
  createPlatformShellSandboxRuntime,
  describeShellSandboxStatus,
  LinuxBubblewrapShellSandboxRuntime,
  MacOSShellSandboxRuntime,
  prepareSandboxedProcessInvocation,
  resolveShellSandboxConfig,
  shellJoin,
  shellQuoteArg,
} from "../src/index.js";

describe("resolveShellSandboxConfig", () => {
  it("adds forced deny-write paths that user config cannot remove", () => {
    const resolved = resolveShellSandboxConfig({
      workspaceRoot: "/repo",
      config: {
        mode: "enforce",
        filesystem: {
          allowWrite: ["src"],
          denyWrite: ["build"],
        },
      },
      userConfigPath: "/home/me/.config/sparkwright/config.json",
      projectConfigPath: "/repo/.sparkwright/config.json",
      skillRoots: ["/repo/.sparkwright/skills"],
    });

    expect(resolved.mode).toBe("enforce");
    expect(resolved.failIfUnavailable).toBe(true);
    expect(resolved.filesystem.allowWrite).toContain("/repo");
    expect(resolved.filesystem.allowWrite).toContain("/repo/src");
    expect(resolved.filesystem.denyWrite).toEqual(
      expect.arrayContaining([
        "/repo/build",
        "/repo/.sparkwright/config.json",
        "/home/me/.config/sparkwright/config.json",
        "/repo/.sparkwright/skills",
      ]),
    );
  });

  it("defaults to warn mode and network deny", () => {
    const resolved = resolveShellSandboxConfig({ workspaceRoot: "/repo" });

    expect(resolved.mode).toBe("warn");
    expect(resolved.failIfUnavailable).toBe(false);
    expect(resolved.network.mode).toBe("deny");
    expect(resolved.filesystem.denyRead).toEqual(
      expect.arrayContaining(["/repo/.env", "/repo/.ssh", "/repo/.aws"]),
    );
  });

  it("describes path-free runtime status", async () => {
    const config = resolveShellSandboxConfig({ workspaceRoot: "/repo" });
    const status = await describeShellSandboxStatus(config, {
      id: "test-runtime",
      platform: "linux",
      isAvailable: async () => true,
      execute: async () => {
        throw new Error("unused");
      },
    });

    expect(status).toEqual({
      mode: "warn",
      failIfUnavailable: false,
      runtimeId: "test-runtime",
      platform: "linux",
      available: true,
      networkMode: "deny",
      filesystemIsolation: "bind-allowlist",
    });
  });
});

describe("platform invocation builders", () => {
  it("builds bubblewrap argv with network and filesystem controls", () => {
    const config = resolveShellSandboxConfig({
      workspaceRoot: "/repo",
      config: {
        filesystem: { allowRead: ["docs"], allowWrite: ["src"] },
        network: { mode: "deny" },
      },
    });

    const invocation = buildBubblewrapInvocation({
      request: { command: "npm test", cwd: "/repo", env: {} },
      config,
      tmpRoot: "/tmp/sw",
    });

    expect(invocation.command).toBe("bwrap");
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        "--unshare-net",
        "--ro-bind-try",
        "/repo/docs",
        "/repo/docs",
        "--bind-try",
        "/repo/src",
        "/repo/src",
        "bash",
        "-c",
        "npm test",
      ]),
    );
  });

  it("builds macOS sandbox profiles with explicit deny-list controls", () => {
    const config = resolveShellSandboxConfig({
      workspaceRoot: "/repo",
      config: {
        filesystem: {
          allowWrite: ["."],
          denyRead: [".env"],
          denyWrite: [".sparkwright/config.json"],
        },
        network: { mode: "deny" },
      },
    });

    const profile = buildMacOSSandboxProfile(config, "/tmp/sw");

    expect(profile).toContain("(allow default)");
    expect(profile).toContain('(deny file-read* (subpath "/repo/.env"))');
    expect(profile).toContain(
      '(deny file-write* (subpath "/repo/.sparkwright/config.json"))',
    );
    expect(profile).toContain("(deny network*)");
  });

  it("quotes process argv only at the shell wrapper boundary", () => {
    expect(shellQuoteArg("plain-value_1")).toBe("plain-value_1");
    expect(shellQuoteArg("two words")).toBe("'two words'");
    expect(shellQuoteArg("it's")).toBe("'it'\\''s'");
    expect(shellJoin(["node", "-e", "console.log('ok')"])).toBe(
      "node -e 'console.log('\\''ok'\\'')'",
    );
  });

  it("prepares sandboxed process invocations for long-lived transports", async () => {
    const config = resolveShellSandboxConfig({ workspaceRoot: tmpdir() });
    const cwd = tmpdir();

    const linux = await prepareSandboxedProcessInvocation(
      new LinuxBubblewrapShellSandboxRuntime("test-bwrap"),
      {
        command: "node",
        args: ["server.js", "--name", "two words"],
        cwd,
      },
      config,
    );
    expect(linux.command).toBe("test-bwrap");
    expect(linux.args.slice(-3)).toEqual([
      "bash",
      "-c",
      "node server.js --name 'two words'",
    ]);
    await linux.cleanup?.();

    const mac = await prepareSandboxedProcessInvocation(
      new MacOSShellSandboxRuntime("test-sandbox-exec"),
      {
        command: "node",
        args: ["server.js", "--name", "two words"],
        cwd,
      },
      config,
    );
    expect(mac.command).toBe("test-sandbox-exec");
    expect(mac.args.slice(-3)).toEqual([
      "/bin/bash",
      "-c",
      "node server.js --name 'two words'",
    ]);
    await mac.cleanup?.();
  });
});

describe("platform sandbox integration", () => {
  it("runs inside the platform sandbox when the runtime is installed", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return;
    const runtime = createPlatformShellSandboxRuntime();
    if (!(await runtime.isAvailable())) return;

    const workspace = await mkdtemp(join(tmpdir(), "sparkwright-sandbox-it-"));
    await mkdir(join(workspace, ".sparkwright"), { recursive: true });
    await mkdir(join(workspace, ".sparkwright", "skills", "guarded"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, ".sparkwright", "config.json"),
      "original\n",
      "utf8",
    );
    await writeFile(
      join(workspace, ".sparkwright", "skills", "guarded", "SKILL.md"),
      "original skill\n",
      "utf8",
    );
    const config = resolveShellSandboxConfig({
      workspaceRoot: workspace,
      config: { mode: "enforce", network: { mode: "deny" } },
      projectConfigPath: join(workspace, ".sparkwright", "config.json"),
      skillRoots: [join(workspace, ".sparkwright", "skills")],
    });

    const allowed = await runtime.execute(
      {
        command: "echo ok > allowed.txt && cat allowed.txt",
        cwd: workspace,
        env: process.env,
      },
      config,
    );
    await expect(allowed.completed).resolves.toMatchObject({
      status: "completed",
      exitCode: 0,
      stdout: "ok\n",
    });

    const denied = await runtime.execute(
      {
        command: "echo blocked > .sparkwright/config.json",
        cwd: workspace,
        env: process.env,
      },
      config,
    );
    await expect(denied.completed).resolves.toMatchObject({
      status: "failed",
    });
    await expect(
      readFile(join(workspace, ".sparkwright", "config.json"), "utf8"),
    ).resolves.toBe("original\n");

    const deniedSkill = await runtime.execute(
      {
        command: "echo blocked > .sparkwright/skills/guarded/SKILL.md",
        cwd: workspace,
        env: process.env,
      },
      config,
    );
    await expect(deniedSkill.completed).resolves.toMatchObject({
      status: "failed",
    });
    await expect(
      readFile(
        join(workspace, ".sparkwright", "skills", "guarded", "SKILL.md"),
        "utf8",
      ),
    ).resolves.toBe("original skill\n");
  });
});
