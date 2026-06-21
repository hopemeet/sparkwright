// AI maintenance note: stable named facade for trace APIs. Phase 1 keeps
// index.ts/internal.ts pointing here while implementation lives in endpoint modules.

export {
  createTraceRedactor,
  filterTraceEvent,
  isVerboseStreamEvent,
  serializeEventJsonl,
} from "./trace-codec.js";
export type {
  TraceLevel,
  TraceRedactionOptions,
  TraceRedactor,
} from "./trace-codec.js";
export {
  buildTraceReport,
  buildTraceReportFile,
  buildTraceReportJsonl,
  buildTraceTimeline,
  buildTraceTimelineFile,
  buildTraceTimelineJsonl,
  loadTraceEventsFile,
  loadTraceEventsJsonl,
  summarizeTraceFile,
  summarizeTraceJsonl,
  verifyTraceFile,
  verifyTraceJsonl,
} from "./trace-diagnostics.js";
export type {
  TraceEventFilter,
  TraceReport,
  TraceReportFinding,
  TraceReportFindingSeverity,
  TraceReportVerdict,
  TraceSummary,
  TraceTimeline,
  TraceTimelinePhase,
  TraceTimelinePhaseCategory,
  TraceTimelinePhaseStatus,
  TraceVerificationFinding,
  TraceVerificationReport,
} from "./trace-diagnostics.js";
export {
  repairSessionTraceConsistency,
  validateSessionTraceConsistency,
} from "./trace-session-consistency.js";
export type {
  RepairSessionTraceConsistencyOptions,
  SessionTraceConsistencyFinding,
  SessionTraceConsistencyReport,
  SessionTraceRepairAction,
  SessionTraceRepairReport,
  ValidateSessionTraceConsistencyOptions,
} from "./trace-session-consistency.js";
export {
  bindStorageDegradationEvents,
  createSessionFileRunStoreFactory,
  FileRunStore,
  loadCheckpointFromRunDir,
  MemoryTrace,
  restoreTranscriptPrompts,
} from "./trace-store.js";
export type {
  FileRunStoreOptions,
  LoadCheckpointFromRunDirOptions,
  SessionFileRunStoreFactoryOptions,
} from "./trace-store.js";
