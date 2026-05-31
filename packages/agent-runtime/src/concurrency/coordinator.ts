// AI maintenance note: ConcurrencyCoordinator is the in-memory registry that
// enforces DECLARATIVE PARTITIONING for concurrent sub-agent fan-out. A Leader
// (the primary run) calls `acquire(taskId, writes)` before dispatching a child
// and `release(taskId)` after the child terminates (or its worktree merges
// back). Conflicting `writes` declarations are rejected at acquire-time so
// merge-time conflicts are impossible by construction.
//
// The coordinator is intentionally transport-agnostic: it does not know about
// RunHandle, TaskManager, or worktrees. Callers compose it with whichever
// dispatch surface they use.

/**
 * Outcome of a `ConcurrencyCoordinator.acquire` call.
 *
 * @public
 * @stability experimental v0.1
 */
export type AcquireResult =
  | { status: "granted" }
  | {
      status: "conflict";
      /** Existing claim ids whose globs overlap the requested writes. */
      conflictsWith: string[];
      /** Human-readable explanation suitable for logging. */
      reason: string;
    };

/**
 * Snapshot of an active claim. Returned by `inFlight()` for diagnostics.
 *
 * @public
 * @stability experimental v0.1
 */
export interface WritesClaim {
  /** @reserved Public claim id field consumed by coordination diagnostics. */
  claimId: string;
  writes: string[];
  /** @reserved Public timestamp field consumed by coordination diagnostics. */
  acquiredAt: string;
}

/**
 * Tracks in-flight write declarations and detects glob overlap between them.
 *
 * Usage:
 *
 * ```ts
 * const coord = new ConcurrencyCoordinator();
 * const r = coord.acquire("task-1", ["src/auth/**"]);
 * if (r.status === "granted") {
 *   // dispatch sub-agent
 *   // ... on terminal:
 *   coord.release("task-1");
 * }
 * ```
 *
 * A claim with an empty `writes` array is treated as a workspace-wide
 * exclusive claim (conservative default) and will conflict with any
 * concurrent claim. Callers that genuinely require workspace-wide isolation
 * should pass `["**"]` explicitly — both forms behave identically; the empty
 * form is a safety net for callers that forgot to declare.
 *
 * @public
 * @stability experimental v0.1
 */
export class ConcurrencyCoordinator {
  private readonly claims = new Map<string, WritesClaim>();

  /**
   * Attempt to register a claim. Returns `granted` when no in-flight claim
   * overlaps with `writes`. Otherwise returns `conflict` with the offending
   * claim ids; the caller decides whether to queue, fail, or wait.
   *
   * Calling `acquire` twice with the same `claimId` is an error — release
   * the previous claim first.
   */
  acquire(claimId: string, writes: string[]): AcquireResult {
    if (this.claims.has(claimId)) {
      throw new Error(
        `ConcurrencyCoordinator: claim id already in use: ${claimId}`,
      );
    }
    const effectiveWrites = writes.length === 0 ? ["**"] : writes;
    const conflictsWith: string[] = [];
    for (const [otherId, claim] of this.claims) {
      if (claimsOverlap(effectiveWrites, claim.writes)) {
        conflictsWith.push(otherId);
      }
    }
    if (conflictsWith.length > 0) {
      return {
        status: "conflict",
        conflictsWith,
        reason: `writes [${effectiveWrites.join(", ")}] overlap with in-flight claims: ${conflictsWith.join(", ")}`,
      };
    }
    this.claims.set(claimId, {
      claimId,
      writes: [...effectiveWrites],
      acquiredAt: new Date().toISOString(),
    });
    return { status: "granted" };
  }

  /** Release a claim. Idempotent — releasing an unknown claim is a no-op. */
  release(claimId: string): void {
    this.claims.delete(claimId);
  }

  /** Snapshot of currently in-flight claims. */
  inFlight(): WritesClaim[] {
    return [...this.claims.values()];
  }

  /** Number of active claims. */
  size(): number {
    return this.claims.size;
  }
}

/**
 * Return true if any concrete file path could match BOTH glob `a` and glob
 * `b`. Conservative: when in doubt, return true (callers will serialize
 * unnecessarily, which is safe). Glob syntax: literal segments, `*` matches a
 * single segment, `**` matches zero or more segments.
 *
 * @public
 * @stability experimental v0.1
 */
export function globsOverlap(a: string, b: string): boolean {
  const sa = normalizeGlob(a);
  const sb = normalizeGlob(b);
  if (sa === sb) return true;
  return segmentsOverlap(splitSegments(sa), splitSegments(sb));
}

function claimsOverlap(a: string[], b: string[]): boolean {
  for (const left of a) {
    for (const right of b) {
      if (globsOverlap(left, right)) return true;
    }
  }
  return false;
}

function normalizeGlob(glob: string): string {
  let trimmed = glob.trim();
  // Strip leading "./".
  while (trimmed.startsWith("./")) trimmed = trimmed.slice(2);
  // Collapse repeated slashes.
  trimmed = trimmed.replace(/\/+/g, "/");
  // Strip trailing slash unless it's just "/".
  if (trimmed.length > 1 && trimmed.endsWith("/")) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

function splitSegments(glob: string): string[] {
  if (glob.length === 0) return [];
  return glob.split("/");
}

/**
 * Recursive segment-level overlap check. `**` matches zero or more whole
 * segments; everything else matches exactly one segment (with `*` matching
 * any substring within that segment).
 */
function segmentsOverlap(a: string[], b: string[]): boolean {
  // Both consumed.
  if (a.length === 0 && b.length === 0) return true;
  // One side empty: the other must consist entirely of `**` (which can
  // absorb zero segments) to overlap.
  if (a.length === 0) return b.every((seg) => seg === "**");
  if (b.length === 0) return a.every((seg) => seg === "**");

  const [ha, ...ra] = a;
  const [hb, ...rb] = b;

  if (ha === "**" && hb === "**") {
    // Both can absorb 0+ segments. Try both branches.
    return (
      segmentsOverlap(ra, b) ||
      segmentsOverlap(a, rb) ||
      segmentsOverlap(ra, rb)
    );
  }
  if (ha === "**") {
    // `**` matches 0 segments (skip it) or 1+ segments (consume head of b).
    return segmentsOverlap(ra, b) || segmentsOverlap(a, rb);
  }
  if (hb === "**") {
    return segmentsOverlap(a, rb) || segmentsOverlap(ra, b);
  }
  // Two concrete segments — both must match a common literal substring.
  if (!segmentOverlap(ha!, hb!)) return false;
  return segmentsOverlap(ra, rb);
}

/**
 * Check whether two single-segment patterns (literals or with `*` wildcards)
 * could match a common string. `*` matches any run of non-`/` characters.
 *
 * Strategy:
 *   1. If neither has `*`, they overlap only when identical.
 *   2. If exactly one has `*`, regex-test the literal against the wildcard
 *      pattern.
 *   3. If both have `*`, anchor by literal prefix and literal suffix.
 *      Incompatible prefixes (or suffixes) rule out overlap; otherwise be
 *      conservative and assume overlap (safe: causes unnecessary
 *      serialization, never silently allows a real conflict).
 */
function segmentOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const aHasStar = a.includes("*");
  const bHasStar = b.includes("*");
  if (!aHasStar && !bHasStar) return false;
  if (aHasStar && !bHasStar) return compileSegmentRegex(a).test(b);
  if (!aHasStar && bHasStar) return compileSegmentRegex(b).test(a);

  // Both have wildcards. Anchor by literal prefix (head before first `*`)
  // and literal suffix (tail after last `*`). When both prefixes are
  // non-empty and neither is a prefix of the other, no string can satisfy
  // both. Same for suffixes. Otherwise conservatively assume overlap.
  const aParts = a.split("*");
  const bParts = b.split("*");
  const aPrefix = aParts[0]!;
  const aSuffix = aParts[aParts.length - 1]!;
  const bPrefix = bParts[0]!;
  const bSuffix = bParts[bParts.length - 1]!;
  if (
    aPrefix.length > 0 &&
    bPrefix.length > 0 &&
    !aPrefix.startsWith(bPrefix) &&
    !bPrefix.startsWith(aPrefix)
  ) {
    return false;
  }
  if (
    aSuffix.length > 0 &&
    bSuffix.length > 0 &&
    !aSuffix.endsWith(bSuffix) &&
    !bSuffix.endsWith(aSuffix)
  ) {
    return false;
  }
  return true;
}

function compileSegmentRegex(segment: string): RegExp {
  const body = segment
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${body}$`);
}
