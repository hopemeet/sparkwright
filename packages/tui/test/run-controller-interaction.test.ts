import { describe, expect, it, vi } from "vitest";
import type { Client } from "@sparkwright/sdk-node";
import { EventStore } from "../src/state/event-store.js";
import { RunController } from "../src/state/run-controller.js";

describe("RunController live interaction", () => {
  it.each(["steer", "follow_up"] as const)(
    "submits %s messages with a stable command identity",
    async (mode) => {
      const store = new EventStore();
      const injectRunMessage = vi.fn(
        async (payload: {
          commandId: string;
          mode: "steer" | "follow_up";
        }) => ({
          commandId: payload.commandId,
          mode: payload.mode,
          status: "queued" as const,
        }),
      );
      const controller = new RunController({
        workspaceRoot: "/workspace/project",
        initialSessionId: "session_main",
        store,
      });
      const internal = controller as unknown as {
        activeRunId: string | null;
        client: Client | null;
      };
      internal.activeRunId = "run_active";
      internal.client = { injectRunMessage } as unknown as Client;

      const commandId =
        mode === "steer"
          ? await controller.steer("change direction")
          : await controller.followUp("do this next");

      expect(commandId).toMatch(/^command_tui_/);
      expect(injectRunMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run_active",
          commandId,
          mode,
          content: mode === "steer" ? "change direction" : "do this next",
        }),
      );
    },
  );
});
