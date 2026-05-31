/**
 * Tiny unified-diff parser tuned for terminal rendering.
 *
 * We don't need full semantic diffing — the host already produced a unified
 * diff string. We just classify each line so the renderer can colour it and
 * skip the headers we don't want to show ("--- a/x", "+++ b/x").
 */

export type DiffLineKind = "header" | "hunk" | "add" | "del" | "ctx" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export interface DiffSummary {
  lines: DiffLine[];
  additions: number;
  deletions: number;
  hunkCount: number;
}

export function parseUnifiedDiff(diff: string): DiffSummary {
  const out: DiffLine[] = [];
  let additions = 0;
  let deletions = 0;
  let hunkCount = 0;
  for (const raw of diff.split("\n")) {
    if (raw.length === 0) {
      out.push({ kind: "ctx", text: "" });
      continue;
    }
    if (raw.startsWith("diff --git") || raw.startsWith("index ")) {
      out.push({ kind: "meta", text: raw });
      continue;
    }
    if (raw.startsWith("---") || raw.startsWith("+++")) {
      out.push({ kind: "header", text: raw });
      continue;
    }
    if (raw.startsWith("@@")) {
      hunkCount += 1;
      out.push({ kind: "hunk", text: raw });
      continue;
    }
    if (raw.startsWith("+")) {
      additions += 1;
      out.push({ kind: "add", text: raw });
      continue;
    }
    if (raw.startsWith("-")) {
      deletions += 1;
      out.push({ kind: "del", text: raw });
      continue;
    }
    out.push({ kind: "ctx", text: raw });
  }
  return { lines: out, additions, deletions, hunkCount };
}
