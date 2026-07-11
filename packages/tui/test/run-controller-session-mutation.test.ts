import { describe, expect, it } from "vitest";
import { EventStore } from "../src/state/event-store.js";
import { RunController } from "../src/state/run-controller.js";

describe("RunController active execution session guards", () => {
  it("rejects new, switch, and fork while the main execution is active", async () => {
    const store = new EventStore();
    const controller = new RunController({
      workspaceRoot: "/workspace/project",
      initialSessionId: "session_main",
      store,
    });
    const internal = controller as unknown as { activeRunId: string | null };
    internal.activeRunId = "run_active";

    expect(controller.newSession()).toBeNull();
    expect(await controller.switchSession("session_other")).toBe(false);
    expect(await controller.forkSession("session_main")).toBeNull();
    expect(controller.getSessionId()).toBe("session_main");

    internal.activeRunId = null;
    const next = controller.newSession();
    expect(next).toMatch(/^session_tui_/);
    expect(controller.getSessionId()).toBe(next);
  });

  it("rejects session mutation while main run startup is in flight", () => {
    const store = new EventStore();
    const controller = new RunController({
      workspaceRoot: "/workspace/project",
      initialSessionId: "session_main",
      store,
    });
    const internal = controller as unknown as { startingMainRun: boolean };
    internal.startingMainRun = true;

    expect(controller.setSession("session_other")).toBe(false);
    expect(controller.getSessionId()).toBe("session_main");
  });
});
