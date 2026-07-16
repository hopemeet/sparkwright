// AI maintenance note: durable workflow stores mirror the task store shape, but
// compose doc-store primitives so workflow persistence does not grow another
// hand-rolled atomic-write/log/lease copy.

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  acquireFileDocumentLease,
  atomicWriteTextSync,
  readJsonDocumentDirSync,
  readJsonDocumentLogSync,
  writeJsonDocumentSync,
  type JsonDocumentInvalidEntry,
  type JsonDocumentLogInvalidEntry,
} from "../doc-store/index.js";
import {
  publishWorkflowJournalEntry,
  readWorkflowJournal,
  readWorkflowJournalSync,
  WorkflowStaleWriteError,
  type WorkflowJournalHead,
} from "./journal.js";
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
  authorizationSnapshot?: WorkflowRunRecord["authorizationSnapshot"];
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
  clearFailure?: boolean;
  resume?: Partial<WorkflowResumePolicy>;
  authorizationSnapshot?: WorkflowRunRecord["authorizationSnapshot"];
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

export interface WorkflowLeaseBoundWriter {
  readonly workflowRunId: WorkflowRunId;
  readonly token: string;
  readonly generation: number;
  readFresh(): Promise<WorkflowRunRecord | undefined>;
  create(input: CreateWorkflowRunRecordInput): Promise<WorkflowRunRecord>;
  mutate(input: {
    expectedRevision: number;
    patch: WorkflowRunRecordPatch;
    event: WorkflowStoreEvent;
  }): Promise<WorkflowRunRecord>;
  compensate(input: {
    expectedRevision: number;
    patch: WorkflowRunRecordPatch;
    event: WorkflowStoreEvent;
  }): Promise<WorkflowRunRecord>;
  refresh(ttlMs?: number): Promise<boolean>;
  release(): Promise<boolean>;
}

export interface WorkflowStore {
  get(id: WorkflowRunId): WorkflowRunRecord | undefined;
  list(): WorkflowStoreListResult;
  /** @reserved Public workflow-store log reader consumed by future workflow diagnostics/resume UIs. */
  eventLog(id: WorkflowRunId): WorkflowStoreEventLogResult;
  canonicalGeneration(id: WorkflowRunId): number;
  acquireWriter(
    id: WorkflowRunId,
    options?: { owner?: string; ttlMs?: number; now?: () => Date },
  ): Promise<WorkflowLeaseBoundWriter | null>;
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

  eventLog(id: WorkflowRunId): WorkflowStoreEventLogResult {
    assertSafeWorkflowRunId(id);
    const canonical = readWorkflowJournalSync(this.rootDir, id);
    if (canonical) {
      return {
        events: canonical.events.map((event) => ({ ...event })),
        invalidEntries: canonical.quarantined.map((entry) => ({
          path: entry.path,
          code: "invalid_document" as const,
          reason: entry.reason,
          line: 0,
        })),
      };
    }
    const result = readJsonDocumentLogSync<WorkflowStoreEvent>({
      path: this.eventLogPath(id),
      parse: parseWorkflowStoreEvent,
    });
    return {
      events: result.entries.map((entry) => entry.value),
      invalidEntries: result.invalidEntries,
    };
  }

  canonicalGeneration(id: WorkflowRunId): number {
    assertSafeWorkflowRunId(id);
    return (
      readWorkflowJournalSync(this.rootDir, id)?.generation ??
      this.records.get(id)?.generation ??
      0
    );
  }

  async acquireWriter(
    id: WorkflowRunId,
    options: { owner?: string; ttlMs?: number; now?: () => Date } = {},
  ): Promise<WorkflowLeaseBoundWriter | null> {
    assertSafeWorkflowRunId(id);
    const lease = await acquireFileDocumentLease({
      path: this.leasePath(id),
      owner: options.owner,
      ttlMs: options.ttlMs,
      now: options.now,
    });
    if (!lease) return null;
    try {
      let head = await readWorkflowJournal(this.rootDir, id);
      if (!head) {
        const legacyRecord = this.get(id);
        const legacyEvents = this.eventLog(id).events;
        const published = await publishWorkflowJournalEntry({
          rootDir: this.rootDir,
          workflowRunId: id,
          physicalSequence: 0,
          payload: {
            kind: "baseline",
            generation: 0,
            recordRevision: 0,
            ...(legacyRecord
              ? {
                  record: {
                    ...legacyRecord,
                    generation: 0,
                    recordRevision: 0,
                  },
                }
              : {}),
            legacyEvents,
          },
        });
        if (!published)
          throw new WorkflowStaleWriteError("baseline publication conflicted");
        head = await readWorkflowJournal(this.rootDir, id);
      }
      if (!head) throw new Error("workflow journal baseline is unreadable");
      const generation = head.generation + 1;
      const claimed = await publishWorkflowJournalEntry({
        rootDir: this.rootDir,
        workflowRunId: id,
        physicalSequence: head.physicalSequence + 1,
        payload: {
          kind: "claim",
          token: lease.token,
          owner: lease.owner,
          previousGeneration: head.generation,
          generation,
          expectedRecordRevision: head.recordRevision,
          at: options.now?.().toISOString() ?? new Date().toISOString(),
        },
      });
      if (!claimed)
        throw new WorkflowStaleWriteError("workflow claim conflicted");
      const claimedHead = await readWorkflowJournal(this.rootDir, id);
      if (
        claimedHead?.token !== lease.token ||
        claimedHead.generation !== generation
      ) {
        throw new WorkflowStaleWriteError(
          "workflow claim did not become canonical",
        );
      }
      const mutate = async (
        kind: "mutation" | "compensation",
        input: {
          expectedRevision: number;
          patch: WorkflowRunRecordPatch;
          event: WorkflowStoreEvent;
        },
      ): Promise<WorkflowRunRecord> => {
        if (!(await lease.refresh())) {
          throw new WorkflowStaleWriteError(
            "workflow lease is no longer active",
          );
        }
        const fresh = await readWorkflowJournal(this.rootDir, id);
        assertWriterHead(
          fresh,
          lease.token,
          generation,
          input.expectedRevision,
        );
        if (!fresh?.record) throw new Error(`Workflow run not found: ${id}`);
        const recordRevision = input.expectedRevision + 1;
        const record = applyWorkflowPatch(fresh.record, input.patch, {
          generation,
          recordRevision,
        });
        const published = await publishWorkflowJournalEntry({
          rootDir: this.rootDir,
          workflowRunId: id,
          physicalSequence: fresh.physicalSequence + 1,
          payload: {
            kind,
            token: lease.token,
            generation,
            expectedRecordRevision: input.expectedRevision,
            recordRevision,
            record,
            event: { ...input.event, workflowRunId: id, status: record.status },
          },
        });
        if (!published)
          throw new WorkflowStaleWriteError(
            "workflow revision publication conflicted",
          );
        const canonical = await readWorkflowJournal(this.rootDir, id);
        if (
          canonical?.token !== lease.token ||
          canonical.generation !== generation ||
          canonical.recordRevision !== recordRevision ||
          canonical.recordPhysicalSequence !== fresh.physicalSequence + 1 ||
          canonical.record?.id !== id
        )
          throw new WorkflowStaleWriteError(
            "published workflow revision was quarantined",
          );
        this.projectCanonical(id, canonical);
        return cloneRecord(canonical.record);
      };
      return {
        workflowRunId: id,
        token: lease.token,
        generation,
        readFresh: async () =>
          cloneOptionalRecord(
            (await readWorkflowJournal(this.rootDir, id))?.record,
          ),
        create: async (input) => {
          if (input.id !== id) {
            throw new Error(
              `Workflow writer ${id} cannot create record ${input.id}.`,
            );
          }
          const fresh = await readWorkflowJournal(this.rootDir, id);
          assertWriterHead(fresh, lease.token, generation, 0);
          if (fresh?.record)
            throw new Error(`Workflow run already exists: ${id}`);
          const now = input.now?.() ?? new Date().toISOString();
          const record = buildWorkflowRecord(input, {
            generation,
            recordRevision: 1,
            now,
          });
          const event: WorkflowStoreEvent = {
            at: now,
            type: "created",
            workflowRunId: id,
            parentRunId: record.parentRunId,
            status: record.status,
            metadata: {
              assetName: record.assetName,
              version: record.version,
              contentHash: record.contentHash,
            },
          };
          const published = await publishWorkflowJournalEntry({
            rootDir: this.rootDir,
            workflowRunId: id,
            physicalSequence: fresh.physicalSequence + 1,
            payload: {
              kind: "mutation",
              token: lease.token,
              generation,
              expectedRecordRevision: 0,
              recordRevision: 1,
              record,
              event,
            },
          });
          if (!published)
            throw new WorkflowStaleWriteError(
              "workflow create publication conflicted",
            );
          const canonical = await readWorkflowJournal(this.rootDir, id);
          if (
            canonical?.recordRevision !== 1 ||
            canonical.recordPhysicalSequence !== fresh.physicalSequence + 1 ||
            canonical.token !== lease.token ||
            !canonical.record
          ) {
            throw new WorkflowStaleWriteError(
              "workflow create did not become canonical",
            );
          }
          this.projectCanonical(id, canonical);
          return cloneRecord(canonical.record);
        },
        mutate: (input) => mutate("mutation", input),
        compensate: (input) => mutate("compensation", input),
        refresh: (ttlMs) => lease.refresh(ttlMs),
        release: () => lease.release(),
      };
    } catch (cause) {
      await lease.release();
      if (cause instanceof WorkflowStaleWriteError) return null;
      throw cause;
    }
  }

  private projectCanonical(id: WorkflowRunId, head: WorkflowJournalHead): void {
    if (!head.record) return;
    this.records.set(id, cloneRecord(head.record));
    this.writeRecord(head.record);
    atomicWriteTextSync(
      this.eventLogPath(id),
      head.events.map((event) => JSON.stringify(event)).join("\n") +
        (head.events.length ? "\n" : ""),
      { durable: true },
    );
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
    for (const entry of existsSync(this.rootDir)
      ? readdirSync(this.rootDir, { withFileTypes: true })
      : []) {
      if (!entry.isDirectory() || !entry.name.endsWith(".journal")) continue;
      const rawId = entry.name.slice(0, -".journal".length);
      if (!isSafeWorkflowRunId(rawId)) continue;
      const id = rawId as WorkflowRunId;
      const canonical = readWorkflowJournalSync(this.rootDir, id);
      if (canonical?.record)
        this.records.set(id, cloneRecord(canonical.record));
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

function assertWriterHead(
  head: WorkflowJournalHead | undefined,
  token: string,
  generation: number,
  expectedRevision: number,
): asserts head is WorkflowJournalHead {
  if (
    !head ||
    head.token !== token ||
    head.generation !== generation ||
    head.recordRevision !== expectedRevision
  ) {
    throw new WorkflowStaleWriteError(
      `stale workflow writer: expected generation ${generation} revision ${expectedRevision}`,
    );
  }
}

function cloneOptionalRecord(
  record: WorkflowRunRecord | undefined,
): WorkflowRunRecord | undefined {
  return record ? cloneRecord(record) : undefined;
}

function buildWorkflowRecord(
  input: CreateWorkflowRunRecordInput,
  state: { generation: number; recordRevision: number; now: string },
): WorkflowRunRecord {
  return {
    schemaVersion: WORKFLOW_RUN_RECORD_SCHEMA_VERSION,
    id: input.id,
    generation: state.generation,
    recordRevision: state.recordRevision,
    assetName: input.assetName,
    ...(input.layer ? { layer: input.layer } : {}),
    ...(input.version ? { version: input.version } : {}),
    contentHash: input.contentHash,
    ...(input.packageHash ? { packageHash: input.packageHash } : {}),
    ...(input.packageHashPolicyVersion
      ? { packageHashPolicyVersion: input.packageHashPolicyVersion }
      : {}),
    ...(input.packageSnapshotRef
      ? { packageSnapshotRef: input.packageSnapshotRef }
      : {}),
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
    ...(input.authorizationSnapshot
      ? {
          authorizationSnapshot: cloneAuthorizationSnapshot(
            input.authorizationSnapshot,
          ),
        }
      : {}),
    ...(input.definitionSnapshot
      ? { definitionSnapshot: cloneJsonLike(input.definitionSnapshot) }
      : {}),
    createdAt: state.now,
    updatedAt: state.now,
    metadata: { ...(input.metadata ?? {}) },
  };
}

function applyWorkflowPatch(
  existing: WorkflowRunRecord,
  patch: WorkflowRunRecordPatch,
  state: { generation: number; recordRevision: number },
): WorkflowRunRecord {
  const now = patch.now?.() ?? new Date().toISOString();
  const status = patch.status ?? existing.status;
  const wait =
    isTerminalStatus(status) || patch.clearWait
      ? undefined
      : patch.wait
        ? {
            ...cloneWait(patch.wait),
            id: patch.wait.id ?? `workflow_wait_${state.recordRevision}`,
          }
        : existing.wait;
  if (status === "waiting" && !wait)
    throw new Error("Workflow waiting status requires wait.kind.");
  const runIds =
    patch.appendRunId && !existing.runIds.includes(patch.appendRunId)
      ? [...existing.runIds, patch.appendRunId]
      : existing.runIds;
  const completedAt =
    patch.completedAt ??
    (isTerminalStatus(status) && !existing.completedAt
      ? now
      : existing.completedAt);
  return {
    ...existing,
    generation: state.generation,
    recordRevision: state.recordRevision,
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
    ...(patch.clearFailure
      ? { failure: undefined }
      : patch.failure
        ? { failure: cloneFailure(patch.failure) }
        : {}),
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
    ...(patch.authorizationSnapshot
      ? {
          authorizationSnapshot: cloneAuthorizationSnapshot(
            patch.authorizationSnapshot,
          ),
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
    ...(typeof raw.recordRevision === "number"
      ? { recordRevision: raw.recordRevision }
      : {}),
    ...(typeof raw.generation === "number"
      ? { generation: raw.generation }
      : {}),
    assetName,
    ...(raw.layer === "builtin" ||
    raw.layer === "user" ||
    raw.layer === "project" ||
    raw.layer === "unknown"
      ? { layer: raw.layer }
      : {}),
    ...(optionalString(raw.version) ? { version: raw.version } : {}),
    contentHash,
    ...(optionalString(raw.packageHash)
      ? { packageHash: raw.packageHash }
      : {}),
    ...(raw.packageHashPolicyVersion === 2
      ? { packageHashPolicyVersion: 2 as const }
      : {}),
    ...(optionalString(raw.packageSnapshotRef)
      ? { packageSnapshotRef: raw.packageSnapshotRef }
      : {}),
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
    ...parseOptionalAuthorizationSnapshot(raw.authorizationSnapshot),
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
    authorizationSnapshot: record.authorizationSnapshot
      ? cloneAuthorizationSnapshot(record.authorizationSnapshot)
      : undefined,
    definitionSnapshot: record.definitionSnapshot
      ? cloneJsonLike(record.definitionSnapshot)
      : undefined,
    metadata: { ...record.metadata },
  };
}

function parseOptionalAuthorizationSnapshot(
  raw: unknown,
): Pick<WorkflowRunRecord, "authorizationSnapshot"> {
  if (!isRecord(raw)) return {};
  const snapshot = parseAuthorizationSnapshot(raw);
  return snapshot ? { authorizationSnapshot: snapshot } : {};
}

function parseAuthorizationSnapshot(
  raw: Record<string, unknown>,
): WorkflowRunRecord["authorizationSnapshot"] | undefined {
  if (
    !Array.isArray(raw.confidentialPaths) ||
    !raw.confidentialPaths.every(optionalString) ||
    typeof raw.confidentialDefaults !== "boolean" ||
    !isWorkflowRunAccessMode(raw.accessMode) ||
    !isWorkflowBackgroundTaskPolicy(raw.backgroundTasks)
  ) {
    return undefined;
  }
  return {
    ...(optionalString(raw.targetPath) ? { targetPath: raw.targetPath } : {}),
    confidentialPaths: [...raw.confidentialPaths],
    confidentialDefaults: raw.confidentialDefaults,
    accessMode: raw.accessMode,
    backgroundTasks: raw.backgroundTasks,
  };
}

function cloneAuthorizationSnapshot(
  snapshot: NonNullable<WorkflowRunRecord["authorizationSnapshot"]>,
): NonNullable<WorkflowRunRecord["authorizationSnapshot"]> {
  return {
    ...snapshot,
    confidentialPaths: [...snapshot.confidentialPaths],
  };
}

function isWorkflowRunAccessMode(
  value: unknown,
): value is NonNullable<
  WorkflowRunRecord["authorizationSnapshot"]
>["accessMode"] {
  return (
    value === "read-only" ||
    value === "ask" ||
    value === "accept-edits" ||
    value === "bypass"
  );
}

function isWorkflowBackgroundTaskPolicy(
  value: unknown,
): value is NonNullable<
  WorkflowRunRecord["authorizationSnapshot"]
>["backgroundTasks"] {
  return (
    value === "disabled" || value === "foreground-only" || value === "enabled"
  );
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
