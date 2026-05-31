// =============================================================================
// @sparkwright/core/internal — UNSTABLE reference implementations.
//
// Public API lives at "@sparkwright/core". Prefer that. Symbols here may move
// or change shape between 0.x minor versions. Pin a minor version if you must
// depend on them.
//
// This entry point exists so that consumers extending core (custom run
// runtimes, file-system integrations, etc.) can opt in explicitly rather than
// reach into the top-level barrel.
// =============================================================================

export { EventLog } from "./events.js";
export {
  buildTraceTimeline,
  buildTraceTimelineFile,
  buildTraceTimelineJsonl,
  createSessionFileRunStoreFactory,
  FileRunStore,
  MemoryTrace,
  loadTraceEventsFile,
  loadTraceEventsJsonl,
  repairSessionTraceConsistency,
  summarizeTraceFile,
  summarizeTraceJsonl,
  validateSessionTraceConsistency,
} from "./trace.js";
export type {
  FileRunStoreOptions,
  RepairSessionTraceConsistencyOptions,
  SessionTraceConsistencyFinding,
  SessionTraceConsistencyReport,
  SessionTraceRepairAction,
  SessionTraceRepairReport,
  SessionFileRunStoreFactoryOptions,
  TraceEventFilter,
  TraceSummary,
  TraceTimeline,
  TraceTimelinePhase,
  TraceTimelinePhaseCategory,
  TraceTimelinePhaseStatus,
  ValidateSessionTraceConsistencyOptions,
} from "./trace.js";
export { LocalWorkspace, ControlledWorkspace } from "./workspace.js";
export type { ControlledWorkspaceOptions } from "./workspace.js";
export {
  DefaultObservationFormatter,
  DefaultContextAssembler,
  SectionedPromptBuilder,
  DefaultPromptBuilder,
  createDefaultPromptSections,
  compilePromptCacheBlocks,
} from "./context.js";
export type {
  DefaultObservationFormatterOptions,
  DefaultContextAssemblerOptions,
  SectionedPromptBuilderOptions,
  DefaultPromptBuilderOptions,
  PromptCacheBlock,
  PromptCacheBlocks,
} from "./context.js";
export { SparkwrightRun } from "./run.js";
export {
  toolBatchEventPayload,
  partitionToolCalls,
  runToolBatch,
  runToolBatchUpdates,
} from "./tool-orchestration.js";
export type { ToolExecutionUpdate } from "./tool-orchestration.js";
