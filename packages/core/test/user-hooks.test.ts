import { describe, expect, it } from "vitest";
import { EventLog } from "../src/events.js";
import {
  bindUserHooks,
  type UserHookRunner,
  type UserHookOutcome,
} from "../src/user-hooks.js";
import { createRunId } from "../src/ids.js";

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("bindUserHooks", () => {
  it("invokes the runner for matching triggers and records completion", async () => {
    const runId = createRunId();
    const events = new EventLog(runId);
    const calls: string[] = [];

    const runner: UserHookRunner = {
      triggers: () => ["tool.completed"],
      invoke: async (invocation): Promise<UserHookOutcome> => {
        calls.push(invocation.trigger);
        return { status: "ok", durationMs: 5, output: "ok" };
      },
    };

    bindUserHooks({ events, runner });
    events.emit("tool.completed", { toolCallId: "x" });
    events.emit("model.completed", { tokens: 1 });
    await flush();

    expect(calls).toEqual(["tool.completed"]);
    const types = events.all().map((entry) => entry.type);
    expect(types).toContain("user_hook.invoked");
    expect(types).toContain("user_hook.completed");
    expect(types).not.toContain("user_hook.failed");
  });

  it("emits user_hook.failed when the runner throws", async () => {
    const runId = createRunId();
    const events = new EventLog(runId);
    const runner: UserHookRunner = {
      triggers: () => ["run.completed"],
      invoke: () => {
        throw new Error("boom");
      },
    };

    bindUserHooks({ events, runner });
    events.emit("run.completed", {});
    await flush();

    const failed = events
      .all()
      .find((entry) => entry.type === "user_hook.failed");
    expect(failed).toBeDefined();
    expect(
      (failed?.payload as { error: { message: string } }).error.message,
    ).toBe("boom");
  });

  it("emits skipped completion when outcome is skipped", async () => {
    const runId = createRunId();
    const events = new EventLog(runId);
    const runner: UserHookRunner = {
      triggers: () => new Set(["approval.requested"]),
      invoke: () => ({ status: "skipped", reason: "not-configured" }),
    };

    bindUserHooks({ events, runner });
    events.emit("approval.requested", {});
    await flush();

    const done = events
      .all()
      .find((entry) => entry.type === "user_hook.completed");
    expect(done).toBeDefined();
    expect((done?.payload as { skipped: boolean }).skipped).toBe(true);
  });

  it("replays past events to a late-bound runner so run.started is not missed", async () => {
    const runId = createRunId();
    const events = new EventLog(runId);
    events.emit("run.started", { goal: "x" });

    const seen: string[] = [];
    const runner: UserHookRunner = {
      triggers: () => ["run.started"],
      invoke: async (inv): Promise<UserHookOutcome> => {
        seen.push(inv.trigger);
        return { status: "ok", durationMs: 0 };
      },
    };

    bindUserHooks({ events, runner });
    await flush();

    expect(seen).toEqual(["run.started"]);
  });

  it("skips non-managed invocations when allowManagedOnly is set", async () => {
    const runId = createRunId();
    const events = new EventLog(runId);
    let invokeCount = 0;
    const runner: UserHookRunner = {
      triggers: () => ["tool.completed"],
      invoke: () => {
        invokeCount += 1;
        return { status: "ok", durationMs: 0 };
      },
    };

    bindUserHooks({
      events,
      runner,
      allowManagedOnly: true,
      resolveDescriptor: (trigger) => ({
        hookId: `${trigger}:user-defined`,
        hookName: trigger,
        source: "project",
      }),
    });
    events.emit("tool.completed", { toolCallId: "a" });
    await flush();

    expect(invokeCount).toBe(0);
    const types = events.all().map((e) => e.type);
    expect(types).not.toContain("user_hook.invoked");
  });

  it("reportProgress emits user_hook.progress with the chunk payload", async () => {
    const runId = createRunId();
    const events = new EventLog(runId);
    const runner: UserHookRunner = {
      triggers: () => ["tool.completed"],
      invoke: async (inv): Promise<UserHookOutcome> => {
        inv.reportProgress({ stdout: "line 1\n", output: "line 1\n" });
        inv.reportProgress({ stdout: "line 2\n", output: "line 2\n" });
        return { status: "ok", durationMs: 1 };
      },
    };

    bindUserHooks({ events, runner });
    events.emit("tool.completed", { toolCallId: "x" });
    await flush();

    const progress = events
      .all()
      .filter((e) => e.type === "user_hook.progress");
    expect(progress).toHaveLength(2);
    expect((progress[0]!.payload as { stdout: string }).stdout).toBe(
      "line 1\n",
    );
  });

  it("forwards the run-level abort signal into invocations", async () => {
    const runId = createRunId();
    const events = new EventLog(runId);
    const controller = new AbortController();
    const captured: AbortSignal[] = [];
    const runner: UserHookRunner = {
      triggers: () => ["tool.completed"],
      invoke: async (inv): Promise<UserHookOutcome> => {
        captured.push(inv.signal);
        return { status: "ok", durationMs: 0 };
      },
    };

    bindUserHooks({ events, runner, signal: controller.signal });
    events.emit("tool.completed", { toolCallId: "x" });
    await flush();

    expect(captured[0]).toBe(controller.signal);
  });
});
