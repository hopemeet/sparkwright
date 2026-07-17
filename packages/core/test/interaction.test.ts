import { describe, expect, it } from "vitest";
import type { InteractionChannel } from "../src/interaction.js";
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
});
