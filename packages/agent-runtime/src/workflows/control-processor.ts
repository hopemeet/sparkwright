import type { WorkflowRunRecord, WorkflowStoreEvent } from "./types.js";
import type {
  FileWorkflowStore,
  WorkflowLeaseBoundWriter,
  WorkflowRunRecordPatch,
} from "./store.js";
import {
  type FileWorkflowControlInbox,
  type WorkflowControlCommandEnvelope,
  type WorkflowControlOutcome,
} from "./control.js";

export type WorkflowControlProcessResult =
  | { status: "idle" }
  | { status: "busy"; commandId: string }
  | { status: "terminal"; outcome: WorkflowControlOutcome }
  | { status: "dispatch_required"; envelope: WorkflowControlCommandEnvelope };

export class WorkflowControlCommandProcessor {
  constructor(
    private readonly options: {
      inbox: FileWorkflowControlInbox;
      store: FileWorkflowStore;
      workspaceId: string;
      owner?: string;
      leaseTtlMs?: number;
      now?: () => Date;
      writer?: WorkflowLeaseBoundWriter;
    },
  ) {}

  async processNext(
    workflowRunId: WorkflowControlCommandEnvelope["workflowRunId"],
    commandId?: string,
  ): Promise<WorkflowControlProcessResult> {
    const pending = this.options.inbox.pending(workflowRunId);
    const envelope = commandId
      ? pending.find((candidate) => candidate.commandId === commandId)
      : pending[0];
    if (!envelope) return { status: "idle" };
    const recovered = this.findAppliedEvent(envelope);
    if (recovered) {
      return this.terminal(
        envelope,
        "applied",
        "recovered_applied",
        "Recovered outcome from the canonical workflow journal.",
      );
    }
    const rejection = this.preconditionRejection(envelope);
    if (rejection) {
      return this.terminal(
        envelope,
        "rejected",
        rejection.code,
        rejection.message,
      );
    }
    if (envelope.command.kind === "resume_request") {
      return { status: "dispatch_required", envelope };
    }

    const suppliedWriter = this.options.writer;
    const writer =
      suppliedWriter ??
      (await this.options.store.acquireWriter(workflowRunId, {
        owner: this.options.owner ?? "workflow-control-processor",
        ttlMs: this.options.leaseTtlMs,
        now: this.options.now,
      }));
    if (!writer) return { status: "busy", commandId: envelope.commandId };
    try {
      const fresh = await writer.readFresh();
      if (!fresh) {
        return this.terminal(
          envelope,
          "rejected",
          "workflow_not_found",
          "Workflow record was not found.",
        );
      }
      const postClaimRejection = commandStateRejection(envelope, fresh, {
        skipGeneration: true,
      });
      if (postClaimRejection) {
        if (this.findAppliedEvent(envelope)) {
          return this.terminal(
            envelope,
            "applied",
            "recovered_applied",
            "Recovered outcome from the canonical workflow journal.",
          );
        }
        return this.terminal(
          envelope,
          "rejected",
          postClaimRejection.code,
          postClaimRejection.message,
        );
      }
      const mutation = commandMutation(envelope, fresh);
      await writer.mutate({
        expectedRevision: fresh.recordRevision,
        patch: mutation.patch,
        event: mutation.event,
      });
      return this.terminal(
        envelope,
        "applied",
        "applied",
        "Workflow control command applied.",
      );
    } finally {
      if (!suppliedWriter) await writer.release();
    }
  }

  async completeDispatch(
    envelope: WorkflowControlCommandEnvelope,
    input: { applied: boolean; code: string; message?: string },
  ): Promise<WorkflowControlProcessResult> {
    return this.terminal(
      envelope,
      input.applied ? "applied" : "rejected",
      input.code,
      input.message,
    );
  }

  private preconditionRejection(
    envelope: WorkflowControlCommandEnvelope,
  ): { code: string; message: string } | undefined {
    const now = (this.options.now?.() ?? new Date()).getTime();
    if (Date.parse(envelope.expiresAt) <= now)
      return { code: "expired", message: "Workflow control command expired." };
    if (envelope.authorization.workspaceId !== this.options.workspaceId)
      return {
        code: "unauthorized_workspace",
        message: "Workflow control workspace scope does not match.",
      };
    const record = this.options.store.get(envelope.workflowRunId);
    if (!record)
      return {
        code: "workflow_not_found",
        message: "Workflow record was not found.",
      };
    if (
      envelope.authorization.sessionId &&
      envelope.authorization.sessionId !== record.sessionId
    )
      return {
        code: "unauthorized_session",
        message: "Workflow control session scope does not match.",
      };
    if (
      this.options.store.canonicalGeneration(envelope.workflowRunId) !==
      envelope.expected.generation
    )
      return {
        code: "stale_generation",
        message: "Workflow generation changed.",
      };
    return commandStateRejection(envelope, record, { skipGeneration: true });
  }

  private findAppliedEvent(
    envelope: WorkflowControlCommandEnvelope,
  ): WorkflowStoreEvent | undefined {
    return this.options.store
      .eventLog(envelope.workflowRunId)
      .events.find(
        (event) => event.metadata?.controlCommandId === envelope.commandId,
      );
  }

  private async terminal(
    envelope: WorkflowControlCommandEnvelope,
    status: WorkflowControlOutcome["status"],
    code: string,
    message?: string,
  ): Promise<WorkflowControlProcessResult> {
    const outcome = await this.options.inbox.recordOutcome({
      schemaVersion: "sparkwright-workflow-control-outcome.v1",
      workflowRunId: envelope.workflowRunId,
      commandId: envelope.commandId,
      status,
      code,
      ...(message ? { message } : {}),
      completedAt: (this.options.now?.() ?? new Date()).toISOString(),
    });
    return { status: "terminal", outcome };
  }
}

function commandStateRejection(
  envelope: WorkflowControlCommandEnvelope,
  record: WorkflowRunRecord,
  options: { skipGeneration?: boolean } = {},
): { code: string; message: string } | undefined {
  if (
    !options.skipGeneration &&
    record.generation !== envelope.expected.generation
  )
    return {
      code: "stale_generation",
      message: "Workflow generation changed.",
    };
  if (envelope.expected.status && record.status !== envelope.expected.status)
    return { code: "state_mismatch", message: "Workflow status changed." };
  if (envelope.expected.waitId && record.wait?.id !== envelope.expected.waitId)
    return { code: "wait_mismatch", message: "Workflow wait changed." };
  if (envelope.command.kind === "provide_input") {
    if (record.status !== "waiting" || record.wait?.kind !== "input")
      return {
        code: "state_mismatch",
        message: "Workflow is not waiting for input.",
      };
    if (record.wait.id !== envelope.command.waitId)
      return { code: "wait_mismatch", message: "Workflow input wait changed." };
    if (record.metadata.pendingWorkflowControlInput)
      return {
        code: "already_resolved",
        message: "Workflow input is already resolved.",
      };
  }
  if (envelope.command.kind === "approval_response") {
    if (record.status !== "waiting" || record.wait?.kind !== "approval")
      return {
        code: "state_mismatch",
        message: "Workflow is not waiting for approval.",
      };
    if (record.wait.approvalId !== envelope.command.approvalId)
      return {
        code: "approval_mismatch",
        message: "Workflow approval changed.",
      };
    if (!record.authorizationSnapshot)
      return {
        code: "approval_authorization_missing",
        message: "Workflow approval authorization snapshot is missing.",
      };
  }
  if (
    envelope.command.kind === "cancel" &&
    (record.status === "completed" ||
      record.status === "failed" ||
      record.status === "cancelled")
  )
    return {
      code: "already_terminal",
      message: `Workflow is already ${record.status}.`,
    };
  return undefined;
}

function commandMutation(
  envelope: WorkflowControlCommandEnvelope,
  record: WorkflowRunRecord,
): {
  patch: WorkflowRunRecordPatch;
  event: WorkflowStoreEvent;
} {
  const at = new Date().toISOString();
  const audit = {
    controlCommandId: envelope.commandId,
    controlSource: envelope.source,
    controlIdempotencyKey: envelope.idempotencyKey,
  };
  if (envelope.command.kind === "cancel") {
    return {
      patch: {
        status: "cancelled",
        failure: {
          kind: "cancelled",
          code: "workflow.cancelled",
          message: envelope.command.reason ?? "cancelled_by_control_command",
        },
        metadata: audit,
      },
      event: {
        at,
        type: "cancelled",
        workflowRunId: record.id,
        parentRunId: record.parentRunId,
        status: "cancelled",
        metadata: audit,
      },
    };
  }
  if (envelope.command.kind === "provide_input") {
    return {
      patch: {
        metadata: {
          ...audit,
          pendingWorkflowControlInput: {
            commandId: envelope.commandId,
            waitId: envelope.command.waitId,
            value: envelope.command.value,
            source: envelope.source,
          },
        },
      },
      event: {
        at,
        type: "input",
        workflowRunId: record.id,
        parentRunId: record.parentRunId,
        status: record.status,
        metadata: audit,
      },
    };
  }
  if (envelope.command.kind === "approval_response") {
    return {
      patch: {
        status: envelope.command.decision === "approved" ? "running" : "failed",
        clearWait: true,
        ...(envelope.command.decision === "denied"
          ? {
              failure: {
                kind: "cancelled" as const,
                code: "workflow.approval_denied",
                message:
                  envelope.command.message ?? "Workflow approval denied.",
              },
            }
          : {}),
        metadata: { ...audit, workflowApprovalDecision: envelope.command },
      },
      event: {
        at,
        type: envelope.command.decision === "approved" ? "updated" : "failed",
        workflowRunId: record.id,
        parentRunId: record.parentRunId,
        status: envelope.command.decision === "approved" ? "running" : "failed",
        metadata: { ...audit, approvalId: envelope.command.approvalId },
      },
    };
  }
  throw new Error("resume_request requires an external dispatcher");
}
