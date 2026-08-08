import { resolve } from "node:path";
import {
  FileTaskNotificationOutbox,
  FileTaskStore,
  FileWorkflowControlInbox,
  FileWorkflowNotificationOutbox,
  TaskManager,
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

/** Workspace/session-store scoped durable owners shared by Host executions. */
export class WorkspaceContext {
  readonly workspaceRoot: string;
  readonly sessionRootDir: string;
  readonly taskNotifications: FileTaskNotificationOutbox;
  readonly workflowNotifications: FileWorkflowNotificationOutbox;
  readonly workflowControls: FileWorkflowControlInbox;
  readonly workflowControlDispatcher = new InFlightCommandDispatcher();
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
    });
  }
}

export function workspaceContextKey(
  identity: WorkspaceContextIdentity,
): string {
  return `${resolve(identity.workspaceRoot)}\0${resolve(identity.sessionRootDir)}`;
}
