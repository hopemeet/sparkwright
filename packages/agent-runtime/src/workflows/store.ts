// AI maintenance note: durable workflow stores mirror the task store shape, but
// compose doc-store primitives so workflow persistence does not grow another
// hand-rolled atomic-write/log/lease copy.

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  acquireFileDocumentLease,
  appendJsonDocumentLogSync,
  readJsonDocumentDirSync,
  readJsonDocumentLogSync,
  writeJsonDocumentSync,
  type FileDocumentLease,
  type JsonDocumentInvalidEntry,
  type JsonDocumentLogInvalidEntry,
} from "../doc-store/index.js";
import type {
  WorkflowDefinition,
  WorkflowAssetPin,
  WorkflowEvidenceRef,
  WorkflowNodeVerdict,
  WorkflowParallelBranchState,
  WorkflowNodeVerdictLogEntry,
  WorkflowResumePolicy,
  WorkflowRunFailure,
  WorkflowRunId,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowStoreEvent,
  WorkflowTransitionDecision,
  WorkflowTransitionLogEntry,
  WorkflowWaitState,
} from "./types.js";
import { WORKFLOW_RUN_RECORD_SCHEMA_VERSION } from "./types.js";

export interface CreateWorkflowRunRecordInput extends WorkflowAssetPin {
  id: WorkflowRunId;
  parentRunId?: WorkflowRunRecord["parentRunId"];
  sessionId?: string;
  activeRunId?: WorkflowRunRecord["activeRunId"];
  runIds?: WorkflowRunRecord["runIds"];
  currentNodeId?: string;
  attempts?: Record<string, number>;
  parallelBranches?: WorkflowRunRecord["parallelBranches"];
  evidenceRefs?: WorkflowEvidenceRef[];
  verdictLog?: WorkflowNodeVerdictLogEntry[];
  transitionLog?: WorkflowTransitionLogEntry[];
  resume?: Partial<WorkflowResumePolicy>;
  definitionSnapshot?: WorkflowDefinition;
  metadata?: Record<string, unknown>;
  now?: () => string;
}

export interface WorkflowRunRecordPatch {
  parentRunId?: WorkflowRunRecord["parentRunId"];
  sessionId?: string;
  activeRunId?: WorkflowRunRecord["activeRunId"];
  appendRunId?: WorkflowRunRecord["activeRunId"];
  status?: WorkflowRunStatus;
  currentNodeId?: string;
  wait?: WorkflowWaitState;
  clearWait?: boolean;
  attempts?: Record<string, number>;
  parallelBranches?: WorkflowRunRecord["parallelBranches"];
  evidenceRefs?: WorkflowEvidenceRef[];
  verdictLog?: WorkflowNodeVerdictLogEntry[];
  transitionLog?: WorkflowTransitionLogEntry[];
  failure?: WorkflowRunFailure;
  resume?: Partial<WorkflowResumePolicy>;
  definitionSnapshot?: WorkflowDefinition;
  metadata?: Record<string, unknown>;
  completedAt?: string;
  now?: () => string;
}

export interface WorkflowStoreListResult {
  records: WorkflowRunRecord[];
  invalidEntries: JsonDocumentInvalidEntry[];
}

export interface WorkflowStoreEventLogResult {
  events: WorkflowStoreEvent[];
  invalidEntries: JsonDocumentLogInvalidEntry[];
}

export interface WorkflowStore {
  create(input: CreateWorkflowRunRecordInput): WorkflowRunRecord;
  get(id: WorkflowRunId): WorkflowRunRecord | undefined;
  list(): WorkflowStoreListResult;
  update(id: WorkflowRunId, patch: WorkflowRunRecordPatch): WorkflowRunRecord;
  appendEvent(event: WorkflowStoreEvent): void;
  /** @reserved Public workflow-store log reader consumed by future workflow diagnostics/resume UIs. */
  eventLog(id: WorkflowRunId): WorkflowStoreEventLogResult;
  acquireLease(
    id: WorkflowRunId,
    options?: { owner?: string; ttlMs?: number; now?: () => Date },
  ): Promise<FileDocumentLease | null>;
}

export interface FileWorkflowStoreOptions {
  /** Directory containing workflow run snapshots/logs. */
  rootDir: string;
  /** Create the root eagerly. Set false for read-only inspection commands. */
  createRoot?: boolean;
}

export class FileWorkflowStore implements WorkflowStore {
  readonly rootDir: string;
  private readonly records = new Map<WorkflowRunId, WorkflowRunRecord>();
  private invalidRecordEntries: JsonDocumentInvalidEntry[] = [];

  constructor(options: FileWorkflowStoreOptions) {
    this.rootDir = resolve(options.rootDir);
    if (options.createRoot !== false) {
      mkdirSync(this.rootDir, { recursive: true });
    }
    this.loadExistingRecords();
  }

  create(input: CreateWorkflowRunRecordInput): WorkflowRunRecord {
    assertSafeWorkflowRunId(input.id);
    if (this.records.has(input.id)) {
      throw new Error(`Workflow run already exists: ${input.id}`);
    }
    const now = input.now?.() ?? new Date().toISOString();
    const record: WorkflowRunRecord = {
      schemaVersion: WORKFLOW_RUN_RECORD_SCHEMA_VERSION,
      id: input.id,
      assetName: input.assetName,
      ...(input.version ? { version: input.version } : {}),
      contentHash: input.contentHash,
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.activeRunId ? { activeRunId: input.activeRunId } : {}),
      runIds: [
        ...(input.runIds ?? (input.activeRunId ? [input.activeRunId] : [])),
      ],
      status: "running",
      ...(input.currentNodeId ? { currentNodeId: input.currentNodeId } : {}),
      attempts: { ...(input.attempts ?? {}) },
      ...(input.parallelBranches
        ? { parallelBranches: cloneParallelBranches(input.parallelBranches) }
        : {}),
      evidenceRefs: [...(input.evidenceRefs ?? [])],
      verdictLog: [...(input.verdictLog ?? [])],
      transitionLog: [...(input.transitionLog ?? [])],
      resume: { verifyOnResume: input.resume?.verifyOnResume ?? true },
      ...(input.definitionSnapshot
        ? { definitionSnapshot: cloneJsonLike(input.definitionSnapshot) }
        : {}),
      createdAt: now,
      updatedAt: now,
      metadata: { ...(input.metadata ?? {}) },
    };
    this.records.set(record.id, record);
    this.writeRecord(record);
    this.appendEvent({
      at: now,
      type: "created",
      workflowRunId: record.id,
      parentRunId: record.parentRunId,
      status: record.status,
      metadata: {
        assetName: record.assetName,
        version: record.version,
        contentHash: record.contentHash,
      },
    });
    return cloneRecord(record);
  }

  get(id: WorkflowRunId): WorkflowRunRecord | undefined {
    assertSafeWorkflowRunId(id);
    const record = this.records.get(id);
    return record ? cloneRecord(record) : undefined;
  }

  list(): WorkflowStoreListResult {
    return {
      records: [...this.records.values()].map(cloneRecord),
      invalidEntries: [...this.invalidRecordEntries],
    };
  }

  update(id: WorkflowRunId, patch: WorkflowRunRecordPatch): WorkflowRunRecord {
    assertSafeWorkflowRunId(id);
    const existing = this.records.get(id);
    if (!existing) throw new Error(`Workflow run not found: ${id}`);
    const now = patch.now?.() ?? new Date().toISOString();
    const status = patch.status ?? existing.status;
    const wait =
      isTerminalStatus(status) || patch.clearWait
        ? undefined
        : patch.wait
          ? cloneWait(patch.wait)
          : existing.wait;
    if (status === "waiting" && !wait) {
      throw new Error("Workflow waiting status requires wait.kind.");
    }
    const runIds = patch.appendRunId
      ? existing.runIds.includes(patch.appendRunId)
        ? existing.runIds
        : [...existing.runIds, patch.appendRunId]
      : existing.runIds;
    const completedAt =
      patch.completedAt ??
      (isTerminalStatus(status) && !existing.completedAt
        ? now
        : existing.completedAt);
    const updated: WorkflowRunRecord = {
      ...existing,
      ...(patch.parentRunId ? { parentRunId: patch.parentRunId } : {}),
      ...(patch.sessionId ? { sessionId: patch.sessionId } : {}),
      ...(patch.activeRunId ? { activeRunId: patch.activeRunId } : {}),
      runIds: [...runIds],
      status,
      ...(patch.currentNodeId !== undefined
        ? { currentNodeId: patch.currentNodeId }
        : {}),
      ...(wait ? { wait } : { wait: undefined }),
      ...(patch.attempts ? { attempts: { ...patch.attempts } } : {}),
      ...(patch.parallelBranches
        ? { parallelBranches: cloneParallelBranches(patch.parallelBranches) }
        : {}),
      ...(patch.evidenceRefs
        ? { evidenceRefs: patch.evidenceRefs.map(cloneEvidenceRef) }
        : {}),
      ...(patch.verdictLog
        ? { verdictLog: patch.verdictLog.map(cloneVerdictLogEntry) }
        : {}),
      ...(patch.transitionLog
        ? { transitionLog: patch.transitionLog.map(cloneTransitionLogEntry) }
        : {}),
      ...(patch.failure ? { failure: cloneFailure(patch.failure) } : {}),
      ...(patch.resume
        ? {
            resume: {
              ...existing.resume,
              ...patch.resume,
              verifyOnResume:
                patch.resume.verifyOnResume ?? existing.resume.verifyOnResume,
            },
          }
        : {}),
      ...(patch.definitionSnapshot
        ? { definitionSnapshot: cloneJsonLike(patch.definitionSnapshot) }
        : {}),
      ...(completedAt ? { completedAt } : {}),
      updatedAt: now,
      metadata: patch.metadata
        ? { ...existing.metadata, ...patch.metadata }
        : { ...existing.metadata },
    };
    this.records.set(id, updated);
    this.writeRecord(updated);
    this.appendEvent({
      at: now,
      type:
        status === "completed"
          ? "completed"
          : status === "failed"
            ? "failed"
            : status === "cancelled"
              ? "cancelled"
              : status === "waiting"
                ? "waiting"
                : "updated",
      workflowRunId: id,
      parentRunId: updated.parentRunId,
      status,
      metadata: {
        currentNodeId: updated.currentNodeId,
        wait: updated.wait,
        failure: updated.failure,
      },
    });
    return cloneRecord(updated);
  }

  appendEvent(event: WorkflowStoreEvent): void {
    assertSafeWorkflowRunId(event.workflowRunId);
    appendJsonDocumentLogSync(this.eventLogPath(event.workflowRunId), event);
  }

  eventLog(id: WorkflowRunId): WorkflowStoreEventLogResult {
    assertSafeWorkflowRunId(id);
    const result = readJsonDocumentLogSync<WorkflowStoreEvent>({
      path: this.eventLogPath(id),
      parse: parseWorkflowStoreEvent,
    });
    return {
      events: result.entries.map((entry) => entry.value),
      invalidEntries: result.invalidEntries,
    };
  }

  acquireLease(
    id: WorkflowRunId,
    options: { owner?: string; ttlMs?: number; now?: () => Date } = {},
  ): Promise<FileDocumentLease | null> {
    assertSafeWorkflowRunId(id);
    return acquireFileDocumentLease({
      path: this.leasePath(id),
      owner: options.owner,
      ttlMs: options.ttlMs,
      now: options.now,
    }).then((lease) => {
      if (!lease) return null;
      const record = this.records.get(id);
      const at = options.now?.().toISOString() ?? new Date().toISOString();
      if (record) {
        this.appendEvent({
          at,
          type: "adopted",
          workflowRunId: id,
          parentRunId: record.parentRunId,
          status: record.status,
          metadata: { owner: lease.owner, token: lease.token },
        });
      }
      return {
        ...lease,
        release: async () => {
          const released = await lease.release();
          if (released) {
            const latest = this.records.get(id);
            this.appendEvent({
              at: options.now?.().toISOString() ?? new Date().toISOString(),
              type: "released",
              workflowRunId: id,
              parentRunId: latest?.parentRunId,
              status: latest?.status ?? "running",
              metadata: { owner: lease.owner, token: lease.token },
            });
          }
          return released;
        },
      };
    });
  }

  private loadExistingRecords(): void {
    const result = readJsonDocumentDirSync<WorkflowRunRecord>({
      dir: this.rootDir,
      extension: ".json",
      parse: parseWorkflowRunRecord,
    });
    this.records.clear();
    this.invalidRecordEntries = result.invalidEntries;
    for (const entry of result.entries) {
      this.records.set(entry.value.id, entry.value);
    }
  }

  private writeRecord(record: WorkflowRunRecord): void {
    writeJsonDocumentSync(this.recordPath(record.id), record);
  }

  private recordPath(id: WorkflowRunId): string {
    return join(this.rootDir, `${String(id)}.json`);
  }

  private eventLogPath(id: WorkflowRunId): string {
    return join(this.rootDir, `${String(id)}.events.jsonl`);
  }

  private leasePath(id: WorkflowRunId): string {
    return join(this.rootDir, `${String(id)}.lease`);
  }
}

export function workflowRunsDir(input: {
  sessionRootDir: string;
  sessionId: string;
}): string {
  return join(input.sessionRootDir, input.sessionId, "workflow-runs");
}

export function workspaceWorkflowRunsDir(input: {
  workspaceRoot: string;
}): string {
  return join(input.workspaceRoot, ".sparkwright", "workflow-runs");
}

export function assertSafeWorkflowRunId(id: WorkflowRunId): void {
  if (!isSafeWorkflowRunId(id)) {
    throw new Error(`Unsafe workflow run id: ${id}`);
  }
}

export function isSafeWorkflowRunId(id: WorkflowRunId | string): boolean {
  return /^workflow_[A-Za-z0-9_-]+$/.test(String(id));
}

function isTerminalStatus(status: WorkflowRunStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

function parseWorkflowRunRecord(raw: unknown): WorkflowRunRecord {
  if (!isRecord(raw)) throw new Error("record must be an object");
  if (raw.schemaVersion !== WORKFLOW_RUN_RECORD_SCHEMA_VERSION) {
    throw new Error("unsupported workflow run schemaVersion");
  }
  const id = stringField(raw, "id") as WorkflowRunId;
  assertSafeWorkflowRunId(id);
  const status = workflowStatus(raw.status);
  const assetName = stringField(raw, "assetName");
  const contentHash = stringField(raw, "contentHash");
  const record: WorkflowRunRecord = {
    schemaVersion: WORKFLOW_RUN_RECORD_SCHEMA_VERSION,
    id,
    assetName,
    ...(optionalString(raw.version) ? { version: raw.version } : {}),
    contentHash,
    ...(optionalString(raw.parentRunId)
      ? { parentRunId: raw.parentRunId as WorkflowRunRecord["parentRunId"] }
      : {}),
    ...(optionalString(raw.sessionId) ? { sessionId: raw.sessionId } : {}),
    ...(optionalString(raw.activeRunId)
      ? { activeRunId: raw.activeRunId as WorkflowRunRecord["activeRunId"] }
      : {}),
    runIds: Array.isArray(raw.runIds)
      ? raw.runIds
          .filter(optionalString)
          .map((runId) => runId as WorkflowRunRecord["runIds"][number])
      : [],
    status,
    ...(optionalString(raw.currentNodeId)
      ? { currentNodeId: raw.currentNodeId }
      : {}),
    ...(isRecord(raw.wait) ? { wait: parseWait(raw.wait) } : {}),
    attempts: isRecord(raw.attempts)
      ? Object.fromEntries(
          Object.entries(raw.attempts).filter(
            (entry): entry is [string, number] => typeof entry[1] === "number",
          ),
        )
      : {},
    ...(isRecord(raw.parallelBranches)
      ? { parallelBranches: parseParallelBranches(raw.parallelBranches) }
      : {}),
    evidenceRefs: Array.isArray(raw.evidenceRefs)
      ? raw.evidenceRefs.filter(isRecord).map(parseEvidenceRef)
      : [],
    verdictLog: Array.isArray(raw.verdictLog)
      ? raw.verdictLog.filter(isRecord).map(parseVerdictLogEntry)
      : [],
    transitionLog: Array.isArray(raw.transitionLog)
      ? raw.transitionLog.filter(isRecord).map(parseTransitionLogEntry)
      : [],
    ...(isRecord(raw.failure) ? { failure: parseFailure(raw.failure) } : {}),
    resume: {
      verifyOnResume:
        !isRecord(raw.resume) || raw.resume.verifyOnResume !== false,
    },
    ...(isRecord(raw.definitionSnapshot)
      ? {
          definitionSnapshot: cloneJsonLike(
            raw.definitionSnapshot,
          ) as unknown as WorkflowDefinition,
        }
      : {}),
    createdAt: stringField(raw, "createdAt"),
    ...(optionalString(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}),
    ...(optionalString(raw.completedAt)
      ? { completedAt: raw.completedAt }
      : {}),
    metadata: isRecord(raw.metadata) ? { ...raw.metadata } : {},
  };
  if (record.status === "waiting" && !record.wait) {
    throw new Error("waiting workflow record requires wait.kind");
  }
  return record;
}

function parseWorkflowStoreEvent(raw: unknown): WorkflowStoreEvent {
  if (!isRecord(raw)) throw new Error("event must be an object");
  const workflowRunId = stringField(raw, "workflowRunId") as WorkflowRunId;
  assertSafeWorkflowRunId(workflowRunId);
  return {
    at: stringField(raw, "at"),
    type: workflowStoreEventType(raw.type),
    workflowRunId,
    ...(optionalString(raw.parentRunId)
      ? { parentRunId: raw.parentRunId as WorkflowRunRecord["parentRunId"] }
      : {}),
    status: workflowStatus(raw.status),
    ...(isRecord(raw.metadata) ? { metadata: { ...raw.metadata } } : {}),
  };
}

function workflowStatus(value: unknown): WorkflowRunStatus {
  if (
    value === "running" ||
    value === "waiting" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  throw new Error(`invalid workflow status: ${String(value)}`);
}

function workflowStoreEventType(value: unknown): WorkflowStoreEvent["type"] {
  if (
    value === "created" ||
    value === "updated" ||
    value === "waiting" ||
    value === "input" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "adopted" ||
    value === "released"
  ) {
    return value;
  }
  throw new Error(`invalid workflow store event type: ${String(value)}`);
}

function cloneRecord(record: WorkflowRunRecord): WorkflowRunRecord {
  return {
    ...record,
    runIds: [...record.runIds],
    attempts: { ...record.attempts },
    parallelBranches: record.parallelBranches
      ? cloneParallelBranches(record.parallelBranches)
      : undefined,
    evidenceRefs: record.evidenceRefs.map(cloneEvidenceRef),
    verdictLog: record.verdictLog.map(cloneVerdictLogEntry),
    transitionLog: record.transitionLog.map(cloneTransitionLogEntry),
    wait: record.wait ? cloneWait(record.wait) : undefined,
    failure: record.failure ? cloneFailure(record.failure) : undefined,
    resume: { ...record.resume },
    definitionSnapshot: record.definitionSnapshot
      ? cloneJsonLike(record.definitionSnapshot)
      : undefined,
    metadata: { ...record.metadata },
  };
}

function cloneWait(wait: WorkflowWaitState): WorkflowWaitState {
  if (
    wait.kind !== "input" &&
    wait.kind !== "task" &&
    wait.kind !== "approval"
  ) {
    throw new Error("workflow wait.kind must be input, task, or approval");
  }
  return {
    ...wait,
    metadata: wait.metadata ? { ...wait.metadata } : undefined,
  };
}

function parseWait(raw: Record<string, unknown>): WorkflowWaitState {
  return cloneWait({
    kind: waitKind(raw.kind),
    ...(optionalString(raw.reason) ? { reason: raw.reason } : {}),
    ...(optionalString(raw.taskId) ? { taskId: raw.taskId } : {}),
    ...(optionalString(raw.approvalId) ? { approvalId: raw.approvalId } : {}),
    ...(isRecord(raw.metadata) ? { metadata: { ...raw.metadata } } : {}),
  });
}

function waitKind(value: unknown): WorkflowWaitState["kind"] {
  if (value === "input" || value === "task" || value === "approval") {
    return value;
  }
  throw new Error("workflow wait.kind must be input, task, or approval");
}

function cloneParallelBranches(
  branches: Record<string, WorkflowParallelBranchState>,
): Record<string, WorkflowParallelBranchState> {
  return Object.fromEntries(
    Object.entries(branches).map(([key, branch]) => [
      key,
      {
        ...branch,
        verdict: cloneJsonLike(branch.verdict),
        evidenceRefs: branch.evidenceRefs?.map(cloneEvidenceRef),
        metadata: branch.metadata ? { ...branch.metadata } : undefined,
      },
    ]),
  );
}

function parseParallelBranches(
  raw: Record<string, unknown>,
): Record<string, WorkflowParallelBranchState> {
  return Object.fromEntries(
    Object.entries(raw)
      .filter((entry): entry is [string, Record<string, unknown>] =>
        isRecord(entry[1]),
      )
      .map(([key, branch]) => [
        key,
        {
          sourceNodeId: stringField(branch, "sourceNodeId"),
          nodeId: stringField(branch, "nodeId"),
          attempt:
            typeof branch.attempt === "number" && branch.attempt > 0
              ? branch.attempt
              : 1,
          status: parallelBranchStatus(branch.status),
          verdict: cloneJsonLike(branch.verdict) as WorkflowNodeVerdict,
          evidenceRefs: Array.isArray(branch.evidenceRefs)
            ? branch.evidenceRefs.filter(isRecord).map(parseEvidenceRef)
            : undefined,
          completedAt: stringField(branch, "completedAt"),
          ...(isRecord(branch.metadata)
            ? { metadata: { ...branch.metadata } }
            : {}),
        },
      ]),
  );
}

function parallelBranchStatus(
  value: unknown,
): WorkflowParallelBranchState["status"] {
  if (value === "passed" || value === "failed" || value === "runtime_error") {
    return value;
  }
  throw new Error("workflow parallel branch status is invalid");
}

function cloneEvidenceRef(ref: WorkflowEvidenceRef): WorkflowEvidenceRef {
  return {
    ...ref,
    metadata: ref.metadata ? { ...ref.metadata } : undefined,
  };
}

function parseEvidenceRef(raw: Record<string, unknown>): WorkflowEvidenceRef {
  const kind = raw.kind;
  if (
    kind !== "trace_span" &&
    kind !== "artifact" &&
    kind !== "task_output" &&
    kind !== "fact" &&
    kind !== "run"
  ) {
    throw new Error("workflow evidence kind is invalid");
  }
  return cloneEvidenceRef({
    kind,
    ref: stringField(raw, "ref"),
    ...(optionalString(raw.nodeId) ? { nodeId: raw.nodeId } : {}),
    ...(optionalString(raw.verifierId) ? { verifierId: raw.verifierId } : {}),
    ...(isRecord(raw.metadata) ? { metadata: { ...raw.metadata } } : {}),
  });
}

function cloneVerdictLogEntry(
  entry: WorkflowNodeVerdictLogEntry,
): WorkflowNodeVerdictLogEntry {
  return {
    ...entry,
    verdict: cloneJsonLike(entry.verdict),
    evidenceRefs: entry.evidenceRefs?.map(cloneEvidenceRef),
  };
}

function parseVerdictLogEntry(
  raw: Record<string, unknown>,
): WorkflowNodeVerdictLogEntry {
  if (typeof raw.attempt !== "number") {
    throw new Error("workflow verdict attempt must be a number");
  }
  return cloneVerdictLogEntry({
    at: stringField(raw, "at"),
    nodeId: stringField(raw, "nodeId"),
    attempt: raw.attempt,
    verdict: cloneJsonLike(raw.verdict) as WorkflowNodeVerdict,
    evidenceRefs: Array.isArray(raw.evidenceRefs)
      ? raw.evidenceRefs.filter(isRecord).map(parseEvidenceRef)
      : undefined,
  });
}

function cloneTransitionLogEntry(
  entry: WorkflowTransitionLogEntry,
): WorkflowTransitionLogEntry {
  return {
    ...entry,
    verdict: cloneJsonLike(entry.verdict),
    decision: cloneJsonLike(entry.decision),
  };
}

function parseTransitionLogEntry(
  raw: Record<string, unknown>,
): WorkflowTransitionLogEntry {
  return cloneTransitionLogEntry({
    at: stringField(raw, "at"),
    verdict: cloneJsonLike(raw.verdict) as WorkflowNodeVerdict,
    decision: cloneJsonLike(raw.decision) as WorkflowTransitionDecision,
  });
}

function cloneFailure(failure: WorkflowRunFailure): WorkflowRunFailure {
  return {
    ...failure,
    metadata: failure.metadata ? { ...failure.metadata } : undefined,
  };
}

function parseFailure(raw: Record<string, unknown>): WorkflowRunFailure {
  const kind = raw.kind;
  if (
    kind !== "verdict" &&
    kind !== "runtime" &&
    kind !== "cancelled" &&
    kind !== "definition"
  ) {
    throw new Error("workflow failure kind is invalid");
  }
  return cloneFailure({
    kind,
    code: stringField(raw, "code"),
    message: stringField(raw, "message"),
    ...(optionalString(raw.nodeId) ? { nodeId: raw.nodeId } : {}),
    ...(isRecord(raw.metadata) ? { metadata: { ...raw.metadata } } : {}),
  });
}

function cloneJsonLike<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
