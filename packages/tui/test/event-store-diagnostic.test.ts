import { describe, expect, it } from "vitest";
import { EventStore } from "../src/state/event-store.js";

describe("EventStore terminal diagnostic scope", () => {
  it("classifies run and connection failures independently", () => {
    const store = new EventStore();
    store.setRunFailure("model failed");
    expect(store.getSnapshot().lastDiagnostic).toMatchObject({
      scope: "RunFailure",
      title: "run failed",
      message: "model failed",
    });

    store.setStatus("running");
    store.setConnectionFailure("host left");
    expect(store.getSnapshot().lastDiagnostic).toMatchObject({
      scope: "ConnectionFailure",
      title: "connection failed",
      message: "host left",
    });
  });

  it("clears a persistent failure only when a new run begins", () => {
    const store = new EventStore();
    store.setRunFailure("failed");
    expect(store.getSnapshot().lastDiagnostic).not.toBeNull();
    store.setStatus("running");
    expect(store.getSnapshot().lastDiagnostic).toBeNull();
  });
});
