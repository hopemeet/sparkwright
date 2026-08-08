import { describe, expect, it } from "vitest";
import { presentationPolicy } from "../src/lib/ui-signal.js";

describe("TUI presentation policy", () => {
  it("keeps progress in status and main failures in persistent diagnostics", () => {
    expect(
      presentationPolicy({ kind: "progress", scope: "Composer" }),
    ).toMatchObject({
      persistence: "transient",
      attention: "none",
      presentation: ["status"],
    });
    for (const scope of ["RunFailure", "ConnectionFailure"] as const) {
      expect(presentationPolicy({ kind: "error", scope })).toMatchObject({
        persistence: "until-resolved",
        attention: "blurred",
        presentation: ["inline", "history"],
      });
    }
  });

  it("uses a short toast for ordinary action feedback", () => {
    expect(
      presentationPolicy({ kind: "success", scope: "ActionSuccess" }),
    ).toMatchObject({
      persistence: "transient",
      attention: "none",
      presentation: ["toast", "history"],
    });
  });

  it("keeps quiet background terminals in status but alerts on failure or action", () => {
    for (const kind of ["success", "warning"] as const) {
      expect(
        presentationPolicy({ kind, scope: "BackgroundTask" }),
      ).toMatchObject({
        attention: "none",
        presentation: ["status", "history"],
      });
    }
    for (const kind of ["error", "action-required"] as const) {
      expect(
        presentationPolicy({ kind, scope: "BackgroundTask" }),
      ).toMatchObject({
        attention: "blurred",
        presentation: ["status", "toast", "history"],
      });
    }
  });

  it("routes approval and config to their dedicated surfaces", () => {
    expect(
      presentationPolicy({ kind: "blocking", scope: "Approval" }),
    ).toMatchObject({
      persistence: "until-resolved",
      attention: "blurred",
      presentation: ["action", "history"],
    });
    expect(
      presentationPolicy({ kind: "error", scope: "Config" }),
    ).toMatchObject({
      persistence: "until-resolved",
      attention: "none",
      presentation: ["status", "history"],
    });
  });

  it("keeps inbox actions persistent without duplicating attention or toast", () => {
    expect(
      presentationPolicy({ kind: "action-required", scope: "ActionInbox" }),
    ).toMatchObject({
      persistence: "until-resolved",
      attention: "none",
      presentation: ["action", "history"],
    });
  });
});
