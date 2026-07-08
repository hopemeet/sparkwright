import type {
  BackgroundTaskPolicy,
  PermissionMode,
  RunAccessMode,
} from "@sparkwright/protocol";

export interface CliRunAccess {
  accessMode?: RunAccessMode;
  backgroundTasks?: BackgroundTaskPolicy;
  shouldWrite: boolean;
  permissionMode: PermissionMode;
}

export interface CliApprovalOptions {
  approveAll: boolean;
  approveEdits: boolean;
  approveShellSafe: boolean;
}
