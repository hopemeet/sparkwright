import { spawn } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  LiveShellHandle,
  ShellExecutionResult,
  ShellStreamingResult,
} from "@sparkwright/core";

/**
 * Public sandbox mode used by hosts.
 *
 * - off: always execute without OS sandboxing.
 * - warn: use sandbox when available, otherwise return an unavailable result
 *   so hosts may explicitly fall back.
 * - enforce: fail closed when sandboxing is unavailable.
 *
 * @public
 * @stability experimental v0.1
 */
export type ShellSandboxMode = "off" | "warn" | "enforce";

/**
 * Coarse network policy. Domain-level controls intentionally stay out of the
 * v0 contract until SparkWright owns a proxy implementation.
 *
 * @public
 * @stability experimental v0.1
 */
export type ShellSandboxNetworkMode = "allow" | "deny";

/**
 * User-facing sandbox config. Paths may be absolute or relative to the
 * workspace root passed to {@link resolveShellSandboxConfig}.
 *
 * @public
 * @stability experimental v0.1
 */
export interface ShellSandboxConfig {
  mode?: ShellSandboxMode;
  failIfUnavailable?: boolean;
  filesystem?: {
    allowRead?: readonly string[];
    allowWrite?: readonly string[];
    denyRead?: readonly string[];
    denyWrite?: readonly string[];
    tmp?: boolean;
  };
  network?: {
    mode?: ShellSandboxNetworkMode;
  };
}

/**
 * Fully resolved config consumed by runtime adapters.
 *
 * @public
 * @stability experimental v0.1
 */
export interface ResolvedShellSandboxConfig {
  mode: ShellSandboxMode;
  failIfUnavailable: boolean;
  filesystem: {
    allowRead: readonly string[];
    allowWrite: readonly string[];
    denyRead: readonly string[];
    denyWrite: readonly string[];
    tmp: boolean;
  };
  network: {
    mode: ShellSandboxNetworkMode;
  };
  forcedDenyWrite: readonly string[];
}

/**
 * Options for resolving a host sandbox config.
 *
 * @public
 * @stability experimental v0.1
 */
export interface ResolveShellSandboxConfigOptions {
  workspaceRoot: string;
  config?: ShellSandboxConfig;
  userConfigPath?: string;
  projectConfigPath?: string;
  explicitConfigPath?: string;
  skillRoots?: readonly string[];
  extraForcedDenyWrite?: readonly string[];
}

/**
 * Request passed to an OS-level runtime.
 *
 * @public
 * @stability experimental v0.1
 */
export interface SandboxedShellRequest {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Request for a long-lived process that should run inside the same OS sandbox
 * profile as shell commands. Unlike {@link SandboxedShellRequest}, this keeps
 * argv semantics at the caller boundary and quotes only at the sandbox wrapper
 * boundary.
 *
 * @public
 * @stability experimental v0.1
 */
export interface SandboxedProcessRequest {
  command: string;
  args?: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  metadata?: Record<string, unknown>;
}

/**
 * Concrete process invocation prepared for `child_process.spawn`.
 *
 * @public
 * @stability experimental v0.1
 */
export interface SandboxedProcessInvocation {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  cleanup?: () => Promise<void>;
  metadata?: Record<string, unknown>;
}

/**
 * One argv-process launch decision. Callers keep ownership of process I/O and
 * lifecycle, while this package owns the platform availability/fallback rule
 * and the concrete invocation.
 */
export type SandboxedProcessLaunchDecision =
  | {
      status: "sandboxed";
      invocation: SandboxedProcessInvocation;
      runtimeId: string;
      available: true;
      enforced: boolean;
    }
  | {
      status: "unsandboxed";
      invocation: SandboxedProcessInvocation;
      runtimeId: string;
      available: false;
      enforced: false;
      reason?: string;
    }
  | {
      status: "unavailable";
      runtimeId: string;
      available: false;
      enforced: true;
      reason: string;
    };

/**
 * OS-level sandbox adapter.
 *
 * @public
 * @stability experimental v0.1
 */
export interface ShellSandboxRuntime {
  readonly id: string;
  readonly platform: NodeJS.Platform | "unsupported";
  isAvailable(): Promise<boolean>;
  execute(
    request: SandboxedShellRequest,
    config: ResolvedShellSandboxConfig,
  ): Promise<ShellStreamingResult>;
}

/**
 * Path-free sandbox status safe for capability reports and traces.
 *
 * @public
 * @stability experimental v0.1
 */
export interface ShellSandboxStatus {
  mode: ShellSandboxMode;
  failIfUnavailable: boolean;
  runtimeId: string;
  platform: NodeJS.Platform | "unsupported";
  available: boolean;
  networkMode: ShellSandboxNetworkMode;
  filesystemIsolation: "bind-allowlist" | "deny-list-guard" | "unsupported";
}

/**
 * Executor result. `unavailable` is deliberately separate from process
 * failures so the host can implement warn-mode fallback explicitly.
 *
 * @public
 * @stability experimental v0.1
 */
export type ShellSandboxExecutorResult =
  | { status: "started"; sandboxed: boolean; result: ShellStreamingResult }
  | { status: "unavailable"; reason: string; runtimeId: string };

export const DEFAULT_SHELL_SANDBOX_MODE: ShellSandboxMode = "warn";

export function resolveShellSandboxConfig(
  options: ResolveShellSandboxConfigOptions,
): ResolvedShellSandboxConfig {
  const workspaceRoot = resolve(options.workspaceRoot);
  const config = options.config ?? {};
  const forcedDenyCandidates = [
    join(workspaceRoot, ".sparkwright"),
    join(workspaceRoot, ".sparkwright", "config.json"),
    options.userConfigPath,
    options.projectConfigPath,
    options.explicitConfigPath,
    ...(options.skillRoots ?? []),
    ...(options.extraForcedDenyWrite ?? []),
  ].filter(
    (path): path is string => typeof path === "string" && path.length > 0,
  );
  const forcedDenyWrite = uniquePaths([
    ...forcedDenyCandidates.flatMap((path) =>
      resolvePathVariants(workspaceRoot, path),
    ),
    ...forcedDenyCandidates
      .filter((path) => path.endsWith(".json"))
      .flatMap((path) =>
        resolvePathVariants(
          workspaceRoot,
          dirname(resolvePath(workspaceRoot, path)),
        ),
      ),
  ]);

  const allowRead = resolvePathList(workspaceRoot, [
    workspaceRoot,
    ...(config.filesystem?.allowRead ?? []),
  ]);
  const allowWrite = resolvePathList(workspaceRoot, [
    workspaceRoot,
    ...(config.filesystem?.allowWrite ?? []),
  ]);
  const denyRead = resolvePathList(workspaceRoot, [
    ".env",
    ".env.local",
    ".ssh",
    ".aws",
    ".gcp",
    ".azure",
    ...(config.filesystem?.denyRead ?? []),
  ]);
  const denyWrite = uniquePaths([
    ...resolvePathList(workspaceRoot, config.filesystem?.denyWrite ?? []),
    ...forcedDenyWrite,
  ]);

  return {
    mode: config.mode ?? DEFAULT_SHELL_SANDBOX_MODE,
    failIfUnavailable:
      config.failIfUnavailable === true || config.mode === "enforce",
    filesystem: {
      allowRead,
      allowWrite,
      denyRead,
      denyWrite,
      tmp: config.filesystem?.tmp ?? true,
    },
    network: {
      mode: config.network?.mode ?? "deny",
    },
    forcedDenyWrite,
  };
}

export function createPlatformShellSandboxRuntime(
  platform: NodeJS.Platform = process.platform,
): ShellSandboxRuntime {
  if (platform === "darwin") return new MacOSShellSandboxRuntime();
  if (platform === "linux") return new LinuxBubblewrapShellSandboxRuntime();
  return new UnsupportedShellSandboxRuntime(platform);
}

export async function describeShellSandboxStatus(
  config: ResolvedShellSandboxConfig,
  runtime: ShellSandboxRuntime = createPlatformShellSandboxRuntime(),
): Promise<ShellSandboxStatus> {
  return {
    mode: config.mode,
    failIfUnavailable: config.failIfUnavailable,
    runtimeId: runtime.id,
    platform: runtime.platform,
    available: config.mode === "off" ? false : await runtime.isAvailable(),
    networkMode: config.network.mode,
    filesystemIsolation: filesystemIsolationForRuntime(runtime),
  };
}

export function filesystemIsolationForRuntime(
  runtime: Pick<ShellSandboxRuntime, "id" | "platform">,
): ShellSandboxStatus["filesystemIsolation"] {
  if (runtime.id === "bubblewrap" || runtime.platform === "linux") {
    return "bind-allowlist";
  }
  if (runtime.id === "sandbox-exec" || runtime.platform === "darwin") {
    return "deny-list-guard";
  }
  return "unsupported";
}

/** Replace the positive filesystem scope while preserving configured denies. */
export function scopeShellSandboxFilesystem(
  config: ResolvedShellSandboxConfig,
  input: { allowRead: readonly string[]; allowWrite: readonly string[] },
): ResolvedShellSandboxConfig {
  return {
    ...config,
    filesystem: {
      ...config.filesystem,
      allowRead: uniquePaths(input.allowRead),
      allowWrite: uniquePaths(input.allowWrite),
    },
  };
}

/** Add stable lexical/realpath read grants without changing write access. */
export async function extendShellSandboxReadAccess(
  config: ResolvedShellSandboxConfig,
  paths: readonly string[],
): Promise<ResolvedShellSandboxConfig> {
  const variants = [...config.filesystem.allowRead];
  for (const path of paths) {
    const resolved = resolve(path);
    variants.push(resolved);
    try {
      variants.push(await realpath(resolved));
    } catch {
      // Missing paths remain represented by their stable lexical form.
    }
  }
  return {
    ...config,
    filesystem: {
      ...config.filesystem,
      allowRead: uniquePaths(variants),
    },
  };
}

/**
 * Compile a fail-closed no-write profile for the selected OS backend. Bind
 * allowlists deny writes by having no writable roots; macOS deny-list guards
 * need explicit lexical, realpath, and /private alias variants.
 */
export async function enforceNoWriteShellSandbox(
  config: ResolvedShellSandboxConfig,
  input: {
    runtime: Pick<ShellSandboxRuntime, "id" | "platform">;
    denyWriteRoots?: readonly string[];
  },
): Promise<ResolvedShellSandboxConfig> {
  const isolation = filesystemIsolationForRuntime(input.runtime);
  const denyWrite =
    isolation === "bind-allowlist"
      ? []
      : isolation === "deny-list-guard"
        ? uniquePaths([
            ...config.filesystem.denyWrite,
            ...(await sandboxPathVariants(input.denyWriteRoots ?? [])),
          ])
        : config.filesystem.denyWrite;
  return {
    ...config,
    mode: "enforce",
    failIfUnavailable: true,
    filesystem: {
      ...config.filesystem,
      allowWrite: [],
      denyWrite,
      tmp: true,
    },
  };
}

async function sandboxPathVariants(
  paths: readonly string[],
): Promise<string[]> {
  const variants: string[] = [];
  for (const path of paths) {
    const resolved = resolve(path);
    variants.push(resolved, ...macOSPrivatePathVariants(resolved));
    try {
      const real = await realpath(resolved);
      variants.push(real, ...macOSPrivatePathVariants(real));
    } catch {
      // Nonexistent roots are still denied by their stable lexical form.
    }
  }
  return variants;
}

function macOSPrivatePathVariants(path: string): string[] {
  const variants: string[] = [];
  for (const alias of ["/var", "/tmp", "/etc"]) {
    const privateAlias = `/private${alias}`;
    if (path === alias || path.startsWith(`${alias}/`)) {
      variants.push(`/private${path}`);
    }
    if (path === privateAlias || path.startsWith(`${privateAlias}/`)) {
      variants.push(path.slice("/private".length));
    }
  }
  return variants;
}

export class ShellSandboxExecutor {
  constructor(private readonly runtime: ShellSandboxRuntime) {}

  async execute(
    request: SandboxedShellRequest,
    config: ResolvedShellSandboxConfig,
  ): Promise<ShellSandboxExecutorResult> {
    if (config.mode === "off") {
      return {
        status: "started",
        sandboxed: false,
        result: spawnStreaming({
          command: "bash",
          args: ["-c", request.command],
          cwd: request.cwd,
          env: request.env,
          stdin: request.stdin,
          timeoutMs: request.timeoutMs,
          metadata: { ...(request.metadata ?? {}), sandboxed: false },
        }),
      };
    }

    const available = await this.runtime.isAvailable();
    if (!available) {
      return {
        status: "unavailable",
        reason: `Shell sandbox runtime "${this.runtime.id}" is unavailable on ${this.runtime.platform}.`,
        runtimeId: this.runtime.id,
      };
    }

    return {
      status: "started",
      sandboxed: true,
      result: await this.runtime.execute(request, config),
    };
  }
}

export class UnsupportedShellSandboxRuntime implements ShellSandboxRuntime {
  readonly id = "unsupported";
  readonly platform: NodeJS.Platform | "unsupported";

  constructor(platform: NodeJS.Platform | "unsupported") {
    this.platform = platform;
  }

  async isAvailable(): Promise<boolean> {
    return false;
  }

  async execute(): Promise<ShellStreamingResult> {
    throw new Error("Unsupported shell sandbox runtime cannot execute.");
  }
}

/**
 * Build a long-lived process invocation for the selected platform sandbox.
 *
 * The returned invocation is intentionally separated from execution so callers
 * that own a streaming protocol, such as MCP stdio, can preserve their own
 * lifecycle while still using the same filesystem and network profile.
 *
 * @public
 * @stability experimental v0.1
 */
export async function prepareSandboxedProcessInvocation(
  runtime: ShellSandboxRuntime,
  request: SandboxedProcessRequest,
  config: ResolvedShellSandboxConfig,
): Promise<SandboxedProcessInvocation> {
  const shellCommand = shellJoin([request.command, ...(request.args ?? [])]);
  if (
    runtime instanceof LinuxBubblewrapShellSandboxRuntime ||
    runtime.id === "bubblewrap"
  ) {
    const executable =
      runtime instanceof LinuxBubblewrapShellSandboxRuntime
        ? runtime.executablePath()
        : "bwrap";
    const tmpRoot = await mkdtemp(join(tmpdir(), "sparkwright-sandbox-"));
    const denyMounts = await prepareBubblewrapDenyMounts(tmpRoot, [
      ...config.filesystem.denyRead,
      ...config.filesystem.denyWrite,
    ]);
    const invocation = buildBubblewrapInvocation({
      executable,
      request: {
        command: shellCommand,
        cwd: request.cwd,
        env: request.env,
        metadata: request.metadata,
      },
      config,
      tmpRoot,
      denyMounts,
    });
    return {
      command: invocation.command,
      args: invocation.args,
      cwd: request.cwd,
      env: request.env,
      cleanup: () => rm(tmpRoot, { recursive: true, force: true }),
      metadata: { ...(request.metadata ?? {}), sandboxRuntime: runtime.id },
    };
  }

  if (
    runtime instanceof MacOSShellSandboxRuntime ||
    runtime.id === "sandbox-exec"
  ) {
    const executable =
      runtime instanceof MacOSShellSandboxRuntime
        ? runtime.executablePath()
        : "sandbox-exec";
    const tmpRoot = await mkdtemp(join(tmpdir(), "sparkwright-sandbox-"));
    const profilePath = join(tmpRoot, "profile.sb");
    const profile = buildMacOSSandboxProfile(config, tmpRoot);
    await writeFile(profilePath, profile, "utf8");
    return {
      command: executable,
      args: ["-f", profilePath, "/bin/bash", "-c", shellCommand],
      cwd: request.cwd,
      env: request.env,
      cleanup: () => rm(tmpRoot, { recursive: true, force: true }),
      metadata: { ...(request.metadata ?? {}), sandboxRuntime: runtime.id },
    };
  }

  throw new Error(`Shell sandbox runtime "${runtime.id}" cannot spawn.`);
}

/**
 * Compile sandbox mode + runtime availability into a launch decision for an
 * argv-owned process. This deliberately does not spawn: MCP, Workflow JSON-RPC,
 * and other transports retain their distinct I/O and shutdown protocols.
 */
export async function prepareSandboxedProcessLaunch(
  runtime: ShellSandboxRuntime,
  request: SandboxedProcessRequest,
  config: ResolvedShellSandboxConfig,
): Promise<SandboxedProcessLaunchDecision> {
  if (config.mode === "off") {
    return {
      status: "unsandboxed",
      invocation: rawProcessInvocation(request),
      runtimeId: runtime.id,
      available: false,
      enforced: false,
    };
  }
  if (!(await runtime.isAvailable())) {
    const reason = `Shell sandbox runtime "${runtime.id}" is unavailable on ${runtime.platform}.`;
    if (config.failIfUnavailable) {
      return {
        status: "unavailable",
        runtimeId: runtime.id,
        available: false,
        enforced: true,
        reason,
      };
    }
    return {
      status: "unsandboxed",
      invocation: rawProcessInvocation(request),
      runtimeId: runtime.id,
      available: false,
      enforced: false,
      reason,
    };
  }
  return {
    status: "sandboxed",
    invocation: await prepareSandboxedProcessInvocation(
      runtime,
      request,
      config,
    ),
    runtimeId: runtime.id,
    available: true,
    enforced: config.failIfUnavailable,
  };
}

function rawProcessInvocation(
  request: SandboxedProcessRequest,
): SandboxedProcessInvocation {
  return {
    command: request.command,
    args: request.args ?? [],
    cwd: request.cwd,
    env: request.env,
    metadata: request.metadata,
  };
}

export class LinuxBubblewrapShellSandboxRuntime implements ShellSandboxRuntime {
  readonly id = "bubblewrap";
  readonly platform = "linux" as const;

  constructor(private readonly executable = "bwrap") {}

  executablePath(): string {
    return this.executable;
  }

  async isAvailable(): Promise<boolean> {
    return commandExists(this.executable);
  }

  async execute(
    request: SandboxedShellRequest,
    config: ResolvedShellSandboxConfig,
  ): Promise<ShellStreamingResult> {
    const tmpRoot = await mkdtemp(join(tmpdir(), "sparkwright-sandbox-"));
    const denyMounts = await prepareBubblewrapDenyMounts(tmpRoot, [
      ...config.filesystem.denyRead,
      ...config.filesystem.denyWrite,
    ]);
    const { command, args } = buildBubblewrapInvocation({
      executable: this.executable,
      request,
      config,
      tmpRoot,
      denyMounts,
    });
    const result = spawnStreaming({
      command,
      args,
      cwd: request.cwd,
      env: request.env,
      stdin: request.stdin,
      timeoutMs: request.timeoutMs,
      metadata: {
        ...(request.metadata ?? {}),
        sandboxed: true,
        sandboxRuntime: this.id,
      },
      cleanup: () => rm(tmpRoot, { recursive: true, force: true }),
    });
    return result;
  }
}

export class MacOSShellSandboxRuntime implements ShellSandboxRuntime {
  readonly id = "sandbox-exec";
  readonly platform = "darwin" as const;

  constructor(private readonly executable = "sandbox-exec") {}

  executablePath(): string {
    return this.executable;
  }

  async isAvailable(): Promise<boolean> {
    return commandExists(this.executable);
  }

  async execute(
    request: SandboxedShellRequest,
    config: ResolvedShellSandboxConfig,
  ): Promise<ShellStreamingResult> {
    const tmpRoot = await mkdtemp(join(tmpdir(), "sparkwright-sandbox-"));
    const profilePath = join(tmpRoot, "profile.sb");
    const profile = buildMacOSSandboxProfile(config, tmpRoot);
    await writeFile(profilePath, profile, "utf8");
    const result = spawnStreaming({
      command: this.executable,
      args: ["-f", profilePath, "/bin/bash", "-c", request.command],
      cwd: request.cwd,
      env: request.env,
      stdin: request.stdin,
      timeoutMs: request.timeoutMs,
      metadata: {
        ...(request.metadata ?? {}),
        sandboxed: true,
        sandboxRuntime: this.id,
      },
      cleanup: () => rm(tmpRoot, { recursive: true, force: true }),
    });
    return result;
  }
}

export interface BuildBubblewrapInvocationOptions {
  executable?: string;
  request: SandboxedShellRequest;
  config: ResolvedShellSandboxConfig;
  tmpRoot: string;
  denyMounts?: readonly BubblewrapDenyMount[];
}

export interface BubblewrapDenyMount {
  path: string;
  source: string;
  kind: "file" | "dir";
}

export function buildBubblewrapInvocation(
  options: BuildBubblewrapInvocationOptions,
): { command: string; args: string[] } {
  const executable = options.executable ?? "bwrap";
  const config = options.config;
  const args = [
    "--die-with-parent",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--ro-bind",
    "/bin",
    "/bin",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind-try",
    "/usr/local",
    "/usr/local",
    "--ro-bind-try",
    "/opt",
    "/opt",
    "--ro-bind",
    "/lib",
    "/lib",
    "--ro-bind-try",
    "/lib64",
    "/lib64",
    "--ro-bind-try",
    "/etc",
    "/etc",
    "--chdir",
    options.request.cwd,
  ];

  if (config.network.mode === "deny") {
    args.push("--unshare-net");
  }

  for (const path of config.filesystem.allowRead) {
    args.push("--ro-bind-try", path, path);
  }
  if (config.filesystem.tmp) {
    args.push("--bind", options.tmpRoot, "/tmp");
  }
  // Bind writable paths AFTER the private /tmp overlay so an explicitly
  // allowed path under /tmp is not shadowed by the empty tmpRoot mounted over
  // /tmp.
  for (const path of config.filesystem.allowWrite) {
    args.push("--bind-try", path, path);
  }

  // bwrap has no deny-after-bind primitive. Hide explicit deny paths by
  // overlaying an empty read-only file or directory over each target.
  for (const mount of options.denyMounts ??
    heuristicBubblewrapDenyMounts(config)) {
    args.push("--ro-bind-try", mount.source, mount.path);
  }

  args.push("bash", "-c", options.request.command);
  return { command: executable, args };
}

async function prepareBubblewrapDenyMounts(
  tmpRoot: string,
  paths: readonly string[],
): Promise<BubblewrapDenyMount[]> {
  const emptyDir = join(tmpRoot, "deny-empty-dir");
  const emptyFile = join(tmpRoot, "deny-empty-file");
  await mkdir(emptyDir, { recursive: true });
  await writeFile(emptyFile, "");
  const mounts: BubblewrapDenyMount[] = [];
  for (const path of uniquePaths(paths)) {
    const stat = await lstat(path).catch(() => undefined);
    mounts.push({
      path,
      source: stat?.isDirectory() ? emptyDir : emptyFile,
      kind: stat?.isDirectory() ? "dir" : "file",
    });
  }
  return mounts;
}

function heuristicBubblewrapDenyMounts(
  config: ResolvedShellSandboxConfig,
): BubblewrapDenyMount[] {
  return uniquePaths([
    ...config.filesystem.denyRead,
    ...config.filesystem.denyWrite,
  ]).map((path) => ({
    path,
    source: pathLooksLikeFile(path) ? "/dev/null" : "/tmp",
    kind: pathLooksLikeFile(path) ? "file" : "dir",
  }));
}

export function buildMacOSSandboxProfile(
  config: ResolvedShellSandboxConfig,
  tmpRoot: string,
): string {
  void tmpRoot;
  const lines = ["(version 1)", "(allow default)"];

  for (const path of config.filesystem.denyRead) {
    lines.push(`(deny file-read* (subpath ${schemeString(path)}))`);
  }
  for (const path of config.filesystem.denyWrite) {
    lines.push(`(deny file-write* (subpath ${schemeString(path)}))`);
  }
  if (config.network.mode === "allow") {
    lines.push("(allow network*)");
  } else {
    lines.push("(deny network*)");
  }
  return `${lines.join("\n")}\n`;
}

function spawnStreaming(input: {
  command: string;
  args?: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
  cleanup?: () => Promise<void>;
}): ShellStreamingResult {
  const startedAt = new Date().toISOString();
  const stdout = new LiveOutputBuffer();
  const stderr = new LiveOutputBuffer();
  const child = spawn(input.command, [...(input.args ?? [])], {
    cwd: input.cwd,
    env: input.env,
  });

  let timedOut = false;
  const timer =
    typeof input.timeoutMs === "number"
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, input.timeoutMs)
      : undefined;

  child.stdout?.on("data", (chunk: Buffer | string) => {
    stdout.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  });
  if (input.stdin !== undefined) {
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input.stdin, "utf8");
  } else {
    child.stdin?.end();
  }

  const completed = new Promise<ShellExecutionResult>((resolveCompleted) => {
    const finish = (
      status: ShellExecutionResult["status"],
      exitCode: number | null,
      errorStderr = "",
    ): void => {
      if (timer) clearTimeout(timer);
      stdout.close();
      stderr.close();
      void input.cleanup?.();
      resolveCompleted({
        status,
        exitCode,
        stdout: stdout.text(),
        stderr: stderr.text() || errorStderr,
        startedAt,
        completedAt: new Date().toISOString(),
        metadata: {
          ...(input.metadata ?? {}),
          timedOut,
          pid: child.pid,
        },
      });
    };
    child.on("error", (err) => finish("failed", null, String(err)));
    child.on("close", (code) =>
      finish(code === 0 ? "completed" : "failed", code),
    );
  });

  const handle: LiveShellHandle = {
    stdout: () => stdout.stream(),
    stderr: () => stderr.stream(),
    abort: (reason) => {
      void reason;
      child.kill("SIGTERM");
    },
    metadata: { pid: child.pid, ...(input.metadata ?? {}) },
  };

  return { handle, completed };
}

class LiveOutputBuffer {
  private readonly chunks: string[] = [];
  private readonly waiters: Array<() => void> = [];
  private closed = false;
  private subscriptions = 0;

  push(chunk: string): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  text(): string {
    return this.chunks.join("");
  }

  async *stream(): AsyncIterable<string> {
    const start = this.subscriptions === 0 ? 0 : this.chunks.length;
    this.subscriptions += 1;
    let index = start;
    while (true) {
      while (index < this.chunks.length) {
        yield this.chunks[index++]!;
      }
      if (this.closed) return;
      await new Promise<void>((resolvePromise) =>
        this.waiters.push(resolvePromise),
      );
    }
  }

  private wake(): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }
}

async function commandExists(command: string): Promise<boolean> {
  if (command.includes(sep) || isAbsolute(command)) {
    return access(command, constants.X_OK)
      .then(() => true)
      .catch(() => false);
  }
  const paths = (process.env.PATH ?? "").split(sep === "\\" ? ";" : ":");
  for (const dir of paths) {
    if (!dir) continue;
    const candidate = join(dir, command);
    const ok = await access(candidate, constants.X_OK)
      .then(() => true)
      .catch(() => false);
    if (ok) return true;
  }
  return false;
}

function resolvePathList(
  workspaceRoot: string,
  paths: readonly string[],
): string[] {
  return uniquePaths(
    paths.flatMap((path) => resolvePathVariants(workspaceRoot, path)),
  );
}

function resolvePath(workspaceRoot: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(workspaceRoot, path);
}

function resolvePathVariants(workspaceRoot: string, path: string): string[] {
  const resolved = resolvePath(workspaceRoot, path);
  try {
    const real = realpathSync.native(resolved);
    return real === resolved ? [resolved] : [resolved, real];
  } catch {
    return [resolved];
  }
}

function uniquePaths(paths: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const normalized = resolve(path);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function shellQuoteArg(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/u.test(value)) return value;
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

export function shellJoin(values: readonly string[]): string {
  return values.map((value) => shellQuoteArg(value)).join(" ");
}

function schemeString(value: string): string {
  return JSON.stringify(value);
}

function pathLooksLikeFile(path: string): boolean {
  const last = path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  return last.includes(".");
}

export async function resolveRealPath(path: string): Promise<string> {
  try {
    return await realpath(resolve(path));
  } catch {
    return resolve(path);
  }
}

export async function assertPathInsideAnyRoot(
  roots: readonly string[],
  target: string,
): Promise<void> {
  const resolvedRoots = await Promise.all(
    roots.map((root) => resolveRealPath(root)),
  );
  const resolvedTarget = await resolveRealPath(target);
  if (!isInsideAnyRoot(resolvedRoots, resolvedTarget)) {
    throw new Error(`Path escapes sandbox roots: ${target}`);
  }
}

function isInsideAnyRoot(roots: readonly string[], target: string): boolean {
  return roots.some((root) => {
    const rel = relative(root, target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}
