import { describe, expect, it } from "vitest";
import {
  approvalResolverFromChannel,
  channelFromApprovalResolver,
  createInteractionNotification,
  createInteractionQuestionRequest,
  type InteractionChannel,
} from "../src/interaction.js";
import { createApprovalRequest } from "../src/approval.js";
import { createRunId } from "../src/ids.js";

describe("InteractionChannel", () => {
  it("adapts a channel.approve to an ApprovalResolver", async () => {
    const runId = createRunId();
    const channel: InteractionChannel = {
      approve: (req) => ({
        approvalId: req.id,
        decision: "approved",
      }),
    };

    const resolver = approvalResolverFromChannel(channel);
    expect(resolver).toBeDefined();

    const request = createApprovalRequest({
      runId,
      action: "fs.write",
      summary: "Write README.md",
    });
    const response = await resolver!(request);
    expect(response.decision).toBe("approved");
    expect(response.approvalId).toBe(request.id);
  });

  it("returns undefined when channel has no approve", () => {
    expect(approvalResolverFromChannel({})).toBeUndefined();
  });

  it("round-trips a legacy ApprovalResolver into a channel", async () => {
    const runId = createRunId();
    const channel = channelFromApprovalResolver((req) => ({
      approvalId: req.id,
      decision: "denied",
      message: "policy says no",
    }));
    const request = createApprovalRequest({
      runId,
      action: "shell.exec",
      summary: "rm -rf",
    });
    const response = await channel.approve!(request);
    expect(response.decision).toBe("denied");
  });

  it("creates question / notification factories with stable shapes", () => {
    const runId = createRunId();
    const question = createInteractionQuestionRequest({
      runId,
      prompt: "Pick a branch",
      choices: [{ id: "main", label: "main" }],
    });
    expect(question.runId).toBe(runId);
    expect(question.choices).toHaveLength(1);
    expect(question.id).toMatch(/^intq_/);

    const note = createInteractionNotification({
      runId,
      level: "warn",
      message: "Approaching token budget",
    });
    expect(note.level).toBe("warn");
    expect(note.id).toMatch(/^intn_/);
  });
});
