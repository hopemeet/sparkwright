import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createId } from "@sparkwright/core";

export type WorkspaceAgentLeaseMode = "read" | "write";

export interface WorkspaceAgentLease {
  readonly id: string;
  readonly workspaceRoot: string;
  readonly ownerId: string;
  readonly mode: WorkspaceAgentLeaseMode;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  renew(ttlMs?: number): boolean;
  release(): boolean;
}

export interface WorkspaceAgentLeaseSnapshot {
  workspaceRoot: string;
  writer?: { leaseId: string; ownerId: string; expiresAt: string };
  readers: Array<{ leaseId: string; ownerId: string; expiresAt: string }>;
  queued: Array<{ ownerId: string; mode: WorkspaceAgentLeaseMode }>;
}

interface LeaseRecord {
  id: string;
  workspaceRoot: string;
  ownerId: string;
  mode: WorkspaceAgentLeaseMode;
  acquiredAtMs: number;
  expiresAtMs: number;
  timer?: ReturnType<typeof setTimeout>;
}

interface Waiter {
  ownerId: string;
  mode: WorkspaceAgentLeaseMode;
  ttlMs: number;
  signal?: AbortSignal;
  resolve: (lease: WorkspaceAgentLease) => void;
  reject: (error: Error) => void;
  onAbort?: () => void;
}

interface ScopeState {
  writer?: LeaseRecord;
  readers: Map<string, LeaseRecord>;
  queue: Waiter[];
}

const DEFAULT_LEASE_TTL_MS = 30_000;

/** Process-local fair RW lease coordinator for Agent workspace access. */
export class WorkspaceAgentArbiter {
  private readonly scopes = new Map<string, ScopeState>();

  acquire(input: {
    workspaceRoot: string;
    ownerId: string;
    mode: WorkspaceAgentLeaseMode;
    ttlMs?: number;
    signal?: AbortSignal;
  }): Promise<WorkspaceAgentLease> {
    const workspaceRoot = canonicalWorkspaceRoot(input.workspaceRoot);
    const ttlMs = positiveTtl(input.ttlMs);
    if (input.signal?.aborted) {
      return Promise.reject(abortError(input.ownerId));
    }
    const scope = this.scope(workspaceRoot);
    return new Promise<WorkspaceAgentLease>((resolveLease, reject) => {
      const waiter: Waiter = {
        ownerId: input.ownerId,
        mode: input.mode,
        ttlMs,
        signal: input.signal,
        resolve: resolveLease,
        reject,
      };
      if (input.signal) {
        waiter.onAbort = () => {
          const index = scope.queue.indexOf(waiter);
          if (index >= 0) scope.queue.splice(index, 1);
          reject(abortError(input.ownerId));
          this.drain(workspaceRoot, scope);
        };
        input.signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      scope.queue.push(waiter);
      this.drain(workspaceRoot, scope);
    });
  }

  inspect(workspaceRoot: string): WorkspaceAgentLeaseSnapshot {
    const canonical = canonicalWorkspaceRoot(workspaceRoot);
    const scope = this.scopes.get(canonical);
    return {
      workspaceRoot: canonical,
      ...(scope?.writer
        ? {
            writer: {
              leaseId: scope.writer.id,
              ownerId: scope.writer.ownerId,
              expiresAt: iso(scope.writer.expiresAtMs),
            },
          }
        : {}),
      readers: [...(scope?.readers.values() ?? [])].map((reader) => ({
        leaseId: reader.id,
        ownerId: reader.ownerId,
        expiresAt: iso(reader.expiresAtMs),
      })),
      queued: (scope?.queue ?? []).map(({ ownerId, mode }) => ({
        ownerId,
        mode,
      })),
    };
  }

  private scope(workspaceRoot: string): ScopeState {
    const existing = this.scopes.get(workspaceRoot);
    if (existing) return existing;
    const created: ScopeState = { readers: new Map(), queue: [] };
    this.scopes.set(workspaceRoot, created);
    return created;
  }

  private drain(workspaceRoot: string, scope: ScopeState): void {
    if (scope.writer) return;
    if (scope.readers.size > 0) {
      while (scope.queue[0]?.mode === "read") {
        this.grant(workspaceRoot, scope, scope.queue.shift()!);
      }
      return;
    }
    if (scope.queue[0]?.mode === "write") {
      this.grant(workspaceRoot, scope, scope.queue.shift()!);
      return;
    }
    while (scope.queue[0]?.mode === "read") {
      this.grant(workspaceRoot, scope, scope.queue.shift()!);
    }
  }

  private grant(
    workspaceRoot: string,
    scope: ScopeState,
    waiter: Waiter,
  ): void {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    const now = Date.now();
    const record: LeaseRecord = {
      id: createId("agent_lease"),
      workspaceRoot,
      ownerId: waiter.ownerId,
      mode: waiter.mode,
      acquiredAtMs: now,
      expiresAtMs: now + waiter.ttlMs,
    };
    record.timer = setTimeout(() => this.releaseRecord(record), waiter.ttlMs);
    record.timer.unref?.();
    if (record.mode === "write") scope.writer = record;
    else scope.readers.set(record.id, record);
    waiter.resolve(this.leaseHandle(record));
  }

  private leaseHandle(record: LeaseRecord): WorkspaceAgentLease {
    return {
      id: record.id,
      workspaceRoot: record.workspaceRoot,
      ownerId: record.ownerId,
      mode: record.mode,
      acquiredAt: iso(record.acquiredAtMs),
      get expiresAt() {
        return iso(record.expiresAtMs);
      },
      renew: (ttlMs) => this.renewRecord(record, positiveTtl(ttlMs)),
      release: () => this.releaseRecord(record),
    };
  }

  private renewRecord(record: LeaseRecord, ttlMs: number): boolean {
    if (!this.isCurrent(record)) return false;
    if (record.timer) clearTimeout(record.timer);
    record.expiresAtMs = Date.now() + ttlMs;
    record.timer = setTimeout(() => this.releaseRecord(record), ttlMs);
    record.timer.unref?.();
    return true;
  }

  private releaseRecord(record: LeaseRecord): boolean {
    const scope = this.scopes.get(record.workspaceRoot);
    if (!scope || !this.isCurrent(record)) return false;
    if (record.timer) clearTimeout(record.timer);
    if (record.mode === "write") scope.writer = undefined;
    else scope.readers.delete(record.id);
    this.drain(record.workspaceRoot, scope);
    if (!scope.writer && scope.readers.size === 0 && scope.queue.length === 0) {
      this.scopes.delete(record.workspaceRoot);
    }
    return true;
  }

  private isCurrent(record: LeaseRecord): boolean {
    const scope = this.scopes.get(record.workspaceRoot);
    return record.mode === "write"
      ? scope?.writer === record
      : scope?.readers.get(record.id) === record;
  }
}

export const processWorkspaceAgentArbiter = new WorkspaceAgentArbiter();

export function createWorkspaceAgentAdmission(input: {
  arbiter?: WorkspaceAgentArbiter;
  workspaceRoot: string;
  mode: WorkspaceAgentLeaseMode;
  ttlMs?: number;
  heartbeatMs?: number;
}): (request: {
  invocation: { childRunId: string };
  abortSignal: AbortSignal;
}) => Promise<() => void> {
  return async ({ invocation, abortSignal }) => {
    const ttlMs = positiveTtl(input.ttlMs);
    const lease = await (input.arbiter ?? processWorkspaceAgentArbiter).acquire(
      {
        workspaceRoot: input.workspaceRoot,
        ownerId: invocation.childRunId,
        mode: input.mode,
        ttlMs,
        signal: abortSignal,
      },
    );
    const heartbeat = setInterval(
      () => lease.renew(ttlMs),
      heartbeatInterval(ttlMs, input.heartbeatMs),
    );
    heartbeat.unref?.();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      lease.release();
    };
  };
}

function canonicalWorkspaceRoot(workspaceRoot: string): string {
  const absolute = resolve(workspaceRoot);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function positiveTtl(value = DEFAULT_LEASE_TTL_MS): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("workspace Agent lease TTL must be positive");
  }
  return Math.floor(value);
}

function heartbeatInterval(ttlMs: number, heartbeatMs?: number): number {
  return Math.min(
    positiveTtl(heartbeatMs ?? Math.max(1, Math.floor(ttlMs / 3))),
    Math.max(1, ttlMs - 1),
  );
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

function abortError(ownerId: string): Error {
  return Object.assign(
    new Error(`Workspace Agent lease acquisition aborted for ${ownerId}.`),
    { name: "AbortError" },
  );
}
