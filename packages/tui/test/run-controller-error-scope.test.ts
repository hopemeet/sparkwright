import { describe, expect, it, vi } from "vitest";
import type { Client } from "@sparkwright/sdk-node";
import { EventStore } from "../src/state/event-store.js";
import { NotificationStore } from "../src/state/notification-store.js";
import { RunController } from "../src/state/run-controller.js";

describe("RunController UI error scope", () => {
  it("keeps a panel RPC failure out of the main run terminal status", async () => {
    const store = new EventStore();
    const signals = new NotificationStore();
    const controller = new RunController({
      workspaceRoot: "/workspace/project",
      store,
      signals,
    });
    store.setStatus("running");
    const client = {
      listSessions: vi.fn().mockRejectedValue(new Error("panel offline")),
    } as unknown as Client;
    (
      controller as unknown as { ensureClient(): Promise<Client> }
    ).ensureClient = async () => client;

    expect(await controller.listSessions()).toEqual([]);
    expect(store.getSnapshot()).toMatchObject({
      status: "running",
      lastError: null,
      lastDiagnostic: null,
    });
    expect(signals.getSnapshot().history.at(-1)).toMatchObject({
      scope: "PanelLoadFailure",
      title: "session list failed",
      message: "panel offline",
    });
  });

  it("returns a distinct failed-action result without changing run status", async () => {
    const store = new EventStore();
    const signals = new NotificationStore();
    const controller = new RunController({
      workspaceRoot: "/workspace/project",
      store,
      signals,
    });
    store.setStatus("running");
    const client = {
      stopTask: vi.fn().mockRejectedValue(new Error("control unavailable")),
    } as unknown as Client;
    (
      controller as unknown as { ensureClient(): Promise<Client> }
    ).ensureClient = async () => client;

    expect(await controller.stopTask("task_1")).toBeNull();
    expect(store.getSnapshot().status).toBe("running");
    expect(signals.getSnapshot().history.at(-1)).toMatchObject({
      scope: "ActionFailure",
      title: "task stop failed",
      message: "control unavailable",
    });
  });
});
