import { type ContentPart, type InteractionChannel } from "@sparkwright/core";
import type {
  HostEvent,
  ProtocolError,
  RunInputPart,
} from "@sparkwright/protocol";
import type { ExecutionHandle } from "@sparkwright/server-runtime";
import { nextMessageId, nowIso } from "../connection.js";
import type { HostExecution } from "../host-execution.js";
import type {
  HostExecutionIdentity,
  HostExecutionMessage,
} from "./contracts.js";

export interface CurrentHostExecutionPort {
  current(): HostExecution | null;
}

export interface ExecutionInteractionOperationsOptions {
  execution: CurrentHostExecutionPort;
  emit: (event: HostEvent) => void;
  approvalTimeoutMs?: number;
}

/** Canonical protocol input-part projection shared by start and inject paths. */
export function contentPartsFromRunInput(
  parts: readonly RunInputPart[] | undefined,
): ContentPart[] {
  if (!parts || parts.length === 0) return [];
  const out: ContentPart[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      if (part.text.length > 0) {
        out.push({
          type: "text",
          text: part.text,
          ...(part.metadata ? { metadata: part.metadata } : {}),
        });
      }
      continue;
    }
    if (!part.data && !part.uri) continue;
    out.push({
      type: part.type,
      ...(part.data ? { data: part.data } : {}),
      ...(part.uri ? { uri: part.uri } : {}),
      ...(part.mediaType ? { mediaType: part.mediaType } : {}),
      ...(part.name ? { name: part.name } : {}),
      ...(part.metadata ? { metadata: part.metadata } : {}),
    });
  }
  return out;
}

/**
 * Host interaction/control routing over the single caller-owned HostExecution.
 * This owner never creates, replaces, or mirrors live execution state.
 */
export class ExecutionInteractionOperations {
  constructor(
    private readonly options: ExecutionInteractionOperationsOptions,
  ) {}

  hasActiveRun(): boolean {
    return this.options.execution.current()?.activeRun != null;
  }

  executionIdentity(): HostExecutionIdentity | undefined {
    const execution = this.options.execution.current();
    return execution
      ? {
          executionId: execution.executionId,
          ...(execution.sessionId ? { sessionId: execution.sessionId } : {}),
          ...(execution.currentRunId()
            ? { currentRunId: execution.currentRunId() }
            : {}),
          runIds: execution.runIdAliases(),
        }
      : undefined;
  }

  executionDriverHandle(
    executionId: string,
  ): ExecutionHandle<HostExecutionMessage, unknown> | undefined {
    const execution = this.options.execution.current();
    if (
      !execution ||
      execution.executionId !== executionId ||
      !execution.rootRunId
    ) {
      return undefined;
    }
    return {
      rootRunId: execution.rootRunId,
      currentRunId: () => execution.currentRunId() ?? execution.rootRunId!,
      tryInject: (message) =>
        this.acceptExecutionMessage(message.runId, message).ok
          ? "accepted"
          : "closed",
      cancel: (reason) => {
        execution.cancel(reason);
      },
      completion: execution.completion,
    };
  }

  createInteractionChannel(runIdHolder: {
    value: string | null;
  }): InteractionChannel {
    return {
      approve: (request) =>
        new Promise((resolve) => {
          const approvalId = request.id;
          const currentRunId = runIdHolder.value;
          if (!currentRunId) {
            resolve({ approvalId, decision: "denied" });
            return;
          }
          const execution = this.options.execution.current();
          if (!execution) {
            resolve({ approvalId, decision: "denied" });
            return;
          }
          const timeout = setTimeout(() => {
            execution.resolveApproval(approvalId, {
              decision: "denied",
              message: "Approval timed out.",
            });
          }, this.options.approvalTimeoutMs ?? 300_000);
          timeout.unref?.();
          execution.addApproval({
            approvalId,
            runId: currentRunId,
            resolve: (response) => {
              clearTimeout(timeout);
              resolve({ approvalId, ...response });
            },
          });
          const details = request.details as { path?: unknown } | undefined;
          this.options.emit({
            envelope: "event",
            id: nextMessageId("evt"),
            kind: "approval.requested",
            timestamp: nowIso(),
            payload: {
              runId: currentRunId,
              approvalId,
              action: request.action,
              summary: request.summary,
              details: {
                ...(typeof details?.path === "string"
                  ? { path: details.path }
                  : {}),
                ...(request.details ?? {}),
              },
            },
          });
        }),
    };
  }

  resolveApproval(
    approvalId: string,
    decision: "approved" | "denied",
    message?: string,
    autoApproved?: boolean,
  ): { ok: true } | { ok: false; error: ProtocolError } {
    const resolved = this.options.execution
      .current()
      ?.resolveApproval(approvalId, {
        decision,
        ...(message !== undefined ? { message } : {}),
        ...(autoApproved !== undefined ? { autoApproved } : {}),
      });
    if (!resolved) {
      return {
        ok: false,
        error: {
          code: "approval_not_found",
          message: `no pending approval with id ${approvalId}`,
        },
      };
    }
    return { ok: true };
  }

  cleanup(reason = "client_disconnected"): void {
    this.options.execution.current()?.cleanup(reason);
  }

  async drain(reason = "host_service_drain"): Promise<void> {
    const execution = this.options.execution.current();
    if (!execution) return;
    execution.cleanup(reason);
    await execution.completion;
    await execution.disposeResources();
  }

  private acceptExecutionMessage(
    runId: string,
    input: {
      content: string;
      parts?: readonly RunInputPart[];
      metadata?: Record<string, unknown>;
    },
  ): { ok: true } | { ok: false; error: ProtocolError } {
    const execution = this.options.execution.current();
    if (!execution?.ownsRun(runId)) {
      return {
        ok: false,
        error: {
          code: "run_not_found",
          message: `no active run with id ${runId}`,
        },
      };
    }
    if (!input.content.trim()) {
      return {
        ok: false,
        error: {
          code: "invalid_payload",
          message: "content must not be empty",
        },
      };
    }
    const acceptance = execution.tryInject(runId, {
      content: input.content,
      parts: contentPartsFromRunInput(input.parts),
      metadata: input.metadata,
    });
    if (acceptance !== "accepted") {
      return {
        ok: false,
        error: {
          code: "run_not_found",
          message: `run ${runId} is no longer accepting messages (${acceptance})`,
        },
      };
    }
    return { ok: true };
  }
}
