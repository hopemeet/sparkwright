// =============================================================================
// AI maintenance note
//
// InteractionChannel is the single outbound approval boundary from the
// runtime to a user-facing embedder. Free-form questions and notifications
// require a real product surface before widening this contract.
//
// See docs/EXTENSION_INTERFACES.md "Interaction Channel".
// =============================================================================

import type { ApprovalRequest, ApprovalResponse } from "./types.js";

export interface InteractionChannel {
  approve(
    request: ApprovalRequest,
  ): Promise<ApprovalResponse> | ApprovalResponse;
}
