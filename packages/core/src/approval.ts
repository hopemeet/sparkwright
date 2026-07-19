import { createApprovalId } from "./ids.js";
import type { RunId } from "./ids.js";
import type { ApprovalRequest, ApprovalResponse } from "./types.js";
import { isRecord } from "./record-utils.js";

export interface ResolveApprovalOptions {
  timeoutMs?: number;
}

export function createApprovalRequest(input: {
  runId: RunId;
  action: string;
  summary: string;
  details?: Record<string, unknown>;
}): ApprovalRequest {
  return {
    id: createApprovalId(),
    runId: input.runId,
    action: input.action,
    summary: input.summary,
    details: input.details ?? {},
    createdAt: new Date().toISOString(),
    status: "pending",
  };
}

export async function resolveApproval(
  request: ApprovalRequest,
  resolver: (
    request: ApprovalRequest,
  ) => Promise<ApprovalResponse> | ApprovalResponse,
  options: ResolveApprovalOptions = {},
): Promise<ApprovalResponse> {
  const timeoutError = validateApprovalTimeout(options.timeoutMs);
  if (timeoutError) {
    return deniedApprovalResponse(request, timeoutError);
  }

  const response =
    options.timeoutMs === undefined
      ? await resolver(request)
      : await resolveWithTimeout(request, resolver, options.timeoutMs);
  const invalidReason = invalidApprovalResponseReason(request, response);

  if (!invalidReason) return response;

  return deniedApprovalResponse(
    request,
    `Invalid approval response: ${invalidReason}`,
  );
}

function invalidApprovalResponseReason(
  request: ApprovalRequest,
  response: unknown,
): string | undefined {
  if (!isRecord(response)) return "response must be an object.";

  if (response.approvalId !== request.id) {
    return "approvalId does not match the pending request.";
  }

  if (response.decision !== "approved" && response.decision !== "denied") {
    return "decision must be approved or denied.";
  }

  if (response.message !== undefined && typeof response.message !== "string") {
    return "message must be a string when provided.";
  }

  if (
    response.autoApproved !== undefined &&
    typeof response.autoApproved !== "boolean"
  ) {
    return "autoApproved must be a boolean when provided.";
  }

  return undefined;
}

async function resolveWithTimeout(
  request: ApprovalRequest,
  resolver: (
    request: ApprovalRequest,
  ) => Promise<ApprovalResponse> | ApprovalResponse,
  timeoutMs: number,
): Promise<ApprovalResponse> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      Promise.resolve().then(() => resolver(request)),
      new Promise<ApprovalResponse>((resolve) => {
        timeout = setTimeout(() => {
          resolve(
            deniedApprovalResponse(
              request,
              `Approval timed out after ${timeoutMs}ms.`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function validateApprovalTimeout(
  timeoutMs: number | undefined,
): string | undefined {
  if (timeoutMs === undefined) return undefined;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    return "Approval timeoutMs must be a positive integer.";
  }
  return undefined;
}

function deniedApprovalResponse(
  request: ApprovalRequest,
  message: string,
): ApprovalResponse {
  return {
    approvalId: request.id,
    decision: "denied",
    message,
  };
}
