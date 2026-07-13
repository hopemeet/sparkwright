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
    return this.terminate("subagent.completed", {
      ...payload,
      terminalState: payload.terminalState ?? "completed",
      finality: payload.finality ?? "complete",
    });
  }

  failed(payload: Record<string, unknown> = {}): boolean {
    return this.terminate("subagent.failed", {
      ...payload,
      terminalState: payload.terminalState ?? "failed",
      finality: payload.finality ?? "partial",
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
