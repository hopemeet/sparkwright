import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { CronStore, defaultCronRoot } from "@sparkwright/cron";
import { projectConfigPath } from "@sparkwright/host";

export type CreateCapabilityKind =
  | "skill"
  | "agent"
  | "cron"
  | "command"
  | "mcp";

export type CreateCapabilityDraft =
  | {
      kind: "skill";
      name: string;
      description: string;
    }
  | {
      kind: "agent";
      id: string;
      prompt: string;
      maxSteps?: number;
      delegateToolName?: string;
    }
  | {
      kind: "cron";
      name?: string;
      schedule: string;
      prompt: string;
      skills?: string[];
    }
  | {
      kind: "command";
      name: string;
      description: string;
      prompt: string;
    }
  | {
      kind: "mcp";
      name: string;
      serverType: "stdio" | "http";
      commandOrUrl: string;
      args?: string[];
    };

export interface CreateCapabilityResult {
  kind: CreateCapabilityKind;
  message: string;
  path?: string;
}

export async function createCapability(
  draft: CreateCapabilityDraft,
  workspaceRoot: string,
): Promise<CreateCapabilityResult> {
  switch (draft.kind) {
    case "skill":
      return createSkill(draft, workspaceRoot);
    case "agent":
      return createAgent(draft, workspaceRoot);
    case "cron":
      return createCron(draft);
    case "command":
      return createCommand(draft, workspaceRoot);
    case "mcp":
      return createMcp(draft, workspaceRoot);
  }
}

function assertName(name: string, label: string): string {
  const trimmed = name.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(trimmed)) {
    throw new Error(`${label} must be lowercase letters, numbers, or hyphens`);
  }
  return trimmed;
}

async function createSkill(
  draft: Extract<CreateCapabilityDraft, { kind: "skill" }>,
  workspaceRoot: string,
): Promise<CreateCapabilityResult> {
  const name = assertName(draft.name, "Skill name");
  const description = required(draft.description, "Description");
  const dir = join(workspaceRoot, ".sparkwright", "skills", name);
  const path = join(dir, "SKILL.md");
  if (existsSync(path)) throw new Error(`Skill already exists: ${path}`);
  await mkdir(dir, { recursive: true });
  await writeFile(path, renderSkillTemplate(name, description), "utf8");
  return { kind: "skill", message: `Created Skill ${name}`, path };
}

async function createCommand(
  draft: Extract<CreateCapabilityDraft, { kind: "command" }>,
  workspaceRoot: string,
): Promise<CreateCapabilityResult> {
  const name = assertName(draft.name, "Command name");
  const description = required(draft.description, "Description");
  const prompt = required(draft.prompt, "Prompt");
  const dir = join(workspaceRoot, ".sparkwright", "command");
  const path = join(dir, `${name}.md`);
  if (existsSync(path)) throw new Error(`Command already exists: ${path}`);
  await mkdir(dir, { recursive: true });
  await writeFile(path, renderCommandTemplate(description, prompt), "utf8");
  return { kind: "command", message: `Created /${name}`, path };
}

async function createAgent(
  draft: Extract<CreateCapabilityDraft, { kind: "agent" }>,
  workspaceRoot: string,
): Promise<CreateCapabilityResult> {
  const id = assertName(draft.id, "Agent id");
  const prompt = required(draft.prompt, "Prompt");
  const configPath = projectConfigPath(workspaceRoot);
  const config = await readJsonObject(configPath);
  const capabilities = ensureObject(config, "capabilities");
  const agents = ensureObject(capabilities, "agents");
  const profiles = ensureArray<Record<string, unknown>>(agents, "profiles");
  if (profiles.some((profile) => profile.id === id)) {
    throw new Error(`Agent already exists: ${id}`);
  }
  profiles.push({
    id,
    name: id,
    mode: "child",
    prompt,
    ...(draft.maxSteps ? { maxSteps: draft.maxSteps } : {}),
  });
  if (draft.delegateToolName) {
    const delegateTools = ensureArray<Record<string, unknown>>(
      agents,
      "delegateTools",
    );
    delegateTools.push({
      profileId: id,
      toolName: draft.delegateToolName,
    });
  }
  await writeJsonObject(configPath, config);
  return { kind: "agent", message: `Created agent ${id}`, path: configPath };
}

async function createMcp(
  draft: Extract<CreateCapabilityDraft, { kind: "mcp" }>,
  workspaceRoot: string,
): Promise<CreateCapabilityResult> {
  const name = assertName(draft.name, "MCP server name");
  const commandOrUrl = required(
    draft.commandOrUrl,
    draft.serverType === "stdio" ? "Command" : "URL",
  );
  const configPath = projectConfigPath(workspaceRoot);
  const config = await readJsonObject(configPath);
  const capabilities = ensureObject(config, "capabilities");
  const mcp = ensureObject(capabilities, "mcp");
  const servers = ensureArray<Record<string, unknown>>(mcp, "servers");
  if (servers.some((server) => server.name === name)) {
    throw new Error(`MCP server already exists: ${name}`);
  }
  servers.push(
    draft.serverType === "stdio"
      ? {
          type: "stdio",
          name,
          command: commandOrUrl,
          ...(draft.args && draft.args.length > 0 ? { args: draft.args } : {}),
          cwd: ".",
          enabled: true,
        }
      : {
          type: "http",
          name,
          url: commandOrUrl,
          enabled: true,
        },
  );
  await writeJsonObject(configPath, config);
  return {
    kind: "mcp",
    message: `Created MCP server ${name}`,
    path: configPath,
  };
}

async function createCron(
  draft: Extract<CreateCapabilityDraft, { kind: "cron" }>,
): Promise<CreateCapabilityResult> {
  const prompt = required(draft.prompt, "Prompt");
  const schedule = required(draft.schedule, "Schedule");
  const store = new CronStore({
    rootDir: defaultCronRoot(),
  });
  const job = await store.createJob({
    prompt,
    schedule,
    ...(draft.name ? { name: draft.name } : {}),
    ...(draft.skills && draft.skills.length > 0
      ? { skills: draft.skills }
      : {}),
  });
  return {
    kind: "cron",
    message: `Created cron job ${job.name}`,
    path: store.jobsPath,
  };
}

function required(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

function renderSkillTemplate(name: string, description: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    'version: "1.0.0"',
    "metadata:",
    '  version: "1.0.0"',
    "---",
    "",
    `Use this skill when the user asks for ${description}`,
    "",
  ].join("\n");
}

function renderCommandTemplate(description: string, prompt: string): string {
  return [
    "---",
    `description: ${description}`,
    "subtask: false",
    "---",
    "",
    prompt,
    "",
  ].join("\n");
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) throw new Error("config must be a JSON object");
    return parsed;
  } catch (error) {
    if (isMissingFileError(error)) return {};
    throw error;
  }
}

async function writeJsonObject(
  path: string,
  value: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function ensureObject(
  target: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = target[key];
  if (value === undefined) {
    const next: Record<string, unknown> = {};
    target[key] = next;
    return next;
  }
  if (!isRecord(value)) throw new Error(`${key} must be a JSON object`);
  return value;
}

function ensureArray<T>(target: Record<string, unknown>, key: string): T[] {
  const value = target[key];
  if (value === undefined) {
    const next: T[] = [];
    target[key] = next;
    return next;
  }
  if (!Array.isArray(value)) throw new Error(`${key} must be an array`);
  return value as T[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return (
    isRecord(error) && typeof error.code === "string" && error.code === "ENOENT"
  );
}
