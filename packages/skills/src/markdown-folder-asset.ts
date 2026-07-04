import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export interface MarkdownFrontmatterSplit {
  frontmatter: Record<string, unknown>;
  body: string;
  /** @reserved Public parser result flag consumed by owner-specific validators. */
  hasFrontmatter: boolean;
  /** @reserved Public parser result provenance for diagnostics/debugging. */
  rawFrontmatter?: string;
}

export interface SplitMarkdownFrontmatterOptions {
  source?: string;
  parseFrontmatter?: (raw: string, source?: string) => Record<string, unknown>;
}

export interface MarkdownFolderAsset {
  assetName: string;
  dir: string;
  sourcePath: string;
  fileName: string;
  frontmatter: Record<string, unknown>;
  body: string;
  contentHash: string;
  version?: string;
}

export interface LoadMarkdownFolderAssetOptions extends SplitMarkdownFrontmatterOptions {
  dir: string;
  fileName: string;
  assetName?: string;
}

export interface DiscoverMarkdownFolderAssetsOptions extends Omit<
  SplitMarkdownFrontmatterOptions,
  "source"
> {
  root: string;
  fileName: string;
  recursive?: boolean;
  maxDepth?: number;
  onError?: (source: string, error: unknown) => void;
}

export function splitMarkdownFrontmatter(
  raw: string,
  options: SplitMarkdownFrontmatterOptions = {},
): MarkdownFrontmatterSplit {
  const normalized = raw.replace(/^\uFEFF/, "");
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/.exec(
    normalized,
  );
  if (!match) {
    return {
      frontmatter: {},
      body: normalized.trim(),
      hasFrontmatter: false,
    };
  }

  const rawFrontmatter = match[1]!;
  const parse = options.parseFrontmatter ?? parseLooseFrontmatterBlock;
  return {
    frontmatter: parse(rawFrontmatter, options.source),
    body: match[2]!.trim(),
    hasFrontmatter: true,
    rawFrontmatter,
  };
}

export function parseLooseFrontmatterBlock(
  raw: string,
  source?: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let nested: Record<string, unknown> | undefined;

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;

    const nestedMatch = /^ {2}([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);
    if (nestedMatch && nested) {
      nested[nestedMatch[1]!] = parseLooseScalarOrList(nestedMatch[2] ?? "");
      continue;
    }

    const match = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);
    if (!match) {
      throw new Error(
        `Unsupported markdown frontmatter line${
          source ? ` (${source})` : ""
        }: ${line}`,
      );
    }

    const [, key, value = ""] = match;
    if (value === "") {
      nested = {};
      out[key!] = nested;
    } else {
      nested = undefined;
      out[key!] = parseLooseScalarOrList(value);
    }
  }

  return out;
}

export function markdownAssetContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function loadMarkdownFolderAsset(
  options: LoadMarkdownFolderAssetOptions,
): Promise<MarkdownFolderAsset> {
  const dir = resolve(options.dir);
  const sourcePath = join(dir, options.fileName);
  const raw = await readFile(sourcePath, "utf8");
  const split = splitMarkdownFrontmatter(raw, {
    source: options.source ?? sourcePath,
    parseFrontmatter: options.parseFrontmatter,
  });
  const assetName = options.assetName ?? basename(dir);
  const version = frontmatterVersion(split.frontmatter);
  return {
    assetName,
    dir,
    sourcePath,
    fileName: options.fileName,
    frontmatter: split.frontmatter,
    body: split.body,
    contentHash: markdownAssetContentHash(raw),
    ...(version ? { version } : {}),
  };
}

export async function discoverMarkdownFolderAssets(
  options: DiscoverMarkdownFolderAssetsOptions,
): Promise<MarkdownFolderAsset[]> {
  const root = resolve(options.root);
  const sourcePaths = new Set<string>();
  await collectMarkdownFolderAssetFiles(
    root,
    options.fileName,
    sourcePaths,
    options.recursive ?? false,
    options.maxDepth ?? 4,
    0,
  );

  const assets: MarkdownFolderAsset[] = [];
  for (const sourcePath of [...sourcePaths].sort((left, right) =>
    left.localeCompare(right),
  )) {
    try {
      assets.push(
        await loadMarkdownFolderAsset({
          dir: dirname(sourcePath),
          fileName: options.fileName,
          parseFrontmatter: options.parseFrontmatter,
        }),
      );
    } catch (error) {
      options.onError?.(sourcePath, error);
    }
  }
  return assets;
}

function parseLooseScalarOrList(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "") return "";

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Fall through to scalar handling.
    }
  }

  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);

  const quoted = /^["'](.*)["']$/.exec(trimmed);
  if (quoted) return quoted[1];

  return trimmed;
}

function frontmatterVersion(
  frontmatter: Record<string, unknown>,
): string | undefined {
  const version = frontmatter.version;
  if (typeof version === "string" && version.trim() !== "") {
    return version.trim();
  }
  if (typeof version === "number" && Number.isFinite(version)) {
    return String(version);
  }
  const metadata = frontmatter.metadata;
  if (
    metadata &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    "version" in metadata
  ) {
    const metadataVersion = (metadata as Record<string, unknown>).version;
    if (typeof metadataVersion === "string" && metadataVersion.trim() !== "") {
      return metadataVersion.trim();
    }
    if (
      typeof metadataVersion === "number" &&
      Number.isFinite(metadataVersion)
    ) {
      return String(metadataVersion);
    }
  }
  return undefined;
}

async function collectMarkdownFolderAssetFiles(
  dir: string,
  fileName: string,
  out: Set<string>,
  recursive: boolean,
  maxDepth: number,
  depth: number,
): Promise<void> {
  const direct = join(dir, fileName);
  if (await isFile(direct)) out.add(direct);

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isDirectory()) continue;
    const child = join(dir, entry.name);
    const childAsset = join(child, fileName);
    if (await isFile(childAsset)) out.add(childAsset);
    if (recursive && depth < maxDepth) {
      await collectMarkdownFolderAssetFiles(
        child,
        fileName,
        out,
        recursive,
        maxDepth,
        depth + 1,
      );
    }
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
