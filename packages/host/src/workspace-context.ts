import { resolve } from "node:path";
import {
  FileTaskNotificationOutbox,
  FileTaskStore,
  FileWorkflowControlInbox,
  FileWorkflowNotificationOutbox,
  TaskManager,
  type TaskLifecycleObserver,
  type TaskLifecycleUpdate,
} from "@sparkwright/agent-runtime";
import { InFlightCommandDispatcher } from "@sparkwright/server-runtime";
import type { WorkspaceLeaseCoordinator } from "./workspace-lease-coordinator.js";
import { workspaceTaskRootDir } from "./runtime/task-runtime-operations.js";
import {
  workspaceWorkflowNotificationRootDir,
  workspaceWorkflowRootDir,
} from "./runtime/workflow-runtime-operations.js";

export interface WorkspaceContextIdentity {
  workspaceRoot: string;
  sessionRootDir: string;
}

type TaskLifecycleListener = (update: TaskLifecycleUpdate) => void;

/** Process-local fanout independent from the parent actor notification inbox. */
export class WorkspaceTaskLifecycleHub implements TaskLifecycleObserver {
  private readonly listeners = new Set<TaskLifecycleListener>();

  subscribe(listener: TaskLifecycleListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onTaskUpdated(update: TaskLifecycleUpdate): void {
    for (const listener of this.listeners) {
      try {
        listener(update);
      } catch {
        // Live lifecycle push is best-effort; TaskStore remains authoritative.
      }
    }
  }
}

/** Workspace/session-store scoped durable owners shared by Host executions. */
export class WorkspaceContext {
  readonly workspaceRoot: string;
  readonly sessionRootDir: string;
  readonly taskNotifications: FileTaskNotificationOutbox;
  readonly workflowNotifications: FileWorkflowNotificationOutbox;
  readonly workflowControls: FileWorkflowControlInbox;
  readonly workflowControlDispatcher = new InFlightCommandDispatcher();
  readonly taskLifecycle = new WorkspaceTaskLifecycleHub();
  readonly taskManager: TaskManager;
  readonly workspaceLeaseCoordinator: WorkspaceLeaseCoordinator;

  constructor(
    identity: WorkspaceContextIdentity,
    workspaceLeaseCoordinator: WorkspaceLeaseCoordinator,
  ) {
    this.workspaceRoot = resolve(identity.workspaceRoot);
    this.sessionRootDir = resolve(identity.sessionRootDir);
    this.workspaceLeaseCoordinator = workspaceLeaseCoordinator;
    const taskRoot = workspaceTaskRootDir(this.workspaceRoot);
    this.taskNotifications = new FileTaskNotificationOutbox({
      rootDir: taskRoot,
      createRoot: false,
    });
    this.workflowNotifications = new FileWorkflowNotificationOutbox({
      rootDir: workspaceWorkflowNotificationRootDir(this.workspaceRoot),
      createRoot: false,
    });
    this.workflowControls = new FileWorkflowControlInbox({
      rootDir: workspaceWorkflowRootDir(this.workspaceRoot),
      createRoot: false,
    });
    this.taskManager = new TaskManager({
      store: new FileTaskStore({ rootDir: taskRoot, createRoot: false }),
      notificationSink: this.taskNotifications,
      notificationInbox: this.taskNotifications,
      lifecycleObserver: this.taskLifecycle,
    });
  }
}

export function workspaceContextKey(
  identity: WorkspaceContextIdentity,
): string {
  return `${resolve(identity.workspaceRoot)}\0${resolve(identity.sessionRootDir)}`;
}
