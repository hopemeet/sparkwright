import {
  PROTOCOL_VERSION,
  isEvent,
  isResponse,
  type EventKind,
  type HostEvent,
  type HostMessage,
  type HostRequest,
  type ProtocolError,
  type RequestKind,
  type ResponseResults,
  type RunStartRequestPayload,
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

  inspectSession(payload: {
    sessionId: string;
  }): Promise<ResponseResults["session.inspect"]> {
    return this.request("session.inspect", payload) as Promise<
      ResponseResults["session.inspect"]
    >;
  }

  forkSession(payload: {
    sourceSessionId: string;
    forkAtSequence?: number;
  }): Promise<ResponseResults["session.fork"]> {
    return this.request("session.fork", payload) as Promise<
      ResponseResults["session.fork"]
    >;
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
