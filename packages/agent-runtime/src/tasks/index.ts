// AI maintenance note: Barrel for the long-running task subsystem. Keep this
// file purely a re-export surface — public API additions belong in the
// individual modules so JSDoc/`@stability` tags stay with their definitions.

export type {
  TaskId,
  TaskStatus,
  TaskError,
  TaskRecord,
  TaskOutputChunk,
  TaskProgressUpdate,
  TaskHandle,
} from "./types.js";
export { createTaskId } from "./types.js";

export type {
  TaskStore,
  TaskListFilter,
  TaskUpdatePatch,
  CreateTaskInput,
} from "./store.js";
export { InMemoryTaskStore } from "./store.js";

export type {
  TaskManagerOptions,
  TaskRunner,
  TaskRunnerController,
  SpawnTaskInput,
} from "./manager.js";
export { TaskManager } from "./manager.js";

export type {
  ActorInbox,
  ActorNotificationBase,
  ActorNotificationInputBase,
  ActorNotificationPredicate,
  ActorNotificationQos,
  ActorNotificationSink,
  ActorNotificationType,
  ActorRef,
  ActorRouteHint,
  AnyActorNotification,
  AnyActorNotificationInput,
  DeliveryResult,
  InternalActorKind,
  TaskNotification,
  TaskNotificationReadyWaitOptions,
  TaskNotificationSink,
  TaskTerminalStatus,
  InMemoryTaskNotificationQueueOptions,
  TaskActorNotification,
  TaskActorNotificationInput,
  TaskCancelledActorNotification,
  TaskCancelledNotificationInput,
  TaskCancelledNotificationPayload,
  TaskCompletedActorNotification,
  TaskCompletedNotificationInput,
  TaskCompletedNotificationPayload,
  TaskFailedActorNotification,
  TaskFailedNotificationInput,
  TaskFailedNotificationPayload,
  TaskOutputActorNotification,
  TaskOutputNotificationInput,
  TaskOutputNotificationPayload,
  TaskProgressActorNotification,
  TaskProgressNotificationInput,
  TaskProgressNotificationPayload,
  WorkflowActorNotification,
  WorkflowActorNotificationInput,
  WorkflowCompletedActorNotification,
  WorkflowCompletedNotificationInput,
  WorkflowCompletedNotificationPayload,
  WorkflowFailedActorNotification,
  WorkflowFailedNotificationInput,
  WorkflowFailedNotificationPayload,
  WorkflowProgressActorNotification,
  WorkflowProgressNotificationInput,
  WorkflowProgressNotificationPayload,
} from "./notifications.js";
export {
  ActorNotificationCapacityError,
  ActorNotificationValidationError,
  InMemoryTaskNotificationQueue,
  acceptActorNotificationInput,
  actorNotificationInputFromTaskNotification,
  isNonRetryableActorNotificationError,
  notificationFromRecord,
  qosForActorNotificationType,
  taskNotificationFromActorNotification,
} from "./notifications.js";

export type {
  CreateTaskToolsOptions,
  TaskCreateKindDescriptor,
} from "./tools.js";
export {
  createTaskTools,
  createTaskCreate,
  createTaskControl,
  createTaskList,
  createTaskGet,
  createTaskStop,
  createTaskOutput,
} from "./tools.js";

export type {
  TaskHealthProbe,
  TaskHealthProbeResult,
  RecoverRunningTasksOptions,
  TaskWatchdogHandle,
  TaskWatchdogOptions,
  TaskWatchdogSweepResult,
} from "./watchdog.js";
export {
  TaskWatchdog,
  pidTaskHealthProbe,
  recoverRunningTasks,
} from "./watchdog.js";

export type { FileTaskStoreOptions } from "./file-store.js";
export { FileTaskStore } from "./file-store.js";

export type {
  FileTaskNotificationEntry,
  FileTaskNotificationOutboxOptions,
} from "./file-notifications.js";
export { FileTaskNotificationOutbox } from "./file-notifications.js";
