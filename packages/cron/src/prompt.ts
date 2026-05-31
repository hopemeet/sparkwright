import { createDefaultContentPolicy } from "@sparkwright/core";
import { loadSkills, type SkillDefinition } from "@sparkwright/skills";
import type { CronJob } from "./model.js";

export interface AssemblePromptOptions {
  skillRoots?: string[];
  now?: Date;
}

export async function assembleCronPrompt(
  job: CronJob,
  options: AssemblePromptOptions = {},
): Promise<string> {
  const skills = await loadNamedSkills(job.skills, options.skillRoots ?? []);
  const parts = [
    "You are running as a scheduled SparkWright cron job.",
    "",
    `Job id: ${job.id}`,
    `Job name: ${job.name}`,
    `Schedule: ${job.scheduleDisplay}`,
    `Run time: ${(options.now ?? new Date()).toISOString()}`,
    job.workspace ? `Workspace: ${job.workspace}` : undefined,
    "",
    "Cron execution rules:",
    "- Treat this prompt as a fresh session with no prior conversation history.",
    "- Complete the scheduled task directly.",
    "- Do not create, update, or remove cron jobs from inside this run.",
    "- If the task is complete but no user-visible delivery is needed, start the final answer with [SILENT].",
    "",
    skills.length > 0 ? renderSkills(skills) : undefined,
    "Scheduled task:",
    job.prompt,
  ].filter((part): part is string => typeof part === "string");

  const prompt = parts.join("\n");
  scanAssembledPrompt(prompt);
  return prompt;
}

export function scanAssembledPrompt(prompt: string): void {
  const verdict = createDefaultContentPolicy().evaluate(prompt, "unknown");
  if (!verdict.allowed) {
    const summary = verdict.blocks
      .map((finding) => `${finding.ruleId}: ${finding.reason}`)
      .join("; ");
    throw new Error(`cron prompt blocked by content policy: ${summary}`);
  }
}

async function loadNamedSkills(
  names: readonly string[],
  roots: readonly string[],
): Promise<SkillDefinition[]> {
  if (names.length === 0) return [];
  if (roots.length === 0) {
    throw new Error(
      "cron job references skills, but no skill roots were configured",
    );
  }
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const skills = await loadSkills([...roots]);
  const matches = skills.filter((skill) =>
    wanted.has(skill.name.toLowerCase()),
  );
  const found = new Set(matches.map((skill) => skill.name.toLowerCase()));
  const missing = [...wanted].filter((name) => !found.has(name));
  if (missing.length > 0) {
    throw new Error(
      `cron job references missing skill(s): ${missing.join(", ")}`,
    );
  }
  return matches;
}

function renderSkills(skills: readonly SkillDefinition[]): string {
  return [
    "Relevant skills:",
    ...skills.map((skill) =>
      [`## ${skill.name}`, skill.description, "", skill.body].join("\n"),
    ),
    "",
  ].join("\n");
}
