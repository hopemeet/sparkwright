#!/usr/bin/env node
import { createInterface } from "node:readline";

const pending = new Map();
let eventSequence = 0;
let runSequence = 0;

const input = createInterface({ input: process.stdin });

input.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let request;
  try {
    request = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (request?.envelope !== "request" || typeof request.id !== "string") {
    return;
  }
  void handleRequest(request);
});

input.on("close", () => process.exit(0));

async function handleRequest(request) {
  switch (request.kind) {
    case "handshake": {
      respondOk(request.id, {});
      emit("host.ready", {
        protocolVersion: request.payload?.protocolVersion ?? "2.0",
        host: { name: "sparkwright-approval-queue-test", version: "0.0.0" },
        capabilities: ["approvals"],
      });
      return;
    }
    case "run.start": {
      const runId = `run_approval_queue_${++runSequence}`;
      const sessionId =
        stringValue(request.payload?.sessionId) ??
        `session_approval_queue_${runSequence}`;
      respondOk(request.id, { runId, sessionId });
      startApprovalQueue(runId, sessionId, request.payload);
      return;
    }
    case "approval.resolve": {
      const approvalId = stringValue(request.payload?.approvalId);
      const waiter = approvalId ? pending.get(approvalId) : undefined;
      if (!approvalId || !waiter) {
        respondError(request.id, "not_found", "approval waiter not found");
        return;
      }
      pending.delete(approvalId);
      waiter.resolve({
        decision: request.payload?.decision,
        message: request.payload?.message,
        autoApproved: request.payload?.autoApproved,
      });
      respondOk(request.id, {});
      return;
    }
    case "run.cancel": {
      const runId = stringValue(request.payload?.runId);
      for (const [approvalId, waiter] of pending) {
        if (waiter.runId !== runId) continue;
        pending.delete(approvalId);
        waiter.resolve({ decision: "denied", message: "test run cancelled" });
      }
      respondOk(request.id, {});
      return;
    }
    case "workflow.list": {
      respondOk(request.id, { workflows: [] });
      return;
    }
    default:
      respondError(
        request.id,
        "not_found",
        `approval queue test adapter does not implement ${request.kind}`,
      );
  }
}

function startApprovalQueue(runId, sessionId, payload) {
  const workspaceRoot =
    stringValue(process.env.SPARKWRIGHT_TEST_WORKSPACE) ?? process.cwd();
  const requests = [
    {
      approvalId: `${runId}_shell`,
      action: "tool.execute",
      summary: "Run the first harmless approval-queue command",
      details: {
        toolName: "bash",
        arguments: {
          command: "printf first-approval-waiter",
          cwd: workspaceRoot,
        },
        reason: "Verify the first card while a second Host waiter is pending.",
        policy: {
          reason: "Concurrent approval queue PTY fixture.",
          metadata: { risk: "risky" },
        },
      },
    },
    {
      approvalId: `${runId}_write`,
      action: "workspace.write",
      summary: "Review the second harmless approval-queue diff",
      details: {
        path: "README.md",
        diff: [
          "--- README.md",
          "+++ README.md",
          "@@ -1 +1 @@",
          "-# Approval queue fixture",
          "+# Approval queue fixture (reviewed)",
          "",
        ].join("\n"),
        reason: "Verify queue advancement after resolving the first waiter.",
        policy: {
          reason: "Concurrent approval queue PTY fixture.",
          metadata: { risk: "medium" },
        },
      },
    },
  ];

  const waiters = requests.map((approval) => {
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    pending.set(approval.approvalId, { runId, resolve });
    return promise;
  });

  // Emit only after both deferreds are installed. The adapter's invariant is
  // that the client can observe 1 of N while all N Host waiters are live.
  for (const approval of requests) {
    emit("approval.requested", { runId, ...approval });
  }

  void Promise.all(waiters).then((resolutions) => {
    emit("run.completed", {
      runId,
      state: "completed",
      stopReason: "final_answer",
      message: `Resolved ${resolutions.length} concurrent approval waiters for ${stringValue(payload?.goal) ?? sessionId}.`,
      assessment: cleanAssessment(runId),
    });
  });
}

function cleanAssessment(runId) {
  const runAssessment = {
    schemaVersion: "run-assessment.v1",
    health: "clean",
    issues: [],
    verification: [],
  };
  return {
    schemaVersion: "execution-assessment.v1",
    health: "clean",
    issues: [],
    verification: [],
    episodeCount: 1,
    rootRunId: runId,
    finalRunId: runId,
    episodes: [{ runId, assessment: runAssessment }],
  };
}

function respondOk(id, result) {
  send({
    envelope: "response",
    id,
    ok: true,
    timestamp: now(),
    result,
  });
}

function respondError(id, code, message) {
  send({
    envelope: "response",
    id,
    ok: false,
    timestamp: now(),
    error: { code, message },
  });
}

function emit(kind, payload) {
  send({
    envelope: "event",
    id: `evt_approval_queue_${++eventSequence}`,
    kind,
    timestamp: now(),
    payload,
  });
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function stringValue(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function now() {
  return new Date().toISOString();
}
