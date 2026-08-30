export { Client } from "./client.js";
export type { ClientEventMap, CreateClientInternalOptions } from "./client.js";
export type { ClientTransport } from "./transport.js";
export { TypedEmitter } from "./emitter.js";

// Re-export protocol types so consumers only need one import.
export {
  PROTOCOL_VERSION,
  getRunFailure,
  isEvent,
  isProtocolErrorCode,
  isRequest,
  isResponse,
  runFailureMessage,
} from "@sparkwright/protocol";
export type {
  ApprovalRequestedEventPayload,
  ApprovalResolveRequestPayload,
  EventKind,
  ExecutionAssessmentPayload,
  HandshakeRequestPayload,
  HostEvent,
  HostLogEventPayload,
  HostMessage,
  HostReadyEventPayload,
  HostRequest,
  HostResponse,
  ImApprovalResolveRequestPayload,
  ImBindRequestPayload,
  ImCancelRequestPayload,
  ImDelivery,
  ImDeliveryAckRequestPayload,
  ImInspectRequestPayload,
  ImMessageRequestPayload,
  ImSessionPermission,
  ImSubjectClaims,
  ImSubscribeRequestPayload,
  ProtocolError,
  ProtocolErrorCode,
  RequestKind,
  ResponseResults,
  RunCancelRequestPayload,
  RunInjectMessageRequestPayload,
  RunResumeRequestPayload,
  RunCompletedEventPayload,
  RunEventPayload,
  RunFailedEventPayload,
  RunStartRequestPayload,
  SessionListRequestPayload,
} from "@sparkwright/protocol";
