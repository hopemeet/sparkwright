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
  createMainHostToolCatalog,
  createReadOnlyChildToolCatalog,
} from "./tool-catalog.js";
export type {
  HostToolCatalogEntry,
  HostToolCatalogExposure,
  HostToolCatalogSource,
} from "./tool-catalog.js";
export { createConfiguredWorkflowHooks } from "./workflow-hooks.js";
export type { CreateConfiguredWorkflowHooksOptions } from "./workflow-hooks.js";
export { createVerificationWorkflowHooks } from "./verification.js";
export type { CreateVerificationWorkflowHooksOptions } from "./verification.js";
export {
  checkDocumentedCommands,
  createDocumentedCommandStopHook,
  shouldCheckDocumentedCommands,
  summarizeDocumentedCommandIssues,
} from "./documented-command-check.js";
export type { DocumentedCommandIssue } from "./documented-command-check.js";
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
  SkillStatsEntry,
  SkillStatsOptions,
  SkillStatsReport,
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
} from "./agent-profiles.js";
export {
  loadHostConfig,
  normalizeGroupedConfig,
  configResolutionOrder,
  userConfigPath,
  projectConfigPath,
  resolveModelSelection,
  parseModelRef,
  costToPricing,
  DETERMINISTIC_PROVIDER,
  DEFAULT_PROVIDER_NPM,
  CONFIG_PROJECT_REL,
  CONFIG_USER_REL,
  CONFIG_ENV_VAR,
} from "./config.js";
export {
  delegateToolName,
  describeDelegateCapability,
  describeExternalDelegateCapability,
  type DelegateCapabilityDescriptor,
  type DelegateFailureCode,
  type DelegateProtocol,
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
export {
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
