// AI maintenance note: the immutable workflow journal is the only durable
// record/event truth. Keep list/get/eventLog on journal replay rather than
// adding snapshot or append-log projections.

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  acquireFileDocumentLease,
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
  WorkflowParallelBranchState,
  WorkflowNodeVerdictLogEntry,
  WorkflowResumePolicy,
  WorkflowRunFailure,
  WorkflowRunId,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowStoreEvent,
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
  /** Directory containing workflow run journals and leases. */
  rootDir: string;
  /** Create the root eagerly. Set false for read-only inspection commands. */
  createRoot?: boolean;
}

export class FileWorkflowStore implements WorkflowStore {
  readonly rootDir: string;

  constructor(options: FileWorkflowStoreOptions) {
    this.rootDir = resolve(options.rootDir);
    if (options.createRoot !== false) {
      mkdirSync(this.rootDir, { recursive: true });
    }
  }

  get(id: WorkflowRunId): WorkflowRunRecord | undefined {
    assertSafeWorkflowRunId(id);
    return cloneOptionalRecord(
      readWorkflowJournalSync(this.rootDir, id)?.record,
    );
  }

  list(): WorkflowStoreListResult {
    const records: WorkflowRunRecord[] = [];
    const invalidEntries: JsonDocumentInvalidEntry[] = [];
    for (const entry of existsSync(this.rootDir)
      ? readdirSync(this.rootDir, { withFileTypes: true }).sort((left, right) =>
          left.name.localeCompare(right.name),
        )
      : []) {
      if (!entry.isDirectory() || !entry.name.endsWith(".journal")) continue;
      const rawId = entry.name.slice(0, -".journal".length);
      if (!isSafeWorkflowRunId(rawId)) {
        invalidEntries.push({
          path: join(this.rootDir, entry.name),
          code: "invalid_document",
          reason: `Unsafe workflow run id: ${rawId}`,
        });
        continue;
      }
      const canonical = readWorkflowJournalSync(
        this.rootDir,
        rawId as WorkflowRunId,
      );
      if (canonical?.record) records.push(cloneRecord(canonical.record));
      invalidEntries.push(
        ...(canonical?.quarantined.map(({ path, code, reason }) => ({
          path,
          code,
          reason,
        })) ?? []),
      );
    }
    return { records, invalidEntries };
  }

  eventLog(id: WorkflowRunId): WorkflowStoreEventLogResult {
    assertSafeWorkflowRunId(id);
    const canonical = readWorkflowJournalSync(this.rootDir, id);
    return {
      events: canonical?.events.map((event) => ({ ...event })) ?? [],
      invalidEntries:
        canonical?.quarantined.map((entry) => ({ ...entry, line: 0 })) ?? [],
    };
  }

  canonicalGeneration(id: WorkflowRunId): number {
    assertSafeWorkflowRunId(id);
    return readWorkflowJournalSync(this.rootDir, id)?.generation ?? 0;
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
        const published = await publishWorkflowJournalEntry({
          rootDir: this.rootDir,
          workflowRunId: id,
          physicalSequence: 0,
          payload: {
            kind: "baseline",
            generation: 0,
            recordRevision: 0,
            events: [],
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

  private leasePath(id: WorkflowRunId): string {
    return join(this.rootDir, `${String(id)}.lease`);
  }
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

function cloneAuthorizationSnapshot(
  snapshot: NonNullable<WorkflowRunRecord["authorizationSnapshot"]>,
): NonNullable<WorkflowRunRecord["authorizationSnapshot"]> {
  return {
    ...snapshot,
    confidentialPaths: [...snapshot.confidentialPaths],
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

function cloneEvidenceRef(ref: WorkflowEvidenceRef): WorkflowEvidenceRef {
  return {
    ...ref,
    metadata: ref.metadata ? { ...ref.metadata } : undefined,
  };
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

function cloneTransitionLogEntry(
  entry: WorkflowTransitionLogEntry,
): WorkflowTransitionLogEntry {
  return {
    ...entry,
    verdict: cloneJsonLike(entry.verdict),
    decision: cloneJsonLike(entry.decision),
  };
}

function cloneFailure(failure: WorkflowRunFailure): WorkflowRunFailure {
  return {
    ...failure,
    metadata: failure.metadata ? { ...failure.metadata } : undefined,
  };
}

function cloneJsonLike<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
