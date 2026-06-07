export { Client } from "./client.js";
export type { ClientEventMap, CreateClientInternalOptions } from "./client.js";
export type { ClientTransport } from "./transport.js";
export { TypedEmitter } from "./emitter.js";

// Re-export protocol types so consumers only need one import.
export {
  PROTOCOL_VERSION,
  isEvent,
  isRequest,
  isResponse,
} from "@sparkwright/protocol";
export type {
  ApprovalRequestedEventPayload,
  ApprovalResolveRequestPayload,
  EventKind,
  HandshakeRequestPayload,
  HostEvent,
  HostLogEventPayload,
  HostMessage,
  HostReadyEventPayload,
  HostRequest,
  HostResponse,
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
