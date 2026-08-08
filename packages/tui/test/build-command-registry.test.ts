import { describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../src/lib/keybindings.js";
import { EventStore } from "../src/state/event-store.js";
import { LayerStack } from "../src/state/layer-stack.js";
import { NotificationStore } from "../src/state/notification-store.js";
import { RunController } from "../src/state/run-controller.js";
import { buildCommandRegistry } from "../src/state/build-command-registry.js";

describe("built-in command surfaces", () => {
  it("preserves independent capability and activity entrypoints", () => {
    const store = new EventStore();
    const layers = new LayerStack();
    const toasts = new NotificationStore();
    const controller = new RunController({
      workspaceRoot: "/workspace/project",
      store,
      signals: toasts,
    });
    const deps = {
      bindings: DEFAULTS,
      layers,
      store,
      controller,
      toasts,
      exit: vi.fn(),
      skillActions: {},
      capActions: {},
      sessionActions: {},
      taskActions: {},
      workflowActions: {},
      projectCommands: [],
      runProjectCommand: vi.fn(),
    } as unknown as Parameters<typeof buildCommandRegistry>[0];
    const registry = buildCommandRegistry(deps);

    for (const name of [
      "tools",
      "skills",
      "agents",
      "mcp",
      "cron",
      "events",
      "tasks",
      "workflow",
      "notifications",
    ]) {
      expect(registry.resolve(name)?.name).toBe(name);
    }
  });
});
