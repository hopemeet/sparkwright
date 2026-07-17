import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { publishExclusiveJsonDocument } from "../doc-store/index.js";
import type {
  WorkflowRunId,
  WorkflowRunRecord,
  WorkflowStoreEvent,
} from "./types.js";

const JOURNAL_SCHEMA = "sparkwright-workflow-journal.v1" as const;

export type WorkflowJournalPayload =
  | {
      kind: "baseline";
      generation: 0;
      recordRevision: 0;
      events: WorkflowStoreEvent[];
    }
  | {
      kind: "claim";
      token: string;
      owner: string;
      previousGeneration: number;
      generation: number;
      expectedRecordRevision: number;
      at: string;
    }
  | {
      kind: "mutation" | "compensation";
      token: string;
      generation: number;
      expectedRecordRevision: number;
      recordRevision: number;
      record: WorkflowRunRecord;
      event: WorkflowStoreEvent;
    };

interface JournalEntry {
  schemaVersion: typeof JOURNAL_SCHEMA;
  workflowRunId: WorkflowRunId;
  physicalSequence: number;
  payload: WorkflowJournalPayload;
  checksum: string;
}

export interface WorkflowJournalHead {
  physicalSequence: number;
  recordPhysicalSequence: number;
  generation: number;
  recordRevision: number;
  token?: string;
  record?: WorkflowRunRecord;
  events: WorkflowStoreEvent[];
  quarantined: Array<{
    path: string;
    code: "read_failed" | "invalid_json" | "invalid_document";
    reason: string;
  }>;
}

export class WorkflowStaleWriteError extends Error {
  readonly code = "WORKFLOW_STALE_WRITE";
  constructor(message: string) {
    super(message);
    this.name = "WorkflowStaleWriteError";
  }
}

export function workflowJournalDir(rootDir: string, id: WorkflowRunId): string {
  return join(resolve(rootDir), `${String(id)}.journal`);
}

export async function readWorkflowJournal(
  rootDir: string,
  id: WorkflowRunId,
): Promise<WorkflowJournalHead | undefined> {
  const dir = workflowJournalDir(rootDir, id);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
  const head: WorkflowJournalHead = {
    physicalSequence: -1,
    recordPhysicalSequence: -1,
    generation: 0,
    recordRevision: 0,
    events: [],
    quarantined: [],
  };
  for (const name of names
    .filter((name) => /^\d{16}\.json$/.test(name))
    .sort()) {
    const path = join(dir, name);
    let entry: JournalEntry;
    try {
      entry = JSON.parse(await readFile(path, "utf8")) as JournalEntry;
      validateEntry(entry, id, Number(name.slice(0, 16)));
    } catch (cause) {
      head.quarantined.push({
        path,
        code: quarantineCode(cause),
        reason: errorMessage(cause),
      });
      head.physicalSequence = Math.max(
        head.physicalSequence,
        Number(name.slice(0, 16)),
      );
      continue;
    }
    applyCanonicalEntry(head, entry, path);
  }
  return head;
}

export function readWorkflowJournalSync(
  rootDir: string,
  id: WorkflowRunId,
): WorkflowJournalHead | undefined {
  const dir = workflowJournalDir(rootDir, id);
  if (!existsSync(dir)) return undefined;
  const head = emptyHead();
  for (const name of readdirSync(dir)
    .filter((name) => /^\d{16}\.json$/.test(name))
    .sort()) {
    const path = join(dir, name);
    let entry: JournalEntry;
    try {
      entry = JSON.parse(readFileSync(path, "utf8")) as JournalEntry;
      validateEntry(entry, id, Number(name.slice(0, 16)));
    } catch (cause) {
      head.quarantined.push({
        path,
        code: quarantineCode(cause),
        reason: errorMessage(cause),
      });
      head.physicalSequence = Math.max(
        head.physicalSequence,
        Number(name.slice(0, 16)),
      );
      continue;
    }
    applyCanonicalEntry(head, entry, path);
  }
  return head;
}

export async function publishWorkflowJournalEntry(input: {
  rootDir: string;
  workflowRunId: WorkflowRunId;
  physicalSequence: number;
  payload: WorkflowJournalPayload;
}): Promise<boolean> {
  const unsigned = {
    schemaVersion: JOURNAL_SCHEMA,
    workflowRunId: input.workflowRunId,
    physicalSequence: input.physicalSequence,
    payload: input.payload,
  };
  const entry: JournalEntry = { ...unsigned, checksum: checksum(unsigned) };
  return publishExclusiveJsonDocument(
    join(
      workflowJournalDir(input.rootDir, input.workflowRunId),
      `${String(input.physicalSequence).padStart(16, "0")}.json`,
    ),
    entry,
  );
}

function validateEntry(
  entry: JournalEntry,
  id: WorkflowRunId,
  sequence: number,
): void {
  if (
    entry.schemaVersion !== JOURNAL_SCHEMA ||
    entry.workflowRunId !== id ||
    entry.physicalSequence !== sequence
  )
    throw new Error("journal envelope mismatch");
  const { checksum: actual, ...unsigned } = entry;
  if (actual !== checksum(unsigned))
    throw new Error("journal checksum mismatch");
}

function emptyHead(): WorkflowJournalHead {
  return {
    physicalSequence: -1,
    recordPhysicalSequence: -1,
    generation: 0,
    recordRevision: 0,
    events: [],
    quarantined: [],
  };
}

function applyCanonicalEntry(
  head: WorkflowJournalHead,
  entry: JournalEntry,
  path: string,
): void {
  head.physicalSequence = Math.max(
    head.physicalSequence,
    entry.physicalSequence,
  );
  const payload = entry.payload;
  if (payload.kind === "baseline") {
    if (entry.physicalSequence !== 0 || head.record || head.events.length > 0) {
      head.quarantined.push({
        path,
        code: "invalid_document",
        reason: "duplicate or misplaced baseline",
      });
      return;
    }
    head.events = [...payload.events];
    return;
  }
  if (payload.kind === "claim") {
    if (
      payload.previousGeneration !== head.generation ||
      payload.generation !== head.generation + 1 ||
      payload.expectedRecordRevision !== head.recordRevision
    ) {
      head.quarantined.push({
        path,
        code: "invalid_document",
        reason: "invalid claim transition",
      });
      return;
    }
    head.generation = payload.generation;
    head.token = payload.token;
    return;
  }
  if (
    payload.generation !== head.generation ||
    payload.token !== head.token ||
    payload.expectedRecordRevision !== head.recordRevision ||
    payload.recordRevision !== head.recordRevision + 1 ||
    payload.record.recordRevision !== payload.recordRevision ||
    payload.record.generation !== payload.generation ||
    payload.record.id !== entry.workflowRunId ||
    payload.event.workflowRunId !== entry.workflowRunId ||
    !isCanonicalRecord(payload.record)
  ) {
    head.quarantined.push({
      path,
      code: "invalid_document",
      reason: "stale or discontinuous mutation",
    });
    return;
  }
  head.recordRevision = payload.recordRevision;
  head.record = payload.record;
  head.recordPhysicalSequence = entry.physicalSequence;
  head.events.push(payload.event);
}

function isCanonicalRecord(record: WorkflowRunRecord): boolean {
  return (
    record.schemaVersion === "sparkwright-workflow-run.v2" &&
    Number.isInteger(record.generation) &&
    record.generation >= 1 &&
    Number.isInteger(record.recordRevision) &&
    record.recordRevision >= 1 &&
    (record.layer === "builtin" ||
      record.layer === "user" ||
      record.layer === "project") &&
    typeof record.packageHash === "string" &&
    record.packageHash.length > 0 &&
    record.packageHashPolicyVersion === 2 &&
    typeof record.packageSnapshotRef === "string" &&
    record.packageSnapshotRef.length > 0 &&
    !("contentHash" in record) &&
    !!record.definitionSnapshot &&
    !("contentHash" in record.definitionSnapshot) &&
    record.definitionSnapshot.assetName === record.assetName &&
    record.definitionSnapshot.version === record.version &&
    record.definitionSnapshot.layer === record.layer &&
    record.definitionSnapshot.packageHash === record.packageHash &&
    record.definitionSnapshot.packageHashPolicyVersion === 2 &&
    record.definitionSnapshot.packageSnapshotRef ===
      record.packageSnapshotRef &&
    record.definitionSnapshot.sourceDir === record.packageSnapshotRef
  );
}

function checksum(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function quarantineCode(
  cause: unknown,
): "read_failed" | "invalid_json" | "invalid_document" {
  if (cause instanceof SyntaxError) return "invalid_json";
  if (cause && typeof cause === "object" && "code" in cause) {
    return "read_failed";
  }
  return "invalid_document";
}
