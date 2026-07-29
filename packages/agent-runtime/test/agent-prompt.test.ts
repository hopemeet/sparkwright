import { describe, expect, it } from "vitest";
import {
  composeInProcessChildAgentPrompt,
  IN_PROCESS_CHILD_AGENT_CONTRACT_PROMPT,
} from "../src/agents/prompt.js";
import { AGENT_RESULT_PROTOCOL_PROMPT } from "../src/agents/result.js";

describe("in-process child agent prompt", () => {
  it("composes the universal contract and result protocol without a profile", () => {
    expect(composeInProcessChildAgentPrompt()).toBe(
      [
        IN_PROCESS_CHILD_AGENT_CONTRACT_PROMPT,
        AGENT_RESULT_PROTOCOL_PROMPT,
      ].join("\n\n"),
    );
  });

  it("places a configured profile before the shared child layers exactly once", () => {
    const prompt = composeInProcessChildAgentPrompt(
      "  You are a domain specialist.  ",
    );

    expect(prompt).toBe(
      [
        "You are a domain specialist.",
        IN_PROCESS_CHILD_AGENT_CONTRACT_PROMPT,
        AGENT_RESULT_PROTOCOL_PROMPT,
      ].join("\n\n"),
    );
    expect(prompt.match(/Child agent contract:/g)).toHaveLength(1);
    expect(prompt.match(/When the delegated goal is complete/g)).toHaveLength(
      1,
    );
  });

  it("keeps the shared contract task-agnostic and evidence-based", () => {
    expect(IN_PROCESS_CHILD_AGENT_CONTRACT_PROMPT).toContain(
      "Attribute effects only to successful observable actions",
    );
    expect(IN_PROCESS_CHILD_AGENT_CONTRACT_PROMPT).toContain(
      "A desired state that already existed",
    );
    expect(IN_PROCESS_CHILD_AGENT_CONTRACT_PROMPT).toContain(
      "do not repeat an unchanged read or successful check",
    );
    expect(IN_PROCESS_CHILD_AGENT_CONTRACT_PROMPT).toContain(
      "Do not ask the user directly",
    );
    expect(IN_PROCESS_CHILD_AGENT_CONTRACT_PROMPT).not.toMatch(
      /\b(file|test|lint|command)\b/i,
    );
  });
});
