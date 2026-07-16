import { describe, expect, it } from "vitest";
import {
  createInteractionNotification,
  createInteractionQuestionRequest,
  type InteractionChannel,
} from "../src/interaction.js";
import { createApprovalRequest } from "../src/approval.js";
import { createRunId } from "../src/ids.js";

describe("InteractionChannel", () => {
  it("routes approvals through channel.approve", async () => {
    const runId = createRunId();
    const channel: InteractionChannel = {
      approve: (req) => ({
        approvalId: req.id,
        decision: "approved",
      }),
    };

    const request = createApprovalRequest({
      runId,
      action: "fs.write",
      summary: "Write README.md",
    });
    const response = await channel.approve!(request);
    expect(response.decision).toBe("approved");
    expect(response.approvalId).toBe(request.id);
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
