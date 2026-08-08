import type { CreateCapabilityKind } from "./create-capability.js";

export type CapabilityView =
  | "all"
  | "tools"
  | "skills"
  | "agents"
  | "mcp"
  | "cron";

export function skillNameFromPayload(payload: unknown): string | undefined {
  if (
    payload &&
    typeof payload === "object" &&
    "name" in payload &&
    typeof payload.name === "string"
  ) {
    return payload.name;
  }
  return undefined;
}

export function createKindFromRest(
  rest: string,
): CreateCapabilityKind | undefined {
  const value = rest.trim().toLowerCase().split(/\s+/u)[0];
  return createKindFromString(value);
}

export function createKindFromPayload(
  payload: unknown,
): CreateCapabilityKind | undefined {
  if (
    payload &&
    typeof payload === "object" &&
    "kind" in payload &&
    typeof payload.kind === "string"
  ) {
    return createKindFromString(payload.kind);
  }
  return undefined;
}

export function capabilityViewFromPayload(payload: unknown): CapabilityView {
  if (
    payload &&
    typeof payload === "object" &&
    "view" in payload &&
    typeof payload.view === "string" &&
    isCapabilityView(payload.view)
  ) {
    return payload.view;
  }
  return "all";
}

function createKindFromString(value: string): CreateCapabilityKind | undefined {
  switch (value) {
    case "skill":
    case "agent":
    case "cron":
    case "command":
    case "mcp":
      return value;
    default:
      return undefined;
  }
}

function isCapabilityView(value: string): value is CapabilityView {
  return (
    value === "all" ||
    value === "tools" ||
    value === "skills" ||
    value === "agents" ||
    value === "mcp" ||
    value === "cron"
  );
}
