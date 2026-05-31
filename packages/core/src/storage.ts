/**
 * Storage protocols for run persistence and trace sinks.
 *
 * These are the extension protocols third parties implement to plug their own
 * persistence layer into the Sparkwright agent loop. The interfaces are kept
 * narrow on purpose so default implementations and remote backends can both
 * satisfy them.
 *
 * Default implementations live in `./trace.ts`:
 *   - `RunStore`  -> `FileRunStore` (writes JSONL trace + artifacts to disk)
 *   - `TraceSink` -> `MemoryTrace`  (collects serialized events in memory)
 *
 * @packageDocumentation
 */

import type { SparkwrightEvent } from "./events.js";
import type { Artifact, RunRecord, RunResult } from "./types.js";

/**
 * Persistent store for a single run's event stream, terminal result, and
 * produced artifacts.
 *
 * Implementations should be safe to call from a single run loop; concurrency
 * across runs is the caller's responsibility.
 *
 * @public
 * @stability experimental v0.1
 */
export interface RunStore {
  /**
   * Append a single event to the run's trace. Artifact materialization for
   * `artifact.created` events is the implementation's responsibility.
   */
  append(event: SparkwrightEvent): void | Promise<void>;

  /**
   * Finalize the run with its updated record and terminal result.
   */
  finish(run: RunRecord, result: RunResult): void | Promise<void>;

  /**
   * Optional: replay the persisted event stream for a run. Reserved for future
   * resume/replay features; not required in v0.1.
   */
  loadEvents?(runId: RunRecord["id"]): AsyncIterable<SparkwrightEvent>;

  /**
   * Optional: explicitly materialize an artifact outside the event stream.
   * The default file store writes artifacts implicitly when it sees
   * `artifact.created`, so most implementations can omit this.
   */
  writeArtifact?(artifact: Artifact): void | Promise<void>;
}

/**
 * Lightweight sink for observing the event stream without owning persistence
 * semantics. Useful for in-memory capture, log forwarding, or telemetry.
 *
 * @public
 * @stability experimental v0.1
 */
export interface TraceSink {
  /**
   * Write a single event. May be sync or async; the harness awaits the
   * returned promise when present.
   */
  write(event: SparkwrightEvent): void | Promise<void>;

  /**
   * Optional: flush any buffered events to the underlying transport.
   */
  flush?(): Promise<void>;
}
