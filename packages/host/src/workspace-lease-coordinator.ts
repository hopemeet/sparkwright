import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  createId,
  type RuntimeContext,
  type ToolDefinition,
  type WorkspaceStateRuntime,
} from "@sparkwright/core";
import type { TaskId, TaskManager } from "@sparkwright/agent-runtime";

export type WorkspaceLeaseMode = "read" | "write";
export type WorkspaceLeaseLossReason = "expired" | "revoked" | "renewal_failed";

export interface WorkspaceLeaseLoss {
  /** @reserved Serialized ownership-loss correlation consumed by diagnostics. */
  leaseId: string;
  workspaceRoot: string;
  ownerId: string;
  mode: WorkspaceLeaseMode;
  reason: WorkspaceLeaseLossReason;
}

export interface WorkspaceLease {
  readonly id: string;
  readonly workspaceRoot: string;
  readonly ownerId: string;
  readonly mode: WorkspaceLeaseMode;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  /** Resolves only when ownership is lost involuntarily, never on release. */
  readonly lost: Promise<WorkspaceLeaseLoss>;
  release(): boolean;
}

export interface WorkspaceLeaseSnapshot {
  workspaceRoot: string;
  writer?: {
    leaseId: string;
    ownerId: string;
    expiresAt: string;
    references: number;
  };
  readers: Array<{
    leaseId: string;
    ownerId: string;
    expiresAt: string;
    references: number;
  }>;
  queued: Array<{ ownerId: string; mode: WorkspaceLeaseMode }>;
}

interface LeaseRecord {
  id: string;
  workspaceRoot: string;
  ownerId: string;
  ancestorOwnerIds: readonly string[];
  mode: WorkspaceLeaseMode;
  acquiredAtMs: number;
  expiresAtMs: number;
  ttlMs: number;
  references: number;
  autoRenew: boolean;
  expiryTimer?: ReturnType<typeof setTimeout>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  loss: Promise<WorkspaceLeaseLoss>;
  resolveLoss: (loss: WorkspaceLeaseLoss) => void;
  lossHandlers: Set<(loss: WorkspaceLeaseLoss) => void>;
}

interface Waiter {
  ownerId: string;
  ancestorOwnerIds: readonly string[];
  mode: WorkspaceLeaseMode;
  ttlMs: number;
  heartbeatMs?: number;
  autoRenew: boolean;
  signal?: AbortSignal;
  onLost?: (loss: WorkspaceLeaseLoss) => void;
  resolve: (lease: WorkspaceLease) => void;
  reject: (error: Error) => void;
  onAbort?: () => void;
}

interface ScopeState {
  writer?: LeaseRecord;
  readers: Map<string, LeaseRecord>;
  queue: Waiter[];
}

const DEFAULT_LEASE_TTL_MS = 30_000;

export class WorkspaceLeaseRunChainConflictError extends Error {
  readonly code = "WORKSPACE_LEASE_RUN_CHAIN_CONFLICT";

  constructor(ownerId: string, ancestorOwnerId: string) {
    super(
      `Workspace lease request for ${ownerId} would wait on ancestor owner ${ancestorOwnerId}; nested mutation must be restructured or fail fast.`,
    );
    this.name = "WorkspaceLeaseRunChainConflictError";
  }
}

export class WorkspaceLeaseUpgradeConflictError extends Error {
  readonly code = "WORKSPACE_LEASE_UPGRADE_CONFLICT";

  constructor(ownerId: string) {
    super(
      `Workspace lease owner ${ownerId} cannot upgrade a held read lease to write; release it before requesting mutation access.`,
    );
    this.name = "WorkspaceLeaseUpgradeConflictError";
  }
}

export class WorkspaceLeaseLostError extends Error {
  readonly code = "WORKSPACE_LEASE_LOST";

  constructor(readonly loss: WorkspaceLeaseLoss) {
    super(
      `Workspace ${loss.mode} lease for ${loss.ownerId} was lost (${loss.reason}).`,
    );
    this.name = "WorkspaceLeaseLostError";
  }
}

export class WorkspaceLeaseObservationConflictError extends Error {
  readonly code = "WORKSPACE_LEASE_OBSERVATION_CONFLICT";

  constructor(
    readonly observedEpoch: number,
    readonly currentEpoch: number,
  ) {
    super(
      `Workspace changed while the child transitioned from read to write (${observedEpoch} -> ${currentEpoch}); reread affected state before retrying the mutation.`,
    );
    this.name = "WorkspaceLeaseObservationConflictError";
  }
}

export class WorkspaceLeaseRevalidationRequiredError extends Error {
  readonly code = "WORKSPACE_LEASE_REVALIDATION_REQUIRED";

  constructor(readonly currentEpoch: number) {
    super(
      `Workspace write lease is held at epoch ${currentEpoch}, but a successful read is required before mutation can be retried.`,
    );
    this.name = "WorkspaceLeaseRevalidationRequiredError";
  }
}

/**
 * Process-local fair workspace lease coordinator. Acquisitions auto-renew by
 * default; callers must explicitly opt out for abandoned-holder/expiry tests.
 * Same-owner acquisition is reentrant. A descendant waiting on an ancestor is
 * rejected instead of entering a run-chain deadlock.
 */
export class WorkspaceLeaseCoordinator {
  private readonly scopes = new Map<string, ScopeState>();

  acquire(input: {
    workspaceRoot: string;
    ownerId: string;
    ancestorOwnerIds?: readonly string[];
    mode: WorkspaceLeaseMode;
    ttlMs?: number;
    heartbeatMs?: number;
    autoRenew?: boolean;
    signal?: AbortSignal;
    onLost?: (loss: WorkspaceLeaseLoss) => void;
  }): Promise<WorkspaceLease> {
    const workspaceRoot = canonicalWorkspaceRoot(input.workspaceRoot);
    const ttlMs = positiveTtl(input.ttlMs);
    const ancestorOwnerIds = uniqueOwnerIds(input.ancestorOwnerIds ?? []);
    if (input.signal?.aborted) {
      return Promise.reject(abortError(input.ownerId));
    }
    const scope = this.scope(workspaceRoot);
    const reentrant = this.reentrantRecord(scope, input.ownerId, input.mode);
    if (reentrant) {
      reentrant.references += 1;
      if (input.onLost) reentrant.lossHandlers.add(input.onLost);
      if (input.autoRenew !== false && !reentrant.autoRenew) {
        reentrant.autoRenew = true;
        this.startHeartbeat(reentrant, input.heartbeatMs);
      }
      this.renewRecord(reentrant, ttlMs);
      return Promise.resolve(this.leaseHandle(reentrant, input.onLost));
    }
    if (
      input.mode === "write" &&
      [...scope.readers.values()].some(
        (reader) => reader.ownerId === input.ownerId,
      )
    ) {
      return Promise.reject(
        new WorkspaceLeaseUpgradeConflictError(input.ownerId),
      );
    }
    const ancestorBlocker = this.ancestorBlocker(scope, ancestorOwnerIds);
    if (ancestorBlocker) {
      return Promise.reject(
        new WorkspaceLeaseRunChainConflictError(input.ownerId, ancestorBlocker),
      );
    }
    return new Promise<WorkspaceLease>((resolveLease, reject) => {
      const waiter: Waiter = {
        ownerId: input.ownerId,
        ancestorOwnerIds,
        mode: input.mode,
        ttlMs,
        ...(input.heartbeatMs !== undefined
          ? { heartbeatMs: input.heartbeatMs }
          : {}),
        autoRenew: input.autoRenew !== false,
        signal: input.signal,
        onLost: input.onLost,
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

  inspect(workspaceRoot: string): WorkspaceLeaseSnapshot {
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
              references: scope.writer.references,
            },
          }
        : {}),
      readers: [...(scope?.readers.values() ?? [])].map((reader) => ({
        leaseId: reader.id,
        ownerId: reader.ownerId,
        expiresAt: iso(reader.expiresAtMs),
        references: reader.references,
      })),
      queued: (scope?.queue ?? []).map(({ ownerId, mode }) => ({
        ownerId,
        mode,
      })),
    };
  }

  /** Administrative/test takeover hook. Lost holders are notified before drain. */
  revoke(
    workspaceRoot: string,
    ownerId: string,
    reason: WorkspaceLeaseLossReason = "revoked",
  ): boolean {
    const canonical = canonicalWorkspaceRoot(workspaceRoot);
    const scope = this.scopes.get(canonical);
    if (!scope) return false;
    const record =
      scope.writer?.ownerId === ownerId
        ? scope.writer
        : [...scope.readers.values()].find(
            (reader) => reader.ownerId === ownerId,
          );
    return record ? this.loseRecord(record, reason) : false;
  }

  private scope(workspaceRoot: string): ScopeState {
    const existing = this.scopes.get(workspaceRoot);
    if (existing) return existing;
    const created: ScopeState = { readers: new Map(), queue: [] };
    this.scopes.set(workspaceRoot, created);
    return created;
  }

  private reentrantRecord(
    scope: ScopeState,
    ownerId: string,
    mode: WorkspaceLeaseMode,
  ): LeaseRecord | undefined {
    if (scope.writer?.ownerId === ownerId) return scope.writer;
    if (mode === "read") {
      return [...scope.readers.values()].find(
        (reader) => reader.ownerId === ownerId,
      );
    }
    return undefined;
  }

  private ancestorBlocker(
    scope: ScopeState,
    ancestorOwnerIds: readonly string[],
  ): string | undefined {
    if (ancestorOwnerIds.length === 0) return undefined;
    const ancestors = new Set(ancestorOwnerIds);
    if (scope.writer && ancestors.has(scope.writer.ownerId)) {
      return scope.writer.ownerId;
    }
    const reader = [...scope.readers.values()].find((candidate) =>
      ancestors.has(candidate.ownerId),
    );
    if (reader) return reader.ownerId;
    return scope.queue.find((waiter) => ancestors.has(waiter.ownerId))?.ownerId;
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
    let resolveLoss!: (loss: WorkspaceLeaseLoss) => void;
    const loss = new Promise<WorkspaceLeaseLoss>((resolveLossPromise) => {
      resolveLoss = resolveLossPromise;
    });
    const record: LeaseRecord = {
      id: createId("workspace_lease"),
      workspaceRoot,
      ownerId: waiter.ownerId,
      ancestorOwnerIds: waiter.ancestorOwnerIds,
      mode: waiter.mode,
      acquiredAtMs: now,
      expiresAtMs: now + waiter.ttlMs,
      ttlMs: waiter.ttlMs,
      references: 1,
      autoRenew: waiter.autoRenew,
      loss,
      resolveLoss,
      lossHandlers: new Set(waiter.onLost ? [waiter.onLost] : []),
    };
    this.scheduleExpiry(record);
    if (record.autoRenew) this.startHeartbeat(record, waiter.heartbeatMs);
    if (record.mode === "write") scope.writer = record;
    else scope.readers.set(record.id, record);
    waiter.resolve(this.leaseHandle(record, waiter.onLost));
  }

  private leaseHandle(
    record: LeaseRecord,
    onLost?: (loss: WorkspaceLeaseLoss) => void,
  ): WorkspaceLease {
    let released = false;
    return {
      id: record.id,
      workspaceRoot: record.workspaceRoot,
      ownerId: record.ownerId,
      mode: record.mode,
      acquiredAt: iso(record.acquiredAtMs),
      get expiresAt() {
        return iso(record.expiresAtMs);
      },
      lost: record.loss,
      release: () => {
        if (released) return false;
        released = true;
        if (onLost) record.lossHandlers.delete(onLost);
        return this.releaseReference(record);
      },
    };
  }

  private startHeartbeat(record: LeaseRecord, heartbeatMs?: number): void {
    if (record.heartbeatTimer) clearInterval(record.heartbeatTimer);
    record.heartbeatTimer = setInterval(
      () => {
        if (!this.renewRecord(record, record.ttlMs)) {
          this.notifyLoss(record, "renewal_failed");
        }
      },
      heartbeatInterval(record.ttlMs, heartbeatMs),
    );
    record.heartbeatTimer.unref?.();
  }

  private renewRecord(record: LeaseRecord, ttlMs: number): boolean {
    if (!this.isCurrent(record)) return false;
    record.ttlMs = ttlMs;
    record.expiresAtMs = Date.now() + ttlMs;
    this.scheduleExpiry(record);
    return true;
  }

  private scheduleExpiry(record: LeaseRecord): void {
    if (record.expiryTimer) clearTimeout(record.expiryTimer);
    const delay = Math.max(1, record.expiresAtMs - Date.now());
    record.expiryTimer = setTimeout(
      () => this.loseRecord(record, "expired"),
      delay,
    );
    record.expiryTimer.unref?.();
  }

  private releaseReference(record: LeaseRecord): boolean {
    if (!this.isCurrent(record)) return false;
    record.references -= 1;
    if (record.references > 0) return true;
    return this.removeRecord(record);
  }

  private loseRecord(
    record: LeaseRecord,
    reason: WorkspaceLeaseLossReason,
  ): boolean {
    if (!this.isCurrent(record)) return false;
    return this.removeRecord(record, () => this.notifyLoss(record, reason));
  }

  private removeRecord(record: LeaseRecord, beforeDrain?: () => void): boolean {
    const scope = this.scopes.get(record.workspaceRoot);
    if (!scope || !this.isCurrent(record)) return false;
    if (record.expiryTimer) clearTimeout(record.expiryTimer);
    if (record.heartbeatTimer) clearInterval(record.heartbeatTimer);
    if (record.mode === "write") scope.writer = undefined;
    else scope.readers.delete(record.id);
    // Tell the current owner to stop before granting the workspace to a waiter.
    // Loss handlers are synchronous by design, so adapters initiate abort
    // before takeover. This is ordering, not fencing or termination proof.
    beforeDrain?.();
    this.drain(record.workspaceRoot, scope);
    if (!scope.writer && scope.readers.size === 0 && scope.queue.length === 0) {
      this.scopes.delete(record.workspaceRoot);
    }
    return true;
  }

  private notifyLoss(
    record: LeaseRecord,
    reason: WorkspaceLeaseLossReason,
  ): void {
    const loss: WorkspaceLeaseLoss = {
      leaseId: record.id,
      workspaceRoot: record.workspaceRoot,
      ownerId: record.ownerId,
      mode: record.mode,
      reason,
    };
    record.resolveLoss(loss);
    for (const handler of record.lossHandlers) {
      try {
        handler(loss);
      } catch {
        // Ownership loss must continue draining even if diagnostics fail.
      }
    }
    record.lossHandlers.clear();
  }

  private isCurrent(record: LeaseRecord): boolean {
    const scope = this.scopes.get(record.workspaceRoot);
    return record.mode === "write"
      ? scope?.writer === record
      : scope?.readers.get(record.id) === record;
  }
}

export const processWorkspaceLeaseCoordinator = new WorkspaceLeaseCoordinator();

const leaseSessions = new WeakMap<
  WorkspaceLeaseCoordinator,
  Map<string, WorkspaceLeaseSession>
>();

export function createWorkspaceMutationAdmission(input: {
  coordinator?: WorkspaceLeaseCoordinator;
  workspaceRoot: string;
  mode: WorkspaceLeaseMode;
  ttlMs?: number;
  heartbeatMs?: number;
  workspaceState?: WorkspaceStateRuntime;
}): (request: {
  invocation: { childRunId: string; parentRunId?: string };
  abortSignal: AbortSignal;
  cancel?: (reason: string, metadata?: Record<string, unknown>) => void;
}) => Promise<() => void> {
  return async ({ invocation, abortSignal, cancel }) => {
    const coordinator = input.coordinator ?? processWorkspaceLeaseCoordinator;
    const acquisition = {
      workspaceRoot: input.workspaceRoot,
      ownerId: invocation.childRunId,
      ancestorOwnerIds: invocation.parentRunId ? [invocation.parentRunId] : [],
      mode: input.mode,
      ttlMs: input.ttlMs,
      heartbeatMs: input.heartbeatMs,
      signal: abortSignal,
      onLost: (loss: WorkspaceLeaseLoss) =>
        cancel?.("Workspace lease lost.", {
          workspaceLeaseLoss: { ...loss },
        }),
    } as const;
    const lease = await coordinator.acquire(acquisition);
    const session = input.workspaceState
      ? new WorkspaceLeaseSession({
          coordinator,
          acquisition,
          lease,
          workspaceState: input.workspaceState,
        })
      : undefined;
    if (session) {
      sessionsFor(coordinator).set(
        leaseSessionKey(input.workspaceRoot, invocation.childRunId),
        session,
      );
    }
    return () => {
      if (session) {
        sessionsFor(coordinator).delete(
          leaseSessionKey(input.workspaceRoot, invocation.childRunId),
        );
        session.release();
      } else {
        lease.release();
      }
    };
  };
}

export function createWorkspaceLeaseAbortController(
  parentSignal?: AbortSignal,
): {
  signal: AbortSignal;
  cancel(reason: string, metadata?: Record<string, unknown>): void;
  dispose(): void;
} {
  const linked = linkedAbortController(parentSignal);
  return {
    signal: linked.controller.signal,
    cancel(reason) {
      linked.controller.abort(new Error(reason));
    },
    dispose: linked.dispose,
  };
}

export function withWorkspaceMutationLease<TArgs, TResult>(
  tool: ToolDefinition<TArgs, TResult>,
  input: {
    coordinator?: WorkspaceLeaseCoordinator;
    workspaceRoot: string;
    backgroundTaskManager?: TaskManager;
  },
): ToolDefinition<TArgs, TResult> {
  const coordinator = input.coordinator ?? processWorkspaceLeaseCoordinator;
  return {
    ...tool,
    async execute(args, ctx) {
      const session = sessionsFor(coordinator).get(
        leaseSessionKey(input.workspaceRoot, String(ctx.run.id)),
      );
      if (!toolMutatesWorkspace(tool, args)) {
        const output = await tool.execute(args, ctx);
        if (toolObservesWorkspace(tool, args)) {
          session?.recordSuccessfulRead();
        }
        return output;
      }
      if (session) {
        await session.ensureWrite();
        try {
          const output = await tool.execute(args, ctx);
          session.recordSuccessfulWrite();
          return output;
        } catch (cause) {
          if (isWorkspaceConflict(cause)) session.requireRevalidation();
          throw cause;
        }
      }
      const localAbort = linkedAbortController(ctx.abortSignal);
      let backgroundTaskId: TaskId | undefined;
      let transferred = false;
      const lease = await coordinator.acquire({
        workspaceRoot: input.workspaceRoot,
        ownerId: String(ctx.run.id),
        ancestorOwnerIds: runAncestorOwnerIds(ctx),
        mode: "write",
        signal: localAbort.controller.signal,
        onLost: (loss) => {
          ctx.reportToolProgress?.({
            label: "workspace_lease_lost",
            message: new WorkspaceLeaseLostError(loss).message,
            metadata: { ...loss },
          });
          localAbort.controller.abort(new WorkspaceLeaseLostError(loss));
          if (backgroundTaskId && input.backgroundTaskManager) {
            void input.backgroundTaskManager
              .handle(backgroundTaskId)
              ?.cancel()
              .catch(() => {});
          }
        },
      });
      try {
        const execution = Promise.resolve(
          tool.execute(args, {
            ...ctx,
            abortSignal: localAbort.controller.signal,
          }),
        );
        const output = await Promise.race([
          execution,
          lease.lost.then((loss) => {
            throw new WorkspaceLeaseLostError(loss);
          }),
        ]);
        const taskId = backgroundTaskIdFromOutput(output);
        const handle = taskId
          ? input.backgroundTaskManager?.handle(taskId)
          : undefined;
        if (handle) {
          backgroundTaskId = taskId;
          transferred = true;
          void handle.wait().finally(() => lease.release());
        }
        return output;
      } finally {
        localAbort.dispose();
        if (!transferred) lease.release();
      }
    },
  };
}

interface WorkspaceLeaseAcquisition {
  workspaceRoot: string;
  ownerId: string;
  ancestorOwnerIds: readonly string[];
  mode: WorkspaceLeaseMode;
  ttlMs?: number;
  heartbeatMs?: number;
  signal: AbortSignal;
  onLost: (loss: WorkspaceLeaseLoss) => void;
}

class WorkspaceLeaseSession {
  private lease: WorkspaceLease;
  private observedEpoch: number;
  private revalidationRequired = false;
  private transition?: Promise<void>;

  constructor(
    private readonly input: {
      coordinator: WorkspaceLeaseCoordinator;
      acquisition: WorkspaceLeaseAcquisition;
      lease: WorkspaceLease;
      workspaceState: WorkspaceStateRuntime;
    },
  ) {
    this.lease = input.lease;
    this.observedEpoch = input.workspaceState.currentEpoch();
  }

  async ensureWrite(): Promise<void> {
    if (this.lease.mode === "write") {
      if (this.revalidationRequired) {
        throw new WorkspaceLeaseRevalidationRequiredError(
          this.input.workspaceState.currentEpoch(),
        );
      }
      return;
    }
    if (!this.transition) {
      this.transition = this.transitionToWrite().finally(() => {
        this.transition = undefined;
      });
    }
    await this.transition;
  }

  recordSuccessfulRead(): void {
    this.observedEpoch = this.input.workspaceState.currentEpoch();
    this.revalidationRequired = false;
  }

  recordSuccessfulWrite(): void {
    this.observedEpoch = this.input.workspaceState.currentEpoch();
  }

  requireRevalidation(): void {
    this.observedEpoch = this.input.workspaceState.currentEpoch();
    this.revalidationRequired = true;
  }

  release(): void {
    this.lease.release();
  }

  private async transitionToWrite(): Promise<void> {
    const transitionEpoch = this.observedEpoch;
    this.lease.release();
    this.lease = await this.input.coordinator.acquire({
      ...this.input.acquisition,
      mode: "write",
    });
    const currentEpoch = this.input.workspaceState.currentEpoch();
    this.observedEpoch = currentEpoch;
    if (currentEpoch !== transitionEpoch) {
      this.revalidationRequired = true;
      throw new WorkspaceLeaseObservationConflictError(
        transitionEpoch,
        currentEpoch,
      );
    }
  }
}

function sessionsFor(
  coordinator: WorkspaceLeaseCoordinator,
): Map<string, WorkspaceLeaseSession> {
  const existing = leaseSessions.get(coordinator);
  if (existing) return existing;
  const created = new Map<string, WorkspaceLeaseSession>();
  leaseSessions.set(coordinator, created);
  return created;
}

function leaseSessionKey(workspaceRoot: string, ownerId: string): string {
  return `${canonicalWorkspaceRoot(workspaceRoot)}\0${ownerId}`;
}

function toolMutatesWorkspace<TArgs, TResult>(
  tool: ToolDefinition<TArgs, TResult>,
  args: TArgs,
): boolean {
  const governance = tool.policyForArgs?.(args)?.governance ?? tool.governance;
  return governance?.sideEffects?.includes("write") === true;
}

function toolObservesWorkspace<TArgs, TResult>(
  tool: ToolDefinition<TArgs, TResult>,
  args: TArgs,
): boolean {
  const governance = tool.policyForArgs?.(args)?.governance ?? tool.governance;
  return governance?.sideEffects?.includes("read") === true;
}

function isWorkspaceConflict(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return false;
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" && /(?:CONFLICT|STALE|REVISION)/u.test(code);
}

function backgroundTaskIdFromOutput(output: unknown): TaskId | undefined {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return undefined;
  }
  const record = output as { background?: unknown; taskId?: unknown };
  return record.background === true && typeof record.taskId === "string"
    ? (record.taskId as TaskId)
    : undefined;
}

function runAncestorOwnerIds(ctx: RuntimeContext): string[] {
  const metadata = ctx.run.metadata;
  const inherited = Array.isArray(metadata.ancestorRunIds)
    ? metadata.ancestorRunIds.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.length > 0,
      )
    : [];
  const parentRunId =
    typeof metadata.parentRunId === "string" ? metadata.parentRunId : undefined;
  return uniqueOwnerIds([...inherited, ...(parentRunId ? [parentRunId] : [])]);
}

function linkedAbortController(signal?: AbortSignal): {
  controller: AbortController;
  dispose(): void;
} {
  const controller = new AbortController();
  if (!signal) return { controller, dispose() {} };
  if (signal.aborted) {
    controller.abort(signal.reason);
    return { controller, dispose() {} };
  }
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  return {
    controller,
    dispose: () => signal.removeEventListener("abort", abort),
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

function uniqueOwnerIds(ownerIds: readonly string[]): string[] {
  return [...new Set(ownerIds.filter((ownerId) => ownerId.length > 0))];
}

function positiveTtl(value = DEFAULT_LEASE_TTL_MS): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("workspace lease TTL must be positive");
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
    new Error(`Workspace lease acquisition aborted for ${ownerId}.`),
    { name: "AbortError" },
  );
}
