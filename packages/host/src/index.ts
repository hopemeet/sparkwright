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
export { applyToolConfig } from "./tools.js";
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
export type {
  SharedConfig,
  SharedConfigSourceMap,
  SharedConfigError,
  LoadedSharedConfig,
  CapabilityConfig,
  CapabilityToolsConfig,
  CapabilitySkillsConfig,
  ProviderConfig,
  ProviderModelConfig,
  ModelCost,
  ModelSelection,
  ParsedModelRef,
} from "./config.js";
