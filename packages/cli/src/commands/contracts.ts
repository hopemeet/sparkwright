import type {
  BackgroundTaskPolicy,
  PermissionMode,
  RunAccessMode,
  TraceLevel,
} from "@sparkwright/protocol";
import type { CliApprovalOptions, CliRunAccess } from "../run-access.js";

export interface CliRunResult {
  exitCode: number;
  tracePath?: string;
  sessionId?: string;
  runState?: string;
  stopReason?: string;
}

export interface ParsedArgs {
  command: string;
  subcommand?: string;
  goal: string;
  target?: string;
  traceLevel: TraceLevel;
  workspaceRoot: string;
  workspaceRootSource: "default" | "config" | "cli";
  sessionRootDir: string;
  sessionRootDirSource: "default" | "cli";
  targetPath: string;
  targetPathSource: "default" | "cli";
  /** Workspace-relative paths/globs whose contents the run must not read. */
  confidentialPaths: string[];
  /** Whether the built-in conservative confidential path defaults are active. */
  confidentialDefaults: boolean;
  imagePaths: string[];
  accessMode?: RunAccessMode;
  backgroundTasks?: BackgroundTaskPolicy;
  shouldWrite: boolean;
  approveAll: boolean;
  approveEdits: boolean;
  approveShellSafe: boolean;
  permissionMode: PermissionMode;
  runAccess: CliRunAccess;
  approvalOptions: CliApprovalOptions;
  /** Model reference in "provider/model" form, or the reserved "deterministic". */
  modelName?: string;
  modelNameSource?: "config" | "cli";
  workflowName?: string;
  sessionId?: string;
  format: "json" | "text";
  eventType?: string;
  runId?: string;
  skillName?: string;
  skillKey?: string;
  packageHash?: string;
  contains?: string;
  limit?: number;
  afterSequence?: number;
  beforeSequence?: number;
  jsonl: boolean;
  apply: boolean;
  force: boolean;
  fromTrace: boolean;
  directCore: boolean;
  verbose: boolean;
  resolveMcp: boolean;
  llm: boolean;
  compaction: boolean;
  detach: boolean;
  delegateGoal?: string;
}
