// =============================================================================
// storage-lock.ts — Optional concurrent-instance lock protocol.
//
// The reference RunStore (FileRunStore) is not safe under concurrent
// access from multiple processes against the same root: appending to the
// same JSONL trace from two writers will interleave events. Hosts that
// allow multi-process scenarios (CLIs invoked twice in parallel, daemons,
// scheduled-task runners) need a mutual-exclusion primitive.
//
// The kernel only defines the contract. Implementations live in host
// packages:
//   - local CLI hosts can use a lock file + flock / O_EXCL.
//   - server hosts can back this with a database row lock or a redis
//     SET NX EX.
//
// Keeping this as a separate optional protocol (rather than methods on
// RunStore) preserves the "thin loop, strong boundaries" stance: most
// embedders won't need it; those that do can wire one in without changing
// the run loop.
// =============================================================================

/**
 * Identifier for a lock scope. By convention, hosts use a stable string
 * keyed to whatever resource is being protected — typically the storage
 * root path (`/var/lib/sparkwright/runs`) or a logical scope name
 * (`session:abc123`).
 *
 * @public
 * @stability experimental v0.1
 */
export type LockScope = string;

export interface LockAcquireOptions {
  /** @reserved Public lock-acquire hint consumed by host lock adapters. */
  waitMs?: number;
  /**
   * Optional metadata recorded with the lock. Implementations should
   * surface this on `LockHandle.metadata` so other callers inspecting
   * the lock can see who holds it.
   */
  metadata?: Record<string, unknown>;
  /** Abort the acquisition attempt early. */
  signal?: AbortSignal;
}

export interface LockHandleMetadata extends Record<string, unknown> {
  /** @reserved Public lock-holder field consumed by diagnostics UIs. */
  scope: LockScope;
  /** @reserved Public lock-holder timestamp consumed by diagnostics UIs. */
  acquiredAt: string;
  /** @reserved Public lock-holder process field consumed by diagnostics UIs. */
  ownerPid?: number;
  /** @reserved Public lock-holder owner field consumed by diagnostics UIs. */
  ownerId?: string;
}

/**
 * Token returned by a successful {@link StorageLock.tryAcquire}. Release
 * is required for correctness; callers should use `try { … } finally { await handle.release(); }`.
 *
 * Idempotent release is encouraged — implementations should make repeated
 * `release()` calls a no-op rather than throwing.
 *
 * @public
 * @stability experimental v0.1
 */
export interface LockHandle {
  readonly metadata: LockHandleMetadata;
  release(): Promise<void>;
}

/**
 * Information about an existing lock holder, returned by
 * {@link StorageLock.inspect} when the scope is currently held.
 *
 * @public
 * @stability experimental v0.1
 */
export type LockHolderInfo = LockHandleMetadata;

/**
 * Pluggable mutual-exclusion primitive. Implementations decide the
 * physical backing (file lock, db row, redis…); the kernel only
 * consumes the protocol when a host opts in.
 *
 * @public
 * @stability experimental v0.1
 */
export interface StorageLock {
  /**
   * Attempt to acquire the lock for `scope`. Returns a handle on success
   * or `null` when the lock is already held by another process and
   * `waitMs` (if any) elapsed without acquisition.
   *
   * Implementations MUST be safe under concurrent invocation from the
   * same process and from sibling processes that share the underlying
   * backing store. They MUST NOT block the event loop synchronously.
   */
  tryAcquire(
    scope: LockScope,
    options?: LockAcquireOptions,
  ): Promise<LockHandle | null>;

  /**
   * Optional inspector for diagnostic / UI flows that want to render a
   * "lock held by …" message without acquiring. Implementations that
   * cannot cheaply inspect may return `undefined`.
   */
  inspect?(scope: LockScope): Promise<LockHolderInfo | undefined>;
}

/**
 * Helper that runs `fn` while holding a lock, releasing on either branch.
 * Returns `null` when the lock could not be acquired so callers can branch
 * on contention without try/catch.
 *
 * @public
 * @stability experimental v0.1
 */
export async function withStorageLock<T>(
  lock: StorageLock,
  scope: LockScope,
  fn: (handle: LockHandle) => Promise<T>,
  options?: LockAcquireOptions,
): Promise<T | null> {
  const handle = await lock.tryAcquire(scope, options);
  if (!handle) return null;
  try {
    return await fn(handle);
  } finally {
    await handle.release();
  }
}
