import { describe, expect, it } from "vitest";
import {
  capabilityViewFromPayload,
  createKindFromPayload,
  createKindFromRest,
  skillNameFromPayload,
} from "../src/lib/layer-payload.js";

describe("layer payload helpers", () => {
  it("parses supported capability views and falls back to all", () => {
    expect(capabilityViewFromPayload({ view: "skills" })).toBe("skills");
    expect(capabilityViewFromPayload({ view: "tools" })).toBe("tools");
    expect(capabilityViewFromPayload({ view: "unknown" })).toBe("all");
    expect(capabilityViewFromPayload(null)).toBe("all");
  });

  it("parses create kinds from slash rest and layer payloads", () => {
    expect(createKindFromRest("skill named helper")).toBe("skill");
    expect(createKindFromRest("mcp server")).toBe("mcp");
    expect(createKindFromRest("nonsense")).toBeUndefined();
    expect(createKindFromPayload({ kind: "agent" })).toBe("agent");
    expect(createKindFromPayload({ kind: "other" })).toBeUndefined();
  });

  it("reads skill names only from valid payloads", () => {
    expect(skillNameFromPayload({ name: "sparkwright-cli-qa" })).toBe(
      "sparkwright-cli-qa",
    );
    expect(skillNameFromPayload({ name: 42 })).toBeUndefined();
    expect(skillNameFromPayload(undefined)).toBeUndefined();
  });
});
