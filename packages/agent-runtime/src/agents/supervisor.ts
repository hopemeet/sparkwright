import type { EventEmitter } from "@sparkwright/core";
import {
  agentInvocationEventBase,
  agentInvocationMetadata,
  type PreparedAgentInvocation,
} from "./invocation.js";

export type AgentSupervisorState =
  | "admission_pending"
  | "admitted"
  | "running"
  | "terminal";

export interface AgentSupervisor {
  readonly invocation: PreparedAgentInvocation;
  readonly state: AgentSupervisorState;
  readonly terminal: boolean;
  requested(payload?: Record<string, unknown>): boolean;
  admit(): boolean;
  started(payload?: Record<string, unknown>): boolean;
  completed(payload?: Record<string, unknown>): boolean;
  failed(payload?: Record<string, unknown>): boolean;
}

export function createAgentSupervisor(input: {
  invocation: PreparedAgentInvocation;
  emitter: EventEmitter;
}): AgentSupervisor {
  return new DefaultAgentSupervisor(input.invocation, input.emitter);
}

class DefaultAgentSupervisor implements AgentSupervisor {
  readonly invocation: PreparedAgentInvocation;
  #state: AgentSupervisorState = "admission_pending";
  #requested = false;

  constructor(
    invocation: PreparedAgentInvocation,
    private readonly emitter: EventEmitter,
  ) {
    this.invocation = invocation;
  }

  get state(): AgentSupervisorState {
    return this.#state;
  }

  get terminal(): boolean {
    return this.#state === "terminal";
  }

  requested(payload: Record<string, unknown> = {}): boolean {
    if (this.#requested || this.terminal) return false;
    this.#requested = true;
    this.emit("subagent.requested", payload);
    return true;
  }

  admit(): boolean {
    this.assertRequested("admit");
    if (this.terminal || this.#state !== "admission_pending") return false;
    this.#state = "admitted";
    return true;
  }

  started(payload: Record<string, unknown> = {}): boolean {
    this.assertRequested("start");
    if (this.terminal || this.#state === "running") return false;
    if (this.#state !== "admitted") {
      throw new Error(
        "AgentSupervisor cannot emit started before invocation admission.",
      );
    }
    this.#state = "running";
    this.emit("subagent.started", payload);
    return true;
  }

  completed(payload: Record<string, unknown> = {}): boolean {
    this.assertRequested("complete");
    if (!this.terminal && this.#state !== "running") {
      throw new Error(
        "AgentSupervisor cannot emit completed before invocation started.",
      );
    }
    const status =
      payload.status === "blocked" || payload.status === "partial"
        ? payload.status
        : payload.terminalState === "blocked"
          ? "blocked"
          : "completed";
    return this.terminate("subagent.completed", {
      ...payload,
      terminalState: payload.terminalState ?? "completed",
      status,
      summary: payload.summary ?? adapterSummary(payload, status),
      blockers:
        payload.blockers ??
        (status === "blocked" ? [adapterBlockedOutcome(payload)] : []),
    });
  }

  failed(payload: Record<string, unknown> = {}): boolean {
    const status =
      payload.status === "blocked" || payload.terminalState === "blocked"
        ? "blocked"
        : "partial";
    return this.terminate("subagent.failed", {
      ...payload,
      terminalState: payload.terminalState ?? "failed",
      status: payload.status ?? status,
      summary:
        payload.summary ??
        adapterSummary(payload, status, "Agent execution failed."),
      blockers: payload.blockers ?? [adapterFailedOutcome(payload, status)],
    });
  }

  private terminate(
    type: "subagent.completed" | "subagent.failed",
    payload: Record<string, unknown>,
  ): boolean {
    this.assertRequested("terminate");
    if (this.terminal) return false;
    this.#state = "terminal";
    this.emit(type, payload);
    return true;
  }

  private emit(type: string, payload: Record<string, unknown>): void {
    this.emitter.emit(
      type as never,
      { ...agentInvocationEventBase(this.invocation), ...payload },
      agentInvocationMetadata(this.invocation),
    );
  }

  private assertRequested(action: string): void {
    if (!this.#requested) {
      throw new Error(
        `AgentSupervisor cannot ${action} before requested lifecycle emission.`,
      );
    }
  }
}

function adapterSummary(
  payload: Record<string, unknown>,
  status: "completed" | "partial" | "blocked",
  fallback?: string,
): string {
  if (typeof payload.message === "string" && payload.message.trim()) {
    return payload.message.trim();
  }
  if (fallback) return fallback;
  if (status === "blocked") return "Agent adapter reported a blocked outcome.";
  if (status === "partial") return "Agent adapter returned a partial outcome.";
  return "Agent adapter completed successfully.";
}

function adapterBlockedOutcome(payload: Record<string, unknown>) {
  return {
    code:
      typeof payload.errorCode === "string"
        ? payload.errorCode
        : "AGENT_ADAPTER_BLOCKED",
    message: adapterSummary(payload, "blocked"),
  };
}

function adapterFailedOutcome(
  payload: Record<string, unknown>,
  status: "partial" | "blocked",
) {
  return {
    code:
      typeof payload.errorCode === "string"
        ? payload.errorCode
        : "AGENT_ADAPTER_FAILED",
    message: adapterSummary(payload, status, "Agent execution failed."),
  };
}
