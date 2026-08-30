import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type HostMessage } from "@sparkwright/protocol";
import { describe, expect, it } from "vitest";
import {
  authenticatedConnection,
  unauthenticatedConnection,
  type Connection,
} from "../src/connection.js";
import { createHostService } from "../src/host-service.js";
import { ProjectTrustManager } from "../src/project-trust.js";
import { serveConnection } from "../src/server.js";

describe("project trust protocol", () => {
  it("lets an explicitly authorized local client inspect, pin, and revoke trust", async () => {
    const fixture = await trustProtocolFixture();
    const pair = connectionPair();
    try {
      const service = createHostService({
        projectTrust: new ProjectTrustManager({ statePath: fixture.statePath }),
      });
      serveConnection(pair.hostSide, {
        hostService: service,
        workspaceRoot: fixture.workspace,
        authContext: unauthenticatedConnection("local-stdio", [
          "project_trust.manage",
        ]),
      });
      await handshake(pair);
      expect(pair.readyCapabilities()).toEqual(
        expect.arrayContaining([
          "project.trust.inspect",
          "project.trust.grant",
          "project.trust.revoke",
        ]),
      );

      pair.send(request("inspect", "project.trust.inspect", {}));
      const inspected = await pair.waitFor("inspect");
      expect(inspected).toMatchObject({
        envelope: "response",
        ok: true,
        result: { status: "untrusted" },
      });
      if (inspected.envelope !== "response" || !inspected.ok) return;
      const manifestHash = String(inspected.result.manifestHash);

      pair.send(
        request("grant", "project.trust.grant", {
          expectedManifestHash: manifestHash,
          scopes: ["commands"],
        }),
      );
      await expect(pair.waitFor("grant")).resolves.toMatchObject({
        envelope: "response",
        ok: true,
        result: {
          scopes: expect.arrayContaining([
            expect.objectContaining({ scope: "commands", status: "trusted" }),
          ]),
        },
      });

      pair.send(
        request("revoke", "project.trust.revoke", { scopes: ["commands"] }),
      );
      await expect(pair.waitFor("revoke")).resolves.toMatchObject({
        envelope: "response",
        ok: true,
        result: {
          scopes: expect.arrayContaining([
            expect.objectContaining({
              scope: "commands",
              status: "untrusted",
            }),
          ]),
        },
      });
    } finally {
      pair.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("allows remote inspection but does not advertise or permit mutation", async () => {
    const fixture = await trustProtocolFixture();
    const pair = connectionPair();
    try {
      const service = createHostService({
        projectTrust: new ProjectTrustManager({ statePath: fixture.statePath }),
      });
      serveConnection(pair.hostSide, {
        hostService: service,
        workspaceRoot: fixture.workspace,
        authContext: authenticatedConnection("remote", "ws-bearer"),
      });
      await handshake(pair);
      expect(pair.readyCapabilities()).toContain("project.trust.inspect");
      expect(pair.readyCapabilities()).not.toContain("project.trust.grant");
      expect(pair.readyCapabilities()).not.toContain("project.trust.revoke");

      pair.send(request("inspect", "project.trust.inspect", {}));
      await expect(pair.waitFor("inspect")).resolves.toMatchObject({
        envelope: "response",
        ok: true,
      });

      pair.send(
        request("grant", "project.trust.grant", {
          expectedManifestHash: "sha256:not-authorized",
        }),
      );
      await expect(pair.waitFor("grant")).resolves.toMatchObject({
        envelope: "response",
        ok: false,
        error: { code: "unauthorized" },
      });
    } finally {
      pair.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

function request(
  id: string,
  kind:
    | "project.trust.inspect"
    | "project.trust.grant"
    | "project.trust.revoke",
  payload: Record<string, unknown>,
): HostMessage {
  return {
    envelope: "request",
    id,
    kind,
    timestamp: "2026-08-08T00:00:00.000Z",
    payload,
  } as HostMessage;
}

async function handshake(
  pair: ReturnType<typeof connectionPair>,
): Promise<void> {
  pair.send({
    envelope: "request",
    id: "handshake",
    kind: "handshake",
    timestamp: "2026-08-08T00:00:00.000Z",
    payload: {
      protocolVersion: PROTOCOL_VERSION,
      client: { name: "project-trust-test", version: "0.1.0" },
    },
  });
  await pair.waitFor("handshake");
}

function connectionPair(): {
  hostSide: Connection;
  send(message: HostMessage): void;
  waitFor(id: string): Promise<HostMessage>;
  readyCapabilities(): string[];
  close(): void;
} {
  let onMessage: ((message: HostMessage) => void) | undefined;
  let onClose: ((reason?: string) => void) | undefined;
  const messages: HostMessage[] = [];
  const waiters = new Map<string, (message: HostMessage) => void>();
  const hostSide: Connection = {
    id: `project_trust_protocol_${Math.random().toString(36).slice(2)}`,
    send(message) {
      messages.push(message);
      if (message.envelope === "response") {
        waiters.get(message.id)?.(message);
        waiters.delete(message.id);
      }
    },
    onMessage(handler) {
      onMessage = handler;
    },
    onClose(handler) {
      onClose = handler;
    },
    close(reason) {
      onClose?.(reason);
    },
  };
  return {
    hostSide,
    send(message) {
      onMessage?.(message);
    },
    waitFor(id) {
      const found = messages.find(
        (message) => message.envelope === "response" && message.id === id,
      );
      if (found) return Promise.resolve(found);
      return new Promise((resolveWait) => waiters.set(id, resolveWait));
    },
    readyCapabilities() {
      const ready = messages.find(
        (message) =>
          message.envelope === "event" && message.kind === "host.ready",
      );
      return ready?.envelope === "event" && ready.kind === "host.ready"
        ? [...(ready.payload.capabilities ?? [])]
        : [];
    },
    close() {
      onClose?.("test complete");
    },
  };
}

async function trustProtocolFixture(): Promise<{
  root: string;
  workspace: string;
  statePath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "sparkwright-trust-protocol-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, ".sparkwright", "command"), {
    recursive: true,
  });
  await writeFile(
    join(workspace, ".sparkwright", "command", "review.md"),
    "Review the repository.",
    "utf8",
  );
  return {
    root,
    workspace,
    statePath: join(root, "state", "project-trust.json"),
  };
}
