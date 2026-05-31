import { defineTool } from "@sparkwright/core";
import { createGlobPathsTool as createGlobPathsToolBase } from "@sparkwright/coding-tools";
import {
  createCronTool as createCronToolBase,
  defaultCronRoot,
} from "@sparkwright/cron";

/**
 * Built-in tool: read a UTF-8 file from the workspace. Safe (no approval).
 *
 * This duplicates the equivalent in @sparkwright/tui temporarily; once the
 * TUI moves to consume the host via @sparkwright/sdk-node it will be
 * dropped from there and live only here.
 */
// read_file paging defaults. The old tool returned a fixed 400-char preview,
// which made the model loop (it never saw past the stub, so it re-read the same
// file). We now return real content, but a naive "return the whole file" is the
// opposite failure: a large file dumps everything into the context budget. So
// the tool pages by line — default window, explicit "hasMore", and a per-call
// character ceiling as a hard backstop against pathologically long lines.
const READ_DEFAULT_LINES = 2000;
const READ_MAX_CHARS = 60_000;

export function createReadFileTool() {
  return defineTool({
    name: "read_file",
    description:
      "Read a UTF-8 text file from the workspace. Returns up to `limit` lines " +
      "(default 2000) starting at 1-based line `offset` (default 1). For large " +
      "files, read successive windows by passing `offset`; the result reports " +
      "`totalLines` and `hasMore` plus the next offset to use. `path` must be " +
      "a concrete file path; glob patterns are not expanded. Use `glob_paths` " +
      "first when you need to discover files from a pattern.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: {
          type: "number",
          description: "1-based line to start at. Default 1.",
        },
        limit: {
          type: "number",
          description: `Max lines to return. Default ${READ_DEFAULT_LINES}.`,
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    policy: { risk: "safe" },
    async execute(args: unknown, ctx) {
      if (!ctx.workspace) throw new Error("Workspace is not configured.");
      const { path, offset, limit } = args as {
        path: string;
        offset?: number;
        limit?: number;
      };
      if (containsGlobPattern(path)) {
        throw new Error(
          `read_file does not support glob patterns: ${path}. Use glob_paths to find matching files, then call read_file with a concrete path.`,
        );
      }
      const content = await ctx.workspace.readText(path);
      const lines = content.split("\n");
      const totalLines = lines.length;
      const startLine = Math.max(1, Math.floor(offset ?? 1));
      const windowLines = Math.max(1, Math.floor(limit ?? READ_DEFAULT_LINES));
      const startIdx = startLine - 1;

      // Offset past EOF: return an empty window rather than erroring, so the
      // model can tell it has walked off the end.
      if (startIdx >= totalLines) {
        return {
          path,
          bytes: content.length,
          totalLines,
          startLine,
          endLine: startLine - 1,
          content: "",
          hasMore: false,
          note: `offset ${startLine} is past end of file (${totalLines} lines).`,
        };
      }

      let endIdx = Math.min(totalLines, startIdx + windowLines);
      let slice = lines.slice(startIdx, endIdx).join("\n");

      // Char backstop: a window of "few" but very long lines (e.g. a minified
      // bundle) can still be huge. Trim to a line boundary within the budget.
      // `midLineCut` is the pathological case — a SINGLE line longer than the
      // whole budget, where there's no line boundary to trim to, so the line
      // itself is returned partial and line-offset paging can't recover the
      // rest. We must say so rather than report a clean, complete window.
      let charCapped = false;
      let midLineCut = false;
      if (slice.length > READ_MAX_CHARS) {
        const cut = slice.slice(0, READ_MAX_CHARS);
        const lastNl = cut.lastIndexOf("\n");
        if (lastNl > 0) {
          slice = cut.slice(0, lastNl);
        } else {
          slice = cut;
          midLineCut = true;
        }
        endIdx = startIdx + (slice === "" ? 1 : slice.split("\n").length);
        charCapped = true;
      }

      const returnedLines = slice === "" ? 0 : slice.split("\n").length;
      const endLine = startIdx + returnedLines;
      // midLineCut → the last line is partial, so there's always "more" even if
      // we've reached the last line index.
      const hasMore = endIdx < totalLines || midLineCut;
      let note: string | undefined;
      if (midLineCut) {
        note = `Line ${startLine} exceeds the ${READ_MAX_CHARS}-char limit; returned its first ${slice.length} chars. The rest of this line is not retrievable by line offset.`;
      } else if (hasMore) {
        note = charCapped
          ? `Returned lines ${startLine}-${endLine} (capped at ${READ_MAX_CHARS} chars). File has ${totalLines} lines — continue with offset ${endLine + 1}.`
          : `Returned lines ${startLine}-${endLine} of ${totalLines} — continue with offset ${endLine + 1}.`;
      }

      return {
        path,
        bytes: content.length,
        totalLines,
        startLine,
        endLine,
        content: slice,
        hasMore,
        truncated: charCapped,
        ...(note ? { note } : {}),
      };
    },
  });
}

export function createGlobPathsTool(workspaceRoot: string) {
  return createGlobPathsToolBase({ workspaceRoot });
}

/**
 * Built-in tool: append a heading + body section to a file. Risky — emits
 * approval.requested via core.
 */
export function createAppendFileTool() {
  return defineTool({
    name: "append_file",
    description:
      "Append a short heading + body section to a UTF-8 text file, creating " +
      "the file (and any parent dirs) if it does not exist. Requires approval. " +
      "Pass `heading` as plain text WITHOUT any leading '#': the tool renders " +
      "it as a level-2 heading itself.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        heading: { type: "string" },
        body: { type: "string" },
      },
      required: ["path", "heading", "body"],
      additionalProperties: false,
    },
    policy: { risk: "risky" },
    async execute(args: unknown, ctx) {
      if (!ctx.workspace) throw new Error("Workspace is not configured.");
      const { path, body } = args as {
        path: string;
        heading: string;
        body: string;
      };
      // Models often pass `heading` already carrying its markdown marker
      // ("## Title"), and we prepend "## " unconditionally — yielding the
      // "## ## Title" double-prefix seen in the C2 trace. Strip any leading
      // '#'/whitespace so the tool owns exactly one level-2 marker regardless
      // of how the caller phrased it.
      const heading = (args as { heading: string }).heading
        .replace(/^\s*#+\s*/, "")
        .trim();
      // A missing file is treated as empty so append_file can CREATE the file.
      // Only ENOENT is swallowed; other read errors (permission, is-a-dir)
      // propagate.
      const current = await ctx.workspace
        .readText(path)
        .catch((err: unknown) => {
          if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return "";
          throw err;
        });
      if (current.includes(`## ${heading}`)) {
        ctx.reportWorkspaceWriteSkipped?.({
          path,
          reason: `Heading "${heading}" already present`,
        });
        return { path, changed: false };
      }
      const next = `${current.replace(/\s+$/, "")}\n\n## ${heading}\n\n${body}\n`;
      const write = await ctx.workspace.writeText(path, next, {
        reason: `Append ${heading}`,
      });
      if (write?.diffArtifact) ctx.reportToolArtifact?.(write.diffArtifact);
      return {
        path,
        changed: true,
        diffArtifactId: write?.diffArtifactId,
        writeSummary: write?.summary,
        finalLines: write?.summary.lastLines,
      };
    },
  });
}

export function createCronTool() {
  return createCronToolBase({ rootDir: defaultCronRoot(process.env) });
}

function containsGlobPattern(path: string): boolean {
  return /[*?[]/.test(path);
}
