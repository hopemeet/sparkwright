import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const WORKFLOW_SERVICE_SCHEMA_VERSION =
  "sparkwright-workflow-service.v1" as const;

export type WorkflowServiceState =
  | "starting"
  | "ready"
  | "draining"
  | "stopped";

export interface WorkflowServiceInstance {
  schemaVersion: typeof WORKFLOW_SERVICE_SCHEMA_VERSION;
  instanceId: string;
  workspaceId: string;
  pid: number;
  state: WorkflowServiceState;
  startedAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface WorkflowServiceHandoff {
  schemaVersion: typeof WORKFLOW_SERVICE_SCHEMA_VERSION;
  handoffId: string;
  idempotencyKey: string;
  workspaceId: string;
  workflowName: string;
  goal: string;
  jobSessionId: string;
  controlSessionId?: string;
  modelName?: string;
  accessMode?: "read-only" | "ask" | "accept-edits" | "bypass";
  permissionMode:
    | "default"
    | "plan"
    | "accept_edits"
    | "dont_ask"
    | "bypass_permissions";
  shouldWrite: boolean;
  traceLevel: "standard" | "debug";
  targetPath?: string;
  confidentialPaths?: string[];
  confidentialDefaults?: boolean;
  source: { kind: "cli"; principalId: string };
  createdAt: string;
  expiresAt: string;
}

export interface WorkflowServiceOutcome {
  schemaVersion: typeof WORKFLOW_SERVICE_SCHEMA_VERSION;
  handoffId: string;
  status: "accepted" | "rejected";
  decidedAt: string;
  workflowRunId?: string;
  sessionId?: string;
  code?: string;
  message?: string;
}

export interface WorkflowServiceAdapter {
  accept(
    handoff: WorkflowServiceHandoff,
  ): Promise<{ workflowRunId: string; sessionId: string }>;
  recover?(
    handoff: WorkflowServiceHandoff,
  ): Promise<{ workflowRunId: string; sessionId: string } | undefined>;
}

export class FileWorkflowServiceStore {
  readonly rootDir: string;
  private readonly now: () => Date;

  constructor(options: { rootDir: string; now?: () => Date }) {
    this.rootDir = resolve(options.rootDir);
    this.now = options.now ?? (() => new Date());
  }

  async publishHandoff(
    input: Omit<WorkflowServiceHandoff, "schemaVersion" | "createdAt"> & {
      createdAt?: string;
    },
  ): Promise<WorkflowServiceHandoff> {
    validateSegment(input.handoffId, "handoffId");
    const handoff: WorkflowServiceHandoff = {
      ...input,
      schemaVersion: WORKFLOW_SERVICE_SCHEMA_VERSION,
      createdAt: input.createdAt ?? this.now().toISOString(),
    };
    validateHandoff(handoff);
    await mkdir(this.handoffsDir(), { recursive: true });
    const path = this.handoffPath(handoff.handoffId);
    if (!(await publishExclusive(path, handoff))) {
      const existing = this.readHandoff(handoff.handoffId);
      if (existing && handoffDigest(existing) === handoffDigest(handoff))
        return existing;
      throw new Error(`Workflow handoff conflict: ${handoff.handoffId}`);
    }
    return handoff;
  }

  readHandoff(handoffId: string): WorkflowServiceHandoff | undefined {
    return readJson(this.handoffPath(handoffId), validateHandoff);
  }

  readOutcome(handoffId: string): WorkflowServiceOutcome | undefined {
    return readJson(this.outcomePath(handoffId), validateOutcome);
  }

  async publishOutcome(outcome: WorkflowServiceOutcome): Promise<boolean> {
    validateOutcome(outcome);
    await mkdir(this.outcomesDir(), { recursive: true });
    return publishExclusive(this.outcomePath(outcome.handoffId), outcome);
  }

  async pending(): Promise<WorkflowServiceHandoff[]> {
    let names: string[];
    try {
      names = await readdir(this.handoffsDir());
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw cause;
    }
    return names
      .filter((name) => name.endsWith(".json"))
      .flatMap((name) => {
        const id = name.slice(0, -5);
        if (this.readOutcome(id)) return [];
        const handoff = this.readHandoff(id);
        return handoff ? [handoff] : [];
      })
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? a.handoffId.localeCompare(b.handoffId)
          : a.createdAt.localeCompare(b.createdAt),
      );
  }

  readInstance(): WorkflowServiceInstance | undefined {
    return readJson(this.instancePath(), validateInstance);
  }

  async requestDrain(instanceId: string): Promise<void> {
    validateSegment(instanceId, "instanceId");
    await atomicWrite(join(this.rootDir, "drain.json"), {
      schemaVersion: WORKFLOW_SERVICE_SCHEMA_VERSION,
      instanceId,
      requestedAt: this.now().toISOString(),
    });
  }

  drainRequested(instanceId: string): boolean {
    try {
      const value = JSON.parse(
        readFileSync(join(this.rootDir, "drain.json"), "utf8"),
      ) as Record<string, unknown>;
      return (
        value.schemaVersion === WORKFLOW_SERVICE_SCHEMA_VERSION &&
        value.instanceId === instanceId
      );
    } catch {
      return false;
    }
  }

  async acquireInstance(input: {
    workspaceId: string;
    instanceId?: string;
    pid?: number;
    ttlMs?: number;
  }): Promise<WorkflowServiceInstanceHandle | undefined> {
    await mkdir(this.rootDir, { recursive: true });
    const at = this.now();
    const existing = this.readInstance();
    if (existing && Date.parse(existing.expiresAt) > at.getTime())
      return undefined;
    if (existsSync(this.instancePath())) {
      await rm(this.instancePath(), { force: true });
    }
    const ttlMs = positiveTtl(input.ttlMs);
    let current: WorkflowServiceInstance = {
      schemaVersion: WORKFLOW_SERVICE_SCHEMA_VERSION,
      instanceId: input.instanceId ?? randomUUID(),
      workspaceId: input.workspaceId,
      pid: input.pid ?? process.pid,
      state: "starting",
      startedAt: at.toISOString(),
      heartbeatAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + ttlMs).toISOString(),
    };
    if (!(await publishExclusive(this.instancePath(), current)))
      return undefined;
    const update = async (state: WorkflowServiceState): Promise<boolean> => {
      const fresh = this.readInstance();
      if (!fresh || fresh.instanceId !== current.instanceId) return false;
      if (fresh.state === "stopped") return false;
      const now = this.now();
      if (Date.parse(fresh.expiresAt) <= now.getTime()) return false;
      current = {
        ...fresh,
        state,
        heartbeatAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      };
      await atomicWrite(this.instancePath(), current);
      return true;
    };
    return {
      record: () => ({ ...current }),
      ready: () => update("ready"),
      heartbeat: () => update(current.state),
      drain: () => update("draining"),
      stop: () => update("stopped"),
    };
  }

  private instancePath(): string {
    return join(this.rootDir, "instance.json");
  }
  private handoffsDir(): string {
    return join(this.rootDir, "handoffs");
  }
  private outcomesDir(): string {
    return join(this.rootDir, "outcomes");
  }
  private handoffPath(id: string): string {
    validateSegment(id, "handoffId");
    return join(this.handoffsDir(), `${id}.json`);
  }
  private outcomePath(id: string): string {
    validateSegment(id, "handoffId");
    return join(this.outcomesDir(), `${id}.json`);
  }
}

export interface WorkflowServiceInstanceHandle {
  record(): WorkflowServiceInstance;
  ready(): Promise<boolean>;
  heartbeat(): Promise<boolean>;
  drain(): Promise<boolean>;
  stop(): Promise<boolean>;
}

export class WorkflowServiceCarrier {
  private accepting = true;
  private active = 0;

  constructor(
    private readonly options: {
      store: FileWorkflowServiceStore;
      instance: WorkflowServiceInstanceHandle;
      adapter: WorkflowServiceAdapter;
      maxConcurrent?: number;
      now?: () => Date;
    },
  ) {}

  async start(): Promise<boolean> {
    await this.runOnce();
    return this.options.instance.ready();
  }

  async runOnce(): Promise<{ accepted: string[]; rejected: string[] }> {
    const report = { accepted: [] as string[], rejected: [] as string[] };
    if (!this.accepting) return report;
    const room = Math.max(0, (this.options.maxConcurrent ?? 1) - this.active);
    const pending = (await this.options.store.pending()).slice(0, room);
    await Promise.all(
      pending.map(async (handoff) => {
        this.active += 1;
        try {
          const now = this.options.now?.() ?? new Date();
          const instance = this.options.instance.record();
          const canonicalInstance = this.options.store.readInstance();
          if (
            !canonicalInstance ||
            canonicalInstance.instanceId !== instance.instanceId ||
            Date.parse(canonicalInstance.expiresAt) <= now.getTime()
          ) {
            return;
          }
          if (
            (canonicalInstance.state !== "ready" &&
              canonicalInstance.state !== "starting") ||
            handoff.workspaceId !== instance.workspaceId ||
            Date.parse(handoff.expiresAt) <= now.getTime()
          ) {
            await this.reject(
              handoff,
              "handoff_rejected",
              "handoff expired or workspace mismatch",
            );
            report.rejected.push(handoff.handoffId);
            return;
          }
          const recovered = await this.options.adapter.recover?.(handoff);
          const accepted =
            recovered ?? (await this.options.adapter.accept(handoff));
          const published = await this.options.store.publishOutcome({
            schemaVersion: WORKFLOW_SERVICE_SCHEMA_VERSION,
            handoffId: handoff.handoffId,
            status: "accepted",
            decidedAt: now.toISOString(),
            workflowRunId: accepted.workflowRunId,
            sessionId: accepted.sessionId,
          });
          if (
            published ||
            this.options.store.readOutcome(handoff.handoffId)?.status ===
              "accepted"
          )
            report.accepted.push(handoff.handoffId);
        } catch (cause) {
          const recovered = await this.options.adapter.recover?.(handoff);
          if (recovered) {
            await this.options.store.publishOutcome({
              schemaVersion: WORKFLOW_SERVICE_SCHEMA_VERSION,
              handoffId: handoff.handoffId,
              status: "accepted",
              decidedAt: (this.options.now?.() ?? new Date()).toISOString(),
              workflowRunId: recovered.workflowRunId,
              sessionId: recovered.sessionId,
            });
            report.accepted.push(handoff.handoffId);
            return;
          }
          await this.reject(
            handoff,
            "handoff_start_failed",
            cause instanceof Error ? cause.message : String(cause),
          );
          report.rejected.push(handoff.handoffId);
        } finally {
          this.active -= 1;
        }
      }),
    );
    return report;
  }

  async drain(): Promise<{ drained: boolean; active: number }> {
    this.accepting = false;
    await this.options.instance.drain();
    return { drained: this.active === 0, active: this.active };
  }

  async stop(): Promise<void> {
    this.accepting = false;
    await this.options.instance.stop();
  }

  private async reject(
    handoff: WorkflowServiceHandoff,
    code: string,
    message: string,
  ): Promise<void> {
    await this.options.store.publishOutcome({
      schemaVersion: WORKFLOW_SERVICE_SCHEMA_VERSION,
      handoffId: handoff.handoffId,
      status: "rejected",
      decidedAt: (this.options.now?.() ?? new Date()).toISOString(),
      code,
      message,
    });
  }
}

async function publishExclusive(
  path: string,
  value: unknown,
): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  try {
    const handle = await open(path, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw cause;
  }
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, `${JSON.stringify(value)}\n`, { flag: "wx" });
  await rename(tmp, path);
}

function readJson<T>(
  path: string,
  validate: (value: unknown) => asserts value is T,
): T | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    validate(value);
    return value;
  } catch {
    return undefined;
  }
}

function validateInstance(
  value: unknown,
): asserts value is WorkflowServiceInstance {
  const record = value as Partial<WorkflowServiceInstance>;
  if (
    !record ||
    record.schemaVersion !== WORKFLOW_SERVICE_SCHEMA_VERSION ||
    typeof record.instanceId !== "string" ||
    typeof record.workspaceId !== "string" ||
    typeof record.pid !== "number" ||
    !["starting", "ready", "draining", "stopped"].includes(
      record.state ?? "",
    ) ||
    typeof record.startedAt !== "string" ||
    typeof record.heartbeatAt !== "string" ||
    typeof record.expiresAt !== "string"
  )
    throw new Error("invalid workflow service instance");
}

function validateHandoff(
  value: unknown,
): asserts value is WorkflowServiceHandoff {
  const record = value as Partial<WorkflowServiceHandoff>;
  if (
    !record ||
    record.schemaVersion !== WORKFLOW_SERVICE_SCHEMA_VERSION ||
    typeof record.handoffId !== "string" ||
    typeof record.idempotencyKey !== "string" ||
    typeof record.workspaceId !== "string" ||
    typeof record.workflowName !== "string" ||
    typeof record.goal !== "string" ||
    typeof record.jobSessionId !== "string" ||
    typeof record.permissionMode !== "string" ||
    typeof record.shouldWrite !== "boolean" ||
    typeof record.traceLevel !== "string" ||
    record.source?.kind !== "cli" ||
    typeof record.source.principalId !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.expiresAt !== "string"
  )
    throw new Error("invalid workflow service handoff");
  validateSegment(record.handoffId, "handoffId");
}

function validateOutcome(
  value: unknown,
): asserts value is WorkflowServiceOutcome {
  const record = value as Partial<WorkflowServiceOutcome>;
  if (
    !record ||
    record.schemaVersion !== WORKFLOW_SERVICE_SCHEMA_VERSION ||
    typeof record.handoffId !== "string" ||
    !["accepted", "rejected"].includes(record.status ?? "") ||
    typeof record.decidedAt !== "string"
  )
    throw new Error("invalid workflow service outcome");
}

function handoffDigest(value: WorkflowServiceHandoff): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validateSegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error(`Unsafe ${label}: ${value}`);
}

function positiveTtl(value = 30_000): number {
  if (!Number.isInteger(value) || value < 1)
    throw new Error("service ttlMs must be positive");
  return value;
}
