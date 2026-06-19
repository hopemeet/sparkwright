import { PERMISSION_MODES, TRACE_LEVELS } from "@sparkwright/protocol";
import type { WorkflowHookMatcher, WorkflowHookName } from "@sparkwright/core";
import type { ShellSandboxConfig } from "@sparkwright/shell-sandbox";
import { z } from "zod";
import { TOOL_USE_SELECTORS } from "./tool-selectors.js";

export const CONFIG_SCHEMA_ID =
  "https://sparkwright.dev/schemas/v0/config.schema.json";
export const CONFIG_SCHEMA_PROTOCOL_VERSION = "0.2";
export const CONFIG_SCHEMA_TITLE = "Sparkwright Config";
export const CONFIG_SCHEMA_DESCRIPTION =
  "User-editable settings shared by the CLI and the interactive TUI. Loaded (in order, later overriding earlier) from ~/.config/sparkwright/config.{json,yaml,yml}, <workspace>/.sparkwright/config.{json,yaml,yml}, and $SPARKWRIGHT_CONFIG. Within a user/project layer, config.json wins over config.yaml, which wins over config.yml; multiple files in one layer are reported as a conflict. CLI args and env vars override files. Fields may be written flat or under the preferred groups identity/policy/run/ui; tools and capabilities are top-level groups. A field set both ways conflicts and the grouped value wins. The providers map is merged by key, tools.use and tools.allowed intersect, tools.disabled unions, tools.defer is replaced by later layers, capabilities merges by sub-capability, and the security boundaries - shell.sandbox, permissionMode, confidentialPaths, and write - merge conservatively so later layers cannot weaken an earlier layer's policy; other shared fields are wholesale-overridden.";

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
const traceLevelSchema = z
  .enum(TRACE_LEVELS)
  .describe(
    "Default trace verbosity when an entrypoint does not pass one. CLI --trace-level overrides.",
  );
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

export const providerModelConfigSchema = z
  .object({
    cost: modelCostSchema.optional(),
    providerOptions: providerOptionsSchema.optional(),
  })
  .strict();

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
        "Default permission mode for unattended cron run/tick commands. CLI --permission-mode still overrides.",
      )
      .optional(),
  })
  .strict()
  .describe(
    "Default approval auto-grants. CLI flags still override these values.",
  );
export const APPROVALS_CONFIG_KEYS = approvalsSchema.keyof().options;

export const shellSandboxSchema = z
  .object({
    mode: z
      .enum(["off", "warn", "enforce"])
      .describe(
        "off disables OS sandboxing; warn uses it when available; enforce fails shell execution when sandboxing is unavailable.",
      )
      .optional(),
    failIfUnavailable: z
      .boolean()
      .describe("Fail closed when the platform sandbox runtime is unavailable.")
      .optional(),
    filesystem: z
      .object({
        allowRead: nonEmptyStringArray.optional(),
        allowWrite: nonEmptyStringArray.optional(),
        denyRead: nonEmptyStringArray.optional(),
        denyWrite: nonEmptyStringArray.optional(),
        tmp: z.boolean().optional(),
      })
      .strict()
      .optional(),
    network: z
      .object({
        mode: z.enum(["allow", "deny"]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .describe(
    "OS-level process sandbox for local command execution. Forced deny-write paths are always appended by the host.",
  );

export const shellSchema = z
  .object({
    sandbox: shellSandboxSchema.optional(),
  })
  .strict()
  .describe("Host shell execution boundary.");

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

export const workflowHookActionSchema = z.union([
  z
    .object({
      type: z.literal("block"),
      reason: nonEmptyString,
    })
    .strict(),
  z
    .object({
      type: z.literal("context"),
      content: nonEmptyString,
      contextType: z.enum(["system", "user", "summary"]).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("command"),
      command: nonEmptyString,
      args: stringArray.optional(),
      cwd: nonEmptyString.optional(),
      timeoutMs: positiveInteger.optional(),
      blockOnFailure: z.boolean().optional(),
      injectOutput: z.enum(["always", "onFailure", "never"]).optional(),
      maxOutputBytes: positiveInteger.optional(),
      stdin: z.enum(["none", "json"]).optional(),
    })
    .strict(),
]);

export const workflowHookFrequencySchema = z.enum(["always", "oncePerTurn"]);

export const hooksSchema = z
  .object({
    workflow: z
      .array(
        z
          .object({
            name: nonEmptyString,
            description: z.string().optional(),
            hook: z.enum([
              "SessionStart",
              "UserPromptSubmit",
              "ModelOutput",
              "PreToolUse",
              "PostToolUse",
              "Stop",
              "SessionEnd",
              "RuntimeSignal",
            ]),
            enabled: z.boolean().optional(),
            onError: z.enum(["continue", "block"]).optional(),
            frequency: workflowHookFrequencySchema.optional(),
            matcher: workflowHookMatcherSchema.optional(),
            action: workflowHookActionSchema,
          })
          .strict(),
      )
      .optional(),
  })
  .strict()
  .describe("Deterministic workflow hooks for host-created runs.");

export const verificationModeSchema = z.enum(["off", "suggest", "require"]);
export const verificationKindSchema = z.enum([
  "lint",
  "typecheck",
  "test",
  "check",
  "custom",
]);

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

export const verificationSchema = z
  .object({
    mode: verificationModeSchema.optional(),
    defaultProfile: nonEmptyString.optional(),
    profiles: z
      .record(z.string(), z.array(verificationCommandSchema))
      .optional(),
    afterWrites: z
      .object({
        profile: nonEmptyString.optional(),
        frequency: workflowHookFrequencySchema.optional(),
        injectOutput: z.enum(["always", "onFailure", "never"]).optional(),
      })
      .strict()
      .optional(),
    stopGate: z
      .object({
        enabled: z.boolean().optional(),
        requireCleanAfterLastWrite: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .describe(
    "Project verification profiles compiled by the host into workflow hooks.",
  );

export const skillEvolutionModeSchema = z.enum([
  "off",
  "notice",
  "draft",
  "apply",
]);

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
    evolution: z
      .object({
        mode: skillEvolutionModeSchema.optional(),
      })
      .strict()
      .optional(),
    inlineShell: z
      .object({
        enabled: z.boolean().optional(),
        timeoutMs: positiveInteger.optional(),
        maxOutputChars: positiveInteger.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .describe("Skill loading settings for host-created runs.");

export const mcpToolSchemaLoadSchema = z.enum(["eager", "defer"]);
export const mcpStartupSchema = z.enum(["lazy", "prepare", "eager"]);

export const mcpConfigSchema = z
  .object({
    // Replaced with an external JSON Schema ref by scripts/generate-config-schema.ts.
    servers: z.array(z.unknown()).optional(),
    defaultTimeoutMs: positiveInteger.optional(),
    namePrefix: z.string().optional(),
    startup: mcpStartupSchema.optional(),
    toolSchemaLoad: mcpToolSchemaLoadSchema.optional(),
    defaultPolicy: z
      .object({
        risk: z.enum(["safe", "risky", "denied"]).optional(),
        requiresApproval: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .describe("MCP server settings for host-created runs.");

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

export const agentsConfigSchema = z
  .object({
    // Replaced with an external JSON Schema ref by scripts/generate-config-schema.ts.
    profiles: z.array(z.unknown()).optional(),
    delegateTools: z.array(delegateToolSchema).optional(),
    maxDepth: nonNegativeInteger
      .describe(
        "Global sub-agent depth ceiling. 0 disables sub-agent spawning.",
      )
      .optional(),
  })
  .strict()
  .describe("Agent profile run templates for host-created runs.");

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

export const providersSchema = z
  .record(z.string(), providerConfigSchema)
  .describe(
    'Named model providers. The reserved name "deterministic" is built in and must not be declared here.',
  );
export const modelSchema = nonEmptyString
  .regex(/^[^/]+(\/.+)?$/)
  .describe('Active model in the form "provider/model".');
export const confidentialPathsSchema = nonEmptyStringArray.describe(
  "Opt-in read-confidentiality paths or globs whose contents a run must not read.",
);
export const maxStepsSchema = positiveInteger.describe(
  "Explicit main-run step ceiling.",
);
export const themeSchema = z
  .enum(["dark", "light", "mono"])
  .describe("Visual theme.");
export const mouseSchema = z.boolean().describe("Enable mouse reporting.");
export const keybindingsSchema = z
  .record(z.string(), z.union([z.string(), stringArray, z.null()]))
  .describe("Override default key chords for named TUI actions.");

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
    permissionMode: permissionModeSchema.optional(),
    workspace: nonEmptyString
      .describe(
        "Workspace root for runs. Relative paths resolve from the directory of the config file that defined them.",
      )
      .optional(),
    confidentialPaths: confidentialPathsSchema.optional(),
    write: writeGuardrailsSchema.optional(),
    runBudget: runBudgetSchema.optional(),
    maxSteps: maxStepsSchema.optional(),
    traceLevel: traceLevelSchema.optional(),
    approvals: approvalsSchema.optional(),
    shell: shellSchema.optional(),
    tools: toolsSchema.optional(),
    capabilities: capabilitiesSchema.optional(),
    theme: themeSchema.optional(),
    mouse: mouseSchema.optional(),
    keybindings: keybindingsSchema.optional(),
    identity: z
      .object({
        model: modelSchema.optional(),
        providers: providersSchema.optional(),
      })
      .strict()
      .describe(
        "Preferred grouping for who/what runs. Flattens to model/providers.",
      )
      .optional(),
    policy: z
      .object({
        permissionMode: permissionModeSchema.optional(),
        confidentialPaths: confidentialPathsSchema.optional(),
        write: writeGuardrailsSchema.optional(),
        sandbox: shellSandboxSchema.optional(),
      })
      .strict()
      .describe(
        "Preferred grouping for security boundaries. Flattens to permissionMode/confidentialPaths/write and shell.sandbox.",
      )
      .optional(),
    run: z
      .object({
        budget: runBudgetSchema.optional(),
        maxSteps: maxStepsSchema.optional(),
        traceLevel: traceLevelSchema.optional(),
        approvals: approvalsSchema.optional(),
      })
      .strict()
      .describe(
        "Preferred grouping for run-shaping defaults. Flattens to runBudget/maxSteps/traceLevel/approvals.",
      )
      .optional(),
    ui: z
      .object({
        theme: themeSchema.optional(),
        mouse: mouseSchema.optional(),
        keybindings: keybindingsSchema.optional(),
      })
      .strict()
      .describe(
        "Preferred grouping for TUI-only preferences. Flattens to theme/mouse/keybindings.",
      )
      .optional(),
  })
  .strict()
  .describe(CONFIG_SCHEMA_DESCRIPTION);

export type SparkwrightConfigInput = z.input<typeof sparkwrightConfigZodSchema>;
export type ModelCost = z.output<typeof modelCostSchema>;
export type ProviderModelConfig = z.output<typeof providerModelConfigSchema>;
export type ProviderConfig = z.output<typeof providerConfigSchema>;
export type WriteGuardrailsConfig = z.output<typeof writeGuardrailsSchema>;
export type ApprovalDefaults = z.output<typeof approvalsSchema>;
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
export type CapabilityHooksConfig = Omit<
  z.output<typeof hooksSchema>,
  "workflow"
> & {
  workflow?: CapabilityWorkflowHookConfig[];
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
export type CapabilityVerificationStopGateConfig = NonNullable<
  z.output<typeof verificationSchema>["stopGate"]
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
