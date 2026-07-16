import type {
  BackgroundTaskPolicy,
  RunAccessMode,
} from "@sparkwright/protocol";

export interface CliRunAccess {
  accessMode: RunAccessMode;
  backgroundTasks?: BackgroundTaskPolicy;
}
