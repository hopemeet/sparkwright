import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  publishExclusiveJsonDocument,
  readJsonDocumentDir,
  readJsonDocumentDirSync,
  writeJsonDocumentSync,
  type JsonDocumentInvalidEntry,
} from "../doc-store/index.js";
import {
  type FileWorkflowControlInbox,
  type WorkflowControlAcceptResult,
  type WorkflowControlCommand,
  type WorkflowControlCommandKind,
  type WorkflowControlSourceIdentity,
} from "./control.js";
import { assertSafeWorkflowRunId } from "./store.js";
import type { WorkflowRunId, WorkflowRunStatus } from "./types.js";

export const WORKFLOW_CHANNEL_SCHEMA_VERSION =
  "sparkwright-workflow-channel.v1" as const;

export type WorkflowChannelSourceKind =
  | "tui"
  | "cli"
  | "agent"
  | "im"
  | "web"
  | "api";

export interface WorkflowChannelBinding {
  schemaVersion: typeof WORKFLOW_CHANNEL_SCHEMA_VERSION;
  bindingId: string;
  workspaceId: string;
  workflowRunId: WorkflowRunId;
  sessionId?: string;
  source: {
    kind: WorkflowChannelSourceKind;
    principalId: string;
    authenticatedBy: string;
    channelId: string;
  };
  allowedCommandKinds: WorkflowControlCommandKind[];
  createdAt: string;
  expiresAt: string;
}

export interface WorkflowChannelRevocation {
  schemaVersion: "sparkwright-workflow-channel-revocation.v1";
  bindingId: string;
  workflowRunId: WorkflowRunId;
  revokedAt: string;
  reason?: string;
}

export type WorkflowChannelDeliveryStatus =
  | "delivered"
  | "failed"
  | "expired"
  | "revoked";

export interface WorkflowChannelDeliveryReceipt {
  schemaVersion: "sparkwright-workflow-channel-delivery.v1";
  bindingId: string;
  workflowRunId: WorkflowRunId;
  notificationId: string;
  deliveryKey: string;
  status: WorkflowChannelDeliveryStatus;
  attemptedAt: string;
  transportMessageId?: string;
  error?: string;
}

export interface WorkflowChannelSnapshot {
  bindings: WorkflowChannelBinding[];
  revocations: WorkflowChannelRevocation[];
  deliveries: WorkflowChannelDeliveryReceipt[];
  invalidEntries: JsonDocumentInvalidEntry[];
}

export class FileWorkflowChannelStore {
  readonly rootDir: string;
  private readonly now: () => Date;

  constructor(options: {
    rootDir: string;
    createRoot?: boolean;
    now?: () => Date;
  }) {
    this.rootDir = resolve(options.rootDir);
    this.now = options.now ?? (() => new Date());
    if (options.createRoot !== false)
      mkdirSync(this.rootDir, { recursive: true });
  }

  async bind(
    input: Omit<
      WorkflowChannelBinding,
      "schemaVersion" | "bindingId" | "createdAt"
    > & {
      bindingId?: string;
      createdAt?: string;
    },
  ): Promise<WorkflowChannelBinding> {
    const binding: WorkflowChannelBinding = {
      ...input,
      schemaVersion: WORKFLOW_CHANNEL_SCHEMA_VERSION,
      bindingId:
        input.bindingId ??
        `workflow_binding_${randomUUID().replaceAll("-", "")}`,
      createdAt: input.createdAt ?? this.now().toISOString(),
    };
    validateBinding(binding);
    const path = this.bindingPath(binding.workflowRunId, binding.bindingId);
    const published = await publishExclusiveJsonDocument(path, binding);
    if (!published) {
      const existing = this.snapshot(binding.workflowRunId).bindings.find(
        (candidate) => candidate.bindingId === binding.bindingId,
      );
      if (!existing || JSON.stringify(existing) !== JSON.stringify(binding))
        throw new Error(
          `Workflow channel binding conflict: ${binding.bindingId}`,
        );
      return clone(existing);
    }
    return clone(binding);
  }

  async revoke(input: {
    workflowRunId: WorkflowRunId;
    bindingId: string;
    reason?: string;
    revokedAt?: string;
  }): Promise<WorkflowChannelRevocation> {
    const revocation: WorkflowChannelRevocation = {
      schemaVersion: "sparkwright-workflow-channel-revocation.v1",
      workflowRunId: input.workflowRunId,
      bindingId: input.bindingId,
      revokedAt: input.revokedAt ?? this.now().toISOString(),
      ...(input.reason ? { reason: input.reason } : {}),
    };
    validateRevocation(revocation);
    const published = await publishExclusiveJsonDocument(
      this.revocationPath(input.workflowRunId, input.bindingId),
      revocation,
    );
    if (!published) {
      const existing = this.snapshot(input.workflowRunId).revocations.find(
        (candidate) => candidate.bindingId === input.bindingId,
      );
      if (!existing)
        throw new Error(
          `Workflow channel revocation unreadable: ${input.bindingId}`,
        );
      return clone(existing);
    }
    return clone(revocation);
  }

  activeBindings(
    workflowRunId: WorkflowRunId,
    at = this.now(),
  ): WorkflowChannelBinding[] {
    const snapshot = this.snapshot(workflowRunId);
    const revoked = new Set(
      snapshot.revocations.map((entry) => entry.bindingId),
    );
    return snapshot.bindings.filter(
      (binding) =>
        !revoked.has(binding.bindingId) &&
        Date.parse(binding.expiresAt) > at.getTime(),
    );
  }

  binding(
    workflowRunId: WorkflowRunId,
    bindingId: string,
  ): WorkflowChannelBinding | undefined {
    return this.snapshot(workflowRunId).bindings.find(
      (entry) => entry.bindingId === bindingId,
    );
  }

  async recordDelivery(
    receipt: WorkflowChannelDeliveryReceipt,
  ): Promise<WorkflowChannelDeliveryReceipt> {
    validateReceipt(receipt);
    const path = this.deliveryPath(receipt);
    const published = await publishExclusiveJsonDocument(path, receipt);
    if (!published) {
      const existing = this.snapshot(receipt.workflowRunId).deliveries.find(
        (candidate) =>
          candidate.bindingId === receipt.bindingId &&
          candidate.notificationId === receipt.notificationId &&
          candidate.attemptedAt === receipt.attemptedAt &&
          candidate.status === receipt.status,
      );
      if (!existing || JSON.stringify(existing) !== JSON.stringify(receipt))
        throw new Error(
          `Workflow channel delivery already differs: ${receipt.deliveryKey}`,
        );
      return clone(existing);
    }
    this.rebuildCursor(receipt.workflowRunId, receipt.bindingId);
    return clone(receipt);
  }

  async delivery(
    workflowRunId: WorkflowRunId,
    bindingId: string,
    notificationId: string,
  ): Promise<WorkflowChannelDeliveryReceipt | undefined> {
    const listed = await readJsonDocumentDir<WorkflowChannelDeliveryReceipt>({
      dir: this.deliveriesDir(workflowRunId, bindingId),
      parse: parseReceipt,
    });
    return listed.entries
      .map((entry) => entry.value)
      .filter((entry) => entry.notificationId === notificationId)
      .sort((a, b) => b.attemptedAt.localeCompare(a.attemptedAt))[0];
  }

  hasTerminalDelivery(
    workflowRunId: WorkflowRunId,
    bindingId: string,
    notificationId: string,
  ): boolean {
    const receipt = this.snapshot(workflowRunId).deliveries.find(
      (entry) =>
        entry.bindingId === bindingId &&
        entry.notificationId === notificationId,
    );
    return Boolean(receipt && receipt.status !== "failed");
  }

  async acceptControl(input: {
    inbox: FileWorkflowControlInbox;
    bindingId: string;
    workflowRunId: WorkflowRunId;
    workspaceId: string;
    sessionId?: string;
    source: WorkflowChannelBinding["source"];
    idempotencyKey: string;
    expected: {
      generation: number;
      status?: WorkflowRunStatus;
      waitId?: string;
    };
    command: WorkflowControlCommand;
    createdAt?: string;
    expiresAt: string;
  }): Promise<WorkflowControlAcceptResult> {
    const binding = this.binding(input.workflowRunId, input.bindingId);
    const now = this.now();
    if (!binding) throw new Error("Workflow channel binding was not found.");
    if (
      this.snapshot(input.workflowRunId).revocations.some(
        (entry) => entry.bindingId === input.bindingId,
      )
    )
      throw new Error("Workflow channel binding is revoked.");
    if (Date.parse(binding.expiresAt) <= now.getTime())
      throw new Error("Workflow channel binding is expired.");
    if (
      binding.workspaceId !== input.workspaceId ||
      binding.workflowRunId !== input.workflowRunId ||
      (binding.sessionId && binding.sessionId !== input.sessionId)
    )
      throw new Error("Workflow channel binding scope mismatch.");
    if (JSON.stringify(binding.source) !== JSON.stringify(input.source))
      throw new Error("Workflow channel source identity mismatch.");
    if (!binding.allowedCommandKinds.includes(input.command.kind))
      throw new Error("Workflow channel command kind is not authorized.");
    const source: WorkflowControlSourceIdentity = {
      kind: binding.source.kind,
      principalId: binding.source.principalId,
      authenticatedBy: binding.source.authenticatedBy,
      connectionId: binding.source.channelId,
    };
    const commandExpiresAt = new Date(
      Math.min(Date.parse(input.expiresAt), Date.parse(binding.expiresAt)),
    ).toISOString();
    return input.inbox.accept({
      workflowRunId: input.workflowRunId,
      idempotencyKey: input.idempotencyKey,
      source,
      authorization: {
        workspaceId: binding.workspaceId,
        ...(binding.sessionId ? { sessionId: binding.sessionId } : {}),
        workflowRunId: binding.workflowRunId,
        allowedCommandKinds: [...binding.allowedCommandKinds],
      },
      expected: input.expected,
      command: input.command,
      createdAt: input.createdAt ?? now.toISOString(),
      expiresAt: commandExpiresAt,
    });
  }

  snapshot(workflowRunId: WorkflowRunId): WorkflowChannelSnapshot {
    assertSafeWorkflowRunId(workflowRunId);
    const bindings = readJsonDocumentDirSync<WorkflowChannelBinding>({
      dir: this.bindingsDir(workflowRunId),
      parse: parseBinding,
    });
    const revocations = readJsonDocumentDirSync<WorkflowChannelRevocation>({
      dir: this.revocationsDir(workflowRunId),
      parse: parseRevocation,
    });
    const deliveries: WorkflowChannelDeliveryReceipt[] = [];
    const invalidEntries: JsonDocumentInvalidEntry[] = [
      ...bindings.invalidEntries,
      ...revocations.invalidEntries,
    ];
    for (const binding of bindings.entries) {
      const listed = readJsonDocumentDirSync<WorkflowChannelDeliveryReceipt>({
        dir: this.deliveriesDir(workflowRunId, binding.value.bindingId),
        parse: parseReceipt,
      });
      deliveries.push(...listed.entries.map((entry) => entry.value));
      invalidEntries.push(...listed.invalidEntries);
    }
    return {
      bindings: bindings.entries.map((entry) => entry.value),
      revocations: revocations.entries.map((entry) => entry.value),
      deliveries,
      invalidEntries,
    };
  }

  private rebuildCursor(workflowRunId: WorkflowRunId, bindingId: string): void {
    const deliveredNotificationIds = this.snapshot(workflowRunId)
      .deliveries.filter(
        (entry) => entry.bindingId === bindingId && entry.status !== "failed",
      )
      .map((entry) => entry.notificationId)
      .sort();
    writeJsonDocumentSync(
      join(this.cursorsDir(workflowRunId), `${safeId(bindingId)}.json`),
      {
        schemaVersion: "sparkwright-workflow-channel-cursor.v1",
        bindingId,
        deliveredNotificationIds,
        rebuiltAt: this.now().toISOString(),
      },
    );
  }

  private channelDir(id: WorkflowRunId): string {
    assertSafeWorkflowRunId(id);
    return join(this.rootDir, `${String(id)}.channels`);
  }
  private bindingsDir(id: WorkflowRunId): string {
    return join(this.channelDir(id), "bindings");
  }
  private revocationsDir(id: WorkflowRunId): string {
    return join(this.channelDir(id), "revocations");
  }
  private deliveriesDir(id: WorkflowRunId, bindingId: string): string {
    return join(this.channelDir(id), "deliveries", safeId(bindingId));
  }
  private cursorsDir(id: WorkflowRunId): string {
    return join(this.channelDir(id), "cursors");
  }
  private bindingPath(id: WorkflowRunId, bindingId: string): string {
    return join(this.bindingsDir(id), `${safeId(bindingId)}.json`);
  }
  private revocationPath(id: WorkflowRunId, bindingId: string): string {
    return join(this.revocationsDir(id), `${safeId(bindingId)}.json`);
  }
  private deliveryPath(receipt: WorkflowChannelDeliveryReceipt): string {
    const attempt = createHash("sha256")
      .update(
        JSON.stringify([
          receipt.deliveryKey,
          receipt.attemptedAt,
          receipt.status,
        ]),
      )
      .digest("hex")
      .slice(0, 16);
    return join(
      this.deliveriesDir(receipt.workflowRunId, receipt.bindingId),
      `${safeId(receipt.notificationId)}-${attempt}.json`,
    );
  }
}

function validateBinding(binding: WorkflowChannelBinding): void {
  if (binding.schemaVersion !== WORKFLOW_CHANNEL_SCHEMA_VERSION)
    throw new Error("Unsupported workflow channel schemaVersion.");
  assertSafeWorkflowRunId(binding.workflowRunId);
  if (!binding.workspaceId)
    throw new Error("Workflow channel workspace is required.");
  safeId(binding.bindingId);
  if (
    !binding.source.principalId ||
    !binding.source.authenticatedBy ||
    !binding.source.channelId
  )
    throw new Error("Workflow channel source must be authenticated.");
  if (
    !["tui", "cli", "agent", "im", "web", "api"].includes(binding.source.kind)
  )
    throw new Error("Workflow channel source kind is invalid.");
  if (binding.allowedCommandKinds.length === 0)
    throw new Error("Workflow channel requires at least one command kind.");
  if (
    binding.allowedCommandKinds.some(
      (kind) =>
        ![
          "cancel",
          "provide_input",
          "approval_response",
          "resume_request",
        ].includes(kind),
    )
  )
    throw new Error("Workflow channel command scope is invalid.");
  if (
    !Number.isFinite(Date.parse(binding.createdAt)) ||
    !Number.isFinite(Date.parse(binding.expiresAt)) ||
    Date.parse(binding.expiresAt) <= Date.parse(binding.createdAt)
  )
    throw new Error("Workflow channel expiry is invalid.");
}

function validateRevocation(value: WorkflowChannelRevocation): void {
  assertSafeWorkflowRunId(value.workflowRunId);
  safeId(value.bindingId);
  if (!Number.isFinite(Date.parse(value.revokedAt)))
    throw new Error("Workflow channel revocation timestamp is invalid.");
}

function validateReceipt(value: WorkflowChannelDeliveryReceipt): void {
  assertSafeWorkflowRunId(value.workflowRunId);
  safeId(value.bindingId);
  safeId(value.notificationId);
  if (
    value.deliveryKey !== `${value.bindingId}:${value.notificationId}` ||
    !["delivered", "failed", "expired", "revoked"].includes(value.status) ||
    !Number.isFinite(Date.parse(value.attemptedAt))
  )
    throw new Error("Workflow channel delivery is invalid.");
}

function parseBinding(raw: unknown): WorkflowChannelBinding {
  if (!raw || typeof raw !== "object")
    throw new Error("binding must be an object");
  const value = raw as WorkflowChannelBinding;
  validateBinding(value);
  return clone(value);
}
function parseRevocation(raw: unknown): WorkflowChannelRevocation {
  if (!raw || typeof raw !== "object")
    throw new Error("revocation must be an object");
  const value = raw as WorkflowChannelRevocation;
  if (value.schemaVersion !== "sparkwright-workflow-channel-revocation.v1")
    throw new Error("unsupported workflow channel revocation schema");
  validateRevocation(value);
  return clone(value);
}
function parseReceipt(raw: unknown): WorkflowChannelDeliveryReceipt {
  if (!raw || typeof raw !== "object")
    throw new Error("receipt must be an object");
  const value = raw as WorkflowChannelDeliveryReceipt;
  if (value.schemaVersion !== "sparkwright-workflow-channel-delivery.v1")
    throw new Error("unsupported workflow channel delivery schema");
  validateReceipt(value);
  return clone(value);
}
function safeId(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error(`Unsafe workflow channel id: ${value}`);
  return value;
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
