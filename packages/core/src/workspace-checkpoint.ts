// Workspace file checkpoints — transparent pre-write snapshots with rollback.
//
// This is infrastructure, not a tool: the model never sees it. When a
// checkpoint store is wired into a ControlledWorkspace, the prior content of
// every file is captured the first time it is written within an open
// checkpoint. Rolling back to a checkpoint restores the workspace to its state
// at the moment that checkpoint was opened, undoing every later write.
//
// The store is dependency-free (no shadow git): it keeps first-touch
// pre-images per checkpoint and replays them in reverse through an injected
// restore target. A host typically opens one checkpoint per turn so a turn can
// be rolled back as a unit.

import { createWorkspaceWriteId } from "./ids.js";

export interface WorkspaceCheckpointFile {
  path: string;
  /** Whether the file existed before the first write in this checkpoint. */
  existedBefore: boolean;
  /** Pre-write content; present only when `existedBefore` is true. */
  content?: string;
}

export interface WorkspaceCheckpointMeta {
  id: string;
  label?: string;
  createdAt: string;
  /** Distinct files captured so far in this checkpoint. */
  fileCount: number;
}

/** Sink that applies a rollback to the underlying filesystem. */
export interface WorkspaceCheckpointRestoreTarget {
  writeText(path: string, content: string): Promise<void>;
  /** Remove a file that did not exist when the checkpoint opened. */
  removeFile(path: string): Promise<void>;
}

export interface WorkspaceRollbackResult {
  checkpointId: string;
  restored: string[];
  removed: string[];
}

export interface WorkspaceCheckpointStoreOptions {
  /** Maximum checkpoints retained; the oldest are pruned past this. Default 20. */
  maxCheckpoints?: number;
  now?: () => Date;
  createId?: () => string;
}

interface OpenCheckpoint {
  id: string;
  label?: string;
  createdAt: string;
  files: Map<string, WorkspaceCheckpointFile>;
}

export class WorkspaceCheckpointStore {
  private readonly maxCheckpoints: number;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly checkpoints: OpenCheckpoint[] = [];

  constructor(options: WorkspaceCheckpointStoreOptions = {}) {
    this.maxCheckpoints = options.maxCheckpoints ?? 20;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? createWorkspaceWriteId;
  }

  /**
   * Seal the current checkpoint (if any) and open a new one. Subsequent writes
   * capture their pre-images here. Returns the new checkpoint id.
   */
  openCheckpoint(label?: string): string {
    const checkpoint: OpenCheckpoint = {
      id: this.createId(),
      label,
      createdAt: this.now().toISOString(),
      files: new Map(),
    };
    this.checkpoints.push(checkpoint);
    this.prune();
    return checkpoint.id;
  }

  /**
   * Capture a file's pre-image before it is written. No-op if the path was
   * already captured in the current checkpoint (first touch wins, preserving
   * the state at checkpoint open). Auto-opens a checkpoint if none is open.
   */
  recordBeforeWrite(file: WorkspaceCheckpointFile): void {
    const open = this.current() ?? this.openCheckpointInternal();
    if (open.files.has(file.path)) return;
    open.files.set(file.path, {
      path: file.path,
      existedBefore: file.existedBefore,
      content: file.existedBefore ? (file.content ?? "") : undefined,
    });
  }

  listCheckpoints(): WorkspaceCheckpointMeta[] {
    return this.checkpoints.map((checkpoint) => ({
      id: checkpoint.id,
      label: checkpoint.label,
      createdAt: checkpoint.createdAt,
      fileCount: checkpoint.files.size,
    }));
  }

  /**
   * Restore the workspace to its state when checkpoint `id` was opened, undoing
   * that checkpoint and every later one. For each affected path the earliest
   * captured pre-image wins; files that did not exist then are removed. The
   * rolled-back checkpoints are dropped.
   */
  async rollback(
    id: string,
    target: WorkspaceCheckpointRestoreTarget,
  ): Promise<WorkspaceRollbackResult> {
    const index = this.checkpoints.findIndex(
      (checkpoint) => checkpoint.id === id,
    );
    if (index === -1) {
      throw new Error(`Unknown workspace checkpoint: ${id}`);
    }

    // Walk from the target checkpoint forward, keeping the earliest pre-image
    // per path — that is the state to restore to.
    const earliest = new Map<string, WorkspaceCheckpointFile>();
    for (let i = index; i < this.checkpoints.length; i += 1) {
      for (const file of this.checkpoints[i].files.values()) {
        if (!earliest.has(file.path)) earliest.set(file.path, file);
      }
    }

    const restored: string[] = [];
    const removed: string[] = [];
    for (const file of earliest.values()) {
      if (file.existedBefore) {
        await target.writeText(file.path, file.content ?? "");
        restored.push(file.path);
      } else {
        await target.removeFile(file.path);
        removed.push(file.path);
      }
    }

    this.checkpoints.splice(index);
    return { checkpointId: id, restored, removed };
  }

  private current(): OpenCheckpoint | undefined {
    return this.checkpoints[this.checkpoints.length - 1];
  }

  private openCheckpointInternal(): OpenCheckpoint {
    this.openCheckpoint();
    return this.current()!;
  }

  private prune(): void {
    while (this.checkpoints.length > this.maxCheckpoints) {
      this.checkpoints.shift();
    }
  }
}
