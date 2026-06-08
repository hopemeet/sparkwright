// =============================================================================
// @sparkwright/core — public API surface
//
// Two layers live behind this entry point:
//
// 1. PUBLIC API — types, factories, and extension interfaces. Semver-tracked
//    from v0.1 onward. Build on these freely.
//
// 2. IMPLEMENTATION — reference classes (SparkwrightRun, EventLog, FileRunStore,
//    LocalWorkspace, default context/prompt/observer impls…). Re-exported here
//    for current consumers and backward compatibility, but their shape is
//    NOT semver-stable in 0.x. Prefer the public API (`createRun`, `defineTool`,
//    extension interfaces). If you must depend on a class directly, import via
//    `@sparkwright/core/internal` and pin a minor version. See docs/AI_TASK_INDEX.md
//    and the README "API Stability" section.
// =============================================================================

// -----------------------------------------------------------------------------
// PUBLIC API
// -----------------------------------------------------------------------------

// IDs & brands
export type {
  Brand,
  SessionId,
  RunId,
  EventId,
  ToolCallId,
  ApprovalId,
  ArtifactId,
  ContextItemId,
  WorkspaceWriteId,
  PlanId,
  PlanStepId,
  SpanId,
  TraceId,
} from "./ids.js";
export {
  createId,
  createSessionId,
  asSessionId,
  assertSafePathSegment,
  createRunId,
  createEventId,
  createToolCallId,
  createApprovalId,
  createArtifactId,
  createContextItemId,
  createWorkspaceWriteId,
  createPlanId,
  createPlanStepId,
  createSpanId,
  createTraceId,
} from "./ids.js";

// Core data shapes
export type * from "./types.js";

// Events
export type {
  EventType,
  SparkwrightEvent,
  EventEmitter,
  BufferedEmitter,
} from "./events.js";
export { createBufferedEmitter } from "./events.js";

// Span correlation (ADR-0008) — optional trace tree layered on the event stream.
export type { SpanFrame, WithSpanSpec, SpanSemantics } from "./spans.js";
export {
  withSpan,
  withSpanSync,
  currentSpan,
  emitInSpan,
  openSpan,
  runWithSpan,
  semanticsToMetadata,
  SPAN_SEMANTIC_METADATA_KEYS,
} from "./spans.js";

// Tools
export type {
  ToolRisk,
  ToolSideEffect,
  ToolIdempotency,
  ToolDataSensitivity,
  ToolRateLimit,
  ToolAuditPolicy,
  ToolCostEstimate,
  ToolInterruptBehavior,
  ToolAvailableProbe,
  ToolResultSizePolicy,
  ToolProgressUpdate,
  ToolOrigin,
  ToolGovernance,
  ToolInputSchema,
  ToolDescriptor,
  ToolDefinition,
  ToolRegistryOptions,
} from "./tools.js";
export {
  defineTool,
  isToolConcurrencySafe,
  validateToolArguments,
  validateToolOutput,
  createToolCall,
  ToolRegistry, // public: createRun({ tools }) accepts a ToolRegistry
} from "./tools.js";
export type {
  RequestedToolCall,
  ToolCallBatch,
  ToolBatchExecutionOptions,
  ToolExecutionUpdate,
} from "./tool-orchestration.js";
export {
  partitionToolCalls,
  runToolBatch,
  runToolBatchUpdates,
  toolBatchEventPayload,
} from "./tool-orchestration.js";

// Prompt-cache integrity detector.
export type { CacheBreakDetectorOptions } from "./cache-break.js";
export { wrapPromptBuilderWithCacheBreakDetector } from "./cache-break.js";

// Tool search — lazy-loading discovery for deferred tools.
export type {
  ToolSearchSource,
  ToolSearchInput,
  ToolSearchMatch,
  ToolSearchResult,
  CreateToolSearchToolOptions,
} from "./tool-search.js";
export {
  createToolSearchTool,
  toolSearchSourceFromRegistry,
} from "./tool-search.js";

// Policy
export type {
  PolicyDecisionKind,
  PermissionMode,
  PolicyResource,
  PolicyInput,
  PolicyDecision,
  Policy,
  PermissionModePolicyOptions,
  ToolGovernancePolicyOptions,
  WorkspaceMutationPolicyOptions,
} from "./policy.js";
export {
  createDefaultPolicy,
  createLayeredPolicy,
  createPermissionModePolicy,
  createToolGovernancePolicy,
  createWorkspaceMutationPolicy,
} from "./policy.js";

// Execution environment boundary
export type {
  ShellExecutionStatus,
  ShellSafetyDecisionKind,
  ShellExecutionRequest,
  ShellSafetyContext,
  ShellSafetyDecision,
  ShellExecutionResult,
  LiveShellHandle,
  ShellStreamingResult,
  ExecutionEnvironment,
  LocalProcessEnvironmentOptions,
  WorkspaceShellPolicyOptions,
  ShellToolOptions,
} from "./environment.js";
export {
  LocalProcessEnvironment,
  createWorkspaceShellPolicy,
  createShellExecutionTool,
} from "./environment.js";

// Approval
export type { ApprovalResolver } from "./approval.js";
export { createApprovalRequest, resolveApproval } from "./approval.js";

// Context
export type {
  ContextLayer,
  ContextStability,
  ContextBudget,
  ModelContextHints,
  ContextAssemblyInput,
  ContextOmission,
  ContextAssemblyResult,
  ContextAssembler,
  ContextHints,
  ContextUsageHint,
  Compactor,
  CompactingContextAssemblerOptions,
  PromptMessage,
  PromptBuildInput,
  PromptBuilder,
  PromptCacheBlock,
  PromptCacheBlocks,
  PromptSectionCachePolicy,
  PromptSectionBuildResult,
  PromptSection,
  SectionedPromptBuilderOptions,
  ObservationFormatInput,
  ObservationFormatter,
} from "./context.js";

// Anchored edits
export type {
  AnchoredLine,
  AnchoredText,
  AnchoredEditOperation,
  ApplyAnchoredEditsInput,
  ApplyAnchoredEditsResult,
} from "./anchored-edit.js";
export {
  ANCHORED_EDIT_HASH_ALGORITHM,
  AnchoredEditError,
  createAnchoredText,
  applyAnchoredEdits,
} from "./anchored-edit.js";

// Validation
export type * from "./validation.js";
export {
  validationFailureMessage,
  kickPostSamplingHooks,
} from "./validation.js";

// Loop pipeline extensions (compaction, prefetch, summarizer)
export type {
  CompactionTrigger,
  CompactionStage,
  CompactionStageInput,
  CompactionStageResult,
  CompactionPipelineOptions,
  CompactionPipelineInput,
  CompactionPipelineResult,
  ObservationSummarizer,
  ContextPrefetcher,
  UsageGateThresholds,
} from "./pipeline.js";
export {
  createCompactionPipeline,
  compactionStageFromCompactor,
  createToolResultBudgetStage,
  createSnipStage,
  createDefaultCompactionStages,
  gateStageByUsage,
  usageMeetsGate,
} from "./pipeline.js";

// Eval / trajectory
export type {
  TrajectoryFindingSeverity,
  TrajectoryFinding,
  TrajectoryEvalOptions,
  TrajectoryEvalResult,
} from "./eval.js";
export { evaluateTrajectory } from "./eval.js";

// Plans
export type {
  PlanStepStatus,
  PlanDecisionStatus,
  Plan,
  PlanStep,
  PlanConstraints,
  PlanStepBudgetEstimate,
  PlanDecision,
  CreatePlanInput,
  ReviewPlanOptions,
} from "./plan.js";
export { createPlan, reviewPlan } from "./plan.js";

// Trace primitives (level + types). Implementations re-exported below.
export type {
  TraceLevel,
  TraceRedactor,
  TraceRedactionOptions,
} from "./trace.js";
export {
  serializeEventJsonl,
  createTraceRedactor,
  filterTraceEvent,
  isVerboseStreamEvent,
} from "./trace.js";

// Model adapter helpers
export type {
  NamedModelAdapter,
  ModelRoute,
  FallbackModelAdapterOptions,
  RoutingModelAdapterOptions,
  AbortableModelAdapterOptions,
} from "./model.js";
export {
  createFallbackModelAdapter,
  createRoutingModelAdapter,
  createAbortableModelAdapter,
} from "./model.js";

// Workspace primitive types (factory `createSimpleTextDiff`). Concrete
// LocalWorkspace / ControlledWorkspace classes are below in IMPLEMENTATION.
export { createSimpleTextDiff } from "./workspace.js";

// Extension protocols — Wave 1 + Wave 2 stubs
export type {
  CapabilityKind,
  CapabilityOrigin,
  CapabilityDescriptor,
  CapabilityRegistryOptions,
  CapabilityFilter,
} from "./capability.js";
export {
  CapabilityRegistry,
  capabilityFromTool,
  capabilitiesFromTools,
} from "./capability.js";
export type { RunStore, TraceSink } from "./storage.js";
export type {
  SessionTraceConsistencyFinding,
  SessionTraceConsistencyReport,
  SessionTraceRepairAction,
  SessionTraceRepairReport,
  RepairSessionTraceConsistencyOptions,
  TraceTimeline,
  TraceTimelinePhase,
  TraceTimelinePhaseCategory,
  TraceTimelinePhaseStatus,
  TraceEventFilter,
  TraceSummary,
  TraceVerificationFinding,
  TraceVerificationReport,
  ValidateSessionTraceConsistencyOptions,
} from "./trace.js";
export {
  buildTraceTimeline,
  buildTraceTimelineFile,
  buildTraceTimelineJsonl,
  loadTraceEventsFile,
  loadTraceEventsJsonl,
  repairSessionTraceConsistency,
  restoreTranscriptPrompts,
  summarizeTraceFile,
  summarizeTraceJsonl,
  validateSessionTraceConsistency,
  verifyTraceFile,
  verifyTraceJsonl,
} from "./trace.js";
export type {
  MemoryStore,
  MemoryEntry,
  MemoryProvider,
  MemoryTurn,
} from "./memory.js";
export {
  buildMemoryContextBlock,
  sanitizeMemoryContext,
  StreamingContextScrubber,
} from "./memory.js";
export { sanitizeToolSchema } from "./schema-sanitize.js";
export type {
  ContentSource,
  ContentRule,
  ContentRuleResult,
  ContentPolicy,
  ContentPolicyVerdict,
  RedactionPattern,
  RedactSensitiveTextOptions,
} from "./content-policy.js";
export {
  createContentPolicy,
  createDefaultContentPolicy,
  DEFAULT_CONTENT_RULES,
  DEFAULT_REDACTION_PATTERNS,
  patternRule,
  redactSensitiveText,
  zeroWidthUnicodeRule,
} from "./content-policy.js";

// Compactor defensive wrappers (safety prefix + anti-thrashing).
export type {
  CompactionSafetyOptions,
  AntiThrashingOptions,
  AntiThrashingState,
} from "./context-safety.js";
export {
  COMPACTION_SAFETY_PREFIX,
  withCompactionSafety,
  withAntiThrashing,
} from "./context-safety.js";

// Cheap deterministic compaction stages.
export type {
  EstimateOptions,
  FileReadDedupOptions,
  ObservationOneLineOptions,
} from "./context-dedup.js";
export {
  IMAGE_CHAR_EQUIVALENT,
  estimateContextChars,
  createFileReadDedupStage,
  createObservationOneLineStage,
  createReferenceMarker,
} from "./context-dedup.js";

// Error-tolerant Compactor wrapper.
export type {
  CompactorFallbackPhase,
  CompactorFallbackEvent,
  CompactorFallbackOptions,
} from "./compactor-fallback.js";
export { withCompactorFallback } from "./compactor-fallback.js";

// Concurrent-instance lock protocol (host-implemented).
export type {
  LockScope,
  LockAcquireOptions,
  LockHandle,
  LockHandleMetadata,
  LockHolderInfo,
  StorageLock,
} from "./storage-lock.js";
export { withStorageLock } from "./storage-lock.js";

// AsyncLocalStorage-backed session context for concurrent runs.
export type { SessionContext } from "./session-context.js";
export {
  runWithSessionContext,
  currentSessionContext,
  extendSessionContext,
  captureSessionContext,
} from "./session-context.js";

// Runtime prompt-injection scan at PromptBuilder boundary.
export type {
  PromptInspector,
  PromptInspectionFinding,
  PromptInspectionVerdict,
  CreateDefaultPromptInspectorOptions,
  WrapPromptBuilderOptions,
} from "./prompt-inspector.js";
export {
  PromptInspectionBlocked,
  createDefaultPromptInspector,
  wrapPromptBuilderWithInspector,
} from "./prompt-inspector.js";
export type {
  Session,
  SessionRecord,
  SessionSeed,
  SessionEventType,
  SessionEvent,
  SessionEventInput,
  SessionStore,
  AppendOnlySessionStore,
  FileSessionStoreOptions,
  RunStoreReplayPayload,
  ReplaySessionEventsInput,
  ProjectSessionReplayToContextOptions,
  ProjectSessionReplayToTranscriptOptions,
  SessionTranscript,
  SessionTranscriptEntry,
  EnsureSessionRunMembershipOptions,
  CreateSessionRunStoreFactoryOptions,
} from "./session.js";
export {
  FileSessionStore,
  InMemorySessionStore,
  createSessionRunStoreFactory,
  ensureSessionRunMembership,
  projectSessionReplayToContextItems,
  projectSessionReplayToTranscript,
  replaySessionEventsFromRunStore,
  forkSessionFromEvent,
} from "./session.js";
export type { ForkSessionInput, ForkSessionResult } from "./session.js";
export type {
  ContextExtensionDescriptor,
  ContextExtensionLoadInput,
  ContextExtension,
  ToolExtension,
} from "./extensions.js";

// Lifecycle hooks (middleware over model/tool/event boundaries).
export type {
  RunHook,
  RunHookContext,
  ToolCallHookInput,
  ToolCallHookDecision,
  ToolResultHookInput,
  ModelCallHookInput,
  ModelOutputHookInput,
  EventHookInput,
  ErrorHookInput,
} from "./hooks.js";
export { combineRunHooks, createDynamicHookSet } from "./hooks.js";

// User-configurable hooks (settings.json-style; host owns execution).
export type {
  UserHookTrigger,
  UserHookSource,
  UserHookInvocation,
  UserHookProgressChunk,
  UserHookOutcome,
  UserHookRunner,
  UserHookDescriptor,
  BindUserHooksOptions,
} from "./user-hooks.js";
export { bindUserHooks } from "./user-hooks.js";

// Interaction channel (approve / ask / notify — unified outbound).
export type {
  InteractionChannel,
  InteractionQuestionChoice,
  InteractionQuestionRequest,
  InteractionQuestionResponse,
  InteractionNotification,
  InteractionNotificationLevel,
} from "./interaction.js";
export {
  approvalResolverFromChannel,
  channelFromApprovalResolver,
  createInteractionNotification,
  createInteractionQuestionRequest,
} from "./interaction.js";

// Slash-command registry (user intent surface; distinct from ToolDefinition).
export type {
  CommandContext,
  CommandResult,
  CommandScope,
  CommandDefinition,
  CommandRegistryOptions,
  CommandResolution,
} from "./commands.js";
export { CommandRegistry } from "./commands.js";

// Usage tracker (per-run tokens / cost / wall time / per-tool / per-model).
export type {
  UsageSnapshot,
  UsageTokenTotals,
  UsageToolStats,
  UsageModelStats,
  UsageTracker,
  CreateUsageTrackerOptions,
  SessionUsageTotals,
  SessionUsageAccumulator,
} from "./usage.js";
export { createUsageTracker, createSessionUsageAccumulator } from "./usage.js";

// Run lifecycle — the primary entry point.
export type {
  CreateRunOptions,
  CredentialRefreshRequest,
  CredentialRefreshResponse,
  CredentialResolver,
  RunHandle,
  RunLoopModelCallInput,
  RunLoopServices,
} from "./run.js";
export { createRun, resumeRunFromCheckpoint } from "./run.js";
export type { ResumeRunOptions } from "./run.js";

// -----------------------------------------------------------------------------
// IMPLEMENTATION — re-exported for current consumers. Prefer factories above.
// Marked @internal at the class declaration. Subject to change in 0.x.
// Importable also via `@sparkwright/core/internal`.
// -----------------------------------------------------------------------------

export { EventLog } from "./events.js";
export {
  FileRunStore,
  MemoryTrace,
  bindStorageDegradationEvents,
  createSessionFileRunStoreFactory,
  loadCheckpointFromRunDir,
} from "./trace.js";
export { LocalWorkspace, ControlledWorkspace } from "./workspace.js";
export type { ControlledWorkspaceOptions } from "./workspace.js";
export { WorkspaceCheckpointStore } from "./workspace-checkpoint.js";
export type {
  WorkspaceCheckpointFile,
  WorkspaceCheckpointMeta,
  WorkspaceCheckpointRestoreTarget,
  WorkspaceCheckpointStoreOptions,
  WorkspaceRollbackResult,
} from "./workspace-checkpoint.js";
export {
  DefaultObservationFormatter,
  DefaultContextAssembler,
  CompactingContextAssembler,
  SectionedPromptBuilder,
  DefaultPromptBuilder,
  createDefaultPromptSections,
  createAppPromptSection,
  createEnvironmentSection,
  createToolGuidanceSection,
  createModelAdaptiveSection,
  compilePromptCacheBlocks,
} from "./context.js";
export type {
  DefaultObservationFormatterOptions,
  DefaultContextAssemblerOptions,
  DefaultPromptBuilderOptions,
  AppPromptSectionOptions,
  EnvironmentSectionInput,
  EnvironmentSectionOptions,
  ToolGuidanceSectionOptions,
  ModelAdaptiveSectionOptions,
  ModelAdaptiveRule,
} from "./context.js";
export type {
  FileRunStoreOptions,
  LoadCheckpointFromRunDirOptions,
  SessionFileRunStoreFactoryOptions,
} from "./trace.js";
export { SparkwrightRun } from "./run.js";
