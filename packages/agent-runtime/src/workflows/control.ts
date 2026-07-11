import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  publishExclusiveJsonDocument,
  readJsonDocumentDir,
  readJsonDocumentDirSync,
  writeJsonDocumentSync,
  type JsonDocumentInvalidEntry,
} from "../doc-store/index.js";
import { assertSafeWorkflowRunId } from "./store.js";
import type { WorkflowRunId, WorkflowRunStatus } from "./types.js";

export const WORKFLOW_CONTROL_SCHEMA_VERSION =
  "sparkwright-workflow-control.v1" as const;

export type WorkflowControlCommand =
  | { kind: "cancel"; reason?: string }
  | { kind: "provide_input"; waitId: string; value: string }
  | {
      kind: "approval_response";
      approvalId: string;
      decision: "approved" | "denied";
      message?: string;
    }
  | { kind: "resume_request"; waitId?: string };

export type WorkflowControlCommandKind = WorkflowControlCommand["kind"];

export interface WorkflowControlSourceIdentity {
  kind: "tui" | "cli" | "sdk" | "api" | "agent" | "im" | "web" | "system";
  principalId: string;
  authenticatedBy: string;
  /** @reserved Serialized audit correlation consumed by workflow-control diagnostics and channel adapters. */
  connectionId?: string;
}

export interface WorkflowControlAuthorization {
  workspaceId: string;
  sessionId?: string;
  workflowRunId: WorkflowRunId;
  allowedCommandKinds: WorkflowControlCommandKind[];
}

export interface WorkflowControlCommandEnvelope {
  schemaVersion: typeof WORKFLOW_CONTROL_SCHEMA_VERSION;
  workflowRunId: WorkflowRunId;
  commandId: string;
  idempotencyKey: string;
  source: WorkflowControlSourceIdentity;
  authorization: WorkflowControlAuthorization;
  expected: {
    generation: number;
    status?: WorkflowRunStatus;
    waitId?: string;
  };
  command: WorkflowControlCommand;
  createdAt: string;
  expiresAt: string;
}

export type WorkflowControlOutcomeStatus =
  | "applied"
  | "rejected"
  | "dead_letter";

export interface WorkflowControlOutcome {
  schemaVersion: "sparkwright-workflow-control-outcome.v1";
  workflowRunId: WorkflowRunId;
  commandId: string;
  status: WorkflowControlOutcomeStatus;
  code: string;
  message?: string;
  completedAt: string;
  metadata?: Record<string, unknown>;
}

interface WorkflowControlDedupeEntry {
  schemaVersion: "sparkwright-workflow-control-dedupe.v1";
  scopeHash: string;
  payloadHash: string;
  envelope: WorkflowControlCommandEnvelope;
}

export type WorkflowControlAcceptResult =
  | { status: "accepted"; envelope: WorkflowControlCommandEnvelope }
  | { status: "duplicate"; envelope: WorkflowControlCommandEnvelope }
  | {
      status: "conflict";
      commandId: string;
      code: "idempotency_conflict";
    };

export interface WorkflowControlInboxSnapshot {
  commands: WorkflowControlCommandEnvelope[];
  outcomes: WorkflowControlOutcome[];
  invalidEntries: JsonDocumentInvalidEntry[];
}

export class FileWorkflowControlInbox {
  readonly rootDir: string;

  constructor(options: { rootDir: string; createRoot?: boolean }) {
    this.rootDir = resolve(options.rootDir);
    if (options.createRoot !== false)
      mkdirSync(this.rootDir, { recursive: true });
  }

  async accept(
    input: Omit<
      WorkflowControlCommandEnvelope,
      "schemaVersion" | "commandId"
    > & {
      commandId?: string;
    },
    options: { trustedSystemSource?: boolean } = {},
  ): Promise<WorkflowControlAcceptResult> {
    const envelope: WorkflowControlCommandEnvelope = {
      ...input,
      schemaVersion: WORKFLOW_CONTROL_SCHEMA_VERSION,
      commandId:
        input.commandId ??
        `workflow_command_${randomUUID().replaceAll("-", "")}`,
    };
    validateEnvelope(envelope, options);
    const scopeHash = digest(idempotencyScope(envelope));
    const payloadHash = digest(JSON.stringify(envelope.command));
    const dedupeEntry: WorkflowControlDedupeEntry = {
      schemaVersion: "sparkwright-workflow-control-dedupe.v1",
      scopeHash,
      payloadHash,
      envelope,
    };
    const dedupePath = join(
      this.dedupeDir(envelope.workflowRunId),
      `${scopeHash}.json`,
    );
    const claimed = await publishExclusiveJsonDocument(dedupePath, dedupeEntry);
    const canonical = claimed ? dedupeEntry : await this.readDedupe(dedupePath);
    if (canonical.payloadHash !== payloadHash) {
      return {
        status: "conflict",
        commandId: canonical.envelope.commandId,
        code: "idempotency_conflict",
      };
    }
    await this.publishCommand(canonical.envelope);
    return {
      status: claimed ? "accepted" : "duplicate",
      envelope: clone(canonical.envelope),
    };
  }

  async recordOutcome(
    outcome: WorkflowControlOutcome,
  ): Promise<WorkflowControlOutcome> {
    validateOutcome(outcome);
    const path = this.outcomePath(outcome.workflowRunId, outcome.commandId);
    const published = await publishExclusiveJsonDocument(path, outcome);
    if (!published) {
      const existing = await this.outcome(
        outcome.workflowRunId,
        outcome.commandId,
      );
      if (!existing || JSON.stringify(existing) !== JSON.stringify(outcome)) {
        throw new Error(
          `Workflow control outcome already differs: ${outcome.commandId}`,
        );
      }
    }
    this.rebuildCursor(outcome.workflowRunId);
    return clone(outcome);
  }

  outcome(
    id: WorkflowRunId,
    commandId: string,
  ): Promise<WorkflowControlOutcome | undefined> {
    return readJsonDocumentDir<WorkflowControlOutcome>({
      dir: this.outcomesDir(id),
      parse: parseOutcome,
    }).then(
      (result) => result.entries.find((entry) => entry.id === commandId)?.value,
    );
  }

  snapshot(id: WorkflowRunId): WorkflowControlInboxSnapshot {
    assertSafeWorkflowRunId(id);
    const commands = readJsonDocumentDirSync<WorkflowControlCommandEnvelope>({
      dir: this.commandsDir(id),
      parse: parseEnvelope,
    });
    const outcomes = readJsonDocumentDirSync<WorkflowControlOutcome>({
      dir: this.outcomesDir(id),
      parse: parseOutcome,
    });
    return {
      commands: commands.entries.map((entry) => entry.value).sort(commandOrder),
      outcomes: outcomes.entries.map((entry) => entry.value),
      invalidEntries: [...commands.invalidEntries, ...outcomes.invalidEntries],
    };
  }

  pending(id: WorkflowRunId): WorkflowControlCommandEnvelope[] {
    const snapshot = this.snapshot(id);
    const terminal = new Set(
      snapshot.outcomes.map((outcome) => outcome.commandId),
    );
    return snapshot.commands.filter(
      (command) => !terminal.has(command.commandId),
    );
  }

  private async publishCommand(
    envelope: WorkflowControlCommandEnvelope,
  ): Promise<void> {
    const published = await publishExclusiveJsonDocument(
      join(
        this.commandsDir(envelope.workflowRunId),
        `${envelope.commandId}.json`,
      ),
      envelope,
    );
    if (!published) {
      const existing = this.snapshot(envelope.workflowRunId).commands.find(
        (command) => command.commandId === envelope.commandId,
      );
      if (!existing || JSON.stringify(existing) !== JSON.stringify(envelope)) {
        throw new Error(
          `Workflow control command id conflict: ${envelope.commandId}`,
        );
      }
    }
  }

  private async readDedupe(path: string): Promise<WorkflowControlDedupeEntry> {
    const dir = dirname(path);
    const file = path.slice(dir.length + 1);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await readJsonDocumentDir<WorkflowControlDedupeEntry>({
        dir,
        parse: parseDedupe,
      });
      const entry = result.entries.find(
        (candidate) => `${candidate.id}.json` === file,
      );
      if (entry) return entry.value;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error(`Workflow control dedupe entry is unreadable: ${path}`);
  }

  private rebuildCursor(id: WorkflowRunId): void {
    const snapshot = this.snapshot(id);
    const terminal = new Set(
      snapshot.outcomes.map((outcome) => outcome.commandId),
    );
    let throughCommandId: string | undefined;
    for (const command of snapshot.commands) {
      if (!terminal.has(command.commandId)) break;
      throughCommandId = command.commandId;
    }
    writeJsonDocumentSync(join(this.controlDir(id), "cursor.json"), {
      schemaVersion: "sparkwright-workflow-control-cursor.v1",
      ...(throughCommandId ? { throughCommandId } : {}),
      rebuiltAt: new Date().toISOString(),
    });
  }

  private controlDir(id: WorkflowRunId): string {
    assertSafeWorkflowRunId(id);
    return join(this.rootDir, `${String(id)}.control`);
  }
  private commandsDir(id: WorkflowRunId): string {
    return join(this.controlDir(id), "commands");
  }
  private outcomesDir(id: WorkflowRunId): string {
    return join(this.controlDir(id), "outcomes");
  }
  private dedupeDir(id: WorkflowRunId): string {
    return join(this.controlDir(id), "dedupe");
  }
  private outcomePath(id: WorkflowRunId, commandId: string): string {
    assertSafeCommandId(commandId);
    return join(this.outcomesDir(id), `${commandId}.json`);
  }
}

function validateEnvelope(
  envelope: WorkflowControlCommandEnvelope,
  options: { trustedSystemSource?: boolean },
): void {
  if (envelope.schemaVersion !== WORKFLOW_CONTROL_SCHEMA_VERSION)
    throw new Error("Unsupported workflow control schemaVersion.");
  assertSafeWorkflowRunId(envelope.workflowRunId);
  assertSafeCommandId(envelope.commandId);
  if (!envelope.idempotencyKey.trim())
    throw new Error("Workflow control idempotencyKey is required.");
  if (!envelope.source.principalId || !envelope.source.authenticatedBy)
    throw new Error("Workflow control source must be authenticated.");
  if (envelope.source.kind === "system" && !options.trustedSystemSource)
    throw new Error(
      "External workflow control source cannot claim system identity.",
    );
  if (envelope.authorization.workflowRunId !== envelope.workflowRunId)
    throw new Error("Workflow control authorization scope mismatch.");
  if (!envelope.authorization.workspaceId)
    throw new Error("Workflow control workspace authorization is required.");
  if (
    !envelope.authorization.allowedCommandKinds.includes(envelope.command.kind)
  )
    throw new Error("Workflow control command kind is not authorized.");
  validateCommand(envelope.command);
  if (
    !Number.isSafeInteger(envelope.expected.generation) ||
    envelope.expected.generation < 0
  )
    throw new Error("Workflow control expected generation is invalid.");
  if (
    !Number.isFinite(Date.parse(envelope.createdAt)) ||
    !Number.isFinite(Date.parse(envelope.expiresAt)) ||
    Date.parse(envelope.expiresAt) <= Date.parse(envelope.createdAt)
  )
    throw new Error("Workflow control expiry is invalid.");
}

function validateCommand(command: WorkflowControlCommand): void {
  if (!command || typeof command !== "object")
    throw new Error("Workflow control command must be an object.");
  if (command.kind === "cancel" || command.kind === "resume_request") return;
  if (command.kind === "provide_input") {
    if (!command.waitId || typeof command.value !== "string")
      throw new Error("provide_input requires waitId and value.");
    return;
  }
  if (command.kind === "approval_response") {
    if (
      !command.approvalId ||
      (command.decision !== "approved" && command.decision !== "denied")
    )
      throw new Error(
        "approval_response requires approvalId and a valid decision.",
      );
    return;
  }
  throw new Error("Unsupported workflow control command kind.");
}

function validateOutcome(outcome: WorkflowControlOutcome): void {
  assertSafeWorkflowRunId(outcome.workflowRunId);
  assertSafeCommandId(outcome.commandId);
  if (!Number.isFinite(Date.parse(outcome.completedAt)))
    throw new Error("Workflow control outcome timestamp is invalid.");
}

function parseEnvelope(raw: unknown): WorkflowControlCommandEnvelope {
  if (!raw || typeof raw !== "object")
    throw new Error("command must be an object");
  const envelope = raw as WorkflowControlCommandEnvelope;
  validateEnvelope(envelope, { trustedSystemSource: true });
  return clone(envelope);
}

function parseOutcome(raw: unknown): WorkflowControlOutcome {
  if (!raw || typeof raw !== "object")
    throw new Error("outcome must be an object");
  const outcome = raw as WorkflowControlOutcome;
  if (outcome.schemaVersion !== "sparkwright-workflow-control-outcome.v1")
    throw new Error("unsupported outcome schema");
  validateOutcome(outcome);
  return clone(outcome);
}

function parseDedupe(raw: unknown): WorkflowControlDedupeEntry {
  if (!raw || typeof raw !== "object")
    throw new Error("dedupe entry must be an object");
  const entry = raw as WorkflowControlDedupeEntry;
  if (entry.schemaVersion !== "sparkwright-workflow-control-dedupe.v1")
    throw new Error("unsupported dedupe schema");
  parseEnvelope(entry.envelope);
  return clone(entry);
}

function idempotencyScope(envelope: WorkflowControlCommandEnvelope): string {
  return JSON.stringify([
    envelope.authorization.workspaceId,
    envelope.workflowRunId,
    envelope.source.kind,
    envelope.source.principalId,
    envelope.source.authenticatedBy,
    envelope.idempotencyKey,
  ]);
}

function commandOrder(
  a: WorkflowControlCommandEnvelope,
  b: WorkflowControlCommandEnvelope,
): number {
  return (
    a.createdAt.localeCompare(b.createdAt) ||
    a.commandId.localeCompare(b.commandId)
  );
}

function assertSafeCommandId(id: string): void {
  if (!/^workflow_command_[A-Za-z0-9_-]+$/.test(id))
    throw new Error(`Unsafe workflow command id: ${id}`);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
