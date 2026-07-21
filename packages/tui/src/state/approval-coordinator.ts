import type { Client } from "@sparkwright/sdk-node";
import { resolveHostClientApprovalByPolicy } from "@sparkwright/host";
import type { HostEvent, RunAccessMode } from "@sparkwright/protocol";
import {
  approvalSubject,
  sessionApprovalRule,
  type ApprovalChoice,
  type SessionApprovalRule,
} from "../lib/session-approval.js";
import {
  summarizeApprovalDiff,
  type ApprovalKind,
  type ApprovalRisk,
  type ApprovalViewModel,
} from "../lib/approval-view-model.js";
import { presentationPolicy, type UiSignalSink } from "../lib/ui-signal.js";

export interface ApprovalExecutionOrigin {
  readonly client: Client;
  readonly sessionId: string;
  readonly accessMode: RunAccessMode;
  readonly kind: "main" | "workflow";
  readonly workflowRunId?: string;
}

export interface ApprovalExecutionContext extends ApprovalExecutionOrigin {
  readonly runId: string;
}

interface ApprovalContext {
  execution: ApprovalExecutionContext;
  view: ApprovalViewModel;
}

export interface ApprovalCoordinatorOptions {
  workspaceRoot: string;
  setView(view: ApprovalViewModel | null): void;
  appendAudit(message: string): void;
  signals?: UiSignalSink;
}

/**
 * Owns all TUI approval coordination while leaving policy truth with Host.
 * Host clients and exact execution origins never cross the view-model seam.
 */
export class ApprovalCoordinator {
  private readonly options: ApprovalCoordinatorOptions;
  private readonly origins = new Map<Client, ApprovalExecutionOrigin>();
  private readonly rules = new Map<string, Map<string, SessionApprovalRule>>();
  private active: ApprovalContext | null = null;
  private queue: ApprovalContext[] = [];

  constructor(options: ApprovalCoordinatorOptions) {
    this.options = options;
  }

  registerExecution(origin: ApprovalExecutionOrigin): ApprovalExecutionOrigin {
    const immutable = Object.freeze({ ...origin });
    this.origins.set(origin.client, immutable);
    return immutable;
  }

  contextFor(client: Client, runId: string): ApprovalExecutionContext {
    const origin = this.origins.get(client);
    if (!origin) {
      throw new Error(
        `approval for ${runId} arrived without an immutable execution origin`,
      );
    }
    return Object.freeze({ ...origin, runId });
  }

  handleRequested(
    execution: ApprovalExecutionContext,
    event: HostEvent & { kind: "approval.requested" },
  ): void {
    const registrationAtRequest = this.origins.get(execution.client);
    const exactExecution = Object.freeze({
      ...execution,
      runId: event.payload.runId,
    });
    const details = recordValue(event.payload.details);
    const policyDecision = resolveHostClientApprovalByPolicy(
      { accessMode: exactExecution.accessMode },
      {
        approvalId: event.payload.approvalId,
        runId: event.payload.runId,
        action: event.payload.action,
        summary: event.payload.summary,
        details,
        createdAt: event.timestamp,
      },
    );
    if (policyDecision) {
      void exactExecution.client
        .resolveApproval(policyDecision)
        .catch((error) =>
          this.reportFailure(
            "automatic approval failed",
            formatError(error),
            `approval:${event.payload.approvalId}:auto-policy`,
          ),
        );
      return;
    }

    const subject = approvalSubject(
      { action: event.payload.action, details },
      this.options.workspaceRoot,
    );
    const context: ApprovalContext = {
      execution: exactExecution,
      view: projectApprovalView(event, exactExecution, subject),
    };
    if (subject.kind !== "unknown") {
      const rule = this.rules.get(exactExecution.sessionId)?.get(subject.key);
      if (rule) {
        void this.autoApproveByRule(
          exactExecution,
          event.payload.approvalId,
          rule,
        ).then((approved) => {
          if (!approved) {
            if (
              registrationAtRequest &&
              this.origins.get(exactExecution.client) !== registrationAtRequest
            ) {
              return;
            }
            context.view = {
              ...context.view,
              error:
                "Session auto-approval failed; review this request manually.",
            };
            this.enqueue(context);
          }
        });
        return;
      }
    }
    this.enqueue(context);
  }

  async resolve(choice: ApprovalChoice): Promise<void> {
    const context = this.active;
    if (!context || context.view.resolving) return;
    const rule =
      choice === "allow-session"
        ? sessionApprovalRule(context.view.subject)
        : undefined;
    context.view = {
      ...context.view,
      resolving: true,
      submittedChoice: choice,
      error: undefined,
    };
    this.projectActive();
    try {
      await context.execution.client.resolveApproval({
        approvalId: context.view.approvalId,
        decision: choice === "deny" ? "denied" : "approved",
        ...(rule
          ? { message: "Approved and remembered for this session." }
          : {}),
      });
      if (rule) {
        this.rulesForSession(context.execution.sessionId).set(rule.key, rule);
        this.options.appendAudit(`approval remembered: ${rule.label}`);
      }
      if (this.active === context) {
        this.active = null;
        this.options.setView(null);
        this.advance();
      }
    } catch (error) {
      if (this.active === context) {
        context.view = {
          ...context.view,
          resolving: false,
          submittedChoice: undefined,
          error: formatError(error),
        };
        this.projectActive();
      }
    }
  }

  listRules(sessionId: string): readonly SessionApprovalRule[] {
    return [...(this.rules.get(sessionId)?.values() ?? [])];
  }

  clearRules(sessionId: string): number {
    const count = this.rules.get(sessionId)?.size ?? 0;
    this.rules.delete(sessionId);
    return count;
  }

  cleanupExecution(client: Client): void {
    this.origins.delete(client);
    const removedActive = this.active?.execution.client === client;
    if (removedActive) {
      this.active = null;
      this.options.setView(null);
    }
    this.queue = this.queue.filter(
      (context) => context.execution.client !== client,
    );
    if (removedActive) this.advance();
    else this.projectActive();
  }

  private async autoApproveByRule(
    execution: ApprovalExecutionContext,
    approvalId: string,
    rule: SessionApprovalRule,
  ): Promise<boolean> {
    try {
      await execution.client.resolveApproval({
        approvalId,
        decision: "approved",
        message: "Auto-approved by a TUI session rule.",
        autoApproved: true,
      });
      this.options.appendAudit(`auto-approved: ${rule.label}`);
      return true;
    } catch (error) {
      this.reportFailure(
        "session auto-approval failed",
        formatError(error),
        `approval:${approvalId}:session-rule`,
      );
      return false;
    }
  }

  private advance(): void {
    const next = this.queue.shift() ?? null;
    this.active = next;
    if (!next) {
      this.options.setView(null);
      return;
    }
    const subject = next.view.subject;
    const rule =
      subject.kind === "unknown"
        ? undefined
        : this.rules.get(next.execution.sessionId)?.get(subject.key);
    if (!rule) {
      this.projectActive();
      return;
    }
    void this.autoApproveByRule(
      next.execution,
      next.view.approvalId,
      rule,
    ).then((approved) => {
      if (this.active !== next) return;
      if (!approved) {
        next.view = {
          ...next.view,
          error: "Session auto-approval failed; review this request manually.",
        };
        this.projectActive();
        return;
      }
      this.active = null;
      this.advance();
    });
  }

  private enqueue(context: ApprovalContext): void {
    if (this.active) this.queue.push(context);
    else this.active = context;
    this.projectActive();
  }

  private projectActive(): void {
    if (!this.active) return;
    this.active.view = {
      ...this.active.view,
      queuePosition: 1,
      queueDepth: 1 + this.queue.length,
    };
    this.options.setView(this.active.view);
  }

  private rulesForSession(sessionId: string): Map<string, SessionApprovalRule> {
    let sessionRules = this.rules.get(sessionId);
    if (!sessionRules) {
      sessionRules = new Map();
      this.rules.set(sessionId, sessionRules);
    }
    return sessionRules;
  }

  private reportFailure(
    title: string,
    message: string,
    dedupeKey: string,
  ): void {
    const kind = "error" as const;
    const scope = "ActionFailure" as const;
    const policy = presentationPolicy({ kind, scope });
    this.options.signals?.publish({
      kind,
      scope,
      source: "tui.approval",
      title,
      message,
      dedupeKey,
      ...policy,
    });
  }
}

function projectApprovalView(
  event: HostEvent & { kind: "approval.requested" },
  execution: ApprovalExecutionContext,
  subject: ReturnType<typeof approvalSubject>,
): ApprovalViewModel {
  const details = recordValue(event.payload.details);
  const args =
    maybeRecord(details.arguments) ??
    maybeRecord(details.args) ??
    maybeRecord(details.toolArgs);
  const toolName = stringValue(details.toolName) ?? stringValue(details.name);
  const command = stringValue(args?.command) ?? stringValue(details.command);
  const cwd = stringValue(args?.cwd) ?? stringValue(details.cwd);
  const policy = recordValue(details.policy);
  const metadata = recordValue(policy.metadata);
  const riskValue =
    stringValue(metadata.risk) ?? stringValue(details.risk) ?? undefined;
  const kind = approvalKind(event.payload.action, toolName);
  const diff = stringValue(details.diff);
  return {
    approvalId: event.payload.approvalId,
    action: event.payload.action,
    kind,
    risk: approvalRisk(kind, riskValue, details),
    summary: event.payload.summary,
    reason: stringValue(details.reason),
    policyReason: stringValue(policy.reason),
    exactScope: exactScopeLabel(subject),
    subject,
    executionKind: execution.kind,
    runId: execution.runId,
    workflowId: execution.workflowRunId,
    sessionId: execution.sessionId,
    queuePosition: 1,
    queueDepth: 1,
    resolving: false,
    path: stringValue(details.path),
    diff,
    diffSummary: summarizeApprovalDiff(diff),
    toolName,
    toolArgs: args,
    command,
    cwd,
    details,
    createdAt: event.timestamp,
  };
}

function approvalKind(
  action: string,
  toolName: string | undefined,
): ApprovalKind {
  if (action === "workspace.write") return "workspace.write";
  if (action === "skill.apply") return "skill.apply";
  if (action === "shell.execute" || toolName === "bash") return "shell.execute";
  if (action === "tool.execute") return "tool.execute";
  return "unknown";
}

function approvalRisk(
  kind: ApprovalKind,
  raw: string | undefined,
  details: Record<string, unknown>,
): ApprovalRisk {
  const normalized = raw?.toLowerCase();
  if (
    normalized === "high" ||
    normalized === "critical" ||
    normalized === "risky" ||
    normalized === "denied" ||
    kind === "shell.execute" ||
    kind === "skill.apply" ||
    (kind === "workspace.write" && details.operation === "remove")
  ) {
    return "high";
  }
  if (normalized === "safe" || normalized === "low") return "low";
  if (kind === "unknown") return "unknown";
  return "medium";
}

function exactScopeLabel(subject: ReturnType<typeof approvalSubject>): string {
  if (subject.kind === "workspace-write")
    return `workspace path ${subject.path}`;
  if (subject.kind === "shell") return `exact command + cwd ${subject.cwd}`;
  if (subject.kind === "tool") return `exact ${subject.toolName} arguments`;
  return "unrecognized scope (allow once only)";
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function maybeRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error !== null && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error ?? "unknown error");
}
