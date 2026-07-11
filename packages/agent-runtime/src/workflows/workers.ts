import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  atomicWriteText,
  publishExclusiveJsonDocument,
} from "../doc-store/index.js";

export const WORKFLOW_WORKER_SCHEMA_VERSION =
  "sparkwright-workflow-worker.v1" as const;

export type WorkflowWorkerState = "active" | "draining" | "stopped";

export interface WorkflowWorkerRegistration {
  schemaVersion: typeof WORKFLOW_WORKER_SCHEMA_VERSION;
  workerId: string;
  instanceId: string;
  workspaceId: string;
  state: WorkflowWorkerState;
  token: string;
  registeredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  /** @reserved Serialized worker shutdown audit timestamp consumed by future service diagnostics. */
  stoppedAt?: string;
}

export interface WorkflowWorkerHandle {
  readonly workerId: string;
  readonly instanceId: string;
  readonly token: string;
  record(): WorkflowWorkerRegistration;
  heartbeat(ttlMs?: number): Promise<boolean>;
  drain(): Promise<boolean>;
  stop(): Promise<boolean>;
}

export class FileWorkflowWorkerRegistry {
  readonly rootDir: string;

  constructor(options: {
    rootDir: string;
    createRoot?: boolean;
    now?: () => Date;
  }) {
    this.rootDir = resolve(options.rootDir);
    this.now = options.now ?? (() => new Date());
    if (options.createRoot !== false)
      void mkdir(this.rootDir, { recursive: true });
  }

  private readonly now: () => Date;

  async register(input: {
    workerId: string;
    instanceId?: string;
    workspaceId: string;
    ttlMs?: number;
  }): Promise<WorkflowWorkerHandle> {
    assertSegment(input.workerId, "workerId");
    const instanceId = input.instanceId ?? randomUUID();
    assertSegment(instanceId, "instanceId");
    const token = randomUUID();
    const ttlMs = positiveTtl(input.ttlMs);
    const now = this.now();
    const record: WorkflowWorkerRegistration = {
      schemaVersion: WORKFLOW_WORKER_SCHEMA_VERSION,
      workerId: input.workerId,
      instanceId,
      workspaceId: input.workspaceId,
      state: "active",
      token,
      registeredAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    };
    const path = this.path(input.workerId, instanceId);
    if (!(await publishExclusiveJsonDocument(path, record))) {
      throw new Error(
        `Workflow worker instance already exists: ${input.workerId}/${instanceId}`,
      );
    }
    let current = record;
    const update = async (
      nextState: WorkflowWorkerState,
      nextTtlMs = ttlMs,
    ): Promise<boolean> => {
      const fresh = this.read(input.workerId, instanceId);
      if (!fresh || fresh.token !== token || fresh.state === "stopped")
        return false;
      const at = this.now();
      if (Date.parse(fresh.expiresAt) <= at.getTime()) return false;
      if (nextState === "active" && fresh.state === "draining") return false;
      current = {
        ...fresh,
        state: nextState,
        heartbeatAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + nextTtlMs).toISOString(),
        ...(nextState === "stopped" ? { stoppedAt: at.toISOString() } : {}),
      };
      await atomicWriteText(path, `${JSON.stringify(current)}\n`, {
        durable: true,
      });
      return true;
    };
    return {
      workerId: input.workerId,
      instanceId,
      token,
      record: () => ({ ...current }),
      heartbeat: (nextTtlMs) =>
        update("active", positiveTtl(nextTtlMs ?? ttlMs)),
      drain: () => update("draining"),
      stop: () => update("stopped"),
    };
  }

  read(
    workerId: string,
    instanceId: string,
  ): WorkflowWorkerRegistration | undefined {
    const path = this.path(workerId, instanceId);
    if (!existsSync(path)) return undefined;
    try {
      return parseWorker(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      return undefined;
    }
  }

  async list(
    input: { workspaceId?: string } = {},
  ): Promise<WorkflowWorkerRegistration[]> {
    let names: string[];
    try {
      names = await readdir(this.rootDir);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw cause;
    }
    return names
      .filter((name) => name.endsWith(".worker.json"))
      .flatMap((name) => {
        try {
          const value = parseWorker(
            JSON.parse(readFileSync(join(this.rootDir, name), "utf8")),
          );
          return !input.workspaceId || value.workspaceId === input.workspaceId
            ? [value]
            : [];
        } catch {
          return [];
        }
      })
      .sort((a, b) => a.registeredAt.localeCompare(b.registeredAt));
  }

  isLive(record: WorkflowWorkerRegistration, now = this.now()): boolean {
    return (
      record.state !== "stopped" && Date.parse(record.expiresAt) > now.getTime()
    );
  }

  private path(workerId: string, instanceId: string): string {
    assertSegment(workerId, "workerId");
    assertSegment(instanceId, "instanceId");
    return join(this.rootDir, `${workerId}.${instanceId}.worker.json`);
  }
}

function positiveTtl(value = 30_000): number {
  if (!Number.isInteger(value) || value < 1)
    throw new Error("worker ttlMs must be positive");
  return value;
}

function assertSegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error(`Unsafe ${label}: ${value}`);
}

function parseWorker(value: unknown): WorkflowWorkerRegistration {
  if (!value || typeof value !== "object")
    throw new Error("worker record must be an object");
  const record = value as WorkflowWorkerRegistration;
  if (
    record.schemaVersion !== WORKFLOW_WORKER_SCHEMA_VERSION ||
    typeof record.workerId !== "string" ||
    typeof record.instanceId !== "string" ||
    typeof record.workspaceId !== "string" ||
    !["active", "draining", "stopped"].includes(record.state) ||
    typeof record.token !== "string" ||
    typeof record.registeredAt !== "string" ||
    typeof record.heartbeatAt !== "string" ||
    typeof record.expiresAt !== "string"
  )
    throw new Error("invalid worker record");
  return { ...record };
}
