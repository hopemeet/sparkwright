import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { AcpSessionStore } from "../src/session.js";

describe("ACP session store", () => {
  it("creates a HostRuntime-backed session scoped to the ACP cwd", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sparkwright-acp-session-"));
    const store = new AcpSessionStore({
      emit() {},
    });

    const session = store.create({ cwd });

    expect(session.cwd).toBe(cwd);
    expect(session.sessionId).toMatch(/^session_/);
    expect(store.get(session.sessionId)).toBe(session);

    store.closeAll();
  });
});
