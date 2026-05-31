// AI maintenance note: The curator's review prompt. The text is opinionated
// — it directs a forked LLM agent to do *umbrella-building consolidation*,
// not duplicate-finding. Hard rules baked in:
//   - never delete (archive only)
//   - never touch pinned / non-agent-created skills
//   - require structured YAML output for downstream automation
//
// Dry-run mode prepends a banner that forbids mutations; the LLM must still
// produce the same report shape, describing what it WOULD do.

import type { SkillUsageRecord } from "@sparkwright/skills";

/**
 * Options for {@link renderCuratorPrompt}.
 *
 * @public
 * @stability experimental v0.1
 */
export interface RenderCuratorPromptOptions {
  /**
   * Agent-created skill records the fork is allowed to operate on. The host
   * pre-filters to agent-authored, non-pinned skills.
   */
  candidates: readonly SkillUsageRecord[];
  /** When true, prepend the dry-run banner forbidding mutations. */
  dryRun?: boolean;
  /** Optional extra instruction appended after the standard body. */
  extraInstructions?: string;
}

/**
 * Banner that disables every mutating curator action. Exported so embedders
 * can render it verbatim in UI / logs.
 *
 * @public
 * @stability experimental v0.1
 */
export const CURATOR_DRY_RUN_BANNER = `===============================================================
DRY-RUN — REPORT ONLY. DO NOT MUTATE THE SKILL LIBRARY.
===============================================================

This is a PREVIEW pass. Follow every instruction below EXCEPT:

  - DO NOT call skill_manage with action=patch, create, delete,
    write_file, or remove_file.
  - DO NOT move skill directories into .archive/ or otherwise
    rewrite any file under the skills root.
  - skills_list and skill_view are FINE — read as much as you need.

Your output IS the deliverable. Produce the exact same
human-readable summary and structured YAML block you would
produce on a live run — but describe the actions you WOULD take,
not actions you took.
===============================================================`;

const BODY = `You are running as Sparkwright's background skill CURATOR. This is an
UMBRELLA-BUILDING consolidation pass, not a passive audit and not a
duplicate-finder.

The goal of the skill collection is a LIBRARY OF CLASS-LEVEL INSTRUCTIONS
AND EXPERIENTIAL KNOWLEDGE. A collection of hundreds of narrow skills where
each one captures one session's specific bug is a FAILURE of the library,
not a feature. The right target shape is CLASS-LEVEL skills with rich
SKILL.md bodies + references/, templates/, and scripts/ subfiles for
session-specific detail.

Hard rules — do not violate:
1. Operate only on the candidate list below; it is already filtered to
   agent-created, non-pinned skills.
2. Never delete. Archiving is the maximum destructive action and is
   recoverable.
3. Do not use use_count as a reason to skip consolidation. Counters are
   often near-zero on freshly tracked records. Judge overlap on CONTENT.
4. Do not reject consolidation on the grounds that "each skill has a
   distinct trigger". Pairwise distinctness is the wrong bar. The right
   bar is: "would a human maintainer write this as N separate skills, or
   as one skill with N labeled subsections?"

How to work:
1. Scan the candidate list. Identify PREFIX CLUSTERS (skills sharing a
   first word or domain keyword).
2. For each cluster with 2+ members, ask "what is the UMBRELLA CLASS
   these skills all serve?" If a maintainer would write it as one skill
   with labelled subsections, MERGE.
3. Three ways to consolidate:
   a. MERGE INTO EXISTING UMBRELLA — patch the broad sibling to add a
      labeled section for each absorbed skill, then archive the narrow
      siblings with absorbed_into=<umbrella>.
   b. CREATE A NEW UMBRELLA — when no member is broad enough, write a
      new class-level SKILL.md and archive the absorbed narrow siblings.
   c. DEMOTE TO references/templates/scripts — when a sibling is narrow
      but valuable, move its body into the umbrella's references/,
      templates/, or scripts/ subdirectory, then archive the old skill.

Every skill you archive MUST appear in exactly one of the two structured
output lists below. If you absorbed X into umbrella Y, X goes under
\`consolidations\` with \`into: Y\`. If you archived X with no forwarding
target, X goes under \`prunings\`.

Output format — strict:

## Human summary
A short paragraph describing the clusters you processed and decisions
left alone.

## Structured summary (required)
\`\`\`yaml
consolidations:
  - from: <old-skill-name>
    into: <umbrella-skill-name>
    reason: <one short sentence — why merged, not just "similar">
prunings:
  - name: <skill-name>
    reason: <one short sentence — why archived with no merge target>
\`\`\`

Leave a list empty (\`consolidations: []\`) if it has no entries. Do not
omit the structured block.`;

/**
 * Render the full curator prompt, including the candidate list and (when
 * requested) the dry-run banner. The output is meant to be passed to a
 * forked LLM agent as a single user message.
 *
 * @public
 * @stability experimental v0.1
 */
export function renderCuratorPrompt(opts: RenderCuratorPromptOptions): string {
  const parts: string[] = [];
  if (opts.dryRun) parts.push(CURATOR_DRY_RUN_BANNER);
  parts.push(BODY);
  parts.push("## Candidates\n" + renderCandidateTable(opts.candidates));
  if (opts.extraInstructions) parts.push(opts.extraInstructions);
  return parts.join("\n\n");
}

function renderCandidateTable(candidates: readonly SkillUsageRecord[]): string {
  if (candidates.length === 0) return "(no agent-created skills tracked)";
  const lines = ["name | uses | last_used_at | last_patched_at | state"];
  lines.push("---|---|---|---|---");
  for (const c of [...candidates].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    lines.push(
      `${c.name} | ${c.useCount} | ${c.lastUsedAt ?? "-"} | ${c.lastPatchedAt ?? "-"} | ${c.state}`,
    );
  }
  return lines.join("\n");
}
