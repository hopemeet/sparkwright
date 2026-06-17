import { isAbsolute } from "node:path";
import { asSessionId, createSessionId } from "@sparkwright/core";
import { HostRuntime } from "@sparkwright/host";
import type { McpServerConfig } from "@sparkwright/mcp-adapter";
import type { AgentSideConnection, SessionId } from "@agentclientprotocol/sdk";
import type {
  HostEvent,
  PermissionMode,
  TraceLevel,
} from "@sparkwright/protocol";

export interface AcpSessionInfo {
  sessionId: SessionId;
  cwd: string;
  mcpServers?: readonly McpServerConfig[];
  runtime: HostRuntime;
  activeRunId?: string;
}

export interface AcpSessionStoreOptions {
  defaultModel?: string;
  defaultPermissionMode?: PermissionMode;
  defaultTraceLevel?: TraceLevel;
  defaultShouldWrite?: boolean;
  /**
   * Root directory under which per-session artifacts (trace, transcript,
   * blobs, …) are written. When omitted, HostRuntime falls back to
   * `<workspace>/.sparkwright/sessions`, which writes into the workspace —
   * undesirable when the workspace is a clean checkout. Plumbed from the ACP
   * `--session-root` flag to keep parity with `sparkwright run`/`tui`.
   */
  sessionRootDir?: string;
  emit: (session: AcpSessionInfo, event: HostEvent) => void;
}

export class AcpSessionStore {
  private readonly sessions = new Map<SessionId, AcpSessionInfo>();

  constructor(private readonly options: AcpSessionStoreOptions) {}

  create(input: {
    cwd: string;
    sessionId?: string;
    mcpServers?: readonly McpServerConfig[];
  }): AcpSessionInfo {
    const cwd = normalizeCwd(input.cwd);
    const sessionId = normalizeSessionId(input.sessionId);
    const session = this.buildSession(sessionId, cwd, input.mcpServers);
    this.sessions.set(sessionId, session);
    return session;
  }

  get(sessionId: string): AcpSessionInfo {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`ACP session not found: ${sessionId}`);
    return session;
  }

  tryGet(sessionId: string): AcpSessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  list(cwd?: string): AcpSessionInfo[] {
    const normalizedCwd = cwd ? normalizeCwd(cwd) : undefined;
    return [...this.sessions.values()].filter(
      (session) => !normalizedCwd || session.cwd === normalizedCwd,
    );
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.runtime.cleanup();
    this.sessions.delete(sessionId);
  }

  closeAll(): void {
    for (const session of this.sessions.values()) {
      session.runtime.cleanup();
    }
    this.sessions.clear();
  }

  private buildSession(
    sessionId: SessionId,
    cwd: string,
    mcpServers?: readonly McpServerConfig[],
  ): AcpSessionInfo {
    const session: AcpSessionInfo = {
      sessionId,
      cwd,
      ...(mcpServers && mcpServers.length > 0 ? { mcpServers } : {}),
      runtime: new HostRuntime({
        workspaceRoot: cwd,
        ...(this.options.sessionRootDir
          ? { sessionRootDir: this.options.sessionRootDir }
          : {}),
        ...(mcpServers && mcpServers.length > 0
          ? { extraMcpServers: mcpServers }
          : {}),
        defaultModel: this.options.defaultModel,
        defaultPermissionMode: this.options.defaultPermissionMode,
        defaultTraceLevel: this.options.defaultTraceLevel,
        defaultShouldWrite: this.options.defaultShouldWrite,
        emit: (event) => this.options.emit(session, event),
      }),
    };
    return session;
  }
}

export type AcpClientConnection = Pick<
  AgentSideConnection,
  "requestPermission" | "sessionUpdate"
>;

export function normalizeSessionId(value?: string): SessionId {
  return value ? asSessionId(value) : createSessionId();
}

function normalizeCwd(cwd: string): string {
  if (!cwd || !isAbsolute(cwd)) {
    throw new Error("ACP session cwd must be an absolute path.");
  }
  return cwd;
}
