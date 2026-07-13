import {
  ACCESS_MODES,
  BACKGROUND_TASK_POLICIES,
  PERMISSION_MODES,
  TRACE_LEVELS,
} from "@sparkwright/protocol";
import type { WorkflowHookMatcher, WorkflowHookName } from "@sparkwright/core";
import { MAX_FOREGROUND_TIMEOUT_MS } from "@sparkwright/shell-tool";
import type { ShellSandboxConfig } from "@sparkwright/shell-sandbox";
import { z } from "zod";
import { TOOL_USE_SELECTORS } from "./tool-selectors.js";

export const CONFIG_SCHEMA_ID =
  "https://sparkwright.dev/schemas/v0/config.schema.json";
export const CONFIG_SCHEMA_PROTOCOL_VERSION = "0.2";
export const CONFIG_SCHEMA_TITLE = "Sparkwright Config";
export const CONFIG_SCHEMA_DESCRIPTION =
  "User-editable settings shared by the CLI and the interactive TUI. Loaded (in order, later overriding earlier) from ~/.config/sparkwright/config.{json,yaml,yml}, <workspace>/.sparkwright/config.{json,yaml,yml}, and $SPARKWRIGHT_CONFIG. Within a user/project layer, config.json wins over config.yaml, which wins over config.yml; multiple files in one layer are reported as a conflict. CLI args and env vars override files. Fields may be written flat or under the preferred groups identity/policy/run/ui; tools and capabilities are top-level groups. A field set both ways conflicts and the grouped value wins. The providers map is merged by key, tools.use and tools.allowed intersect, tools.disabled unions, tools.defer is replaced by later layers, capabilities merges by sub-capability, and the security boundaries - shell.sandbox, run.accessMode, confidentialPaths, and write - merge conservatively so later layers cannot weaken an earlier layer's policy (project clamps user); confidentialDefaults is an explicit later-layer override for the built-in confidential path set; other shared fields are wholesale-overridden.";

export const stringSchema = z.string();
export const nonEmptyString = stringSchema.min(1);
export const booleanSchema = z.boolean();
export const numberSchema = z.number();
export const integerSchema = numberSchema.int();
export const stringArray = z.array(stringSchema);
export const integerArray = z.array(integerSchema);
export const nonEmptyStringArray = z.array(nonEmptyString);
export const positiveInteger = integerSchema.min(1);
export const nonNegativeInteger = integerSchema.min(0);
export const positiveNumber = numberSchema.positive();
export const stringRecordSchema = z.record(stringSchema, stringSchema);
export const providerOptionsSchema = z
  .record(stringSchema, z.object({}).catchall(z.unknown()))
  .describe(
    "Request-level AI SDK providerOptions keyed by provider namespace.",
  );

const permissionModeSchema = z
  .enum(PERMISSION_MODES)
  .describe("Permission policy mode for runs started from the TUI.");
export const PERMISSION_MODE_CONFIG_VALUES = permissionModeSchema.options;
const accessModeSchema = z
  .enum(ACCESS_MODES)
  .describe(
    "High-level run autonomy preset. The single user-facing access knob; compiles internally to permissionMode + write capability. read-only=plan/no-write, ask=approve writes, accept-edits=auto-accept edits, bypass=auto-approve.",
  );
export const ACCESS_MODE_CONFIG_VALUES = accessModeSchema.options;
const backgroundTasksSchema = z
  .enum(BACKGROUND_TASK_POLICIES)
  .describe(
    "Session-level foreground/background task policy. enabled allows task promotion and detached tasks; foreground-only forces task_create to wait inline; disabled rejects new task_create work.",
  );
export const BACKGROUND_TASK_POLICY_CONFIG_VALUES =
  backgroundTasksSchema.options;
const traceLevelSchema = z
  .enum(TRACE_LEVELS)
  .describe(
    "Default trace verbosity when an entrypoint does not pass one. CLI --trace-level overrides.",
  );
export const TRACE_LEVEL_CONFIG_VALUES = traceLevelSchema.options;
const toolUseSelectorSchema = z.union([
  z.enum(TOOL_USE_SELECTORS),
  z
    .string()
    .regex(/^mcp:.+$/)
    .describe("Select tools from one configured MCP server, e.g. mcp:demo."),
]);

export const modelCostSchema = z
  .object({
    input: z.number().optional(),
    output: z.number().optional(),
    cacheRead: z.number().optional(),
    cacheWrite: z.number().optional(),
  })
  .strict()
  .describe("Per-million-token pricing used to attach costUsd to usage.");
export const MODEL_COST_CONFIG_KEYS = modelCostSchema.keyof().options;

export const providerModelConfigSchema = z
  .object({
    cost: modelCostSchema.optional(),
    providerOptions: providerOptionsSchema.optional(),
  })
  .strict();
export const PROVIDER_MODEL_CONFIG_KEYS =
  providerModelConfigSchema.keyof().options;

export const providerConfigSchema = z
  .object({
    npm: nonEmptyString
      .describe(
        'AI SDK package used to construct the client. Defaults to "@ai-sdk/openai".',
      )
      .optional(),
    baseURL: z
      .string()
      .url()
      .describe(
        "OpenAI-compatible base URL. Overridden by the OPENAI_BASE_URL env var when set.",
      )
      .optional(),
    apiKey: nonEmptyString
      .describe(
        "API key for this provider. Overridden by provider-specific env vars when set.",
      )
      .optional(),
    providerOptions: providerOptionsSchema.optional(),
    models: z
      .record(z.string(), providerModelConfigSchema)
      .describe(
        "Optional per-model metadata. When any models are listed, model overrides must use one of those ids.",
      )
      .optional(),
  })
  .strict();
export const PROVIDER_CONFIG_KEYS = providerConfigSchema.keyof().options;

export const writeGuardrailsSchema = z
  .object({
    maxFiles: positiveInteger
      .describe("Maximum distinct files a run may write.")
      .optional(),
    maxDiffLines: positiveInteger
      .describe("Maximum changed diff lines per write.")
      .optional(),
    allowDeletions: z
      .boolean()
      .describe("Whether in-place edits may remove lines.")
      .optional(),
  })
  .strict()
  .describe("Workspace write guardrails. Merges conservatively across layers.");
export const WRITE_GUARDRAILS_CONFIG_KEYS =
  writeGuardrailsSchema.keyof().options;

export const runBudgetSchema = z
  .object({
    maxDurationMs: positiveInteger.optional(),
    maxModelCalls: positiveInteger.optional(),
    maxToolCalls: positiveInteger.optional(),
    maxTokens: positiveInteger.optional(),
    maxCostUsd: positiveNumber.optional(),
  })
  .strict()
  .describe(
    "Resource budget for the interactive main run. maxModelCalls is the tightest natural step bound.",
  );
export const RUN_BUDGET_CONFIG_KEYS = runBudgetSchema.keyof().options;
export const RUN_BUDGET_POSITIVE_INTEGER_CONFIG_KEYS = runBudgetSchema
  .pick({
    maxDurationMs: true,
    maxModelCalls: true,
    maxToolCalls: true,
    maxTokens: true,
  })
  .keyof().options;

export const taskUnknownCostPolicySchema = z.enum(["skip", "token_cap_only"]);
export const TASK_UNKNOWN_COST_POLICIES = taskUnknownCostPolicySchema.options;
export const taskBudgetSchema = z
  .object({
    maxSourceChars: positiveInteger.optional(),
    maxOutputTokens: positiveInteger.optional(),
    maxInputTokens: positiveInteger.optional(),
    maxCostUsd: positiveNumber.optional(),
    unknownCostPolicy: taskUnknownCostPolicySchema.optional(),
  })
  .strict()
  .describe("Shared budget contract for model-backed auxiliary tasks.");
export const TASK_BUDGET_CONFIG_KEYS = taskBudgetSchema.keyof().options;
export const TASK_BUDGET_POSITIVE_INTEGER_CONFIG_KEYS = taskBudgetSchema
  .pick({
    maxSourceChars: true,
    maxOutputTokens: true,
    maxInputTokens: true,
  })
  .keyof().options;

export const approvalsSchema = z
  .object({
    shellSafe: z
      .boolean()
      .describe("Auto-approve commands the safety classifier rates safe.")
      .optional(),
    edits: z.boolean().describe("Auto-approve workspace edits.").optional(),
    all: z
      .boolean()
      .describe("Auto-approve everything the policy allows.")
      .optional(),
    cronMode: permissionModeSchema
      .describe(
        "Default permission mode for unattended cron run/tick commands. CLI --access-mode still overrides.",
      )
      .optional(),
  })
  .strict()
  .describe(
    "Default approval auto-grants. CLI flags still override these values.",
  );
export const APPROVALS_CONFIG_KEYS = approvalsSchema.keyof().options;
export const APPROVAL_BOOLEAN_CONFIG_KEYS = approvalsSchema
  .pick({
    shellSafe: true,
    edits: true,
    all: true,
  })
  .keyof().options;

export const shellSandboxFilesystemSchema = z
  .object({
    allowRead: nonEmptyStringArray.optional(),
    allowWrite: nonEmptyStringArray.optional(),
    denyRead: nonEmptyStringArray.optional(),
    denyWrite: nonEmptyStringArray.optional(),
    tmp: z.boolean().optional(),
  })
  .strict();
export const SHELL_SANDBOX_FILESYSTEM_CONFIG_KEYS =
  shellSandboxFilesystemSchema.keyof().options;
export const SHELL_SANDBOX_FILESYSTEM_PATH_CONFIG_KEYS =
  shellSandboxFilesystemSchema
    .pick({
      allowRead: true,
      allowWrite: true,
      denyRead: true,
      denyWrite: true,
    })
    .keyof().options;

export const shellSandboxModeSchema = z.enum(["off", "warn", "enforce"]);
export const SHELL_SANDBOX_MODES = shellSandboxModeSchema.options;
export const shellSandboxNetworkModeSchema = z.enum(["allow", "deny"]);
export const SHELL_SANDBOX_NETWORK_MODES =
  shellSandboxNetworkModeSchema.options;

export const shellSandboxNetworkSchema = z
  .object({
    mode: shellSandboxNetworkModeSchema.optional(),
  })
  .strict();
export const SHELL_SANDBOX_NETWORK_CONFIG_KEYS =
  shellSandboxNetworkSchema.keyof().options;

export const shellSandboxSchema = z
  .object({
    mode: shellSandboxModeSchema
      .describe(
        "off disables OS sandboxing; warn uses it when available and otherwise falls back; enforce prevents unsandboxed fallback when the runtime is unavailable. Enforce does not imply the same filesystem boundary on every OS.",
      )
      .optional(),
    failIfUnavailable: z
      .boolean()
      .describe("Fail closed when the platform sandbox runtime is unavailable.")
      .optional(),
    filesystem: shellSandboxFilesystemSchema.optional(),
    network: shellSandboxNetworkSchema.optional(),
  })
  .strict()
  .describe(
    "Experimental OS-level process sandbox for supported local execution paths. Linux bubblewrap uses a bind allowlist; macOS sandbox-exec uses an allow-default deny-list guard. Forced deny-write paths are always appended by the host.",
  );
export const SHELL_SANDBOX_CONFIG_KEYS = shellSandboxSchema.keyof().options;

export const shellSchema = z
  .object({
    foregroundTimeoutMs: positiveInteger
      .max(MAX_FOREGROUND_TIMEOUT_MS)
      .describe(
        "Foreground shell budget in milliseconds before promotion to a background task. Defaults to 300000 and is capped at 600000.",
      )
      .optional(),
    sandbox: shellSandboxSchema.optional(),
  })
  .strict()
  .describe("Host shell execution boundary.");
export const SHELL_CONFIG_KEYS = shellSchema.keyof().options;

export const toolsSchema = z
  .object({
    use: z
      .array(toolUseSelectorSchema)
      .describe(
        "High-level source/capability selectors retained in the prepared tool set. Omit to use all otherwise enabled tools.",
      )
      .optional(),
    allowed: stringArray
      .describe(
        "Concrete tool names retained in the prepared run tool set. Omit to allow all otherwise enabled tools.",
      )
      .optional(),
    disabled: stringArray
      .describe("Concrete tool names removed from the prepared run tool set.")
      .optional(),
    defer: stringArray
      .describe(
        "Concrete built-in tool names prepared as deferred schemas when supported.",
      )
      .optional(),
  })
  .strict()
  .describe(
    "Preferred tool exposure/loading settings. Standard tools are enabled by default.",
  );
export const TOOLS_CONFIG_KEYS = toolsSchema.keyof().options;

const stringOrStringArraySchema = z.union([z.string(), stringArray]);
export const workflowHookNameSchema = z.enum([
  "RunStart",
  "TurnStart",
  "ModelOutput",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "RunEnd",
  "RuntimeSignal",
]);
export const WORKFLOW_HOOK_NAMES = workflowHookNameSchema.options;
export const eventHookTriggerSchema = z.enum([
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.budget.checked",
  "run.budget.exceeded",
  "model.requested",
  "model.completed",
  "tool.requested",
  "tool.completed",
  "tool.failed",
]);
export const EVENT_HOOK_TRIGGERS = eventHookTriggerSchema.options;
export const workflowHookOnErrorSchema = z.enum(["continue", "block"]);
export const WORKFLOW_HOOK_ON_ERROR_MODES = workflowHookOnErrorSchema.options;
export const workflowHookFrequencySchema = z.enum(["always", "oncePerTurn"]);
export const WORKFLOW_HOOK_FREQUENCIES = workflowHookFrequencySchema.options;
export const workflowHookActionTypeSchema = z.enum([
  "block",
  "context",
  "command",
  "http",
  "agent",
]);
export const WORKFLOW_HOOK_ACTION_TYPES = workflowHookActionTypeSchema.options;
export const workflowHookContextTypeSchema = z.enum([
  "system",
  "user",
  "summary",
]);
export const WORKFLOW_HOOK_CONTEXT_TYPES =
  workflowHookContextTypeSchema.options;
export const workflowHookOutputInjectionSchema = z.enum([
  "always",
  "onFailure",
  "never",
]);
export const WORKFLOW_HOOK_OUTPUT_INJECTION_MODES =
  workflowHookOutputInjectionSchema.options;
export const workflowHookStdinSchema = z.enum(["none", "json"]);
export const WORKFLOW_HOOK_STDIN_MODES = workflowHookStdinSchema.options;
export const workflowHookCommandResultModeSchema = z.enum([
  "exitCode",
  "stdoutJson",
]);
export const WORKFLOW_HOOK_COMMAND_RESULT_MODES =
  workflowHookCommandResultModeSchema.options;
export const workflowHookHttpMethodSchema = z.enum([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);
export const WORKFLOW_HOOK_HTTP_METHODS = workflowHookHttpMethodSchema.options;
export const workflowHookHttpResultModeSchema = z.enum([
  "status",
  "responseJson",
]);
export const WORKFLOW_HOOK_HTTP_RESULT_MODES =
  workflowHookHttpResultModeSchema.options;
export const hookHttpAllowRuleSchema = z.union([
  z
    .object({
      origin: z.string().url(),
    })
    .strict(),
  z
    .object({
      hostname: nonEmptyString,
    })
    .strict(),
]);
export const HOOKS_HTTP_ALLOW_CONFIG_KEYS = ["origin", "hostname"] as const;
export const hooksHttpConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    allow: z.array(hookHttpAllowRuleSchema).optional(),
    allowPrivateNetwork: z.boolean().optional(),
  })
  .strict()
  .describe(
    "Host-owned allowlist and network policy for HTTP hook actions. Project configs cannot define this policy or HTTP hook actions.",
  );
export const HOOKS_HTTP_CONFIG_KEYS = hooksHttpConfigSchema.keyof().options;
export const workflowHookAgentResultModeSchema = z.enum([
  "context",
  "workflowResult",
]);
export const WORKFLOW_HOOK_AGENT_RESULT_MODES =
  workflowHookAgentResultModeSchema.options;

export const workflowHookMatcherSchema = z
  .object({
    toolName: stringOrStringArraySchema.optional(),
    eventType: stringOrStringArraySchema.optional(),
    signal: stringOrStringArraySchema.optional(),
    status: stringOrStringArraySchema.optional(),
    pathGlob: stringOrStringArraySchema.optional(),
    excludePathGlob: stringOrStringArraySchema.optional(),
  })
  .strict();
export const WORKFLOW_HOOK_MATCHER_CONFIG_KEYS =
  workflowHookMatcherSchema.keyof().options;

export const workflowHookBlockActionSchema = z
  .object({
    type: z.literal("block"),
    reason: nonEmptyString,
  })
  .strict();
export const WORKFLOW_HOOK_BLOCK_ACTION_CONFIG_KEYS =
  workflowHookBlockActionSchema.keyof().options;

export const workflowHookContextActionSchema = z
  .object({
    type: z.literal("context"),
    content: nonEmptyString,
    contextType: workflowHookContextTypeSchema.optional(),
  })
  .strict();
export const WORKFLOW_HOOK_CONTEXT_ACTION_CONFIG_KEYS =
  workflowHookContextActionSchema.keyof().options;

export const workflowHookCommandActionSchema = z
  .object({
    type: z.literal("command"),
    command: nonEmptyString,
    args: stringArray.optional(),
    cwd: nonEmptyString.optional(),
    timeoutMs: positiveInteger.optional(),
    blockOnFailure: z.boolean().optional(),
    injectOutput: workflowHookOutputInjectionSchema.optional(),
    maxOutputBytes: positiveInteger.optional(),
    stdin: workflowHookStdinSchema.optional(),
    resultMode: workflowHookCommandResultModeSchema.optional(),
  })
  .strict();
export const WORKFLOW_HOOK_COMMAND_ACTION_CONFIG_KEYS =
  workflowHookCommandActionSchema.keyof().options;

export const workflowHookHttpActionSchema = z
  .object({
    type: z.literal("http"),
    url: z.string().url(),
    method: workflowHookHttpMethodSchema.optional(),
    headers: stringRecordSchema.optional(),
    body: z.string().optional(),
    timeoutMs: positiveInteger.optional(),
    blockOnFailure: z.boolean().optional(),
    injectOutput: workflowHookOutputInjectionSchema.optional(),
    resultMode: workflowHookHttpResultModeSchema.optional(),
  })
  .strict();
export const WORKFLOW_HOOK_HTTP_ACTION_CONFIG_KEYS =
  workflowHookHttpActionSchema.keyof().options;

export const workflowHookAgentActionSchema = z
  .object({
    type: z.literal("agent"),
    agentId: nonEmptyString.optional(),
    toolName: nonEmptyString.optional(),
    goal: nonEmptyString,
    metadata: z.record(z.string(), z.unknown()).optional(),
    resultMode: workflowHookAgentResultModeSchema.optional(),
    injectOutput: workflowHookOutputInjectionSchema.optional(),
  })
  .strict();
export const WORKFLOW_HOOK_AGENT_ACTION_CONFIG_KEYS =
  workflowHookAgentActionSchema.keyof().options;

export const WORKFLOW_HOOK_ACTION_CONFIG_KEYS_BY_TYPE = {
  block: WORKFLOW_HOOK_BLOCK_ACTION_CONFIG_KEYS,
  context: WORKFLOW_HOOK_CONTEXT_ACTION_CONFIG_KEYS,
  command: WORKFLOW_HOOK_COMMAND_ACTION_CONFIG_KEYS,
  http: WORKFLOW_HOOK_HTTP_ACTION_CONFIG_KEYS,
  agent: WORKFLOW_HOOK_AGENT_ACTION_CONFIG_KEYS,
} as const;

export const workflowHookActionSchema = z.union([
  workflowHookBlockActionSchema,
  workflowHookContextActionSchema,
  workflowHookCommandActionSchema,
  workflowHookHttpActionSchema,
  workflowHookAgentActionSchema,
]);

export const eventHookActionSchema = z.union([
  workflowHookCommandActionSchema,
  workflowHookHttpActionSchema,
  workflowHookAgentActionSchema,
]);

export const workflowHookConfigSchema = z
  .object({
    name: nonEmptyString,
    description: z.string().optional(),
    hook: workflowHookNameSchema,
    enabled: z.boolean().optional(),
    onError: workflowHookOnErrorSchema.optional(),
    frequency: workflowHookFrequencySchema.optional(),
    matcher: workflowHookMatcherSchema.optional(),
    action: workflowHookActionSchema,
  })
  .strict();
export const WORKFLOW_HOOK_CONFIG_KEYS =
  workflowHookConfigSchema.keyof().options;

export const agentProfileWorkflowHookActionSchema = z.union([
  workflowHookBlockActionSchema,
  workflowHookContextActionSchema,
  workflowHookCommandActionSchema,
  workflowHookHttpActionSchema,
]);
export const agentProfileWorkflowHookMatcherSchema = z.union([
  nonEmptyString,
  workflowHookMatcherSchema,
]);
export const agentProfileWorkflowHookEntrySchema = z
  .object({
    name: nonEmptyString.optional(),
    description: z.string().optional(),
    enabled: z.boolean().optional(),
    onError: workflowHookOnErrorSchema.optional(),
    frequency: workflowHookFrequencySchema.optional(),
    matcher: agentProfileWorkflowHookMatcherSchema.optional(),
    action: agentProfileWorkflowHookActionSchema,
  })
  .strict();
export const AGENT_PROFILE_WORKFLOW_HOOK_CONFIG_KEYS =
  agentProfileWorkflowHookEntrySchema.keyof().options;
export const agentProfileHooksSchema = z
  .object({
    RunStart: z.array(agentProfileWorkflowHookEntrySchema).optional(),
    TurnStart: z.array(agentProfileWorkflowHookEntrySchema).optional(),
    ModelOutput: z.array(agentProfileWorkflowHookEntrySchema).optional(),
    PreToolUse: z.array(agentProfileWorkflowHookEntrySchema).optional(),
    PostToolUse: z.array(agentProfileWorkflowHookEntrySchema).optional(),
    Stop: z.array(agentProfileWorkflowHookEntrySchema).optional(),
    RunEnd: z.array(agentProfileWorkflowHookEntrySchema).optional(),
    RuntimeSignal: z.array(agentProfileWorkflowHookEntrySchema).optional(),
  })
  .strict()
  .describe(
    "Per-agent workflow hook guardrails applied only to this profile's in-process child runs. Agent actions are intentionally not supported here.",
  );
export const AGENT_PROFILE_HOOKS_CONFIG_KEYS =
  agentProfileHooksSchema.keyof().options;

export const eventHookConfigSchema = z
  .object({
    name: nonEmptyString,
    description: z.string().optional(),
    trigger: z.union([eventHookTriggerSchema, z.array(eventHookTriggerSchema)]),
    enabled: z.boolean().optional(),
    matcher: workflowHookMatcherSchema.optional(),
    action: eventHookActionSchema,
  })
  .strict();
export const EVENT_HOOK_CONFIG_KEYS = eventHookConfigSchema.keyof().options;

export const hooksSchema = z
  .object({
    http: hooksHttpConfigSchema.optional(),
    workflow: z.array(workflowHookConfigSchema).optional(),
    events: z.array(eventHookConfigSchema).optional(),
  })
  .strict()
  .describe(
    "Deterministic workflow hooks and non-blocking event hooks for host-created runs.",
  );
export const HOOKS_CONFIG_KEYS = hooksSchema.keyof().options;

export const verificationModeSchema = z.enum(["off", "suggest", "require"]);
export const VERIFICATION_MODES = verificationModeSchema.options;

export const verificationKindSchema = z.enum([
  "lint",
  "typecheck",
  "test",
  "check",
  "custom",
]);
export const VERIFICATION_KINDS = verificationKindSchema.options;

export const verificationCommandSchema = z
  .object({
    id: nonEmptyString,
    kind: verificationKindSchema.optional(),
    command: nonEmptyString,
    args: stringArray.optional(),
    cwd: nonEmptyString.optional(),
    timeoutMs: positiveInteger.optional(),
    maxOutputBytes: positiveInteger.optional(),
  })
  .strict();
export const VERIFICATION_COMMAND_CONFIG_KEYS =
  verificationCommandSchema.keyof().options;

export const verificationAfterWritesSchema = z
  .object({
    profile: nonEmptyString.optional(),
    injectOutput: workflowHookOutputInjectionSchema.optional(),
  })
  .strict();
export const VERIFICATION_AFTER_WRITES_CONFIG_KEYS =
  verificationAfterWritesSchema.keyof().options;

export const verificationSchema = z
  .object({
    mode: verificationModeSchema.optional(),
    defaultProfile: nonEmptyString.optional(),
    profiles: z
      .record(z.string(), z.array(verificationCommandSchema))
      .optional(),
    afterWrites: verificationAfterWritesSchema.optional(),
  })
  .strict()
  .describe(
    "Project verification profiles compiled by the host into workflow hooks.",
  );
export const VERIFICATION_CONFIG_KEYS = verificationSchema.keyof().options;

export const skillEvolutionModeSchema = z.enum([
  "off",
  "notice",
  "draft",
  "apply",
]);
export const SKILL_EVOLUTION_MODES = skillEvolutionModeSchema.options;

export const skillEvolutionSchema = z
  .object({
    mode: skillEvolutionModeSchema.optional(),
  })
  .strict();
export const SKILL_EVOLUTION_CONFIG_KEYS = skillEvolutionSchema.keyof().options;

export const skillInlineShellSchema = z
  .object({
    enabled: z.boolean().optional(),
    timeoutMs: positiveInteger.optional(),
    maxOutputChars: positiveInteger.optional(),
  })
  .strict();
export const SKILL_INLINE_SHELL_CONFIG_KEYS =
  skillInlineShellSchema.keyof().options;

export const skillsSchema = z
  .object({
    roots: stringArray
      .describe(
        "Skill root directories. Relative paths resolve from the config file that defined them.",
      )
      .optional(),
    includeLoaderTool: z
      .boolean()
      .describe("Register the progressive skill_load tool.")
      .optional(),
    loadSelectedSkills: z
      .boolean()
      .describe("Load matcher-selected Skill bodies into resident context.")
      .optional(),
    maxSelectedSkills: nonNegativeInteger.optional(),
    resourceFileLimit: nonNegativeInteger.optional(),
    allowedSkills: stringArray.optional(),
    deniedSkills: stringArray.optional(),
    evolution: skillEvolutionSchema.optional(),
    inlineShell: skillInlineShellSchema.optional(),
  })
  .strict()
  .describe("Skill loading settings for host-created runs.");
export const SKILLS_CONFIG_KEYS = skillsSchema.keyof().options;

export const mcpToolSchemaLoadSchema = z.enum(["eager", "defer"]);
export const MCP_TOOL_SCHEMA_LOAD_MODES = mcpToolSchemaLoadSchema.options;

export const mcpStartupSchema = z.enum(["lazy", "prepare", "eager"]);
export const MCP_STARTUP_MODES = mcpStartupSchema.options;

export const mcpDefaultPolicyRiskSchema = z.enum(["safe", "risky", "denied"]);
export const MCP_DEFAULT_POLICY_RISKS = mcpDefaultPolicyRiskSchema.options;

export const mcpDefaultPolicySchema = z
  .object({
    risk: mcpDefaultPolicyRiskSchema.optional(),
    requiresApproval: z.boolean().optional(),
  })
  .strict();
export const MCP_DEFAULT_POLICY_CONFIG_KEYS =
  mcpDefaultPolicySchema.keyof().options;

export const mcpConfigSchema = z
  .object({
    // Replaced with an external JSON Schema ref by scripts/generate-config-schema.ts.
    servers: z.array(z.unknown()).optional(),
    defaultTimeoutMs: positiveInteger.optional(),
    namePrefix: z.string().optional(),
    startup: mcpStartupSchema.optional(),
    toolSchemaLoad: mcpToolSchemaLoadSchema.optional(),
    defaultPolicy: mcpDefaultPolicySchema.optional(),
  })
  .strict()
  .describe("MCP server settings for host-created runs.");
export const MCP_CONFIG_KEYS = mcpConfigSchema.keyof().options;

export const delegateToolSchema = z
  .object({
    profileId: nonEmptyString,
    toolName: nonEmptyString.optional(),
    description: nonEmptyString.optional(),
    requiresApproval: z.boolean().optional(),
    forbidNesting: z.boolean().optional(),
    maxSteps: positiveInteger.optional(),
  })
  .strict();
export const DELEGATE_TOOL_CONFIG_KEYS = delegateToolSchema.keyof().options;
export const DELEGATE_TOOL_OPTIONAL_STRING_CONFIG_KEYS = delegateToolSchema
  .pick({
    toolName: true,
    description: true,
  })
  .keyof().options;
export const DELEGATE_TOOL_BOOLEAN_CONFIG_KEYS = delegateToolSchema
  .pick({
    requiresApproval: true,
    forbidNesting: true,
  })
  .keyof().options;
export const agentProfileDelegateToolSchema = delegateToolSchema
  .omit({ profileId: true })
  .strict();
export const AGENT_PROFILE_DELEGATE_TOOL_CONFIG_KEYS =
  agentProfileDelegateToolSchema.keyof().options;

export const agentProfileModeSchema = z.enum(["primary", "child", "all"]);
export const AGENT_PROFILE_MODES = agentProfileModeSchema.options;

export const delegateEnvModeSchema = z.enum(["inherit", "explicit"]);
export const DELEGATE_ENV_MODES = delegateEnvModeSchema.options;

export const delegateWorkspaceAccessSchema = z.enum(["none", "read_write"]);
export const DELEGATE_WORKSPACE_ACCESS_MODES =
  delegateWorkspaceAccessSchema.options;

export const externalCommandInputSchema = z.enum(["argument", "stdin", "none"]);
export const EXTERNAL_COMMAND_INPUT_MODES = externalCommandInputSchema.options;

export const agentProfileAcpMetadataSchema = z
  .object({
    transport: z.literal("stdio"),
    command: nonEmptyString,
    args: stringArray.optional(),
    cwd: stringSchema.optional(),
    env: stringRecordSchema.optional(),
    envMode: delegateEnvModeSchema.optional(),
    workspaceAccess: delegateWorkspaceAccessSchema.optional(),
    timeoutMs: numberSchema.optional(),
  })
  .strict();
export const AGENT_PROFILE_ACP_METADATA_CONFIG_KEYS =
  agentProfileAcpMetadataSchema.keyof().options;

export const agentProfileExternalCommandMetadataSchema = z
  .object({
    command: nonEmptyString,
    args: stringArray.optional(),
    cwd: stringSchema.optional(),
    env: stringRecordSchema.optional(),
    envMode: delegateEnvModeSchema.optional(),
    workspaceAccess: delegateWorkspaceAccessSchema.optional(),
    timeoutMs: numberSchema.optional(),
    input: externalCommandInputSchema.optional(),
    maxOutputBytes: numberSchema.optional(),
    maxStdoutBytes: numberSchema.optional(),
    maxStderrBytes: numberSchema.optional(),
    successExitCodes: integerArray.optional(),
  })
  .strict();
export const AGENT_PROFILE_EXTERNAL_COMMAND_METADATA_CONFIG_KEYS =
  agentProfileExternalCommandMetadataSchema.keyof().options;

export const agentProfileMetadataSchema = z
  .object({
    acp: agentProfileAcpMetadataSchema.optional(),
    externalCommand: agentProfileExternalCommandMetadataSchema.optional(),
  })
  .catchall(z.unknown());

export const agentProfileWhenSchema = z
  .object({
    keywords: stringArray
      .describe(
        "Keyword hints used to sort/label this profile's delegate tool for a goal. This is a routing hint only; it does not hide or grant capabilities.",
      )
      .optional(),
  })
  .strict();

export const agentProfileConfigSchema = z
  .object({
    id: nonEmptyString,
    name: stringSchema.optional(),
    description: stringSchema.optional(),
    mode: agentProfileModeSchema.optional(),
    model: z.unknown().optional(),
    prompt: stringSchema.optional(),
    use: z.array(toolUseSelectorSchema).optional(),
    allowedTools: stringArray.optional(),
    deniedTools: stringArray.optional(),
    triggers: stringArray
      .describe(
        "Keyword hints used to sort/label this profile's delegate tool for a goal. This is a routing hint only; it does not hide or grant capabilities.",
      )
      .optional(),
    when: agentProfileWhenSchema.optional(),
    delegateTool: agentProfileDelegateToolSchema.optional(),
    exposeAsDelegate: z
      .boolean()
      .describe(
        "Tri-state automatic delegation opt-in/opt-out. true forces automatic delegate exposure even when capabilities.agents.exposeChildrenAsDelegates is off; false suppresses automatic delegate_agent/list_agents/delegate_parallel targeting and direct aliases. An explicit delegateTool or delegateTools entry still wins.",
      )
      .optional(),
    hooks: agentProfileHooksSchema.optional(),
    policy: z.array(z.object({}).catchall(z.unknown())).optional(),
    maxSteps: positiveInteger.optional(),
    runBudget: z.object({}).catchall(z.unknown()).optional(),
    metadata: agentProfileMetadataSchema.optional(),
  })
  .strict();
export const AGENT_PROFILE_CONFIG_KEYS =
  agentProfileConfigSchema.keyof().options;
export const AGENT_PROFILE_OPTIONAL_STRING_CONFIG_KEYS =
  agentProfileConfigSchema
    .pick({
      name: true,
      description: true,
      prompt: true,
    })
    .keyof().options;
export const AGENT_PROFILE_TOOL_ARRAY_CONFIG_KEYS = agentProfileConfigSchema
  .pick({
    allowedTools: true,
    deniedTools: true,
  })
  .keyof().options;

export const AGENT_EXPOSURE_MODES = ["indexed", "all"] as const;
export type AgentExposureMode = (typeof AGENT_EXPOSURE_MODES)[number];

export const providersSchema = z
  .record(z.string(), providerConfigSchema)
  .describe(
    'Named model providers. The reserved name "deterministic" is built in and must not be declared here.',
  );
export const modelSchema = nonEmptyString
  .regex(/^[^/]+(\/.+)?$/)
  .describe('Active model in the form "provider/model".');

export const agentsConfigSchema = z
  .object({
    // Replaced with an external JSON Schema ref by scripts/generate-config-schema.ts.
    profiles: z.array(z.unknown()).optional(),
    delegateTools: z.array(delegateToolSchema).optional(),
    spawnModel: modelSchema
      .describe(
        "Optional raw model ref for dynamic spawn_agent children. If unset, they inherit the parent run model.",
      )
      .optional(),
    delegateModel: modelSchema
      .describe(
        "Optional raw model ref for configured in-process delegates when the profile does not set model. ACP and external-command delegates resolve outside the parent process.",
      )
      .optional(),
    exposure: z
      .enum(AGENT_EXPOSURE_MODES)
      .describe(
        'Controls direct delegate_* tool exposure. "indexed" exposes non-opted-out agents through list_agents/delegate_agent/delegate_parallel and only exposes pinned or per-profile exposed delegates; "all" exposes every resolved delegate as a direct delegate_* tool. Default indexed.',
      )
      .optional(),
    pinnedDelegates: stringArray
      .describe(
        "Profile ids or delegate tool names that should remain exposed as direct delegate_* tools when exposure is indexed.",
      )
      .optional(),
    exposeChildrenAsDelegates: z
      .boolean()
      .describe(
        "Opt-in: auto-expose every child/all profile without an explicit delegate as a delegate_<id> tool. Default false. Per-profile exposeAsDelegate overrides this.",
      )
      .optional(),
    enableParallelDelegates: z
      .boolean()
      .describe(
        'Opt-in: expose delegate_parallel for foreground fan-out across read-only configured delegates. Default false. The tool only accepts delegates with workspaceAccess "none".',
      )
      .optional(),
    maxDepth: nonNegativeInteger
      .describe(
        "Global sub-agent depth ceiling. 0 disables sub-agent spawning.",
      )
      .optional(),
  })
  .strict()
  .describe("Agent profile run templates for host-created runs.");
export const AGENTS_CONFIG_KEYS = agentsConfigSchema.keyof().options;

export const capabilitiesSchema = z
  .object({
    hooks: hooksSchema.optional(),
    verification: verificationSchema.optional(),
    skills: skillsSchema.optional(),
    mcp: mcpConfigSchema.optional(),
    agents: agentsConfigSchema.optional(),
  })
  .strict()
  .describe("Host-owned capability runtime settings.");
export const CAPABILITIES_CONFIG_KEYS = capabilitiesSchema.keyof().options;

export const taskConfigSchema = z
  .object({
    enabled: booleanSchema.optional(),
    model: modelSchema.optional(),
    budget: taskBudgetSchema.optional(),
  })
  .strict();
export const TASK_CONFIG_KEYS = taskConfigSchema.keyof().options;
export const tasksSchema = z
  .record(nonEmptyString, taskConfigSchema)
  .describe("Model-backed auxiliary task routing and budget defaults.");
export const confidentialPathsSchema = nonEmptyStringArray.describe(
  "Additional read-confidentiality paths or globs whose contents a run must not read.",
);
export const confidentialDefaultsSchema = booleanSchema.describe(
  "Whether runs include SparkWright's built-in conservative confidential path defaults. Defaults to true.",
);
export const maxStepsSchema = positiveInteger.describe(
  "Explicit main-run step ceiling.",
);
export const workspaceSchema = nonEmptyString.describe(
  "Workspace root for runs. Relative paths resolve from the directory of the config file that defined them.",
);
export const themeSchema = z
  .enum(["dark", "light", "mono"])
  .describe("Visual theme.");
export const mouseSchema = z.boolean().describe("Enable mouse reporting.");
export const keybindingsSchema = z
  .record(z.string(), z.union([z.string(), stringArray, z.null()]))
  .describe("Override default key chords for named TUI actions.");

export const identityGroupSchema = z
  .object({
    model: modelSchema.optional(),
    providers: providersSchema.optional(),
  })
  .strict()
  .describe(
    "Preferred grouping for who/what runs. Flattens to model/providers.",
  );
export const IDENTITY_GROUP_CONFIG_KEYS = identityGroupSchema.keyof().options;

export const policyGroupSchema = z
  .object({
    confidentialPaths: confidentialPathsSchema.optional(),
    confidentialDefaults: confidentialDefaultsSchema.optional(),
    write: writeGuardrailsSchema.optional(),
    sandbox: shellSandboxSchema.optional(),
  })
  .strict()
  .describe(
    "Preferred grouping for security boundaries. Flattens to confidentialDefaults/confidentialPaths/write and shell.sandbox. Run autonomy lives in run.accessMode.",
  );
export const POLICY_GROUP_CONFIG_KEYS = policyGroupSchema.keyof().options;

export const runGroupSchema = z
  .object({
    accessMode: accessModeSchema.optional(),
    backgroundTasks: backgroundTasksSchema.optional(),
    budget: runBudgetSchema.optional(),
    maxSteps: maxStepsSchema.optional(),
    traceLevel: traceLevelSchema.optional(),
    approvals: approvalsSchema.optional(),
  })
  .strict()
  .describe(
    "Preferred grouping for run-shaping defaults. Flattens to accessMode/backgroundTasks/runBudget/maxSteps/traceLevel/approvals.",
  );
export const RUN_GROUP_CONFIG_KEYS = runGroupSchema.keyof().options;

export const uiGroupSchema = z
  .object({
    theme: themeSchema.optional(),
    mouse: mouseSchema.optional(),
    keybindings: keybindingsSchema.optional(),
  })
  .strict()
  .describe(
    "Preferred grouping for TUI-only preferences. Flattens to theme/mouse/keybindings.",
  );
export const UI_GROUP_CONFIG_KEYS = uiGroupSchema.keyof().options;

export const CONFIG_GROUP_CONFIG_KEYS = {
  identity: IDENTITY_GROUP_CONFIG_KEYS,
  policy: POLICY_GROUP_CONFIG_KEYS,
  run: RUN_GROUP_CONFIG_KEYS,
  ui: UI_GROUP_CONFIG_KEYS,
} as const;

export const CONFIG_GROUP_FIELD_MAP = {
  identity: { model: "model", providers: "providers" },
  policy: {
    confidentialPaths: "confidentialPaths",
    confidentialDefaults: "confidentialDefaults",
    write: "write",
    sandbox: "shell",
  },
  run: {
    accessMode: "accessMode",
    backgroundTasks: "backgroundTasks",
    budget: "runBudget",
    maxSteps: "maxSteps",
    traceLevel: "traceLevel",
    approvals: "approvals",
  },
  ui: {
    theme: "theme",
    mouse: "mouse",
    keybindings: "keybindings",
  },
} as const;

export const sparkwrightConfigZodSchema = z
  .object({
    $schema: z
      .string()
      .describe(
        "Optional reference to this JSON Schema so editors can offer completion and validation. Ignored by the loader.",
      )
      .optional(),
    model: modelSchema.optional(),
    providers: providersSchema.optional(),
    accessMode: accessModeSchema.optional(),
    backgroundTasks: backgroundTasksSchema.optional(),
    workspace: workspaceSchema.optional(),
    confidentialPaths: confidentialPathsSchema.optional(),
    confidentialDefaults: confidentialDefaultsSchema.optional(),
    write: writeGuardrailsSchema.optional(),
    runBudget: runBudgetSchema.optional(),
    maxSteps: maxStepsSchema.optional(),
    traceLevel: traceLevelSchema.optional(),
    approvals: approvalsSchema.optional(),
    shell: shellSchema.optional(),
    tools: toolsSchema.optional(),
    tasks: tasksSchema.optional(),
    capabilities: capabilitiesSchema.optional(),
    theme: themeSchema.optional(),
    mouse: mouseSchema.optional(),
    keybindings: keybindingsSchema.optional(),
    identity: identityGroupSchema.optional(),
    policy: policyGroupSchema.optional(),
    run: runGroupSchema.optional(),
    ui: uiGroupSchema.optional(),
  })
  .strict()
  .describe(CONFIG_SCHEMA_DESCRIPTION);
export const SPARKWRIGHT_CONFIG_KEYS =
  sparkwrightConfigZodSchema.keyof().options;

export type SparkwrightConfigInput = z.input<typeof sparkwrightConfigZodSchema>;
export type ModelCost = z.output<typeof modelCostSchema>;
export type ProviderModelConfig = z.output<typeof providerModelConfigSchema>;
export type ProviderConfig = z.output<typeof providerConfigSchema>;
export type WriteGuardrailsConfig = z.output<typeof writeGuardrailsSchema>;
export type ApprovalDefaults = z.output<typeof approvalsSchema>;
export type TaskBudgetConfig = z.output<typeof taskBudgetSchema>;
export type TaskConfig = z.output<typeof taskConfigSchema>;
export type ShellConfig = Omit<z.output<typeof shellSchema>, "sandbox"> & {
  sandbox?: ShellSandboxConfig;
};
export type CapabilityToolsConfig = z.output<typeof toolsSchema>;
export type CapabilityHookActionConfig = z.output<
  typeof workflowHookActionSchema
>;
export type CapabilityWorkflowHookFrequency = z.output<
  typeof workflowHookFrequencySchema
>;
export type CapabilityWorkflowHookConfig = Omit<
  NonNullable<z.output<typeof hooksSchema>["workflow"]>[number],
  "hook" | "matcher"
> & {
  hook: WorkflowHookName;
  matcher?: WorkflowHookMatcher;
};
export type CapabilityEventHookConfig = Omit<
  NonNullable<z.output<typeof hooksSchema>["events"]>[number],
  "matcher"
> & {
  matcher?: WorkflowHookMatcher;
};
export type CapabilityHooksConfig = Omit<
  z.output<typeof hooksSchema>,
  "workflow" | "events"
> & {
  workflow?: CapabilityWorkflowHookConfig[];
  events?: CapabilityEventHookConfig[];
};
export type CapabilityVerificationMode = z.output<
  typeof verificationModeSchema
>;
export type CapabilityVerificationKind = z.output<
  typeof verificationKindSchema
>;
export type CapabilityVerificationCommandConfig = z.output<
  typeof verificationCommandSchema
>;
export type CapabilityVerificationAfterWritesConfig = NonNullable<
  z.output<typeof verificationSchema>["afterWrites"]
>;
export type CapabilityVerificationConfig = z.output<typeof verificationSchema>;
export type CapabilitySkillsConfig = z.output<typeof skillsSchema>;
export type CapabilitySkillEvolutionMode = z.output<
  typeof skillEvolutionModeSchema
>;
export type CapabilitySkillEvolutionConfig = NonNullable<
  z.output<typeof skillsSchema>["evolution"]
>;
export type CapabilitySkillInlineShellConfig = NonNullable<
  z.output<typeof skillsSchema>["inlineShell"]
>;
export type CapabilityMcpToolSchemaLoad = z.output<
  typeof mcpToolSchemaLoadSchema
>;
export type CapabilityMcpStartup = z.output<typeof mcpStartupSchema>;
export type CapabilityDelegateToolConfig = z.output<typeof delegateToolSchema>;
