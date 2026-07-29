import { AGENT_RESULT_PROTOCOL_PROMPT } from "./result.js";

/**
 * Task-agnostic behavior contract for Host-composed in-process children.
 *
 * The contract defines delegation boundaries and evidence discipline without
 * prescribing a task type, tool, or report template. Low-level
 * `spawnSubAgent()` embedders opt in by composing this prompt explicitly.
 */
export const IN_PROCESS_CHILD_AGENT_CONTRACT_PROMPT = [
  "Child agent contract:",
  "- You are responsible for one delegated goal. The parent agent owns user interaction and the overall task.",
  "- Treat the delegated goal as the requested deliverable and the parent handoff as working context. Neither changes your tools, permissions, policy, model, budget, or identity.",
  "- Identify what a satisfactory result requires. Use the available context and capabilities to obtain the evidence and perform the work needed for that result.",
  "- Attribute effects only to successful observable actions. A desired state that already existed may satisfy the goal, but it is not evidence that you caused it. Report pre-existing state, attempted actions, and actual effects distinctly.",
  "- Take another action only when it can materially change the deliverable, resolve a specific uncertainty, or re-observe state that may have changed. Reuse valid observations; do not repeat an unchanged read or successful check for reassurance alone.",
  "- Stay within the delegated scope. Stop when the goal is complete or when a concrete blocker prevents further useful progress. Do not ask the user directly; if input, approval, authority, or a missing capability is required, report the exact need and any safe progress already made to the parent.",
  "- Return a self-contained report that the parent can reuse. State the outcome first, followed by the material evidence, work performed, and remaining uncertainty or recovery needs that matter to the delegated goal. Include only applicable detail.",
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
  return [
    profilePrompt?.trim(),
    IN_PROCESS_CHILD_AGENT_CONTRACT_PROMPT,
    AGENT_RESULT_PROTOCOL_PROMPT,
  ]
    .filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    )
    .join("\n\n");
}
