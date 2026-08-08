import { describe, expect, it } from "vitest";
import {
  composeInProcessChildAgentPrompt,
  IN_PROCESS_CHILD_AGENT_CONTRACT_PROMPT,
} from "../src/agents/prompt.js";

describe("in-process child agent prompt", () => {
  it("uses one universal contract without a profile", () => {
    expect(composeInProcessChildAgentPrompt()).toBe(
      IN_PROCESS_CHILD_AGENT_CONTRACT_PROMPT,
    );
  });

  it("places a configured profile before the shared child contract exactly once", () => {
    const prompt = composeInProcessChildAgentPrompt(
      "  You are a domain specialist.  ",
    );

    expect(prompt).toBe(
      [
        "You are a domain specialist.",
        IN_PROCESS_CHILD_AGENT_CONTRACT_PROMPT,
      ].join("\n\n"),
    );
    expect(prompt.match(/Child agent contract:/g)).toHaveLength(1);
    expect(prompt.match(/Finish with one self-contained/g)).toHaveLength(1);
  });

  it("keeps the shared contract task-agnostic and evidence-based", () => {
    expect(IN_PROCESS_CHILD_AGENT_CONTRACT_PROMPT).toContain(
      "Base claims on successful observed actions",
    );
    expect(IN_PROCESS_CHILD_AGENT_CONTRACT_PROMPT).toContain(
      "distinguish pre-existing state",
    );
    expect(IN_PROCESS_CHILD_AGENT_CONTRACT_PROMPT).toContain(
      "do not repeat unchanged work",
    );
    expect(IN_PROCESS_CHILD_AGENT_CONTRACT_PROMPT).toContain(
      "parent owns user interaction",
    );
    expect(IN_PROCESS_CHILD_AGENT_CONTRACT_PROMPT).toContain(
      "If the goal remains incomplete",
    );
    expect(IN_PROCESS_CHILD_AGENT_CONTRACT_PROMPT).not.toMatch(
      /\b(file|test|lint|command)\b/i,
    );
  });
});
