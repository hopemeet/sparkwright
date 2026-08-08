import { describe, expect, it } from "vitest";
import {
  summarizeTaskActivity,
  summarizeUnreadTaskActivity,
} from "../src/lib/task-activity.js";
import type { RunEvent } from "../src/lib/event-type.js";

function terminal(
  type: "task.completed" | "task.failed" | "task.cancelled",
  sequence: number,
  taskId: string,
  completionPolicy?: "inline" | "awaited" | "detached",
): RunEvent {
  return {
    type,
    sequence,
    payload: {
      taskId,
      ...(completionPolicy ? { completionPolicy } : {}),
    },
  } as RunEvent;
}

describe("task activity", () => {
  it("keeps unread cancelled tasks separate from failures", () => {
    const activity = summarizeTaskActivity([
      terminal("task.completed", 1, "task_done"),
      terminal("task.failed", 2, "task_failed"),
      terminal("task.cancelled", 3, "task_cancelled"),
    ]);

    expect(summarizeUnreadTaskActivity(activity.tasks, 0)).toEqual({
      total: 3,
      completed: 1,
      failed: 1,
      cancelled: 1,
    });
  });

  it("keeps inline and awaited success quiet while surfacing detached terminals", () => {
    const activity = summarizeTaskActivity([
      terminal("task.completed", 1, "task_inline", "inline"),
      terminal("task.completed", 2, "task_awaited", "awaited"),
      terminal("task.completed", 3, "task_detached", "detached"),
      terminal("task.failed", 4, "task_failed", "inline"),
      terminal("task.cancelled", 5, "task_cancelled", "awaited"),
    ]);

    expect(summarizeUnreadTaskActivity(activity.tasks, 0)).toEqual({
      total: 3,
      completed: 1,
      failed: 1,
      cancelled: 1,
    });
  });

  it("recovers inline completion policy from the task_create receipt", () => {
    const activity = summarizeTaskActivity([
      terminal("task.completed", 156, "task_inline"),
      {
        type: "tool.completed",
        sequence: 157,
        payload: {
          toolName: "task_create",
          output: {
            taskId: "task_inline",
            actualMode: "inline",
            status: "completed",
          },
        },
      } as RunEvent,
    ]);

    expect(activity.tasks[0]?.completionPolicy).toBe("inline");
    expect(summarizeUnreadTaskActivity(activity.tasks, 0)).toEqual({
      total: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    });
  });
});
