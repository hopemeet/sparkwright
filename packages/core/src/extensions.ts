// AI maintenance note: Extensions are prepared into ordinary ContextItem and
// ToolDefinition inputs. The run loop remains unaware of extension identity;
// governance, approval, trace, and capability inspection stay on the existing
// primitives.

import { isRecord } from "./record-utils.js";
import type { ContextItem } from "./types.js";
import type {
  ToolDefinition,
  ToolGovernance,
  ToolSideEffect,
} from "./tools.js";

/**
 * Descriptor returned by `ContextExtension.describe()` so a product shell can
 * inspect available context sources before any expensive load.
 */
export interface ContextExtensionDescriptor {
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface ContextExtensionLoadInput {
  goal: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Adapter shape for sources that produce `ContextItem`s (skills, memory,
 * retrieval, MCP resources, etc.). Implementations should return items shaped
 * for `createRun({ context })`.
 */
export interface ContextExtension {
  name: string;
  describe():
    | Promise<ContextExtensionDescriptor[]>
    | ContextExtensionDescriptor[];
  load(
    input: ContextExtensionLoadInput,
  ): Promise<ContextItem[]> | ContextItem[];
}

/**
 * Adapter shape for sources that produce `ToolDefinition`s (MCP servers,
 * local scripts, hosted tool brokers, etc.).
 */
export interface ToolExtension {
  name: string;
  listTools(): Promise<ToolDefinition[]> | ToolDefinition[];
}

export interface ExtensionLimits {
  /** Maximum context descriptors/items exposed by this extension. */
  maxContextItems?: number;
  /** Maximum serialized context payload prepared for one run. */
  maxContextChars?: number;
  /** Maximum tools exposed by this extension. */
  maxTools?: number;
}

/**
 * One in-process extension registration. The id is the authoritative audit
 * identity; adapter-local names remain presentation labels only.
 */
export interface ExtensionRegistration {
  id: string;
  version?: string;
  description?: string;
  context?: ContextExtension;
  tools?: ToolExtension;
  limits?: ExtensionLimits;
}

export interface ExtensionSummary {
  id: string;
  version?: string;
  description?: string;
  context: ContextExtensionDescriptor[];
  tools: string[];
}

export interface InspectedExtensions {
  extensions: ExtensionSummary[];
  tools: ToolDefinition[];
}

export interface PreparedExtensions extends InspectedExtensions {
  context: ContextItem[];
}

export type ExtensionPreparationErrorCode =
  | "EXTENSION_INVALID"
  | "EXTENSION_CONFLICT"
  | "EXTENSION_LOAD_FAILED"
  | "EXTENSION_LIMIT_EXCEEDED";

/** Stable failure shape for extension registration and preparation. */
export class ExtensionPreparationError extends Error {
  constructor(
    readonly code: ExtensionPreparationErrorCode,
    readonly extensionId: string,
    readonly phase: "registration" | "describe" | "context" | "tools",
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ExtensionPreparationError";
  }
}

const DEFAULT_EXTENSION_LIMITS: Required<ExtensionLimits> = {
  maxContextItems: 32,
  maxContextChars: 100_000,
  maxTools: 64,
};

const EXTENSION_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const ALLOWED_CONTEXT_TYPES = new Set<ContextItem["type"]>([
  "system",
  "file",
  "summary",
]);
const SIDE_EFFECTS = new Set<ToolSideEffect>([
  "none",
  "read",
  "write",
  "network",
  "external",
]);
const RISKY_SIDE_EFFECTS = new Set<ToolSideEffect>([
  "write",
  "network",
  "external",
]);
const TOOL_RISKS = new Set(["safe", "risky", "denied"]);
const TOOL_IDEMPOTENCY = new Set([
  "idempotent",
  "conditional",
  "non_idempotent",
]);

/**
 * Inspect registered surfaces without loading run context. Tool definitions
 * are already normalized through the same fail-closed governance path used by
 * `prepareExtensions()`.
 */
export async function inspectExtensions(
  registrations: readonly ExtensionRegistration[],
): Promise<InspectedExtensions> {
  const resolved = await resolveExtensions(registrations, undefined);
  return { extensions: resolved.extensions, tools: resolved.tools };
}

/**
 * Prepare registered extensions into normal Core inputs. This is deliberately
 * a helper rather than a second runtime: callers pass the returned context and
 * tools into their existing `createRun()` composition.
 */
export async function prepareExtensions(
  registrations: readonly ExtensionRegistration[],
  input: ContextExtensionLoadInput,
): Promise<PreparedExtensions> {
  return resolveExtensions(registrations, input);
}

async function resolveExtensions(
  registrations: readonly ExtensionRegistration[],
  input: ContextExtensionLoadInput | undefined,
): Promise<PreparedExtensions> {
  validateRegistrations(registrations);
  const context: ContextItem[] = [];
  const tools: ToolDefinition[] = [];
  const extensions: ExtensionSummary[] = [];
  const contextIds = new Set<string>();
  const toolNames = new Map<string, string>();

  // Preserve registration order for deterministic prompt/tool inventories.
  for (const registration of registrations) {
    const limits = resolveLimits(registration);
    const contextDescriptors = registration.context
      ? await callExtension(registration, "describe", () =>
          registration.context!.describe(),
        )
      : [];
    validateContextDescriptors(registration, contextDescriptors, limits);

    const extensionTools = registration.tools
      ? await callExtension(registration, "tools", () =>
          registration.tools!.listTools(),
        )
      : [];
    if (!Array.isArray(extensionTools)) {
      throw extensionError(
        registration,
        "tools",
        "EXTENSION_INVALID",
        "listTools() must return an array.",
      );
    }
    if (extensionTools.length > limits.maxTools) {
      throw extensionError(
        registration,
        "tools",
        "EXTENSION_LIMIT_EXCEEDED",
        `exposed ${extensionTools.length} tools; limit is ${limits.maxTools}.`,
      );
    }

    const governedTools = extensionTools.map((tool) => {
      validateTool(registration, tool);
      const previousOwner = toolNames.get(tool.name);
      if (previousOwner) {
        throw extensionError(
          registration,
          "tools",
          "EXTENSION_CONFLICT",
          `tool "${tool.name}" is already owned by extension "${previousOwner}".`,
        );
      }
      toolNames.set(tool.name, registration.id);
      return governExtensionTool(tool, registration);
    });
    tools.push(...governedTools);

    if (registration.context && input) {
      const loaded = await callExtension(registration, "context", () =>
        registration.context!.load(input),
      );
      const governedContext = governExtensionContext(
        registration,
        loaded,
        limits,
        contextIds,
      );
      context.push(...governedContext);
    }

    extensions.push({
      id: registration.id,
      ...(registration.version ? { version: registration.version } : {}),
      ...(registration.description
        ? { description: registration.description }
        : {}),
      context: contextDescriptors.map(cloneContextDescriptor),
      tools: governedTools.map((tool) => tool.name),
    });
  }

  return { extensions, tools, context };
}

function validateRegistrations(
  registrations: readonly ExtensionRegistration[],
): void {
  if (!Array.isArray(registrations)) {
    throw new ExtensionPreparationError(
      "EXTENSION_INVALID",
      "unknown",
      "registration",
      "Extension registrations must be an array.",
    );
  }
  const ids = new Set<string>();
  for (const registration of registrations) {
    const candidate: unknown = registration;
    if (!isRecord(candidate)) {
      throw new ExtensionPreparationError(
        "EXTENSION_INVALID",
        "unknown",
        "registration",
        "Extension registration must be an object.",
      );
    }
    if (
      typeof registration.id !== "string" ||
      registration.id.length > 128 ||
      !EXTENSION_ID_PATTERN.test(registration.id)
    ) {
      throw extensionError(
        registration,
        "registration",
        "EXTENSION_INVALID",
        "id must use lowercase letters, digits, dots, underscores, or hyphens and start with a letter.",
      );
    }
    if (ids.has(registration.id)) {
      throw extensionError(
        registration,
        "registration",
        "EXTENSION_CONFLICT",
        `duplicate extension id "${registration.id}".`,
      );
    }
    ids.add(registration.id);
    if (!registration.context && !registration.tools) {
      throw extensionError(
        registration,
        "registration",
        "EXTENSION_INVALID",
        "registration must provide a context or tool adapter.",
      );
    }
    if (
      registration.description !== undefined &&
      (typeof registration.description !== "string" ||
        registration.description.length > 1_000)
    ) {
      throw extensionError(
        registration,
        "registration",
        "EXTENSION_INVALID",
        "description must be a string up to 1,000 characters.",
      );
    }
    if (
      registration.version !== undefined &&
      (typeof registration.version !== "string" ||
        registration.version.trim().length === 0 ||
        registration.version.length > 128)
    ) {
      throw extensionError(
        registration,
        "registration",
        "EXTENSION_INVALID",
        "version must be a non-empty string up to 128 characters.",
      );
    }
    validateAdapter(registration, "context");
    validateAdapter(registration, "tools");
    resolveLimits(registration);
  }
}

function validateAdapter(
  registration: ExtensionRegistration,
  kind: "context" | "tools",
): void {
  const adapter = registration[kind];
  if (adapter === undefined) return;
  const valid =
    isRecord(adapter) &&
    typeof adapter.name === "string" &&
    adapter.name.trim().length > 0 &&
    adapter.name.length <= 128 &&
    (kind === "context"
      ? typeof adapter.describe === "function" &&
        typeof adapter.load === "function"
      : typeof adapter.listTools === "function");
  if (!valid) {
    throw extensionError(
      registration,
      "registration",
      "EXTENSION_INVALID",
      `${kind} adapter requires a bounded name and its declared functions.`,
    );
  }
}

function resolveLimits(
  registration: ExtensionRegistration,
): Required<ExtensionLimits> {
  const limits = {
    ...DEFAULT_EXTENSION_LIMITS,
    ...(registration.limits ?? {}),
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw extensionError(
        registration,
        "registration",
        "EXTENSION_INVALID",
        `${name} must be a positive safe integer.`,
      );
    }
  }
  return limits;
}

function validateContextDescriptors(
  registration: ExtensionRegistration,
  descriptors: unknown,
  limits: Required<ExtensionLimits>,
): asserts descriptors is ContextExtensionDescriptor[] {
  if (!Array.isArray(descriptors)) {
    throw extensionError(
      registration,
      "describe",
      "EXTENSION_INVALID",
      "describe() must return an array.",
    );
  }
  if (descriptors.length > limits.maxContextItems) {
    throw extensionError(
      registration,
      "describe",
      "EXTENSION_LIMIT_EXCEEDED",
      `described ${descriptors.length} context sources; limit is ${limits.maxContextItems}.`,
    );
  }
  if (serializedLength(descriptors) > limits.maxContextChars) {
    throw extensionError(
      registration,
      "describe",
      "EXTENSION_LIMIT_EXCEEDED",
      `context descriptors exceed the ${limits.maxContextChars}-character limit.`,
    );
  }
  const names = new Set<string>();
  for (const descriptor of descriptors) {
    if (
      !isRecord(descriptor) ||
      typeof descriptor.name !== "string" ||
      descriptor.name.trim().length === 0 ||
      descriptor.name.length > 128 ||
      (descriptor.description !== undefined &&
        (typeof descriptor.description !== "string" ||
          descriptor.description.length > 1_000)) ||
      (descriptor.metadata !== undefined && !isRecord(descriptor.metadata))
    ) {
      throw extensionError(
        registration,
        "describe",
        "EXTENSION_INVALID",
        "every context descriptor must have a non-empty name.",
      );
    }
    if (names.has(descriptor.name)) {
      throw extensionError(
        registration,
        "describe",
        "EXTENSION_CONFLICT",
        `duplicate context descriptor "${descriptor.name}".`,
      );
    }
    names.add(descriptor.name);
  }
}

function governExtensionContext(
  registration: ExtensionRegistration,
  loaded: unknown,
  limits: Required<ExtensionLimits>,
  knownIds: Set<string>,
): ContextItem[] {
  if (!Array.isArray(loaded)) {
    throw extensionError(
      registration,
      "context",
      "EXTENSION_INVALID",
      "load() must return an array.",
    );
  }
  if (loaded.length > limits.maxContextItems) {
    throw extensionError(
      registration,
      "context",
      "EXTENSION_LIMIT_EXCEEDED",
      `loaded ${loaded.length} context items; limit is ${limits.maxContextItems}.`,
    );
  }

  let payloadChars = 0;
  const governed = loaded.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      item.id.trim().length === 0 ||
      item.id.length > 256 ||
      typeof item.content !== "string" ||
      !isRecord(item.metadata) ||
      !ALLOWED_CONTEXT_TYPES.has(item.type as ContextItem["type"])
    ) {
      throw extensionError(
        registration,
        "context",
        "EXTENSION_INVALID",
        "context items must be system/file/summary items with id, string content, and metadata.",
      );
    }
    if (knownIds.has(item.id)) {
      throw extensionError(
        registration,
        "context",
        "EXTENSION_CONFLICT",
        `context item id "${item.id}" is already registered.`,
      );
    }
    knownIds.add(item.id);
    payloadChars +=
      item.content.length +
      serializedLength(item.parts) +
      serializedLength(item.metadata);
    const contextItem = item as unknown as ContextItem;
    return {
      ...contextItem,
      source: {
        kind: "extension",
        uri: `extension:${registration.id}`,
      },
      metadata: {
        ...contextItem.metadata,
        extension: extensionIdentity(registration),
      },
    };
  });

  if (payloadChars > limits.maxContextChars) {
    throw extensionError(
      registration,
      "context",
      "EXTENSION_LIMIT_EXCEEDED",
      `loaded ${payloadChars} context characters; limit is ${limits.maxContextChars}.`,
    );
  }
  return governed;
}

function validateTool(
  registration: ExtensionRegistration,
  tool: unknown,
): asserts tool is ToolDefinition {
  if (
    !isRecord(tool) ||
    typeof tool.name !== "string" ||
    !TOOL_NAME_PATTERN.test(tool.name) ||
    typeof tool.description !== "string" ||
    tool.description.trim().length === 0 ||
    typeof tool.execute !== "function" ||
    !isRecord(tool.inputSchema)
  ) {
    throw extensionError(
      registration,
      "tools",
      "EXTENSION_INVALID",
      "tools require a valid name, description, object inputSchema, and execute function.",
    );
  }
  validateSideEffects(
    registration,
    (tool as unknown as ToolDefinition).governance?.sideEffects,
  );
  validateToolControl(
    registration,
    (tool as unknown as ToolDefinition).policy,
    (tool as unknown as ToolDefinition).governance,
  );
}

function validateToolControl(
  registration: ExtensionRegistration,
  policy: ToolDefinition["policy"],
  governance: ToolGovernance | undefined,
): void {
  const policyCandidate: unknown = policy;
  if (policyCandidate !== undefined && !isRecord(policyCandidate)) {
    throw extensionError(
      registration,
      "tools",
      "EXTENSION_INVALID",
      "tool policy must be an object.",
    );
  }
  if (policy?.risk !== undefined && !TOOL_RISKS.has(policy.risk)) {
    throw extensionError(
      registration,
      "tools",
      "EXTENSION_INVALID",
      "tool policy.risk is invalid.",
    );
  }
  if (
    policy?.requiresApproval !== undefined &&
    typeof policy.requiresApproval !== "boolean"
  ) {
    throw extensionError(
      registration,
      "tools",
      "EXTENSION_INVALID",
      "tool policy.requiresApproval must be boolean.",
    );
  }
  const governanceCandidate: unknown = governance;
  if (governanceCandidate !== undefined && !isRecord(governanceCandidate)) {
    throw extensionError(
      registration,
      "tools",
      "EXTENSION_INVALID",
      "tool governance must be an object.",
    );
  }
  if (
    governance?.idempotency !== undefined &&
    !TOOL_IDEMPOTENCY.has(governance.idempotency)
  ) {
    throw extensionError(
      registration,
      "tools",
      "EXTENSION_INVALID",
      "tool governance.idempotency is invalid.",
    );
  }
}

function validateSideEffects(
  registration: ExtensionRegistration,
  sideEffects: ToolGovernance["sideEffects"],
): void {
  if (sideEffects === undefined) return;
  if (
    !Array.isArray(sideEffects) ||
    sideEffects.length === 0 ||
    sideEffects.some((value) => !SIDE_EFFECTS.has(value))
  ) {
    throw extensionError(
      registration,
      "tools",
      "EXTENSION_INVALID",
      "tool governance.sideEffects must be a non-empty list of known effects.",
    );
  }
}

function governExtensionTool(
  tool: ToolDefinition,
  registration: ExtensionRegistration,
): ToolDefinition {
  const base = normalizeToolControl(tool.policy, tool.governance, registration);
  const originalPolicyForArgs = tool.policyForArgs?.bind(tool);
  const originalConcurrency = tool.isConcurrencySafe?.bind(tool);
  const governed: ToolDefinition = {
    ...tool,
    delegation: tool.delegation ?? "parent_only",
    interruptBehavior: tool.interruptBehavior ?? "block",
    policy: base.policy,
    governance: base.governance,
    ...(originalPolicyForArgs
      ? {
          policyForArgs(args: unknown) {
            const dynamic = originalPolicyForArgs(args);
            if (!dynamic) return base;
            if (isPromiseLike(dynamic) || !isRecord(dynamic)) {
              throw extensionError(
                registration,
                "tools",
                "EXTENSION_INVALID",
                "policyForArgs() must return a synchronous policy object.",
              );
            }
            return normalizeToolControl(
              { ...base.policy, ...(dynamic.policy ?? {}) },
              { ...base.governance, ...(dynamic.governance ?? {}) },
              registration,
            );
          },
        }
      : {}),
  };

  if (originalConcurrency) {
    governed.isConcurrencySafe = (args: unknown) => {
      try {
        const dynamic = governed.policyForArgs?.(args) ?? base;
        const effective = normalizeToolControl(
          dynamic.policy,
          dynamic.governance,
          registration,
        );
        if (!isReadOnlyReplaySafe(effective.policy, effective.governance)) {
          return false;
        }
        return originalConcurrency(args) === true;
      } catch {
        return false;
      }
    };
  }
  return governed;
}

function normalizeToolControl(
  policy: ToolDefinition["policy"],
  governance: ToolGovernance | undefined,
  registration: ExtensionRegistration,
): {
  policy: NonNullable<ToolDefinition["policy"]>;
  governance: ToolGovernance;
} {
  validateToolControl(registration, policy, governance);
  validateSideEffects(registration, governance?.sideEffects);
  const sideEffects = governance?.sideEffects?.length
    ? [...new Set(governance.sideEffects)]
    : (["external"] as ToolSideEffect[]);
  const requiresGovernanceApproval = sideEffects.some((effect) =>
    RISKY_SIDE_EFFECTS.has(effect),
  );
  const declaredOrigin = governance?.origin;
  return {
    policy: {
      ...(policy ?? {}),
      risk:
        policy?.risk === "denied"
          ? "denied"
          : requiresGovernanceApproval
            ? "risky"
            : (policy?.risk ?? "safe"),
      requiresApproval:
        requiresGovernanceApproval || policy?.requiresApproval === true,
      ...(requiresGovernanceApproval && !policy?.approvalReason
        ? { approvalReason: "Extension tool side effects require approval." }
        : {}),
    },
    governance: {
      ...(governance ?? {}),
      sideEffects,
      idempotency: governance?.idempotency ?? "non_idempotent",
      dataSensitivity: governance?.dataSensitivity ?? "internal",
      audit: governance?.audit ?? { level: "metadata" },
      origin: {
        kind: declaredOrigin?.kind ?? "local",
        name: declaredOrigin?.name ?? registration.id,
        metadata: {
          ...(declaredOrigin?.metadata ?? {}),
          extensionId: registration.id,
          ...(registration.version
            ? { extensionVersion: registration.version }
            : {}),
        },
      },
    },
  };
}

function isReadOnlyReplaySafe(
  policy: NonNullable<ToolDefinition["policy"]>,
  governance: ToolGovernance,
): boolean {
  if (policy.risk === "risky" || policy.risk === "denied") return false;
  if (policy.requiresApproval === true) return false;
  if (governance.idempotency === "non_idempotent") return false;
  return (governance.sideEffects ?? []).every(
    (effect) => effect === "none" || effect === "read",
  );
}

async function callExtension<T>(
  registration: ExtensionRegistration,
  phase: "describe" | "context" | "tools",
  call: () => T | Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (cause) {
    if (cause instanceof ExtensionPreparationError) throw cause;
    throw extensionError(
      registration,
      phase,
      "EXTENSION_LOAD_FAILED",
      cause instanceof Error ? cause.message : String(cause),
      cause,
    );
  }
}

function extensionError(
  registration: Pick<ExtensionRegistration, "id">,
  phase: ExtensionPreparationError["phase"],
  code: ExtensionPreparationErrorCode,
  detail: string,
  cause?: unknown,
): ExtensionPreparationError {
  const id = typeof registration.id === "string" ? registration.id : "unknown";
  return new ExtensionPreparationError(
    code,
    id,
    phase,
    `Extension "${id}" ${phase} failed: ${detail}`,
    cause,
  );
}

function extensionIdentity(
  registration: ExtensionRegistration,
): Record<string, string> {
  return {
    id: registration.id,
    ...(registration.version ? { version: registration.version } : {}),
  };
}

function cloneContextDescriptor(
  descriptor: ContextExtensionDescriptor,
): ContextExtensionDescriptor {
  return {
    ...descriptor,
    ...(descriptor.metadata ? { metadata: { ...descriptor.metadata } } : {}),
  };
}

function serializedLength(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    isRecord(value) && typeof (value as { then?: unknown }).then === "function"
  );
}
