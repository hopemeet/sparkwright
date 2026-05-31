import {
  createClient,
  type HostEvent,
  type RunStartRequestPayload,
} from "@sparkwright/sdk-node";

export interface SparkwrightBridgeOptions {
  hostUrl?: string;
  requestTimeoutMs?: number;
}

export interface ActiveBridgeRun {
  runId: string;
  injectMessage(input: {
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  resolveApproval(input: {
    approvalId: string;
    decision: "approved" | "denied";
    message?: string;
  }): Promise<void>;
  cancel(reason?: string): Promise<void>;
  close(): void;
}

export class SparkwrightBridge {
  constructor(private readonly options: SparkwrightBridgeOptions = {}) {}

  async startRun(
    payload: RunStartRequestPayload,
    handlers: {
      onEvent(event: HostEvent): Promise<void> | void;
      onTerminal(event: HostEvent): Promise<void> | void;
    },
  ): Promise<ActiveBridgeRun> {
    const client = await createClient({
      url: this.options.hostUrl,
      requestTimeoutMs: this.options.requestTimeoutMs,
      client: { name: "sparkwright-im-gateway", version: "0.1.0" },
      capabilities: ["im-gateway", "approvals", "sessions"],
    });

    const started = await client.startRun(payload);
    const runId = started.runId;
    const terminalKinds = new Set(["run.completed", "run.failed"]);

    client.on("run.event", (event) => void handlers.onEvent(event));
    client.on("approval.requested", (event) => void handlers.onEvent(event));
    client.on("run.completed", (event) => {
      void handlers.onEvent(event);
      void handlers.onTerminal(event);
    });
    client.on("run.failed", (event) => {
      void handlers.onEvent(event);
      void handlers.onTerminal(event);
    });
    client.on("disconnect", () => {
      // A disconnect may happen after normal close; terminal handlers are
      // driven by explicit host events so there is nothing to synthesize here.
      void terminalKinds;
    });

    return {
      runId,
      injectMessage: async (input) => {
        await client.injectRunMessage({ runId, ...input });
      },
      resolveApproval: async (input) => {
        await client.resolveApproval(input);
      },
      cancel: async (reason) => {
        await client.cancelRun({ runId, reason });
      },
      close: () => client.close(),
    };
  }
}
