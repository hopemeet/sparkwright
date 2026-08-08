import { describe, expect, it, vi } from "vitest";
import type { Client } from "@sparkwright/sdk-node";
import type { HostMessage } from "@sparkwright/protocol";
import { EventStore } from "../src/state/event-store.js";
import {
  RunController,
  type HostTaskUpdatedEvent,
} from "../src/state/run-controller.js";

describe("RunController task lifecycle events", () => {
  it("forwards task.updated independently from the Core run-event store", () => {
    const store = new EventStore();
    const controller = new RunController({
      workspaceRoot: "/workspace/project",
      initialSessionId: "session_task_events",
      store,
    });
    const handlers = new Map<string, (event: never) => void>();
    const client = {
      on: vi.fn((kind: string, handler: (event: never) => void) => {
        handlers.set(kind, handler);
      }),
    } as unknown as Client;
    (
      controller as unknown as {
        attachListeners(client: Client): void;
      }
    ).attachListeners(client);
    const updates: HostTaskUpdatedEvent[] = [];
    const unsubscribe = controller.subscribeTaskUpdates((event) =>
      updates.push(event),
    );
    const event = taskUpdatedEvent();

    handlers.get("task.updated")!(event as never);

    expect(updates).toEqual([event]);
    expect(store.getSnapshot().events).toEqual([]);

    unsubscribe();
    handlers.get("task.updated")!(event as never);
    expect(updates).toHaveLength(1);
  });
});

function taskUpdatedEvent(): Extract<
  HostMessage,
  { envelope: "event"; kind: "task.updated" }
> {
  return {
    envelope: "event",
    id: "evt_task_1",
    kind: "task.updated",
    timestamp: "2026-07-23T00:00:03.000Z",
    payload: {
      taskId: "task_1",
      parentRunId: "run_1",
      sessionId: "session_task_events",
      transition: "terminal",
      kind: "agent",
      completionPolicy: "detached",
      awaited: false,
      status: "completed",
      createdAt: "2026-07-23T00:00:00.000Z",
      completedAt: "2026-07-23T00:00:02.000Z",
      resultSummary: "done",
      outputRef: { method: "task.output", taskId: "task_1" },
    },
  };
}
