import { createId, type ContentPart, type RunHandle } from "@sparkwright/core";
import type { MemoryTrace } from "@sparkwright/core/internal";
import type { WorkflowRunId } from "@sparkwright/agent-runtime";
import {
  runTodoSupervised,
  type RunTodoSupervisedOptions,
  type TodoSupervisedRunResult,
} from "@sparkwright/agent-runtime";

export interface HostExecutionActiveRun {
  runId: string;
  run: RunHandle;
  trace: MemoryTrace;
  sessionId: string;
  closeCapabilities?: () => Promise<void>;
  workflowRunId?: WorkflowRunId;
  processWorkflowControls?: () => Promise<void>;
}

export interface HostExecutionTerminal {
  executionId: string;
  sessionId?: string;
  rootRunId?: string;
  /** @reserved Public execution terminal alias consumed by future control surfaces. */
  finalRunId?: string;
  state: "completed" | "failed" | "cancelled";
}

interface PendingExecutionApproval {
  approvalId: string;
  runId: string;
  resolve: (response: {
    decision: "approved" | "denied";
    message?: string;
    autoApproved?: boolean;
  }) => void;
}

/**
 * Lifecycle owner for one interactive Host execution. A Core run is only one
 * episode: aliases, cancellation, approvals, resources, and completion span
 * the entire episode chain.
 */
export class HostExecution {
  readonly executionId: string;
  readonly abortController: AbortController;
  readonly completion: Promise<HostExecutionTerminal>;

  private sessionIdValue?: string;
  private rootRunIdValue?: string;
  private finalRunIdValue?: string;
  private activeRunValue: HostExecutionActiveRun | null = null;
  private readonly runIds = new Set<string>();
  private readonly pendingApprovals = new Map<
    string,
    PendingExecutionApproval
  >();
  private readonly closedResources = new Set<() => Promise<void>>();
  private readonly cleanupHooks: Array<() => void | Promise<void>> = [];
  private resourcesCompletion?: Promise<void>;
  private resolveCompletion!: (terminal: HostExecutionTerminal) => void;
  private terminal?: HostExecutionTerminal;

  constructor(
    options: { abortController?: AbortController; executionId?: string } = {},
  ) {
    this.executionId = options.executionId ?? (createId("execution") as string);
    this.abortController = options.abortController ?? new AbortController();
    this.completion = new Promise((resolve) => {
      this.resolveCompletion = resolve;
    });
  }

  get sessionId(): string | undefined {
    return this.sessionIdValue;
  }

  get rootRunId(): string | undefined {
    return this.rootRunIdValue;
  }

  currentRunId(): string | undefined {
    return this.activeRunValue?.runId;
  }

  get activeRun(): HostExecutionActiveRun | null {
    return this.activeRunValue;
  }

  bindSession(sessionId: string): void {
    if (this.sessionIdValue && this.sessionIdValue !== sessionId) {
      throw new Error(
        `Execution ${this.executionId} is already bound to session ${this.sessionIdValue}.`,
      );
    }
    this.sessionIdValue = sessionId;
  }

  attachRun(active: HostExecutionActiveRun): void {
    this.bindSession(active.sessionId);
    this.activeRunValue = active;
    this.rootRunIdValue ??= active.runId;
    this.finalRunIdValue = active.runId;
    this.runIds.add(active.runId);
  }

  runEpisodeChain(
    options: RunTodoSupervisedOptions,
  ): Promise<TodoSupervisedRunResult> {
    return runTodoSupervised({
      ...options,
      runOnce: async (input) => {
        if (this.abortController.signal.aborted) {
          throw Object.assign(new Error("Interactive execution cancelled."), {
            name: "AbortError",
          });
        }
        return options.runOnce(input);
      },
    });
  }

  ownsRun(runId: string): boolean {
    return this.runIds.has(runId);
  }

  runIdAliases(): readonly string[] {
    return [...this.runIds];
  }

  tryInject(
    runId: string,
    input: {
      content: string;
      parts?: ContentPart[];
      metadata?: Record<string, unknown>;
    },
  ): "accepted" | "closed" | "not_found" {
    const active = this.activeRunValue;
    if (!active || (!this.runIds.has(runId) && active.runId !== runId)) {
      return "not_found";
    }
    const acceptance = active.run.tryEnqueueCommand({
      type: "user_message",
      content: input.content,
      parts: input.parts,
      metadata: input.metadata,
    });
    return acceptance.accepted ? "accepted" : "closed";
  }

  cancel(reason = "client requested cancel"): boolean {
    if (this.terminal) return false;
    if (!this.abortController.signal.aborted) {
      this.abortController.abort(reason);
    }
    this.activeRunValue?.run.cancel({ reason });
    return true;
  }

  addApproval(input: PendingExecutionApproval): void {
    this.pendingApprovals.set(input.approvalId, input);
  }

  resolveApproval(
    approvalId: string,
    response: {
      decision: "approved" | "denied";
      message?: string;
      autoApproved?: boolean;
    },
  ): boolean {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return false;
    this.pendingApprovals.delete(approvalId);
    pending.resolve(response);
    return true;
  }

  denyPendingApprovals(): void {
    for (const pending of this.pendingApprovals.values()) {
      pending.resolve({ decision: "denied" });
    }
    this.pendingApprovals.clear();
  }

  async closeActiveCapabilities(): Promise<void> {
    const close = this.activeRunValue?.closeCapabilities;
    if (!close || this.closedResources.has(close)) return;
    this.closedResources.add(close);
    await close();
  }

  addCleanup(cleanup: () => void | Promise<void>): void {
    if (this.resourcesCompletion) {
      void Promise.resolve(cleanup()).catch(() => {});
      return;
    }
    this.cleanupHooks.push(cleanup);
  }

  disposeResources(): Promise<void> {
    this.resourcesCompletion ??= (async () => {
      for (const cleanup of this.cleanupHooks.splice(0).reverse()) {
        await cleanup();
      }
    })();
    return this.resourcesCompletion;
  }

  detachRun(): void {
    this.activeRunValue = null;
  }

  finish(state: HostExecutionTerminal["state"]): HostExecutionTerminal {
    if (this.terminal) return this.terminal;
    const terminal: HostExecutionTerminal = {
      executionId: this.executionId,
      ...(this.sessionIdValue ? { sessionId: this.sessionIdValue } : {}),
      ...(this.rootRunIdValue ? { rootRunId: this.rootRunIdValue } : {}),
      ...(this.finalRunIdValue ? { finalRunId: this.finalRunIdValue } : {}),
      state,
    };
    this.terminal = terminal;
    this.denyPendingApprovals();
    this.resolveCompletion(terminal);
    return terminal;
  }

  cleanup(reason = "client_disconnected"): void {
    this.cancel(reason);
    this.denyPendingApprovals();
    void this.disposeResources().catch(() => {});
    this.detachRun();
  }
}
