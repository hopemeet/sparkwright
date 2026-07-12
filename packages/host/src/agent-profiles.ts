// AI maintenance note: Markdown-authored agent profiles. A `.sparkwright/agents/*.md`
// file is an ergonomic alternative to a `capabilities.agents.profiles[]` entry in
// config.json — nicer for long role prompts. Discovery + mapping live here at the
// host edge; the canonical AgentProfile shape lives in @sparkwright/agent-runtime.
// Explicit config.json entries win over same-id markdown files. Advanced fields
// (policy, runBudget) stay in config.json; markdown frontmatter covers the
// common case. See docs/guides/AGENTS.md and docs/reference/EXTENSION_INTERFACES.md.

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AgentMode, AgentProfile } from "@sparkwright/agent-runtime";
import { splitMarkdownFrontmatter } from "@sparkwright/skills";
import { parse as parseYaml } from "yaml";
import { resolveCapabilityDirs } from "./layers.js";

const AGENT_MODES = new Set<AgentMode>(["primary", "child", "all"]);
type AgentProfileWorkflowHook = NonNullable<AgentProfile["hooks"]>[number];
type AgentProfileWorkflowHookAction = AgentProfileWorkflowHook["action"];
type AgentProfileWorkflowHookMatcher = NonNullable<
  AgentProfileWorkflowHook["matcher"]
>;

const WORKFLOW_HOOK_NAMES = new Set([
  "RunStart",
  "TurnStart",
  "ModelOutput",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "RunEnd",
  "RuntimeSignal",
]);
const AGENT_PROFILE_HOOK_MATCHER_KEYS = [
  "toolName",
  "eventType",
  "signal",
  "status",
  "pathGlob",
  "excludePathGlob",
] as const satisfies readonly (keyof AgentProfileWorkflowHookMatcher)[];
const AGENT_PROFILE_HOOK_CONTEXT_TYPES = new Set<
  NonNullable<
    Extract<AgentProfileWorkflowHookAction, { type: "context" }>["contextType"]
  >
>(["system", "user", "summary"]);
const AGENT_PROFILE_HOOK_OUTPUT_INJECTION_MODES = new Set<
  NonNullable<
    | Extract<
        AgentProfileWorkflowHookAction,
        { type: "command" }
      >["injectOutput"]
    | Extract<AgentProfileWorkflowHookAction, { type: "http" }>["injectOutput"]
  >
>(["always", "onFailure", "never"]);
const AGENT_PROFILE_HOOK_STDIN_MODES = new Set<
  NonNullable<
    Extract<AgentProfileWorkflowHookAction, { type: "command" }>["stdin"]
  >
>(["none", "json"]);
const AGENT_PROFILE_HOOK_COMMAND_RESULT_MODES = new Set<
  NonNullable<
    Extract<AgentProfileWorkflowHookAction, { type: "command" }>["resultMode"]
  >
>(["exitCode", "stdoutJson"]);
const AGENT_PROFILE_HOOK_HTTP_METHODS = new Set<
  NonNullable<
    Extract<AgentProfileWorkflowHookAction, { type: "http" }>["method"]
  >
>(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const AGENT_PROFILE_HOOK_HTTP_RESULT_MODES = new Set<
  NonNullable<
    Extract<AgentProfileWorkflowHookAction, { type: "http" }>["resultMode"]
  >
>(["status", "responseJson"]);
const AGENT_PROFILE_HOOK_ON_ERROR_MODES = new Set<
  NonNullable<AgentProfileWorkflowHook["onError"]>
>(["continue", "block"]);
const AGENT_PROFILE_HOOK_FREQUENCIES = new Set<
  NonNullable<AgentProfileWorkflowHook["frequency"]>
>(["always", "oncePerTurn"]);

// Agent id charset. `:` is accepted so authors can write explicit namespaced
// ids (e.g. `review:foo`); ids are still flat by default (path is never
// auto-derived into the id). Mirrors isAgentId in cli.ts / tools.ts.
const AGENT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

/** A within-layer id collision discovered while scanning an agents tree. */
export interface AgentProfileCollision {
  id: string;
  /**
   * Path of the file kept (first encountered).
   *
   * @reserved Public discovery-diagnostic field consumed by collision reporters.
   */
  keptSource: string;
  /**
   * Path of the file dropped (fail-closed, not silently last-wins).
   *
   * @reserved Public discovery-diagnostic field consumed by collision reporters.
   */
  droppedSource: string;
}

export interface AgentProfileFileEntry {
  profile: AgentProfile;
  source: string;
  identity: MarkdownAgentIdentity;
}

export interface MarkdownAgentIdentity {
  /** @reserved Stable artifact kind carried into invocation-time trace attribution. */
  artifactKind: "agent";
  layer: "builtin" | "user" | "project";
  /** @reserved Logical asset name used by future trace-derived projections. */
  logicalName: string;
  packageHashPolicyVersion: 2;
  packageHash: string;
}

export interface AgentProfileFileCollision {
  id: string;
  kept: AgentProfileFileEntry;
  dropped: AgentProfileFileEntry;
}

export interface AgentProfileFileDiscoveryOptions {
  onCollision?: (collision: AgentProfileCollision) => void;
  onFileCollision?: (collision: AgentProfileFileCollision) => void;
  onError?: (source: string, error: unknown) => void;
}

/**
 * Discover and parse `<workspaceRoot>/.sparkwright/agents/*.md` into profiles.
 * Missing dir → empty list. Unreadable files are skipped.
 */
export async function discoverProjectAgentProfiles(
  workspaceRoot: string,
  onCollision?: (collision: AgentProfileCollision) => void,
): Promise<AgentProfile[]> {
  const dir = join(workspaceRoot, ".sparkwright", "agents");
  return discoverAgentProfilesInDir(dir, onCollision);
}

export async function discoverLayeredAgentProfiles(
  workspaceRoot: string,
  env: Record<string, string | undefined> = process.env,
  onCollision?: (collision: AgentProfileCollision) => void,
): Promise<AgentProfile[]> {
  const byId = new Map<string, AgentProfile>();
  for (const dir of resolveCapabilityDirs("agents", {
    cwd: workspaceRoot,
    env,
  })) {
    // Same id in different layers is legitimate layering (project overrides
    // user); last layer wins. Same id within one layer is an ambiguous
    // basename collision and is failed closed inside discoverAgentProfilesInDir.
    for (const entry of await discoverAgentProfileFileEntriesInDir(dir.dir, {
      onCollision,
    })) {
      byId.set(entry.profile.id, {
        ...entry.profile,
        assetIdentity: { ...entry.identity, layer: dir.layer },
      });
    }
  }
  return [...byId.values()];
}

async function discoverAgentProfilesInDir(
  dir: string,
  onCollision?: (collision: AgentProfileCollision) => void,
): Promise<AgentProfile[]> {
  const entries = await discoverAgentProfileFileEntriesInDir(dir, {
    onCollision,
  });
  return entries.map((entry) => entry.profile);
}

export async function discoverAgentProfileFileEntriesInDir(
  dir: string,
  options: AgentProfileFileDiscoveryOptions = {},
): Promise<AgentProfileFileEntry[]> {
  const byId = new Map<string, AgentProfileFileEntry>();
  await collectAgentProfileFileEntriesInDir(dir, byId, options);
  return [...byId.values()];
}

async function collectAgentProfileFileEntriesInDir(
  dir: string,
  byId: Map<string, AgentProfileFileEntry>,
  options: AgentProfileFileDiscoveryOptions,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectAgentProfileFileEntriesInDir(fullPath, byId, options);
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    const raw = await readFile(fullPath, "utf8").catch((error: unknown) => {
      options.onError?.(fullPath, error);
      return undefined;
    });
    if (raw === undefined) continue;
    const profile = parseAgentProfileFile(basename(entry.name, ".md"), raw);
    const existing = byId.get(profile.id);
    if (existing) {
      const dropped = {
        profile,
        source: fullPath,
        identity: markdownAgentIdentity(profile.id, raw),
      };
      // Fail closed: keep the first file for this id and drop the rest, instead
      // of silently last-wins. The dropped file is reported so authors can fix
      // the ambiguity (or move to an explicit namespaced id).
      options.onCollision?.({
        id: profile.id,
        keptSource: existing.source,
        droppedSource: fullPath,
      });
      options.onFileCollision?.({
        id: profile.id,
        kept: existing,
        dropped,
      });
      continue;
    }
    byId.set(profile.id, {
      profile,
      source: fullPath,
      identity: markdownAgentIdentity(profile.id, raw),
    });
  }
}

export function markdownAgentIdentity(
  logicalName: string,
  raw: string,
  layer: MarkdownAgentIdentity["layer"] = "project",
): MarkdownAgentIdentity {
  const hash = createHash("sha256");
  hash.update("AGENT.md");
  hash.update("\0");
  hash.update(raw);
  hash.update("\0");
  return {
    artifactKind: "agent",
    layer,
    logicalName,
    packageHashPolicyVersion: 2,
    packageHash: `sha256:${hash.digest("hex")}`,
  };
}

/**
 * Merge markdown-authored profiles (weak) under config profiles (strong) by id.
 * A config entry with the same id wins wholesale — config is the precise layer.
 */
export function mergeAgentProfilesById(
  weak: readonly AgentProfile[],
  strong: readonly AgentProfile[],
): AgentProfile[] {
  const byId = new Map<string, AgentProfile>();
  for (const profile of weak) byId.set(profile.id, profile);
  for (const profile of strong) byId.set(profile.id, profile);
  return [...byId.values()];
}

/**
 * Resolve the effective agent profile list for a workspace: markdown files
 * folded under config.json profiles, config winning ties by id.
 */
export async function resolveAgentProfiles(
  workspaceRoot: string,
  configProfiles: readonly AgentProfile[] | undefined,
  onCollision?: (collision: AgentProfileCollision) => void,
): Promise<AgentProfile[]> {
  const markdown = await discoverLayeredAgentProfiles(
    workspaceRoot,
    process.env,
    onCollision,
  );
  return mergeAgentProfilesById(markdown, configProfiles ?? []);
}

/**
 * Parse one agent markdown file into an AgentProfile. The id defaults to the
 * filename (`fallbackId`); a frontmatter `id` may override it with an explicit
 * (possibly namespaced, e.g. `review:foo`) id. The path is never auto-derived
 * into the id.
 */
export function parseAgentProfileFile(
  fallbackId: string,
  raw: string,
): AgentProfile {
  const { frontmatter, body } = splitMarkdownFrontmatter(raw, {
    parseFrontmatter: parseAgentFrontmatterBlock,
  });
  const explicitId = scalar(frontmatter, "id");
  const id =
    explicitId && AGENT_ID_PATTERN.test(explicitId) ? explicitId : fallbackId;
  const profile: AgentProfile = { id };

  const name = scalar(frontmatter, "name");
  if (name) profile.name = name;
  const description = scalar(frontmatter, "description");
  if (description) profile.description = description;

  const use = list(frontmatter, "use");
  if (use.length > 0) profile.use = use;
  const allowedTools = firstList(frontmatter, "allowedtools", "tools");
  if (allowedTools.length > 0) profile.allowedTools = allowedTools;
  const deniedTools = firstList(frontmatter, "deniedtools", "disallowedtools");
  if (deniedTools.length > 0) profile.deniedTools = deniedTools;
  const triggers = list(frontmatter, "triggers");
  if (triggers.length > 0) profile.triggers = triggers;
  const when = profileWhen(frontmatter);
  if (when) profile.when = when;
  const hooks = parseAgentProfileWorkflowHooks(frontmatter.hooks, id);
  if (hooks) profile.hooks = hooks;

  const maxSteps = integer(frontmatter, "maxsteps");
  if (maxSteps !== undefined) profile.maxSteps = maxSteps;
  const runBudget = runBudgetRecord(frontmatter);
  if (runBudget) profile.runBudget = runBudget;
  const delegateTool = profileDelegateTool(frontmatter);
  if (delegateTool) profile.delegateTool = delegateTool;
  const exposeAsDelegate = booleanValue(frontmatter, "exposeasdelegate");
  if (exposeAsDelegate !== undefined)
    profile.exposeAsDelegate = exposeAsDelegate;
  const metadata = record(frontmatter, "metadata");
  if (metadata) profile.metadata = metadata;

  const mode = agentMode(frontmatter, "mode");
  const model = scalar(frontmatter, "model");
  const prompt = body.length > 0 ? body : undefined;

  if (mode) profile.mode = mode;
  if (model) profile.model = model;
  if (prompt) profile.prompt = prompt;

  return profile;
}

interface Frontmatter {
  [key: string]: unknown;
}

function parseAgentFrontmatterBlock(raw: string): Frontmatter {
  try {
    return normalizeFrontmatterKeys(parseYaml(raw));
  } catch {
    return parseAgentLineFrontmatter(raw);
  }
}

function parseAgentLineFrontmatter(raw: string): Frontmatter {
  const frontmatter: Frontmatter = {};
  for (const line of raw.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!kv) continue;
    frontmatter[kv[1]!.toLowerCase()] = kv[2]!.trim();
  }
  return frontmatter;
}

function normalizeFrontmatterKeys(value: unknown): Frontmatter {
  if (!isRecord(value)) return {};
  const frontmatter: Frontmatter = {};
  for (const [key, entry] of Object.entries(value)) {
    frontmatter[key.toLowerCase()] = entry;
  }
  return frontmatter;
}

function scalar(fm: Frontmatter, key: string): string | undefined {
  const value = fm[key];
  if (value === undefined) return undefined;
  // YAML 1.2 coerces literal `true`/`false` to booleans. Preserve the author's
  // text (e.g. `name: true`) instead of silently dropping the field.
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const stripped = stripQuotes(value);
  return stripped.length > 0 ? stripped : undefined;
}

function list(fm: Frontmatter, key: string): string[] {
  const value = fm[key];
  if (value === undefined) return [];
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        typeof item === "string" || typeof item === "number"
          ? stripQuotes(item)
          : "",
      )
      .filter((item) => item.length > 0);
  }
  if (typeof value !== "string") return [];
  const inner = value.replace(/^\[(.*)\]$/, "$1");
  return inner
    .split(",")
    .map((item) => stripQuotes(item.trim()))
    .filter((item) => item.length > 0);
}

function firstList(fm: Frontmatter, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = list(fm, key);
    if (value.length > 0) return value;
  }
  return [];
}

function profileWhen(fm: Frontmatter): AgentProfile["when"] | undefined {
  const raw = fm.when;
  if (isRecord(raw)) {
    const keywords = stringListValue(raw.keywords);
    return keywords.length > 0 ? { keywords } : undefined;
  }
  const keywords = list(fm, "when");
  return keywords.length > 0 ? { keywords } : undefined;
}

export function parseAgentProfileWorkflowHooks(
  raw: unknown,
  profileId: string,
): AgentProfile["hooks"] | undefined {
  if (!isRecord(raw)) return undefined;
  const hooks: AgentProfileWorkflowHook[] = [];
  for (const [hookName, entriesRaw] of Object.entries(raw)) {
    if (!isWorkflowHookName(hookName)) continue;
    const entries = Array.isArray(entriesRaw) ? entriesRaw : [entriesRaw];
    entries.forEach((entry, index) => {
      const hook = profileWorkflowHookEntry(profileId, hookName, entry, index);
      if (hook) hooks.push(hook);
    });
  }
  return hooks.length > 0 ? hooks : undefined;
}

function profileWorkflowHookEntry(
  profileId: string,
  hook: AgentProfileWorkflowHook["hook"],
  raw: unknown,
  index: number,
): AgentProfileWorkflowHook | undefined {
  if (!isRecord(raw)) return undefined;
  const action = profileWorkflowHookAction(raw.action);
  if (!action) return undefined;
  const matcher =
    raw.matcher === undefined
      ? undefined
      : profileWorkflowHookMatcher(raw.matcher);
  if (raw.matcher !== undefined && matcher === undefined) return undefined;
  return {
    name:
      typeof raw.name === "string" && raw.name.length > 0
        ? raw.name
        : `${profileId}.${hook}.${index}`,
    ...(typeof raw.description === "string"
      ? { description: raw.description }
      : {}),
    hook,
    ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
    ...(isStringSetValue(raw.onError, AGENT_PROFILE_HOOK_ON_ERROR_MODES)
      ? { onError: raw.onError }
      : {}),
    ...(isStringSetValue(raw.frequency, AGENT_PROFILE_HOOK_FREQUENCIES)
      ? { frequency: raw.frequency }
      : {}),
    ...(matcher ? { matcher } : {}),
    action,
  };
}

function profileWorkflowHookMatcher(
  raw: unknown,
): AgentProfileWorkflowHookMatcher | undefined {
  if (typeof raw === "string") {
    const toolName = stripQuotes(raw);
    return toolName.length > 0 ? { toolName } : undefined;
  }
  if (!isRecord(raw)) return undefined;
  const matcher: AgentProfileWorkflowHookMatcher = {};
  for (const key of AGENT_PROFILE_HOOK_MATCHER_KEYS) {
    const value = stringOrStringArrayValue(raw[key]);
    if (value !== undefined) matcher[key] = value;
  }
  return Object.keys(matcher).length > 0 ? matcher : undefined;
}

function profileWorkflowHookAction(
  raw: unknown,
): AgentProfileWorkflowHookAction | undefined {
  if (!isRecord(raw) || typeof raw.type !== "string") return undefined;
  if (raw.type === "block") {
    return typeof raw.reason === "string" && raw.reason.length > 0
      ? { type: "block", reason: raw.reason }
      : undefined;
  }
  if (raw.type === "context") {
    if (typeof raw.content !== "string" || raw.content.length === 0) {
      return undefined;
    }
    return {
      type: "context",
      content: raw.content,
      ...(isStringSetValue(raw.contextType, AGENT_PROFILE_HOOK_CONTEXT_TYPES)
        ? { contextType: raw.contextType }
        : {}),
    };
  }
  if (raw.type === "command") {
    if (typeof raw.command !== "string" || raw.command.length === 0) {
      return undefined;
    }
    return {
      type: "command",
      command: raw.command,
      ...(raw.args !== undefined ? { args: stringListValue(raw.args) } : {}),
      ...(typeof raw.cwd === "string" ? { cwd: raw.cwd } : {}),
      ...positiveIntegerField(raw, "timeoutMs"),
      ...(typeof raw.blockOnFailure === "boolean"
        ? { blockOnFailure: raw.blockOnFailure }
        : {}),
      ...(isStringSetValue(
        raw.injectOutput,
        AGENT_PROFILE_HOOK_OUTPUT_INJECTION_MODES,
      )
        ? { injectOutput: raw.injectOutput }
        : {}),
      ...positiveIntegerField(raw, "maxOutputBytes"),
      ...(isStringSetValue(raw.stdin, AGENT_PROFILE_HOOK_STDIN_MODES)
        ? { stdin: raw.stdin }
        : {}),
      ...(isStringSetValue(
        raw.resultMode,
        AGENT_PROFILE_HOOK_COMMAND_RESULT_MODES,
      )
        ? { resultMode: raw.resultMode }
        : {}),
    };
  }
  if (raw.type === "http") {
    if (typeof raw.url !== "string" || !isHttpUrlString(raw.url)) {
      return undefined;
    }
    const headers = stringRecordValue(raw.headers);
    return {
      type: "http",
      url: raw.url,
      ...(isStringSetValue(raw.method, AGENT_PROFILE_HOOK_HTTP_METHODS)
        ? { method: raw.method }
        : {}),
      ...(headers ? { headers } : {}),
      ...(typeof raw.body === "string" ? { body: raw.body } : {}),
      ...positiveIntegerField(raw, "timeoutMs"),
      ...(typeof raw.blockOnFailure === "boolean"
        ? { blockOnFailure: raw.blockOnFailure }
        : {}),
      ...(isStringSetValue(
        raw.injectOutput,
        AGENT_PROFILE_HOOK_OUTPUT_INJECTION_MODES,
      )
        ? { injectOutput: raw.injectOutput }
        : {}),
      ...(isStringSetValue(raw.resultMode, AGENT_PROFILE_HOOK_HTTP_RESULT_MODES)
        ? { resultMode: raw.resultMode }
        : {}),
    };
  }
  return undefined;
}

function isWorkflowHookName(
  value: string,
): value is AgentProfileWorkflowHook["hook"] {
  return WORKFLOW_HOOK_NAMES.has(value);
}

function positiveIntegerField(
  raw: Record<string, unknown>,
  key: "timeoutMs" | "maxOutputBytes",
): { timeoutMs?: number; maxOutputBytes?: number } {
  const value = raw[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? { [key]: value }
    : {};
}

function stringListValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        typeof item === "string" || typeof item === "number"
          ? stripQuotes(item)
          : "",
      )
      .filter((item) => item.length > 0);
  }
  if (typeof value !== "string") return [];
  return value
    .replace(/^\[(.*)\]$/, "$1")
    .split(",")
    .map((item) => stripQuotes(item.trim()))
    .filter((item) => item.length > 0);
}

function stringOrStringArrayValue(
  value: unknown,
): string | string[] | undefined {
  if (typeof value === "string") {
    const text = stripQuotes(value);
    return text.length > 0 ? text : undefined;
  }
  if (Array.isArray(value)) {
    const items = value
      .map((item) =>
        typeof item === "string" || typeof item === "number"
          ? stripQuotes(item)
          : "",
      )
      .filter((item) => item.length > 0);
    return items.length > 0 ? items : undefined;
  }
  return undefined;
}

function stringRecordValue(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function isStringSetValue<const T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
): value is T {
  return typeof value === "string" && allowed.has(value as T);
}

function isHttpUrlString(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function integer(fm: Frontmatter, key: string): number | undefined {
  const value = scalar(fm, key);
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function booleanValue(fm: Frontmatter, key: string): boolean | undefined {
  const value = fm[key];
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

// Positive-integer budget keys mirror runBudgetSchema in config-zod-schema.ts.
// The config.json path is zod-validated; markdown frontmatter is not, so we
// validate here and drop invalid keys rather than passing an unchecked cast
// into the budget math (which would otherwise throw late at run start).
const RUN_BUDGET_INTEGER_KEYS = [
  "maxDurationMs",
  "maxModelCalls",
  "maxToolCalls",
  "maxTokens",
] as const;

function runBudgetRecord(
  fm: Frontmatter,
): AgentProfile["runBudget"] | undefined {
  const raw = record(fm, "runbudget");
  if (!raw) return undefined;
  const budget: Record<string, number> = {};
  for (const key of RUN_BUDGET_INTEGER_KEYS) {
    const value = raw[key];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      budget[key] = value;
    }
  }
  const cost = raw.maxCostUsd;
  if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) {
    budget.maxCostUsd = cost;
  }
  return Object.keys(budget).length > 0
    ? (budget as AgentProfile["runBudget"])
    : undefined;
}

function record(
  fm: Frontmatter,
  key: string,
): Record<string, unknown> | undefined {
  const value = fm[key];
  return isRecord(value) ? value : undefined;
}

function profileDelegateTool(
  fm: Frontmatter,
): AgentProfile["delegateTool"] | undefined {
  const raw = fm.delegatetool ?? fm.delegate;
  const toolName =
    scalar(fm, "delegatetoolname") ??
    scalar(fm, "delegatetool") ??
    scalar(fm, "delegate");
  const fromObject = isRecord(raw)
    ? {
        ...(typeof raw.toolName === "string" && raw.toolName.length > 0
          ? { toolName: raw.toolName }
          : {}),
        ...(typeof raw.description === "string" && raw.description.length > 0
          ? { description: raw.description }
          : {}),
        ...(typeof raw.requiresApproval === "boolean"
          ? { requiresApproval: raw.requiresApproval }
          : {}),
        ...(typeof raw.forbidNesting === "boolean"
          ? { forbidNesting: raw.forbidNesting }
          : {}),
        ...(Number.isInteger(raw.maxSteps) && (raw.maxSteps as number) > 0
          ? { maxSteps: raw.maxSteps as number }
          : {}),
      }
    : undefined;
  const enabled =
    fromObject !== undefined ||
    booleanValue(fm, "delegatetool") === true ||
    booleanValue(fm, "delegate") === true ||
    toolName !== undefined;
  if (!enabled) return undefined;
  const maxSteps = integer(fm, "delegatemaxsteps");
  return {
    ...(fromObject ?? {}),
    ...(toolName && toolName !== "true" ? { toolName } : {}),
    ...(scalar(fm, "delegatedescription")
      ? { description: scalar(fm, "delegatedescription") }
      : {}),
    ...(booleanValue(fm, "requiresapproval") !== undefined
      ? { requiresApproval: booleanValue(fm, "requiresapproval") }
      : {}),
    ...(booleanValue(fm, "forbidnesting") !== undefined
      ? { forbidNesting: booleanValue(fm, "forbidnesting") }
      : {}),
    ...(maxSteps !== undefined ? { maxSteps } : {}),
  };
}

function agentMode(fm: Frontmatter, key: string): AgentMode | undefined {
  const value = scalar(fm, key);
  return value && AGENT_MODES.has(value as AgentMode)
    ? (value as AgentMode)
    : undefined;
}

function stripQuotes(value: string | number): string {
  const text = String(value);
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1);
    }
  }
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
