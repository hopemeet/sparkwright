import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildBubblewrapInvocation,
  buildMacOSSandboxProfile,
  createPlatformShellSandboxRuntime,
  describeShellSandboxStatus,
  enforceNoWriteShellSandbox,
  enforceProtectedWriteRootsShellSandbox,
  extendShellSandboxReadAccess,
  LinuxBubblewrapShellSandboxRuntime,
  MacOSShellSandboxRuntime,
  prepareSandboxedProcessInvocation,
  prepareSandboxedProcessLaunch,
  resolveShellSandboxConfig,
  scopeShellSandboxFilesystem,
  shellJoin,
  shellQuoteArg,
} from "../src/index.js";

// resolveShellSandboxConfig resolves/join()s every path against the OS path
// rules, so expectations must be built with the same node:path helpers rather
// than hardcoded POSIX strings — otherwise these tests fail on Windows where
// resolve("/repo") is "D:\\repo". The sandbox backends only run on macOS/Linux
// (where ROOT === "/repo"), but the unit tests exercise the path assembly on
// every platform.
const ROOT = resolve("/repo");

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
    expect(resolved.filesystem.allowWrite).toContain(ROOT);
    expect(resolved.filesystem.allowWrite).toContain(join(ROOT, "src"));
    expect(resolved.filesystem.denyWrite).toEqual(
      expect.arrayContaining([
        join(ROOT, "build"),
        join(ROOT, ".sparkwright", "config.json"),
        resolve("/home/me/.config/sparkwright/config.json"),
        join(ROOT, ".sparkwright", "skills"),
      ]),
    );
  });

  it("defaults to warn mode and network deny", () => {
    const resolved = resolveShellSandboxConfig({ workspaceRoot: "/repo" });

    expect(resolved.mode).toBe("warn");
    expect(resolved.failIfUnavailable).toBe(false);
    expect(resolved.network.mode).toBe("deny");
    expect(resolved.filesystem.denyRead).toEqual(
      expect.arrayContaining([
        join(ROOT, ".env"),
        join(ROOT, ".ssh"),
        join(ROOT, ".aws"),
      ]),
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

describe("prepareSandboxedProcessLaunch", () => {
  const request = {
    command: "node",
    args: ["server.js"],
    cwd: ROOT,
  };

  it("returns an unsandboxed argv invocation when warn mode is unavailable", async () => {
    const config = resolveShellSandboxConfig({ workspaceRoot: ROOT });
    const decision = await prepareSandboxedProcessLaunch(
      {
        id: "missing",
        platform: "linux",
        isAvailable: async () => false,
        execute: async () => {
          throw new Error("unused");
        },
      },
      request,
      config,
    );

    expect(decision).toMatchObject({
      status: "unsandboxed",
      available: false,
      enforced: false,
      runtimeId: "missing",
      invocation: request,
    });
    expect(decision.status === "unsandboxed" && decision.reason).toMatch(
      /unavailable/,
    );
  });

  it("returns unavailable without an invocation when enforce mode cannot start", async () => {
    const config = resolveShellSandboxConfig({
      workspaceRoot: ROOT,
      config: { mode: "enforce" },
    });
    const decision = await prepareSandboxedProcessLaunch(
      {
        id: "missing",
        platform: "darwin",
        isAvailable: async () => false,
        execute: async () => {
          throw new Error("unused");
        },
      },
      request,
      config,
    );

    expect(decision).toMatchObject({
      status: "unavailable",
      available: false,
      enforced: true,
      runtimeId: "missing",
    });
    expect(decision).not.toHaveProperty("invocation");
  });
});

describe("resolved filesystem grants", () => {
  it("scopes positive roots without discarding configured denies", () => {
    const config = resolveShellSandboxConfig({
      workspaceRoot: ROOT,
      config: { filesystem: { denyWrite: ["protected"] } },
    });
    const scoped = scopeShellSandboxFilesystem(config, {
      allowRead: [join(ROOT, "input")],
      allowWrite: [join(ROOT, "scratch")],
    });

    expect(scoped.filesystem.allowRead).toEqual([join(ROOT, "input")]);
    expect(scoped.filesystem.allowWrite).toEqual([join(ROOT, "scratch")]);
    expect(scoped.filesystem.denyWrite).toContain(join(ROOT, "protected"));
  });

  it("compiles no-write semantics for bind and deny-list backends", async () => {
    const config = resolveShellSandboxConfig({ workspaceRoot: ROOT });
    const linux = await enforceNoWriteShellSandbox(config, {
      runtime: { id: "bubblewrap", platform: "linux" },
      denyWriteRoots: [ROOT],
    });
    const mac = await enforceNoWriteShellSandbox(config, {
      runtime: { id: "sandbox-exec", platform: "darwin" },
      denyWriteRoots: [ROOT],
    });

    expect(linux).toMatchObject({
      mode: "enforce",
      failIfUnavailable: true,
      filesystem: { allowWrite: [], denyWrite: [], tmp: true },
    });
    expect(mac.filesystem.allowWrite).toEqual([]);
    expect(mac.filesystem.denyWrite).toContain(ROOT);
  });

  it("protects workspace writes while preserving delegate scratch writes", async () => {
    const scratch = resolve("/tmp/sparkwright-delegate");
    const scoped = scopeShellSandboxFilesystem(
      resolveShellSandboxConfig({ workspaceRoot: ROOT }),
      {
        allowRead: [scratch],
        allowWrite: [scratch],
      },
    );
    const linux = await enforceProtectedWriteRootsShellSandbox(scoped, {
      runtime: { id: "bubblewrap", platform: "linux" },
      protectedRoots: [ROOT],
    });
    const mac = await enforceProtectedWriteRootsShellSandbox(scoped, {
      runtime: { id: "sandbox-exec", platform: "darwin" },
      protectedRoots: [ROOT],
    });

    expect(linux).toMatchObject({
      mode: "enforce",
      failIfUnavailable: true,
      filesystem: { allowWrite: [scratch] },
    });
    expect(linux.filesystem.denyWrite).not.toContain(ROOT);
    expect(mac.filesystem.allowWrite).toEqual([scratch]);
    expect(mac.filesystem.denyWrite).toContain(ROOT);
  });

  it("extends read access with a stable resolved path", async () => {
    const config = resolveShellSandboxConfig({ workspaceRoot: ROOT });
    const extended = await extendShellSandboxReadAccess(config, [
      join(ROOT, "skills"),
    ]);

    expect(extended.filesystem.allowRead).toContain(join(ROOT, "skills"));
    expect(extended.filesystem.allowWrite).toEqual(
      config.filesystem.allowWrite,
    );
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
        join(ROOT, "docs"),
        join(ROOT, "docs"),
        "--bind-try",
        join(ROOT, "src"),
        join(ROOT, "src"),
        "bash",
        "-c",
        "npm test",
      ]),
    );
  });

  it("binds writable paths after the private /tmp overlay so they are not shadowed", () => {
    if (process.platform === "win32") return;
    const config = resolveShellSandboxConfig({
      workspaceRoot: "/repo",
      config: {
        filesystem: { allowWrite: ["/tmp/sparkwright-trace-x"] },
        network: { mode: "allow" },
      },
    });

    const invocation = buildBubblewrapInvocation({
      request: { command: "true", cwd: "/repo", env: {} },
      config,
      tmpRoot: "/tmp/sw",
    });

    const tmpBind = invocation.args.findIndex(
      (arg, i) =>
        arg === "--bind" &&
        invocation.args[i + 1] === "/tmp/sw" &&
        invocation.args[i + 2] === "/tmp",
    );
    const writeBind = invocation.args.findIndex(
      (arg, i) =>
        arg === "--bind-try" &&
        invocation.args[i + 1] === "/tmp/sparkwright-trace-x",
    );
    expect(tmpBind).toBeGreaterThanOrEqual(0);
    expect(writeBind).toBeGreaterThan(tmpBind);
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
    // schemeString() is JSON.stringify, so on Windows the path is emitted with
    // escaped backslashes — match that exactly by stringifying the joined path.
    expect(profile).toContain(
      `(deny file-read* (subpath ${JSON.stringify(join(ROOT, ".env"))}))`,
    );
    expect(profile).toContain(
      `(deny file-write* (subpath ${JSON.stringify(
        join(ROOT, ".sparkwright", "config.json"),
      )}))`,
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
