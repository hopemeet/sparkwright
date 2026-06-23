import {
  PROTOCOL_VERSION,
  getRunFailure,
  isEvent,
  isResponse,
  type EventKind,
  type HostEvent,
  type HostMessage,
  type HostRequest,
  type ProtocolError,
  type RequestKind,
  type ResponseResults,
  type RunInputPayload,
  type RunResumeRequestPayload,
  type RunStartRequestPayload,
  type SessionCompactRequestPayload,
  type SessionInspectRequestPayload,
  type CapabilityInspectRequestPayload,
} from "@sparkwright/protocol";
import { TypedEmitter } from "./emitter.js";
import type { ClientTransport } from "./transport.js";

export interface CreateClientInternalOptions {
  transport: ClientTransport;
  /** Identifies this client in the handshake. */
  client: { name: string; version: string };
  /** Optional capability strings advertised to the host. */
  capabilities?: string[];
  /** Default 120_000 ms. */
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: ProtocolError) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Typed event map. Use client.on('run.event', handler).
 *
 * `disconnect` is synthetic — fired when the transport closes, so UI
 * layers can show a banner without subscribing to every event kind.
 */
export type ClientEventMap = {
  "host.ready": [HostEvent & { kind: "host.ready" }];
  "host.log": [HostEvent & { kind: "host.log" }];
  "run.event": [HostEvent & { kind: "run.event" }];
  "approval.requested": [HostEvent & { kind: "approval.requested" }];
  "run.continuation": [HostEvent & { kind: "run.continuation" }];
  "run.completed": [HostEvent & { kind: "run.completed" }];
  "run.failed": [HostEvent & { kind: "run.failed" }];
  disconnect: [string | undefined];
};

export type RunTerminalEvent =
  | (HostEvent & { kind: "run.completed" })
  | (HostEvent & { kind: "run.failed" });

export interface StartRunAndCollectOptions {
  /** Default: false, because provider chunk boundaries are not stable. */
  includeStreamChunks?: boolean;
  /** Default: the client's request timeout. */
  terminalTimeoutMs?: number;
}

export interface CollectedRun {
  runId: string;
  runIds: string[];
  start: ResponseResults["run.start"];
  /** @reserved Public collected-run field consumed by SDK consumers. */
  terminal: RunTerminalEvent;
  events: HostEvent[];
  /** @reserved Public collected-run field consumed by SDK consumers. */
  runEvents: unknown[];
  /** @reserved Public collected-run field consumed by SDK consumers. */
  finalAnswer?: string;
  outcome?: unknown;
  failure?: unknown;
  toolFailures: unknown[];
  artifacts: unknown[];
  writes: unknown[];
  approvals: Array<HostEvent & { kind: "approval.requested" }>;
}

let messageCounter = 0;
function nextRequestId(): string {
  messageCounter += 1;
  return `req_${messageCounter}_${Date.now().toString(36)}`;
}

/**
 * Transport-agnostic wire-protocol client. Browser-safe (no Node deps).
 *
 * Provided to consumers via @sparkwright/sdk-node and @sparkwright/sdk-browser,
 * which each add a transport implementation and a createClient() factory.
 */
export class Client extends TypedEmitter<ClientEventMap> {
  private transport: ClientTransport;
  private pending = new Map<string, PendingRequest>();
  private closed = false;
  private requestTimeoutMs: number;
  private clientInfo: { name: string; version: string };
  private capabilities?: string[];

  constructor(opts: CreateClientInternalOptions) {
    super();
    this.transport = opts.transport;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 120_000;
    this.clientInfo = opts.client;
    this.capabilities = opts.capabilities;

    this.transport.onMessage((message) => this.handleMessage(message));
    this.transport.onClose((reason) => {
      this.closed = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject({
          code: "internal_error",
          message: `transport closed: ${reason}`,
        });
      }
      this.pending.clear();
      this.emit("disconnect", reason);
    });
  }

  /** Send the initial handshake; resolves on the host's response. */
  async handshake(): Promise<void> {
    await this.request("handshake", {
      protocolVersion: PROTOCOL_VERSION,
      client: this.clientInfo,
      capabilities: this.capabilities,
    });
  }

  startRun(
    payload: RunStartRequestPayload,
  ): Promise<ResponseResults["run.start"]> {
    return this.request(
      "run.start",
      payload as unknown as Record<string, unknown>,
    ) as Promise<ResponseResults["run.start"]>;
  }

  async startRunAndCollect(
    payload: RunStartRequestPayload,
    options: StartRunAndCollectOptions = {},
  ): Promise<CollectedRun> {
    const events: HostEvent[] = [];
    const runEvents: unknown[] = [];
    const toolFailures: unknown[] = [];
    const artifacts: unknown[] = [];
    const writes: unknown[] = [];
    const approvals: Array<HostEvent & { kind: "approval.requested" }> = [];
    const includeStreamChunks = options.includeStreamChunks ?? false;
    const terminalTimeoutMs =
      options.terminalTimeoutMs ?? this.requestTimeoutMs;
    let startedRunId: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const runIds = new Set<string>();

    let resolveTerminal!: (event: RunTerminalEvent) => void;
    let rejectTerminal!: (error: ProtocolError) => void;
    const terminal = new Promise<RunTerminalEvent>((resolve, reject) => {
      resolveTerminal = resolve;
      rejectTerminal = reject;
    });

    const shouldAcceptRunId = (runId: string): boolean =>
      !startedRunId || runIds.has(runId);
    const shouldAcceptTerminal = (event: RunTerminalEvent): boolean =>
      shouldAcceptRunId(event.payload.runId);

    const onRunEvent = (event: HostEvent & { kind: "run.event" }) => {
      if (!shouldAcceptRunId(event.payload.runId)) return;
      if (!startedRunId) runIds.add(event.payload.runId);
      const inner = event.payload.event;
      if (!includeStreamChunks && eventType(inner) === "model.stream.chunk") {
        return;
      }
      events.push(event);
      runEvents.push(inner);
      switch (eventType(inner)) {
        case "tool.failed":
          toolFailures.push(inner);
          break;
        case "artifact.created":
          artifacts.push(inner);
          break;
        case "workspace.write.completed":
          writes.push(inner);
          break;
      }
    };
    const onApproval = (event: HostEvent & { kind: "approval.requested" }) => {
      if (!shouldAcceptRunId(event.payload.runId)) return;
      events.push(event);
      approvals.push(event);
    };
    const onContinuation = (
      event: HostEvent & { kind: "run.continuation" },
    ) => {
      if (
        !shouldAcceptRunId(event.payload.previousRunId) &&
        !shouldAcceptRunId(event.payload.runId)
      ) {
        return;
      }
      runIds.add(event.payload.previousRunId);
      runIds.add(event.payload.runId);
      events.push(event);
    };
    const onCompleted = (event: HostEvent & { kind: "run.completed" }) => {
      if (!shouldAcceptTerminal(event)) return;
      events.push(event);
      resolveTerminal(event);
    };
    const onFailed = (event: HostEvent & { kind: "run.failed" }) => {
      if (!shouldAcceptTerminal(event)) return;
      events.push(event);
      resolveTerminal(event);
    };
    const onDisconnect = (reason: string | undefined) => {
      if (!startedRunId) return;
      rejectTerminal({
        code: "internal_error",
        message: `transport closed before run completed: ${reason}`,
      });
    };

    this.on("run.event", onRunEvent);
    this.on("approval.requested", onApproval);
    this.on("run.continuation", onContinuation);
    this.on("run.completed", onCompleted);
    this.on("run.failed", onFailed);
    this.on("disconnect", onDisconnect);

    try {
      const start = await this.startRun(payload);
      startedRunId = start.runId;
      runIds.add(start.runId);
      timer = setTimeout(() => {
        rejectTerminal({
          code: "internal_error",
          message: `run did not complete within ${terminalTimeoutMs}ms`,
        });
      }, terminalTimeoutMs);
      const terminalEvent = await terminal;
      if (!runIds.has(terminalEvent.payload.runId)) {
        throw {
          code: "internal_error",
          message: `received terminal event for ${terminalEvent.payload.runId}; expected one of ${[...runIds].join(", ")}`,
        } satisfies ProtocolError;
      }
      if (timer) clearTimeout(timer);
      return {
        runId: start.runId,
        runIds: [...runIds],
        start,
        terminal: terminalEvent,
        events,
        runEvents,
        finalAnswer:
          terminalEvent.kind === "run.completed"
            ? terminalEvent.payload.message
            : undefined,
        outcome:
          terminalEvent.kind === "run.completed"
            ? terminalEvent.payload.outcome
            : undefined,
        failure: getRunFailure(terminalEvent.payload),
        toolFailures,
        artifacts,
        writes,
        approvals,
      };
    } finally {
      if (timer) clearTimeout(timer);
      this.off("run.event", onRunEvent);
      this.off("approval.requested", onApproval);
      this.off("run.continuation", onContinuation);
      this.off("run.completed", onCompleted);
      this.off("run.failed", onFailed);
      this.off("disconnect", onDisconnect);
    }
  }

  resumeRun(
    payload: RunResumeRequestPayload,
  ): Promise<ResponseResults["run.resume"]> {
    return this.request(
      "run.resume",
      payload as unknown as Record<string, unknown>,
    ) as Promise<ResponseResults["run.resume"]>;
  }

  cancelRun(payload: {
    runId: string;
    reason?: string;
  }): Promise<ResponseResults["run.cancel"]> {
    return this.request("run.cancel", payload) as Promise<
      ResponseResults["run.cancel"]
    >;
  }

  injectRunMessage(payload: {
    runId: string;
    content: string;
    input?: RunInputPayload;
    metadata?: Record<string, unknown>;
  }): Promise<ResponseResults["run.inject_message"]> {
    return this.request("run.inject_message", payload) as Promise<
      ResponseResults["run.inject_message"]
    >;
  }

  resolveApproval(payload: {
    approvalId: string;
    decision: "approved" | "denied";
    message?: string;
    autoApproved?: boolean;
  }): Promise<ResponseResults["approval.resolve"]> {
    return this.request("approval.resolve", payload) as Promise<
      ResponseResults["approval.resolve"]
    >;
  }

  listSessions(
    payload: { limit?: number } = {},
  ): Promise<ResponseResults["session.list"]> {
    return this.request("session.list", payload) as Promise<
      ResponseResults["session.list"]
    >;
  }

  inspectSession(
    payload: SessionInspectRequestPayload,
  ): Promise<ResponseResults["session.inspect"]> {
    return this.request(
      "session.inspect",
      payload as unknown as Record<string, unknown>,
    ) as Promise<ResponseResults["session.inspect"]>;
  }

  forkSession(payload: {
    sourceSessionId: string;
    forkAtSequence?: number;
  }): Promise<ResponseResults["session.fork"]> {
    return this.request("session.fork", payload) as Promise<
      ResponseResults["session.fork"]
    >;
  }

  compactSession(
    payload: SessionCompactRequestPayload,
  ): Promise<ResponseResults["session.compact"]> {
    return this.request(
      "session.compact",
      payload as unknown as Record<string, unknown>,
    ) as Promise<ResponseResults["session.compact"]>;
  }

  inspectCapabilities(
    payload: CapabilityInspectRequestPayload = {},
  ): Promise<ResponseResults["capability.inspect"]> {
    return this.request(
      "capability.inspect",
      payload as unknown as Record<string, unknown>,
    ) as unknown as Promise<ResponseResults["capability.inspect"]>;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.transport.close();
  }

  private async request<K extends RequestKind>(
    kind: K,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (this.closed) {
      throw {
        code: "internal_error",
        message: "client is closed",
      } satisfies ProtocolError;
    }
    const id = nextRequestId();
    const message: HostRequest = {
      envelope: "request",
      id,
      kind,
      timestamp: new Date().toISOString(),
      payload,
    } as HostRequest;

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject({
          code: "internal_error",
          message: `request ${kind} timed out after ${this.requestTimeoutMs}ms`,
        } satisfies ProtocolError);
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send(message);
    });
  }

  private handleMessage(message: HostMessage): void {
    if (isResponse(message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return; // late response / unknown id
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(message.error);
      return;
    }
    if (isEvent(message)) {
      // EventKind is a finite enum; runtime cast is safe because of the
      // upstream isEvent guard.
      this.emit(message.kind as EventKind, message as never);
      return;
    }
    // Hosts do not send requests to clients in v1.0; ignore.
  }
}

function eventType(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  return typeof event.type === "string" ? event.type : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
