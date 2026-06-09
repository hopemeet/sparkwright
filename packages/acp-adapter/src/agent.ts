import { resolve } from "node:path";
import {
  RequestError,
  type Agent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
} from "@agentclientprotocol/sdk";
import type { PermissionMode, TraceLevel } from "@sparkwright/core";
import { HostRuntime } from "@sparkwright/host";
import { contentBlocksToText } from "./content.js";
import {
  AcpSessionStore,
  type AcpClientConnection,
  type AcpSessionInfo,
} from "./session.js";
import { routeHostEventToAcp } from "./event.js";

export interface SparkwrightAcpAgentOptions {
  defaultWorkspaceRoot: string;
  defaultModel?: string;
  defaultPermissionMode?: PermissionMode;
  defaultTraceLevel?: TraceLevel;
  defaultShouldWrite?: boolean;
  agentName?: string;
  agentVersion?: string;
}

export function createSparkwrightAcpAgentFactory(
  options: SparkwrightAcpAgentOptions,
): (connection: AgentSideConnection) => Agent {
  return (connection) => new SparkwrightAcpAgent(connection, options);
}

export class SparkwrightAcpAgent implements Agent {
  private readonly sessions: AcpSessionStore;
  private readonly activeTurns = new Map<
    string,
    {
      resolve: (response: PromptResponse) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(
    private readonly connection: AcpClientConnection,
    private readonly options: SparkwrightAcpAgentOptions,
  ) {
    this.sessions = new AcpSessionStore({
      defaultModel: options.defaultModel,
      defaultPermissionMode: options.defaultPermissionMode,
      defaultTraceLevel: options.defaultTraceLevel,
      defaultShouldWrite: options.defaultShouldWrite,
      emit: (session, event) => {
        void routeHostEventToAcp({ session, connection, event }).catch(
          () => {},
        );
        if (event.kind === "run.completed") {
          this.finishTurn(session, {
            stopReason:
              event.payload.state === "cancelled" ? "cancelled" : "end_turn",
          });
        } else if (event.kind === "run.failed") {
          this.failTurn(session, new Error(event.payload.error.message));
        }
      },
    });
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: 1,
      agentInfo: {
        name: this.options.agentName ?? "SparkWright",
        version: this.options.agentVersion ?? "0.1.0",
      },
      agentCapabilities: {
        promptCapabilities: {
          embeddedContext: true,
          image: false,
          audio: false,
        },
        sessionCapabilities: {
          close: {},
          list: {},
          resume: {},
        },
      },
      authMethods: [],
    };
  }

  async authenticate(
    _params: AuthenticateRequest,
  ): Promise<AuthenticateResponse> {
    return {};
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const session = this.sessions.create({
      cwd: params.cwd || this.options.defaultWorkspaceRoot,
    });
    return { sessionId: session.sessionId };
  }

  async resumeSession(
    params: ResumeSessionRequest,
  ): Promise<ResumeSessionResponse> {
    this.sessions.create({
      sessionId: params.sessionId,
      cwd: params.cwd || this.options.defaultWorkspaceRoot,
    });
    return {};
  }

  async listSessions(
    params: ListSessionsRequest,
  ): Promise<ListSessionsResponse> {
    const sessions = this.sessions
      .list(params.cwd ?? undefined)
      .map((session) => ({
        sessionId: session.sessionId,
        cwd: session.cwd,
        updatedAt: new Date().toISOString(),
      }));
    return { sessions };
  }

  async closeSession(
    params: CloseSessionRequest,
  ): Promise<CloseSessionResponse> {
    this.sessions.close(params.sessionId);
    return {};
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (session.activeRunId) {
      throw RequestError.invalidRequest({
        message: "A run is already active for this ACP session.",
      });
    }

    const goal = contentBlocksToText(params.prompt);
    if (!goal) {
      throw RequestError.invalidParams({
        message: "Prompt content must include text or embedded text resources.",
      });
    }

    await this.connection.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: goal },
      },
    });

    const turn = new Promise<PromptResponse>((resolve, reject) => {
      this.activeTurns.set(session.sessionId, { resolve, reject });
    });

    const started = await session.runtime.startRun({
      goal,
      sessionId: session.sessionId,
      model: this.options.defaultModel,
      permissionMode: this.options.defaultPermissionMode,
      traceLevel: this.options.defaultTraceLevel ?? "standard",
      shouldWrite: this.options.defaultShouldWrite === true,
      metadata: {
        source: "acp",
        acpSessionId: session.sessionId,
        workspaceRoot: session.cwd,
        permissionMode: this.options.defaultPermissionMode ?? "default",
        traceLevel: this.options.defaultTraceLevel ?? "standard",
        shouldWrite: this.options.defaultShouldWrite === true,
      },
    });

    if (!started.ok) {
      this.activeTurns.delete(session.sessionId);
      throw RequestError.internalError(started.error);
    }

    session.activeRunId = started.runId;
    return turn.finally(() => {
      session.activeRunId = undefined;
      this.activeTurns.delete(session.sessionId);
    });
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.tryGet(params.sessionId);
    if (!session?.activeRunId) return;
    session.runtime.cancelRun(session.activeRunId, "ACP client cancelled");
  }

  async extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (method === "sparkwright/capabilities") {
      return this.inspectCapabilities(params);
    }
    throw RequestError.methodNotFound(method);
  }

  async extNotification(
    _method: string,
    _params: Record<string, unknown>,
  ): Promise<void> {
    return;
  }

  closeAll(): void {
    this.sessions.closeAll();
  }

  private finishTurn(session: AcpSessionInfo, response: PromptResponse): void {
    this.activeTurns.get(session.sessionId)?.resolve(response);
  }

  private failTurn(session: AcpSessionInfo, error: Error): void {
    this.activeTurns.get(session.sessionId)?.reject(error);
  }

  private async inspectCapabilities(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const sessionId = stringParam(params.sessionId);
    if (sessionId) {
      let session: AcpSessionInfo;
      try {
        session = this.sessions.get(sessionId);
      } catch (error) {
        throw RequestError.invalidParams({
          message: error instanceof Error ? error.message : String(error),
        });
      }
      const inspected = await session.runtime.inspectCapabilities();
      if (inspected.ok) {
        return inspected.snapshot as unknown as Record<string, unknown>;
      }
      throw RequestError.internalError(inspected.error);
    }

    const rawCwd = stringParam(params.cwd) ?? this.options.defaultWorkspaceRoot;
    const cwd = resolve(this.options.defaultWorkspaceRoot, rawCwd);
    const runtime = new HostRuntime({
      workspaceRoot: cwd,
      defaultModel: this.options.defaultModel,
      defaultPermissionMode: this.options.defaultPermissionMode,
      defaultTraceLevel: this.options.defaultTraceLevel,
      defaultShouldWrite: this.options.defaultShouldWrite,
      emit: () => {},
    });
    try {
      const inspected = await runtime.inspectCapabilities();
      if (inspected.ok) {
        return inspected.snapshot as unknown as Record<string, unknown>;
      }
      throw RequestError.internalError(inspected.error);
    } finally {
      runtime.cleanup();
    }
  }
}

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}
