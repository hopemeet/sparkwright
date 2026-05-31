// AI maintenance note: Parser for the structured YAML block the curator
// review fork is asked to emit. We don't ship a YAML dependency; the block
// is tiny and well-defined, so a hand-rolled mini-parser is enough. If the
// LLM drifts off-format the parser collects errors instead of throwing —
// downstream tooling can decide whether to retry or fail open.

/**
 * One consolidation directive: archive `from`, absorb its content into
 * `into`.
 *
 * @public
 * @stability experimental v0.1
 */
export interface CuratorConsolidation {
  from: string;
  into: string;
  reason: string;
}

/**
 * One pruning directive: archive `name` with no forwarding target.
 *
 * @public
 * @stability experimental v0.1
 */
export interface CuratorPruning {
  name: string;
  reason: string;
}

/**
 * Parsed curator report. `errors[]` is non-empty when the YAML block is
 * present but malformed; absence of the block produces an error too.
 *
 * @public
 * @stability experimental v0.1
 */
export interface CuratorReport {
  consolidations: CuratorConsolidation[];
  prunings: CuratorPruning[];
  errors: string[];
}

const FENCE_RE = /```ya?ml\s*\n([\s\S]*?)```/i;

/**
 * Parse the structured YAML block out of a curator's response. Tolerant of
 * surrounding human-readable text. Errors are surfaced via the `errors`
 * field rather than thrown so the caller can choose policy.
 *
 * @public
 * @stability experimental v0.1
 */
export function parseCuratorReport(text: string): CuratorReport {
  const report: CuratorReport = {
    consolidations: [],
    prunings: [],
    errors: [],
  };
  const match = FENCE_RE.exec(text);
  if (!match) {
    report.errors.push("structured YAML block not found");
    return report;
  }

  const block = match[1];
  const lines = block.split(/\r?\n/);

  let section: "consolidations" | "prunings" | null = null;
  let current: Record<string, string> | null = null;
  const flush = (): void => {
    if (!current || !section) return;
    if (section === "consolidations") {
      if (current.from && current.into) {
        report.consolidations.push({
          from: current.from,
          into: current.into,
          reason: current.reason ?? "",
        });
      } else {
        report.errors.push(
          `consolidation missing from/into: ${JSON.stringify(current)}`,
        );
      }
    } else {
      if (current.name) {
        report.prunings.push({
          name: current.name,
          reason: current.reason ?? "",
        });
      } else {
        report.errors.push(`pruning missing name: ${JSON.stringify(current)}`);
      }
    }
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, "  ").trimEnd();
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    const sectionMatch = /^([a-zA-Z_]+):\s*(\[\s*\])?\s*$/.exec(line);
    if (sectionMatch) {
      flush();
      const name = sectionMatch[1];
      if (name === "consolidations" || name === "prunings") {
        section = name;
      } else {
        section = null;
      }
      continue;
    }

    const dashKv = /^\s*-\s+([a-zA-Z_]+):\s*(.*)$/.exec(line);
    if (dashKv) {
      flush();
      current = {};
      current[dashKv[1]] = stripQuotes(dashKv[2]);
      continue;
    }

    const kv = /^\s+([a-zA-Z_]+):\s*(.*)$/.exec(line);
    if (kv && current) {
      current[kv[1]] = stripQuotes(kv[2]);
      continue;
    }
  }
  flush();

  return report;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  const quoted = /^["'](.*)["']$/.exec(trimmed);
  return quoted ? quoted[1] : trimmed;
}
