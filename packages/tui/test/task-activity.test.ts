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
): RunEvent {
  return { type, sequence, payload: { taskId } } as RunEvent;
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
});
