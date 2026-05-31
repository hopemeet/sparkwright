// AI maintenance note: TaskRecord/TaskHandle model the BACKGROUND LONG-RUNNING
// WORK axis spawned by a run. Tasks are orthogonal to sub-agents: a sub-agent
// is a child Run with its own loop; a task is a piece of work the host runs
// asynchronously and the parent polls (output streaming, status, cancel).
//
// Shapes intentionally mirror RunHandle/RunRecord conventions in
// packages/core/src/run.ts (record + handle, branded ids, terminal-state
// transitions) without reusing the Run type — tasks have their own lifecycle.

import { createId } from "@sparkwright/core";
import type { Brand, RunId } from "@sparkwright/core";

/**
 * Branded identifier for a background task.
 *
 * @public
 * @stability experimental v0.1
 */
export type TaskId = Brand<string, "TaskId">;

/**
 * Lifecycle states a task transitions through. Terminal states are
 * `completed`, `failed`, and `cancelled`.
 *
 * @public
 * @stability experimental v0.1
 */
export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Error descriptor attached to a failed task.
 *
 * @public
 * @stability experimental v0.1
 */
export interface TaskError {
  code: string;
  message: string;
  metadata?: Record<string, unknown>;
}

/**
 * Persistent record describing a background task. Hosts may serialize this for
 * cross-process resumption; the runtime treats it as the authoritative shape.
 *
 * @public
 * @stability experimental v0.1
 */
export interface TaskRecord {
  id: TaskId;
  parentRunId: RunId;
  kind: string;
  title?: string;
  status: TaskStatus;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp set when the runner first executes. */
  startedAt?: string;
  /** ISO-8601 timestamp updated whenever output is appended. */
  lastOutputAt?: string;
  /** ISO-8601 timestamp updated whenever progress is reported. */
  lastProgressAt?: string;
  /** ISO-8601 timestamp updated by host watchdogs after a health probe. */
  lastHealthCheckAt?: string;
  /** Total number of output chunks appended so far. */
  outputChunks?: number;
  /** Total UTF-16 string length of output appended so far. */
  outputBytes?: number;
  /** ISO-8601 timestamp set on terminal transition. */
  completedAt?: string;
  /** Final value produced by the runner. Present only when status === "completed". */
  result?: unknown;
  /** Populated when status === "failed". */
  error?: TaskError;
  metadata: Record<string, unknown>;
}

/**
 * One streamed chunk of a task's output. `sequence` is a monotonically
 * increasing per-task counter; clients use it to resume.
 *
 * @public
 * @stability experimental v0.1
 */
export interface TaskOutputChunk {
  taskId: TaskId;
  sequence: number;
  /** ISO-8601 timestamp. */
  timestamp: string;
  channel: "stdout" | "stderr" | "event";
  data: string;
}

/**
 * Progress payload reported by runners. Mirrors core's ToolProgressUpdate but
 * stays decoupled to keep the task surface independent of the tool loop.
 *
 * @public
 * @stability experimental v0.1
 */
export interface TaskProgressUpdate {
  /** @reserved Public field consumed by task-progress UIs. */
  label?: string;
  message?: string;
  /** @reserved Public field consumed by task-progress UIs. */
  completedUnits?: number;
  /** @reserved Public field consumed by task-progress UIs. */
  totalUnits?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Live handle to a spawned task. The `record` reference is mutable and
 * reflects the latest known state; treat reads as a snapshot.
 *
 * @public
 * @stability experimental v0.1
 */
export interface TaskHandle {
  record: TaskRecord;
  /**
   * Request cancellation. Resolves once the runner has observed the abort and
   * the record reaches a terminal state. Idempotent.
   */
  cancel(): Promise<void>;
  /**
   * Resolve with the terminal `TaskRecord`. Never rejects — failures surface
   * as `status === "failed"` with `error` populated.
   *
   * @reserved Public field consumed by task orchestrators.
   */
  wait(): Promise<TaskRecord>;
  /**
   * Stream output chunks. Yields any already-buffered chunks then live ones
   * until the task reaches a terminal state.
   */
  output(): AsyncIterable<TaskOutputChunk>;
}

/**
 * Generate a fresh task id.
 *
 * @public
 * @stability experimental v0.1
 */
export function createTaskId(): TaskId {
  return createId("task") as unknown as TaskId;
}
