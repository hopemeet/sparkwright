#!/usr/bin/env node
// Scans packages/*/src for fields annotated with `@reserved` JSDoc comments,
// and additionally performs a lightweight "unused field" detection using the
// TypeScript AST to enumerate interface / type-literal property declarations,
// then text-scans the same source tree for references shaped like `.name` or
// `["name"]` / `['name']`.
//
// Outputs three buckets:
//   * Reserved declared       — fields tagged @reserved (informational).
//   * Possibly unused         — declared on an exported interface / type but
//                               with zero textual references (warn-only by
//                               default; fails under --strict).
//   * Used but tagged reserved — fields tagged @reserved that DO have
//                               references (candidates to "graduate").
//
// `npm run check:reserved` exits 0 even when warnings are present so the
// gate stays informational. Run with `--strict` to fail on possibly-unused.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = path.join(root, "packages");

const STRICT = process.argv.includes("--strict");

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      yield full;
    }
  }
}

// Properties we should never flag as "possibly unused" regardless of how
// they look. These are either:
//  - structural names that appear in many shapes (false-positive prone), or
//  - intentionally serialized-only fields (written to JSON / trace files and
//    consumed by downstream tooling, not by the TS code itself).
const PROPERTY_IGNORE = new Set([
  // common collection / generic accessors that have noisy reference patterns
  "length",
  "size",
  // schema-shaped serialization fields that tooling reads, not code
  "$schema",
  "$id",
  "$ref",
  // public protocol / extension fields that may only be read by downstream
  // consumers, JSON Schema fixtures, traces, or generated declarations.
  "__brand",
  "accent2",
  // consumed only in search-dialog.tsx (JSX); this scanner walks .ts files
  // only, so a .tsx-only reader reads as zero references.
  "snippet",
  "allowed",
  "approval.requested",
  "run.continuation",
  "argCount",
  "artifactRefs",
  "audit",
  "allowedRoles",
  "available",
  "budgetEstimate",
  "byModel",
  "byTool",
  "bump",
  "cancel",
  "category",
  "cat",
  "checkPolicy",
  "compact",
  "color",
  "contextWindowTokens",
  "costEstimate",
  "create",
  "cwd",
  "dataSensitivity",
  "deliveredAt",
  "detail",
  "diffAdded",
  "diffHunk",
  "diffRemoved",
  "displayTimeUnit",
  "disconnect",
  "drain",
  "dur",
  "durationMs",
  "effectivePolicy",
  "effectiveProfile",
  "envKeys",
  "estimatedTokens",
  "estimatedUsd",
  "eventSequence",
  "executeShell",
  "expectedOutput",
  "experimental",
  "failure",
  "field",
  "file",
  "flush",
  "host.log",
  "host.ready",
  "headerKeys",
  "hint",
  "hunkCount",
  "idempotency",
  "indexedSkills",
  "initialize",
  "key",
  "label",
  "lastError",
  "lastInputTokens",
  "level",
  "link",
  "loadEvents",
  "loadedSkills",
  "maxCalls",
  "metrics",
  "missing",
  "originalChars",
  "occurredAt",
  "onMemoryWrite",
  "onPreCompress",
  "onSessionEnd",
  "partialStderr",
  "partialStdout",
  "ph",
  "planId",
  "preview",
  "priority",
  "promoted",
  "queuePrefetch",
  "rateLimit",
  "recordPatch",
  "recordUse",
  "reasons",
  "remember",
  "recall",
  "forget",
  "reservedOutputTokens",
  "retentionDays",
  "rules",
  "run.completed",
  "runEndedAt",
  "run.event",
  "run.failed",
  "runIds",
  "runStartedAt",
  "runState",
  "scores",
  "selectionReason",
  "sessionBlocks",
  "setPinned",
  "shutdown",
  "sideEffects",
  "signal",
  "silent",
  "skippedBecauseLocked",
  "snapshotForSystemPrompt",
  "spans",
  "statusAwaiting",
  "statusDone",
  "statusError",
  "statusIdle",
  "statusRunning",
  "statuses",
  "stepId",
  "systemPromptBlock",
  "supportsPromptCaching",
  "tags",
  "tier",
  "trace",
  "traceEvents",
  "timestamp",
  "truncated",
  "turnBlocks",
  "userContent",
  "assistantContent",
  "volatileBlocks",
  "viewers",
  "wallTimeMs",
  "warning",
  "warnings",
  "windowMs",
  "writeArtifact",
  "getOne",
  "muted",
  "y",
]);

// Collect source files first so the reference scan only happens once.
const sources = [];
const refOnlySources = [];
for (const pkg of await readdir(packagesDir)) {
  const srcDir = path.join(packagesDir, pkg, "src");
  try {
    const s = await stat(srcDir);
    if (!s.isDirectory()) continue;
  } catch {
    continue;
  }
  for await (const file of walk(srcDir)) {
    const content = await readFile(file, "utf8");
    // Declarations are parsed from .ts only (ScriptKind.TS chokes on JSX), but
    // .tsx files are kept for the reference scan below — a field read only from
    // a .tsx component (e.g. app.tsx) would otherwise look unreferenced.
    if (file.endsWith(".tsx")) {
      refOnlySources.push({ pkg, file, content });
    } else {
      sources.push({ pkg, file, content });
    }
  }
}

// AST pass: collect property declarations on exported interfaces and on type
// literals attached to exported type aliases. Also collect @reserved JSDoc
// tags on those properties.
const declarations = []; // { pkg, file, line, name, exported, reserved, reservedNote }

function getLine(sourceFile, pos) {
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
}

function hasExportModifier(node) {
  const modifiers = ts.canHaveModifiers(node)
    ? ts.getModifiers(node)
    : undefined;
  return Boolean(
    modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
  );
}

function readReservedTag(node) {
  // Returns the text of the @reserved tag if present, else null.
  const tags = ts.getJSDocTags(node) ?? [];
  for (const tag of tags) {
    if (tag.tagName.escapedText === "reserved") {
      const comment =
        typeof tag.comment === "string"
          ? tag.comment
          : Array.isArray(tag.comment)
            ? tag.comment.map((c) => c.text ?? "").join("")
            : "";
      return `@reserved ${comment}`.trim();
    }
  }
  return null;
}

function visitMembers(sourceFile, pkg, file, members, exported) {
  for (const member of members) {
    if (
      !ts.isPropertySignature(member) &&
      !ts.isMethodSignature(member) &&
      !ts.isPropertyDeclaration(member)
    ) {
      continue;
    }
    const nameNode = member.name;
    if (!nameNode) continue;
    let name;
    if (ts.isIdentifier(nameNode)) name = nameNode.text;
    else if (ts.isStringLiteral(nameNode)) name = nameNode.text;
    else continue;
    const reservedNote = readReservedTag(member);
    declarations.push({
      pkg,
      file,
      line: getLine(sourceFile, member.getStart(sourceFile)),
      name,
      exported,
      reserved: Boolean(reservedNote),
      reservedNote,
    });
  }
}

function visit(node, sourceFile, pkg, file) {
  if (ts.isInterfaceDeclaration(node)) {
    visitMembers(sourceFile, pkg, file, node.members, hasExportModifier(node));
  } else if (ts.isTypeAliasDeclaration(node)) {
    const exported = hasExportModifier(node);
    if (ts.isTypeLiteralNode(node.type)) {
      visitMembers(sourceFile, pkg, file, node.type.members, exported);
    } else if (ts.isIntersectionTypeNode(node.type)) {
      for (const member of node.type.types) {
        if (ts.isTypeLiteralNode(member)) {
          visitMembers(sourceFile, pkg, file, member.members, exported);
        }
      }
    }
  }
  ts.forEachChild(node, (child) => visit(child, sourceFile, pkg, file));
}

for (const { pkg, file, content } of sources) {
  const sf = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  visit(sf, sf, pkg, file);
}

// Reference scan: count occurrences of `.name` or `["name"]` / `['name']`
// across all collected sources. We deliberately scan the same source set we
// pulled declarations from — same blast radius as the protocol surface.
const allText = sources
  .concat(refOnlySources)
  .map((s) => s.content)
  .join("\n");

const refCache = new Map();
function refCount(name) {
  if (refCache.has(name)) return refCache.get(name);
  // Escape regex-special chars (property names should be identifiers, but be
  // defensive in case a string literal name slips through).
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `(?:\\.${esc}\\b)|(?:\\[\\s*["']${esc}["']\\s*\\])`,
    "g",
  );
  // Count matches across all source text. Each declaration itself does NOT
  // produce a `.name` match (declarations are bare identifiers), so we don't
  // need to subtract self-references.
  const matches = allText.match(re);
  const count = matches ? matches.length : 0;
  refCache.set(name, count);
  return count;
}

// Deduplicate by (file, line, name) — interfaces and their re-exports might
// otherwise double-count.
const dedup = new Map();
for (const d of declarations) {
  const key = `${d.file}:${d.line}:${d.name}`;
  if (!dedup.has(key)) dedup.set(key, d);
}

const reservedDeclared = [];
const possiblyUnused = [];
const usedButReserved = [];

for (const d of dedup.values()) {
  const count = refCount(d.name);
  d.refs = count;
  if (d.reserved) {
    reservedDeclared.push(d);
    if (count > 0) usedButReserved.push(d);
  } else if (d.exported && count === 0 && !PROPERTY_IGNORE.has(d.name)) {
    possiblyUnused.push(d);
  }
}

function rel(file) {
  return path.relative(root, file);
}

function sortByLoc(a, b) {
  return a.file === b.file
    ? a.line - b.line
    : rel(a.file).localeCompare(rel(b.file));
}
reservedDeclared.sort(sortByLoc);
possiblyUnused.sort(sortByLoc);
usedButReserved.sort(sortByLoc);

console.log(`Reserved declared (${reservedDeclared.length}):`);
if (reservedDeclared.length === 0) {
  console.log("  (none)");
} else {
  for (const d of reservedDeclared) {
    console.log(`  ${rel(d.file)}:${d.line}  ${d.name}  (refs=${d.refs})`);
    if (d.reservedNote) console.log(`    ${d.reservedNote}`);
  }
}

console.log("");
console.log(`Possibly unused (${possiblyUnused.length}):`);
if (possiblyUnused.length === 0) {
  console.log("  (none)");
} else {
  for (const d of possiblyUnused) {
    console.log(`  ${rel(d.file)}:${d.line}  ${d.name}`);
  }
  console.log(
    "  note: zero textual references; consider tagging @reserved or removing.",
  );
}

console.log("");
console.log(`Used but tagged reserved (${usedButReserved.length}):`);
if (usedButReserved.length === 0) {
  console.log("  (none)");
} else {
  for (const d of usedButReserved) {
    console.log(`  ${rel(d.file)}:${d.line}  ${d.name}  (refs=${d.refs})`);
  }
  console.log(
    "  note: these have readers; the @reserved tag may be ready to graduate.",
  );
}

if (STRICT && possiblyUnused.length > 0) {
  console.error(
    `\nstrict mode: ${possiblyUnused.length} possibly-unused field(s) detected.`,
  );
  process.exit(1);
}
process.exit(0);
