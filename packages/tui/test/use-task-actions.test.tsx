import React from "react";
import { render } from "ink";
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../src/lib/event-type.js";
import { LayerStack } from "../src/state/layer-stack.js";
import { NotificationStore } from "../src/state/notification-store.js";
import type { RunController } from "../src/state/run-controller.js";
import { useTaskActions } from "../src/state/use-task-actions.js";

describe("useTaskActions terminal notifications", () => {
  it("seeds replayed terminals quietly and alerts on a later live transition", async () => {
    const toasts = new NotificationStore();
    const layers = new LayerStack();
    const controller = {} as RunController;
    const instance = render(
      <Harness
        events={[]}
        controller={controller}
        toasts={toasts}
        layers={layers}
      />,
      { patchConsole: false },
    );
    await settle();

    const historic = taskEvent("task.failed", 1, "task_historic");
    instance.rerender(
      <Harness
        events={[historic]}
        controller={controller}
        toasts={toasts}
        layers={layers}
      />,
    );
    await settle();
    expect(toasts.getSnapshot().history).toHaveLength(0);

    const started = taskEvent("task.started", 2, "task_live");
    instance.rerender(
      <Harness
        events={[historic, started]}
        controller={controller}
        toasts={toasts}
        layers={layers}
      />,
    );
    await settle();
    const failed = taskEvent("task.failed", 3, "task_live");
    instance.rerender(
      <Harness
        events={[historic, started, failed]}
        controller={controller}
        toasts={toasts}
        layers={layers}
      />,
    );
    await settle();

    expect(toasts.getSnapshot().history).toHaveLength(1);
    expect(toasts.getSnapshot().history[0]).toMatchObject({
      scope: "BackgroundTask",
      title: "task failed",
      message: "task_live",
    });
    instance.unmount();
  });
});

function Harness(props: {
  events: RunEvent[];
  controller: RunController;
  toasts: NotificationStore;
  layers: LayerStack;
}): null {
  useTaskActions(props);
  return null;
}

function taskEvent(
  type: "task.started" | "task.failed",
  sequence: number,
  taskId: string,
): RunEvent {
  return { type, sequence, payload: { taskId } } as RunEvent;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}
