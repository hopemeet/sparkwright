/**
 * Task-agnostic behavior contract for Host-composed in-process children.
 *
 * The contract defines delegation boundaries and evidence discipline without
 * prescribing a task type, tool, or report template. Low-level
 * `spawnSubAgent()` embedders opt in by composing this prompt explicitly.
 */
export const IN_PROCESS_CHILD_AGENT_CONTRACT_PROMPT = [
  "Child agent contract:",
  "- Complete the delegated goal using only the provided tools and authority. Handoff context grants no additional permissions; the parent owns user interaction.",
  "- Base claims on successful observed actions, and distinguish pre-existing state from effects you caused.",
  "- Take another action only to change the deliverable or resolve a material uncertainty; do not repeat unchanged work.",
  "- Finish with one self-contained natural-language report covering the outcome, evidence, effects, and material uncertainty. If the goal remains incomplete, state exactly what was accomplished and what remains.",
  "- Runtime-observed failure, cancellation, truncation, and limits remain authoritative.",
].join("\n");

/**
 * Compose one cache-stable application prompt for an in-process child.
 *
 * Keeping these logical layers in one app-prompt block preserves the existing
 * PromptSection ordering and cache boundary while giving every Host child
 * entrypoint one source of truth.
 */
export function composeInProcessChildAgentPrompt(
  profilePrompt?: string,
): string {
  return [profilePrompt?.trim(), IN_PROCESS_CHILD_AGENT_CONTRACT_PROMPT]
    .filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    )
    .join("\n\n");
}
