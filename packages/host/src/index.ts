// Public API. Embedders may import this to run a host inside an existing
// Node process (tests do this); the bin entry covers the common standalone
// case.

export { serveConnection } from "./server.js";
export type { ServeConnectionOptions } from "./server.js";
export { HostRuntime } from "./runtime.js";
export type { RuntimeOptions } from "./runtime.js";
export type { Connection } from "./connection.js";
export { createStdioConnection } from "./transport-stdio.js";
export { startWsServer } from "./transport-ws.js";
export type { WsServerOptions } from "./transport-ws.js";
export { installLogPipe, attachLogSink } from "./log-pipe.js";
export { installCrashLog } from "./crash-log.js";
export { runHostMain } from "./main.js";
export { buildConfiguredAdapter } from "./model-builder.js";
export type { BuildAdapterInput } from "./model-builder.js";
export { runConfiguredDelegate } from "./delegate-runner.js";
export type {
  RunConfiguredDelegateInput,
  RunConfiguredDelegateResult,
} from "./delegate-runner.js";
export {
  DEFAULT_DEFERRED_TOOLS,
  applyToolConfig,
  createGlobPathsTool,
  createGrepTextTool,
  createListDirTool,
} from "./tools.js";
export {
  catalogEntryOrigin,
  catalogToolDefinitions,
  createCliDiagnosticToolCatalog,
  createConfiguredDelegateChildToolCatalog,
  createMainHostToolCatalog,
  createReadOnlyChildToolCatalog,
  resolveConfiguredToolAllowlist,
} from "./tool-catalog.js";
export type {
  HostToolCatalogEntry,
  HostToolCatalogSource,
} from "./tool-catalog.js";
export {
  DISCOVERY_TOOL_NAME,
  TOOL_USE_SELECTORS,
  WORKSPACE_READ_TOOL_NAMES,
  WORKSPACE_WRITE_TOOL_NAMES,
  assertCodingToolsCoveredByWorkspaceSelectors,
  formatToolUseSelectorList,
  intersectToolUseSelectors,
  isToolUseSelector,
  resolveSelectorAllowlist,
  shouldAppendDiscoveryTool,
} from "./tool-selectors.js";
export type { ToolSelectorCatalogEntry } from "./tool-selectors.js";
export {
  bindConfiguredEventHooks,
  createConfiguredWorkflowHooks,
} from "./workflow-hooks.js";
export type {
  BindConfiguredEventHooksOptions,
  CreateConfiguredWorkflowHooksOptions,
} from "./workflow-hooks.js";
export {
  TracedProcessRunner,
  inferProcessRuntime,
} from "./traced-process-runner.js";
export type {
  ProgressChunk,
  ProgressContext,
  TracedProcessInput,
  TracedProcessResult,
} from "./traced-process-runner.js";
export { createSkillInlineShellRunner } from "./skill-inline-shell.js";
export type { CreateSkillInlineShellRunnerOptions } from "./skill-inline-shell.js";
export { createVerificationWorkflowHooks } from "./verification.js";
export type { CreateVerificationWorkflowHooksOptions } from "./verification.js";
export {
  checkDocumentedCommands,
  createDocumentedCommandRulePack,
  createDocumentedCommandStopHook,
  DOCUMENTED_COMMAND_RULE_ACTION_SUMMARY,
  DOCUMENTED_COMMAND_RULE_CONFIGURATION_HINT,
  DOCUMENTED_COMMAND_RULE_DESCRIPTION,
  DOCUMENTED_COMMAND_RULE_DISABLE_HINT,
  DOCUMENTED_COMMAND_RULE_ID,
  DOCUMENTED_COMMAND_RULE_MATCHER_SUMMARY,
  DOCUMENTED_COMMAND_RULE_NAME,
  evaluateDocumentedCommandRule,
  shouldCheckDocumentedCommands,
  summarizeDocumentedCommandIssues,
} from "./documented-command-check.js";
export type {
  DocumentedCommandIssue,
  DocumentedCommandRuleActivation,
  DocumentedCommandRulePack,
} from "./documented-command-check.js";
export {
  projectSkillRoot,
  existingSkillRoots,
  resolveSkillRootsForRuntime,
  skillRootPaths,
} from "./skill-roots.js";
export { loadLayeredSkillReport } from "./skill-report.js";
export type {
  SkillReport,
  SkillReportEntry,
  SkillShadowDiagnostic,
} from "./skill-report.js";
export { collectSkillStats } from "./skill-stats.js";
export type {
  SkillStatsCatalogInfo,
  SkillStatsEntry,
  SkillStatsFinding,
  SkillStatsFindingCode,
  SkillStatsFindingRelation,
  SkillStatsFindingSeverity,
  SkillStatsFreshness,
  SkillStatsIdentityConfidence,
  SkillStatsOptions,
  SkillStatsProjectionCacheInfo,
  SkillStatsQuery,
  SkillStatsQueryScope,
  SkillStatsReport,
  SkillStatsWindow,
} from "./skill-stats.js";
export { createFileCapabilityPackageWriter } from "./capability-package-mutation.js";
export type {
  CapabilityPackageMutationAction,
  CapabilityPackageMutationResult,
  CapabilityPackageMutationWriter,
} from "./capability-package-mutation.js";
export { runSkillDoctor } from "./skill-doctor.js";
export type {
  RunSkillDoctorOptions,
  SkillDoctorEntry,
  SkillDoctorFinding,
  SkillDoctorReport,
  SkillDoctorSeverity,
  SkillDoctorStatus,
} from "./skill-doctor.js";
export type { WorkspaceDisplayPathOptions } from "@sparkwright/core";
export {
  formatWorkspaceDisplayPath,
  middleEllipsisPath,
} from "@sparkwright/core";
export {
  applySkillProposal,
  createSkillCreateProposal,
  createSkillUpdateProposal,
  listSkillHistory,
  listSkillProposals,
  pruneSkillProposals,
  readSkillHistoryDetail,
  readSkillProposal,
  rejectSkillProposal,
  skillEvolutionRoot,
  restoreSkillFromHistory,
  supersedeSkillProposal,
} from "./skill-evolution.js";
export type {
  ApplySkillProposalResult,
  CloseSkillProposalInput,
  CreateSkillCreateProposalInput,
  CreateSkillUpdateProposalInput,
  PruneSkillProposalsInput,
  PruneSkillProposalsResult,
  RestoreSkillFromHistoryInput,
  RestoreSkillFromHistoryResult,
  SkillHistoryEntry,
  SkillHistoryDetail,
  SkillHistoryKind,
  SkillHistoryMetadata,
  SkillProposalDetail,
  SkillProposalKind,
  SkillProposalMetadata,
  SkillProposalState,
  SkillProposalSummary,
  SupersedeSkillProposalInput,
} from "./skill-evolution.js";
export { loadLayeredAgentReport } from "./agent-report.js";
export type {
  AgentReport,
  AgentReportEntry,
  AgentReportLayer,
  AgentShadowDiagnostic,
  AgentCollisionDiagnostic,
} from "./agent-report.js";
export { resolveCapabilityDirs, userConfigBase } from "./layers.js";
export type {
  CapabilityKind,
  CapabilityLayer,
  ResolvedCapabilityDir,
} from "./layers.js";
export {
  resolveAgentProfiles,
  discoverLayeredAgentProfiles,
  discoverProjectAgentProfiles,
  mergeAgentProfilesById,
  parseAgentProfileFile,
  type AgentProfileCollision,
} from "./agent-profiles.js";
export {
  loadHostConfig,
  normalizeGroupedConfig,
  configResolutionOrder,
  projectConfigCandidatePaths,
  readConfigFileObject,
  resolveConfigWriteTarget,
  serializeConfigFileObject,
  userConfigCandidatePaths,
  userConfigPath,
  writeConfigFileObject,
  projectConfigPath,
  resolveModelSelection,
  parseModelRef,
  costToPricing,
  DETERMINISTIC_PROVIDER,
  DEFAULT_PROVIDER_NPM,
  CONFIG_FILE_BASENAMES,
  CONFIG_PROJECT_REL,
  CONFIG_USER_REL,
  CONFIG_ENV_VAR,
} from "./config.js";
export {
  delegateToolName,
  delegateToolDescription,
  describeDelegateCapability,
  describeExternalDelegateCapability,
  directDelegateExposureMode,
  filterDirectDelegatesForExposure,
  resolveAgentDelegateTools,
  sanitizeToolSegment,
  type DelegateCapabilityDescriptor,
  type DelegateFailureCode,
  type DelegateProtocol,
  type DelegateToolCollision,
  type DelegateToolSource,
  type DirectDelegateExposureConfig,
  type DirectDelegateExposureMode,
  type ResolveAgentDelegateToolsOptions,
  type DelegateWorkspaceAccess,
} from "./delegate-capability.js";
export { validateRunInput } from "./run-input-validation.js";
export type {
  RunInputValidationInput,
  RunInputValidationResult,
} from "./run-input-validation.js";
export {
  recordHostClientStartFailure,
  writeHostStartFailureTrace,
} from "./failure-trace.js";
export type {
  HostClientStartFailureInput,
  HostStartFailureTraceInput,
  HostStartFailureTraceResult,
} from "./failure-trace.js";
export {
  resolveHostBin,
  resolveHostCommand,
  resolveHostExecutableArgs,
  resolveHostSourceBin,
  resolveHostStdioSpawn,
} from "./client-spawn.js";
export type {
  HostStdioSpawnInput,
  ResolvedHostStdioSpawn,
} from "./client-spawn.js";
export { resolveHostClientApprovalByPolicy } from "./client-approval.js";
export type {
  HostClientApprovalPolicyInput,
  HostClientApprovalRequestInput,
} from "./client-approval.js";
export {
  createHostCapabilityInspectRequest,
  createHostClientRunMetadata,
  createHostResumeRunRequest,
  createHostStartRunRequest,
  resolveHostRequestModel,
  tracePathForSession,
} from "./client-run.js";
export type {
  HostClientModelSource,
  HostClientRunMetadataInput,
  HostClientSource,
} from "./client-run.js";
export {
  MAX_RUN_IMAGE_INPUT_BYTES,
  SUPPORTED_RUN_IMAGE_INPUT_TYPES,
  buildImageRunInputPart,
  createRunInputPayloadFromParts,
  imageMediaTypeForPath,
  runInputMetadataRecord,
  summarizeRunInputParts,
} from "./client-input.js";
export type {
  BuildImageRunInputPartResult,
  RunImageInputPart,
  RunInputSummary,
} from "./client-input.js";
export type {
  SharedConfig,
  SharedConfigSourceMap,
  SharedConfigError,
  LoadedSharedConfig,
  ApprovalDefaults,
  CapabilityConfig,
  CapabilitySkillEvolutionConfig,
  CapabilitySkillEvolutionMode,
  CapabilityHooksConfig,
  CapabilityWorkflowHookConfig,
  CapabilityHookActionConfig,
  CapabilityToolsConfig,
  CapabilitySkillsConfig,
  ShellConfig,
  ProviderConfig,
  ProviderModelConfig,
  ModelCost,
  ModelSelection,
  ParsedModelRef,
} from "./config.js";
