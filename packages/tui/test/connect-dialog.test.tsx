import { PassThrough } from "node:stream";
import type {
  ProviderAuthMethodsSnapshot,
  ProviderCatalogSnapshot,
  ProviderConnectionSummary,
} from "@sparkwright/protocol";
import React from "react";
import { render } from "ink";
import { describe, expect, it, vi } from "vitest";
import { ConnectDialog } from "../src/components/connect-dialog.js";

describe("ConnectDialog", () => {
  it("walks provider, method, masked secret, and model without echoing the key", async () => {
    const secret = "sk-tui-connect-sentinel";
    const { stdin, stdout, text } = interactiveIo();
    const onSubmitSecret = vi.fn(
      async (): Promise<ProviderConnectionSummary> => connection,
    );
    const onCommitModel = vi.fn();
    const app = render(
      <ConnectDialog
        catalog={disconnectedCatalog}
        loading={false}
        onLoadMethods={async () => authMethods}
        onSubmitSecret={onSubmitSecret}
        onRefresh={async () => connectedCatalog}
        onCommitModel={onCommitModel}
        onCancel={() => {}}
      />,
      { stdout, stdin, patchConsole: false, exitOnCtrlC: false },
    );

    await settle();
    stdin.write("\r");
    await settle();
    expect(text()).toContain("endpoint: https://api.openai.com/v1");

    stdin.write("\r");
    await settle();
    stdin.write(secret);
    await settle();
    expect(text()).toContain("API key:");
    expect(text()).toContain("••••");
    expect(text()).not.toContain(secret);

    stdin.write("\r");
    await settle(8);
    expect(onSubmitSecret).toHaveBeenCalledWith("openai", "api_key", secret);
    expect(text()).toContain("Connected. Choose the model for the next run.");
    expect(text()).toContain("openai/gpt-test");
    expect(text()).not.toContain(secret);

    stdin.write("\r");
    await settle();
    expect(onCommitModel).toHaveBeenCalledWith("openai/gpt-test");

    app.unmount();
    stdin.destroy();
  });
});

const authMethods: ProviderAuthMethodsSnapshot = {
  providerId: "openai",
  binding: {
    providerId: "openai",
    driverId: "@ai-sdk/openai",
    endpoint: "https://api.openai.com/v1",
    endpointFingerprint: "sha256:endpoint",
    authMethodId: "api_key",
  },
  methods: [
    {
      id: "api_key",
      type: "api_key",
      label: "API key",
    },
  ],
};

const connection: ProviderConnectionSummary = {
  id: "connection_test",
  providerId: "openai",
  status: "unverified",
  source: "stored",
  binding: authMethods.binding,
  selected: true,
  grantScope: "workspace",
  generation: 1,
};

const disconnectedCatalog: ProviderCatalogSnapshot = {
  catalogVersion: 1,
  revision: 0,
  projection: "all",
  providers: [
    {
      id: "openai",
      displayName: "OpenAI",
      npm: "@ai-sdk/openai",
      configured: false,
      connected: false,
      available: false,
      authMethods: authMethods.methods,
      connections: [],
      models: [
        {
          ref: "openai/gpt-test",
          providerId: "openai",
          modelId: "gpt-test",
          selected: false,
          available: false,
        },
      ],
      credential: {
        id: "credential_openai",
        providerId: "openai",
        status: "missing",
        generation: 0,
      },
    },
  ],
};

const connectedCatalog: ProviderCatalogSnapshot = {
  ...disconnectedCatalog,
  revision: 1,
  providers: [
    {
      ...disconnectedCatalog.providers[0]!,
      connected: true,
      available: true,
      connections: [connection],
      models: [
        {
          ref: "openai/gpt-test",
          providerId: "openai",
          modelId: "gpt-test",
          selected: false,
          available: true,
        },
      ],
      credential: {
        id: connection.id,
        providerId: "openai",
        status: "unverified",
        source: "stored",
        sourceLabel: "credential store",
        generation: 1,
      },
    },
  ],
};

function interactiveIo(): {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  text(): string;
} {
  let output = "";
  const stdout = {
    columns: 100,
    rows: 24,
    write(value: string) {
      output += value;
      return true;
    },
    on() {},
    off() {},
    removeListener() {},
  } as unknown as NodeJS.WriteStream;
  const stdin = new PassThrough() as NodeJS.ReadStream & {
    isTTY: boolean;
    setRawMode: () => void;
    ref: () => void;
    unref: () => void;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  return {
    stdin,
    stdout,
    text: () => output,
  };
}

async function settle(rounds = 3): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
