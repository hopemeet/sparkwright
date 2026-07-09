import { describe, expect, it } from "vitest";
import { LayerStack } from "../src/state/layer-stack.js";

describe("LayerStack", () => {
  it("orders by priority — approval floats above ordinary panels", () => {
    const s = new LayerStack();
    s.push("help");
    s.push("approval", { id: "a1" });
    const top = s.top();
    expect(top?.name).toBe("approval");
    expect((top?.payload as { id: string })?.id).toBe("a1");
  });

  it("pushing same name swaps payload instead of stacking", () => {
    const s = new LayerStack();
    s.push("approval", { id: "a1" });
    s.push("approval", { id: "a2" });
    expect(s.getSnapshot().length).toBe(1);
    expect((s.top()?.payload as { id: string })?.id).toBe("a2");
  });

  it("pop by name removes only that layer", () => {
    const s = new LayerStack();
    s.push("activity", { tab: "events" });
    s.push("help");
    s.pop("activity");
    expect(s.getSnapshot().map((l) => l.name)).toEqual(["help"]);
  });

  it("toggle pushes then pops", () => {
    const s = new LayerStack();
    s.toggle("help");
    expect(s.has("help")).toBe(true);
    s.toggle("help");
    expect(s.has("help")).toBe(false);
  });
});
