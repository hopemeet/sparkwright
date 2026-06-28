// AI maintenance note: Manifest parsing for the discovery protocol. Accepts
// either a pure JSON document or a markdown file with a small YAML-ish
// frontmatter (key: value lines, optional `triggers`/`examples`/etc. as
// space- or comma-separated strings or JSON arrays). No external YAML library
// is used — the grammar is deliberately tiny so we can keep the dependency
// surface empty. If a host needs richer YAML, they can preprocess upstream
// and hand the result to {@link parseSkillManifestObject}.

import type { SkillManifest } from "./types.js";

const DESCRIPTION_MAX_LENGTH = 1024;

/**
 * Input accepted by {@link parseSkillManifest} — either raw source text or a
 * pre-parsed object.
 *
 * @public
 * @stability experimental v0.1
 */
export type SkillManifestInput = string | Record<string, unknown>;

interface ParseSkillManifestOptions {
  allowEmptyInstructions?: boolean;
}

/**
 * Parse a skill manifest from raw text or an object.
 *
 * Source text starting with `{` is treated as JSON. Source text starting with
 * `---` is treated as YAML frontmatter followed by a markdown body; the body
 * becomes the manifest's `instructions`. Otherwise the entire text is treated
 * as a JSON document.
 *
 * @public
 * @stability experimental v0.1
 */
export function parseSkillManifest(
  input: SkillManifestInput,
  source?: string,
): SkillManifest {
  return parseSkillManifestInternal(input, source, {
    allowEmptyInstructions: false,
  });
}

/**
 * Compatibility parser for the legacy {@link import("./index.js").parseSkill}
 * adapter. It uses the canonical manifest grammar, but preserves the old
 * `parseSkill` behavior that accepted an empty markdown body.
 *
 * @internal
 */
export function parseSkillManifestCompat(
  input: SkillManifestInput,
  source?: string,
): SkillManifest {
  return parseSkillManifestInternal(input, source, {
    allowEmptyInstructions: true,
  });
}

function parseSkillManifestInternal(
  input: SkillManifestInput,
  source: string | undefined,
  options: ParseSkillManifestOptions,
): SkillManifest {
  if (typeof input !== "string") {
    return parseSkillManifestObjectInternal(input, source, options);
  }

  const trimmed = input.trimStart();
  if (trimmed.startsWith("{")) {
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch (cause) {
      throw new Error(
        `Skill manifest is not valid JSON${source ? ` (${source})` : ""}: ${
          (cause as Error).message
        }`,
      );
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(
        `Skill manifest JSON must be an object${source ? ` (${source})` : ""}.`,
      );
    }
    return parseSkillManifestObjectInternal(
      raw as Record<string, unknown>,
      source,
      options,
    );
  }

  if (trimmed.startsWith("---")) {
    const { frontmatter, body } = splitFrontmatter(trimmed, source);
    if (
      frontmatter.instructions === undefined &&
      (body !== "" || options.allowEmptyInstructions)
    ) {
      frontmatter.instructions = body;
    }
    return parseSkillManifestObjectInternal(frontmatter, source, options);
  }

  throw new Error(
    `Skill manifest must begin with '{' (JSON) or '---' (frontmatter)${
      source ? ` (${source})` : ""
    }.`,
  );
}

/**
 * Validate and normalize a pre-parsed manifest object.
 *
 * @public
 * @stability experimental v0.1
 */
export function parseSkillManifestObject(
  raw: Record<string, unknown>,
  source?: string,
): SkillManifest {
  return parseSkillManifestObjectInternal(raw, source, {
    allowEmptyInstructions: false,
  });
}

function parseSkillManifestObjectInternal(
  raw: Record<string, unknown>,
  source: string | undefined,
  options: ParseSkillManifestOptions,
): SkillManifest {
  const name = requireString(raw.name, "name", source);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw new Error(
      `Skill name must use lowercase letters, numbers, and hyphens (max 64 chars)${
        source ? ` (${source})` : ""
      }.`,
    );
  }

  const description = requireString(raw.description, "description", source);
  if (description.length > DESCRIPTION_MAX_LENGTH) {
    throw new Error(
      `Skill description must be at most ${DESCRIPTION_MAX_LENGTH} characters${
        source ? ` (${source})` : ""
      }.`,
    );
  }
  const instructions = requireString(raw.instructions, "instructions", source, {
    allowEmpty: options.allowEmptyInstructions,
  });

  const manifest: SkillManifest = {
    name,
    description,
    instructions,
  };

  const triggers = optionalStringList(raw.triggers, "triggers", source);
  if (triggers) manifest.triggers = triggers;

  const examples = optionalStringList(raw.examples, "examples", source);
  if (examples) manifest.examples = examples;

  const allowedTools = optionalStringList(
    raw.allowedTools ?? raw["allowed-tools"],
    "allowedTools",
    source,
  );
  if (allowedTools) manifest.allowedTools = allowedTools;

  const requiredCapabilities = optionalStringList(
    raw.requiredCapabilities ?? raw["required-capabilities"],
    "requiredCapabilities",
    source,
  );
  if (requiredCapabilities)
    manifest.requiredCapabilities = requiredCapabilities;

  const metadata = optionalRecord(raw.metadata, "metadata", source);
  const version =
    optionalVersion(raw.version) ?? optionalVersion(metadata?.version);
  if (version) manifest.version = version;

  const license = optionalString(raw.license);
  if (license) manifest.license = license;

  const compatibility = optionalStringList(
    raw.compatibility,
    "compatibility",
    source,
  );
  if (compatibility) manifest.compatibility = compatibility;

  const sourcePath = optionalString(raw.source) ?? source;
  if (sourcePath) manifest.source = sourcePath;

  if (metadata) manifest.metadata = { ...metadata };

  return manifest;
}

interface FrontmatterSplit {
  frontmatter: Record<string, unknown>;
  body: string;
}

function splitFrontmatter(text: string, source?: string): FrontmatterSplit {
  // Assume `text` starts with `---` (caller checked).
  const afterOpen = text.slice(3);
  const newline = afterOpen.indexOf("\n");
  if (newline === -1) {
    throw new Error(
      `Skill frontmatter must include a closing '---'${
        source ? ` (${source})` : ""
      }.`,
    );
  }

  const rest = afterOpen.slice(newline + 1);
  const closeMatch = /\n---\s*(?:\n|$)/.exec(rest);
  if (!closeMatch) {
    throw new Error(
      `Skill frontmatter must include a closing '---'${
        source ? ` (${source})` : ""
      }.`,
    );
  }

  const head = rest.slice(0, closeMatch.index);
  const body = rest.slice(closeMatch.index + closeMatch[0].length).trim();
  return { frontmatter: parseFrontmatterBlock(head, source), body };
}

function parseFrontmatterBlock(
  block: string,
  source?: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let nested: Record<string, unknown> | undefined;

  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;

    const nestedMatch = /^ {2}([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);
    if (nestedMatch && nested) {
      nested[nestedMatch[1]] = parseScalarOrList(nestedMatch[2] ?? "");
      continue;
    }

    const match = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);
    if (!match) {
      throw new Error(
        `Unsupported skill frontmatter line${
          source ? ` (${source})` : ""
        }: ${line}`,
      );
    }

    const [, key, value = ""] = match;
    if (value === "") {
      nested = {};
      out[key] = nested;
    } else {
      nested = undefined;
      out[key] = parseScalarOrList(value);
    }
  }

  return out;
}

function parseScalarOrList(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "") return "";

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through to scalar handling
    }
  }

  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);

  const quoted = /^["'](.*)["']$/.exec(trimmed);
  if (quoted) return quoted[1];

  return trimmed;
}

function requireString(
  value: unknown,
  field: string,
  source: string | undefined,
  options: { allowEmpty?: boolean } = {},
): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed !== "" || options.allowEmpty) return trimmed;
  }
  throw new Error(
    `Skill manifest field '${field}' is required${
      source ? ` (${source})` : ""
    }.`,
  );
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function optionalVersion(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function optionalRecord(
  value: unknown,
  field: string,
  source: string | undefined,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(
    `Skill ${field} must be an object${source ? ` (${source})` : ""}.`,
  );
}

function optionalStringList(
  value: unknown,
  field: string,
  source: string | undefined,
): string[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value)) {
    return value.map(String).filter((item) => item.trim() !== "");
  }
  if (typeof value === "string") {
    return value
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  throw new Error(
    `Skill manifest field '${field}' must be a string or array${
      source ? ` (${source})` : ""
    }.`,
  );
}
