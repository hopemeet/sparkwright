// AI maintenance note: File-authored slash commands live at the edge, not in
// core. Core owns the CommandRegistry contract (packages/core/src/commands.ts);
// this package only discovers `.sparkwright/command/*.md`, parses them into
// front-end-agnostic descriptors, and interpolates their bodies. It never
// executes a run and never runs shell itself — shell interpolation is delegated
// to a caller-supplied gated runner so the existing safety/approval gate stays
// the single execution path. See docs/PROJECT_CONFIG_SURFACE.md.

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  evaluateShellSafety,
  type ShellSafetyOptions,
} from "@sparkwright/shell-tool";

export type { ShellSafetyOptions };

/** Frontmatter understood on a command markdown file. Unknown keys are ignored. */
export interface ProjectCommandFrontmatter {
  description?: string;
  /** Optional model override (`provider/model`) applied when the run starts. */
  model?: string;
  /** When true, the embedder should spawn a child run instead of the main run. */
  subtask?: boolean;
}

/** One parsed piece of a command body template. */
export type CommandTemplateSegment =
  | { kind: "literal"; text: string }
  /** `$ARGUMENTS` — replaced with the full rest-of-line. */
  | { kind: "arguments" }
  /** `$1`..`$9` — replaced with a positional arg (1-based). */
  | { kind: "arg"; index: number }
  /** `` !`<cmd>` `` — replaced with the gated shell runner's stdout. */
  | { kind: "shell"; command: string };

/** Where a discovered command came from. Project shadows user. */
export type ProjectCommandSource = "project" | "user";

/** A front-end-agnostic command declaration parsed from a markdown file. */
export interface ProjectCommandDescriptor {
  /** Canonical name (filename without `.md`), also the slash command. */
  name: string;
  /** One-line description from frontmatter, or "" when absent. */
  description: string;
  model?: string;
  subtask: boolean;
  source: ProjectCommandSource;
  /** Absolute path to the source file. */
  path: string;
  /** Raw body (everything after frontmatter). */
  body: string;
  /** Parsed body, ready for {@link interpolateCommandTemplate}. */
  segments: CommandTemplateSegment[];
}

/** Intent returned by a command's run; the embedder decides how to start it. */
export interface StartRunIntent {
  kind: "start_run";
  prompt: string;
  model?: string;
  subtask: boolean;
}

const COMMAND_DIR_REL = ["command"]; // <root>/.sparkwright/command

/**
 * Discover command markdown files. Precedence, weak → strong:
 *   user dir (weak) → project dir → reservedNames (config, strongest).
 * A name declared in `reservedNames` (i.e. present in config.json) shadows any
 * file and is omitted; a project file shadows a user file of the same name.
 * Shadowing is reported via `onShadowed` so the embedder can warn rather than
 * silently drop a declaration.
 */
export async function discoverProjectCommands(options: {
  /** Workspace root. Scans `<cwd>/.sparkwright/command/*.md`. */
  cwd: string;
  /** Absolute path to the user-level command dir (e.g. ~/.config/sparkwright/command). */
  userCommandDir?: string;
  /** Command names already declared in config.json; these shadow files. */
  reservedNames?: Iterable<string>;
  onShadowed?: (info: {
    name: string;
    path: string;
    shadowedBy: "config" | "project";
  }) => void;
}): Promise<ProjectCommandDescriptor[]> {
  const reserved = new Set(options.reservedNames ?? []);
  const byName = new Map<string, ProjectCommandDescriptor>();

  // Weak → strong so the strong source wins via Map overwrite.
  const userDir = options.userCommandDir;
  const projectDir = join(options.cwd, ".sparkwright", ...COMMAND_DIR_REL);

  for (const desc of await readCommandDir(userDir, "user")) {
    if (reserved.has(desc.name)) {
      options.onShadowed?.({
        name: desc.name,
        path: desc.path,
        shadowedBy: "config",
      });
      continue;
    }
    byName.set(desc.name, desc);
  }

  for (const desc of await readCommandDir(projectDir, "project")) {
    if (reserved.has(desc.name)) {
      options.onShadowed?.({
        name: desc.name,
        path: desc.path,
        shadowedBy: "config",
      });
      continue;
    }
    const shadowed = byName.get(desc.name);
    if (shadowed && shadowed.source === "user") {
      options.onShadowed?.({
        name: shadowed.name,
        path: shadowed.path,
        shadowedBy: "project",
      });
    }
    byName.set(desc.name, desc);
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function readCommandDir(
  dir: string | undefined,
  source: ProjectCommandSource,
): Promise<ProjectCommandDescriptor[]> {
  if (!dir) return [];
  const entries = await safeReaddir(dir);
  const out: ProjectCommandDescriptor[] = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".md")) continue;
    const path = join(dir, entry);
    const raw = await readFile(path, "utf8").catch(() => undefined);
    if (raw === undefined) continue;
    out.push(parseCommandFile(basename(entry, ".md"), path, source, raw));
  }
  return out;
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** Parse a command file's raw contents into a descriptor. */
export function parseCommandFile(
  name: string,
  path: string,
  source: ProjectCommandSource,
  raw: string,
): ProjectCommandDescriptor {
  const { frontmatter, body } = splitFrontmatter(raw);
  return {
    name,
    description: frontmatter.description ?? "",
    model: frontmatter.model,
    subtask: frontmatter.subtask ?? false,
    source,
    path,
    body,
    segments: parseCommandTemplate(body),
  };
}

/**
 * Split a leading `---` ... `---` YAML-subset frontmatter block from the body.
 * Only `description` (string), `model` (string), and `subtask` (boolean) are
 * recognized; other keys are ignored. No external YAML dependency.
 */
export function splitFrontmatter(raw: string): {
  frontmatter: ProjectCommandFrontmatter;
  body: string;
} {
  const normalized = raw.replace(/^\uFEFF/, "");
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/.exec(
    normalized,
  );
  if (!match) return { frontmatter: {}, body: normalized.trim() };

  const frontmatter: ProjectCommandFrontmatter = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    const value = stripQuotes(kv[2]!.trim());
    if (key === "description") frontmatter.description = value;
    else if (key === "model") frontmatter.model = value;
    else if (key === "subtask") frontmatter.subtask = parseBool(value);
  }
  return { frontmatter, body: match[2]!.trim() };
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function parseBool(value: string): boolean {
  return /^(true|yes|on|1)$/i.test(value.trim());
}

// Order matters: shell first (it contains a backtick), then $ARGUMENTS, then
// positional $1..$9. `$ARGUMENTS` is matched before `$1` so the longer token
// wins; positional refs are a single digit to avoid eating `$12` ambiguously.
//
// Argument tokens inside a `` !`...` `` span are NOT recognized — the backtick
// span is captured verbatim as the shell command. So `` !`grep $1 src` `` runs
// `grep $1 src` literally (the shell sees `$1`, not the command argument). This
// is deliberate: splicing user-supplied args into a shell command string is a
// command-injection vector. Build arguments into the prompt text instead, and
// keep `` !`...` `` for fixed commands like `` !`git diff` ``.
const TOKEN = /!`([^`]*)`|\$ARGUMENTS\b|\$([1-9])\b/g;

/**
 * Parse a command body into literal / argument / shell segments.
 *
 * `$ARGUMENTS` and `$1..$9` are recognized only in literal text, never inside a
 * `` !`...` `` span (see the note on TOKEN above).
 */
export function parseCommandTemplate(body: string): CommandTemplateSegment[] {
  const segments: CommandTemplateSegment[] = [];
  let last = 0;
  for (let m = TOKEN.exec(body); m !== null; m = TOKEN.exec(body)) {
    if (m.index > last) {
      segments.push({ kind: "literal", text: body.slice(last, m.index) });
    }
    if (m[1] !== undefined) {
      segments.push({ kind: "shell", command: m[1] });
    } else if (m[2] !== undefined) {
      segments.push({ kind: "arg", index: Number(m[2]) });
    } else {
      segments.push({ kind: "arguments" });
    }
    last = m.index + m[0].length;
  }
  if (last < body.length) {
    segments.push({ kind: "literal", text: body.slice(last) });
  }
  return segments;
}

/** Caller-supplied gated shell runner. Returns stdout; throws to fail the command. */
export type ShellRunner = (command: string) => Promise<string>;

/**
 * Resolve a command's segments to a final prompt string.
 * - `$ARGUMENTS` → `rest`; `$1..$9` → positional args (missing → "").
 * - `` !`cmd` `` → `runShell(cmd)`. If any shell segment exists but no
 *   `runShell` is supplied, this throws — pure-text commands never need one.
 * A throw from `runShell` (denied / failed) propagates so the command fails as
 * a whole rather than running on a truncated prompt.
 */
export async function interpolateCommandTemplate(
  segments: readonly CommandTemplateSegment[],
  input: { args: readonly string[]; rest: string; runShell?: ShellRunner },
): Promise<string> {
  let out = "";
  for (const seg of segments) {
    if (seg.kind === "literal") out += seg.text;
    else if (seg.kind === "arguments") out += input.rest;
    else if (seg.kind === "arg") out += input.args[seg.index - 1] ?? "";
    else {
      if (!input.runShell) {
        throw new Error(
          `Command uses !\`${seg.command}\` shell interpolation but no shell runner was provided.`,
        );
      }
      out += await input.runShell(seg.command);
    }
  }
  return out;
}

/** True when the body contains at least one `` !`...` `` segment. */
export function hasShellInterpolation(
  segments: readonly CommandTemplateSegment[],
): boolean {
  return segments.some((s) => s.kind === "shell");
}

/**
 * Build a {@link ShellRunner} that classifies each command with
 * {@link evaluateShellSafety} before executing it through a caller-supplied
 * `execute`. This is the seam that keeps file-command shell on the same safety
 * floor as model-invoked shell.
 *
 * - `deny` → throws (the command fails as a whole).
 * - `require_approval` → calls `approve` if provided; throws when it returns
 *   false or is absent. There is no silent bypass.
 * - `allow` (or approved) → runs `execute`; a non-zero exit throws.
 */
export function createSafetyGatedShellRunner(options: {
  execute: (command: string) => Promise<{ stdout: string; exitCode: number }>;
  safety?: ShellSafetyOptions;
  approve?: (request: {
    command: string;
    reason: string;
  }) => boolean | Promise<boolean>;
}): ShellRunner {
  return async (command: string): Promise<string> => {
    const verdict = evaluateShellSafety(command, options.safety);
    if (verdict.decision === "deny") {
      throw new Error(`Shell interpolation denied: ${verdict.reason}`);
    }
    if (verdict.decision === "require_approval") {
      const ok = options.approve
        ? await options.approve({ command, reason: verdict.reason })
        : false;
      if (!ok) {
        throw new Error(
          `Shell interpolation requires approval and was not approved: ${verdict.reason}`,
        );
      }
    }
    const result = await options.execute(command);
    if (result.exitCode !== 0) {
      throw new Error(
        `Shell interpolation \`${command}\` exited with code ${result.exitCode}.`,
      );
    }
    return result.stdout.trimEnd();
  };
}

/** Resolve a descriptor into a `start_run` intent for the embedder to dispatch. */
export async function buildStartRunIntent(
  descriptor: ProjectCommandDescriptor,
  input: { args: readonly string[]; rest: string; runShell?: ShellRunner },
): Promise<StartRunIntent> {
  const prompt = await interpolateCommandTemplate(descriptor.segments, input);
  return {
    kind: "start_run",
    prompt,
    model: descriptor.model,
    subtask: descriptor.subtask,
  };
}
