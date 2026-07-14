import type { AgentProfile } from "@sparkwright/agent-runtime";
import type {
  BackgroundTaskPolicy,
  RunAccessMode,
  RunBudget,
} from "@sparkwright/core";
import type { PermissionMode, TraceLevel } from "@sparkwright/protocol";
import type {
  ApprovalDefaults,
  AgentExposureMode,
  CapabilityDelegateToolConfig,
  CapabilityHooksConfig,
  CapabilityMcpStartup,
  CapabilityMcpToolSchemaLoad,
  CapabilitySkillsConfig,
  CapabilityToolsConfig,
  CapabilityVerificationConfig,
  ModelCost,
  ProviderConfig,
  ShellConfig,
  TaskConfig,
  WriteGuardrailsConfig,
} from "../config-zod-schema.js";

export const CONFIG_PROJECT_REL = ".sparkwright/config.json";
export const CONFIG_USER_REL = ".config/sparkwright/config.json";
export const CONFIG_ENV_VAR = "SPARKWRIGHT_CONFIG";
export const CONFIG_FILE_BASENAMES = [
  "config.json",
  "config.yaml",
  "config.yml",
] as const;
export const CONFIG_USER_DIR_SUBPATH = "sparkwright";
export const CONFIG_USER_JSON_SUBPATH = "sparkwright/config.json";

/** Reserved provider key for the built-in offline demo model. */
export const DETERMINISTIC_PROVIDER = "deterministic";
/** AI SDK package assumed when a provider omits `npm`. */
export const DEFAULT_PROVIDER_NPM = "@ai-sdk/openai";
export const SUPPORTED_PROVIDER_NPMS: Record<
  string,
  { factory: string; apiKeyEnv: string; baseUrlEnv?: string }
> = {
  "@ai-sdk/openai": {
    factory: "createOpenAI",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
  },
  "@ai-sdk/anthropic": {
    factory: "createAnthropic",
    apiKeyEnv: "ANTHROPIC_API_KEY",
  },
  "@ai-sdk/google": {
    factory: "createGoogleGenerativeAI",
    apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
  },
};

export interface SharedConfig {
  model?: string;
  providers?: Record<string, ProviderConfig>;
  accessMode?: RunAccessMode;
  accessModeCeiling?: RunAccessMode;
  backgroundTasks?: BackgroundTaskPolicy;
  backgroundTasksCeiling?: BackgroundTaskPolicy;
  permissionMode?: PermissionMode;
  workspace?: string;
  confidentialDefaults?: boolean;
  confidentialPaths?: string[];
  write?: WriteGuardrailsConfig;
  shell?: ShellConfig;
  tools?: CapabilityToolsConfig;
  tasks?: Record<string, TaskConfig>;
  capabilities?: CapabilityConfig;
  runBudget?: RunBudget;
  maxSteps?: number;
  traceLevel?: TraceLevel;
  approvals?: ApprovalDefaults;
}

export interface CapabilityConfig {
  hooks?: CapabilityHooksConfig;
  verification?: CapabilityVerificationConfig;
  skills?: CapabilitySkillsConfig;
  mcp?: CapabilityMcpConfig;
  agents?: CapabilityAgentsConfig;
}

export interface CapabilityAgentsConfig {
  profiles?: AgentProfile[];
  delegateTools?: CapabilityDelegateToolConfig[];
  spawnModel?: string;
  delegateModel?: string;
  exposure?: AgentExposureMode;
  pinnedDelegates?: string[];
  exposeChildrenAsDelegates?: boolean;
  enableParallelDelegates?: boolean;
  maxDepth?: number;
}

export type CapabilityMcpServerConfig =
  | {
      type: "stdio";
      name: string;
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      enabled?: boolean;
      toolSchemaLoad?: CapabilityMcpToolSchemaLoad;
    }
  | {
      type: "http";
      name: string;
      url: string;
      headers?: Record<string, string>;
      timeoutMs?: number;
      enabled?: boolean;
      toolSchemaLoad?: CapabilityMcpToolSchemaLoad;
    };

export interface CapabilityMcpConfig {
  servers?: CapabilityMcpServerConfig[];
  defaultTimeoutMs?: number;
  namePrefix?: string;
  startup?: CapabilityMcpStartup;
  toolSchemaLoad?: CapabilityMcpToolSchemaLoad;
  defaultPolicy?: {
    risk?: "safe" | "risky" | "denied";
    requiresApproval?: boolean;
  };
}

export interface SharedConfigSourceMap {
  model?: string;
  accessMode?: string;
  accessModeCeiling?: string;
  backgroundTasks?: string;
  backgroundTasksCeiling?: string;
  permissionMode?: string;
  workspace?: string;
  confidentialDefaults?: string;
  confidentialPaths?: string;
  write?: string;
  shell?: string;
  tools?: string;
  runBudget?: string;
  maxSteps?: string;
  traceLevel?: string;
  approvals?: string;
  providers?: Record<string, string>;
  tasks?: string;
}

export interface SharedConfigError {
  file: string;
  field: string;
  message: string;
}

export interface SharedConfigWarning {
  file: string;
  field: string;
  message: string;
}

export interface LoadedSharedConfig {
  config: SharedConfig;
  sources: SharedConfigSourceMap;
  attempted: { path: string; loaded: boolean }[];
  errors: SharedConfigError[];
  warnings: SharedConfigWarning[];
}

export interface ParsedModelRef {
  providerKey: string;
  modelId: string;
}

export type ModelSelection =
  | { kind: "deterministic" }
  | {
      kind: "configured";
      providerKey: string;
      modelId: string;
      npm: string;
      baseURL?: string;
      apiKey?: string;
      cost?: ModelCost;
      providerOptions?: Record<string, Record<string, unknown>>;
    }
  | { kind: "error"; message: string };
