import { PassThrough } from "node:stream";
import type {
  ProviderAuthMethodsSnapshot,
  ProviderAuthAttemptSummary,
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
        onSelectConnection={async () => connectedCatalog}
        onDisconnectConnection={async () => disconnectedCatalog}
        onBeginOAuth={async () => null}
        onOAuthStatus={async () => null}
        onCompleteOAuth={async () => null}
        onCancelOAuth={async () => {}}
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

  it("shows browser OAuth progress and advances after Host completion", async () => {
    const { stdin, stdout, text } = interactiveIo();
    const onOAuthStatus = vi.fn(
      async (): Promise<ProviderAuthAttemptSummary> => completedOAuthAttempt,
    );
    const app = render(
      <ConnectDialog
        catalog={oauthDisconnectedCatalog}
        loading={false}
        onLoadMethods={async () => oauthMethods}
        onSubmitSecret={async () => null}
        onSelectConnection={async () => oauthConnectedCatalog}
        onDisconnectConnection={async () => oauthDisconnectedCatalog}
        onBeginOAuth={async () => pendingOAuthAttempt}
        onOAuthStatus={onOAuthStatus}
        onCompleteOAuth={async () => null}
        onCancelOAuth={async () => {}}
        onRefresh={async () => oauthConnectedCatalog}
        onCommitModel={() => {}}
        onCancel={() => {}}
      />,
      { stdout, stdin, patchConsole: false, exitOnCtrlC: false },
    );

    await settle();
    stdin.write("\r");
    await settle();
    stdin.write("\r");
    await settle();
    expect(text()).toContain("https://auth.example/authorize");
    expect(text()).toContain("waiting for authorization");

    await settle(18);
    expect(onOAuthStatus).toHaveBeenCalledWith("oauth_test");
    expect(text()).toContain("Connected. Choose the model for the next run.");
    expect(text()).toContain("openrouter/openrouter/auto");

    app.unmount();
    stdin.destroy();
  });

  it("selects and non-destructively disconnects an existing connection", async () => {
    const { stdin, stdout, text } = interactiveIo();
    const onSelectConnection = vi.fn(async () => selectedAlternateCatalog);
    const onDisconnectConnection = vi.fn(
      async () => disconnectedAlternateCatalog,
    );
    const app = render(
      <ConnectDialog
        catalog={multiConnectionCatalog}
        loading={false}
        onLoadMethods={async () => authMethods}
        onSubmitSecret={async () => null}
        onSelectConnection={onSelectConnection}
        onDisconnectConnection={onDisconnectConnection}
        onBeginOAuth={async () => null}
        onOAuthStatus={async () => null}
        onCompleteOAuth={async () => null}
        onCancelOAuth={async () => {}}
        onRefresh={async () => multiConnectionCatalog}
        onCommitModel={() => {}}
        onCancel={() => {}}
      />,
      { stdout, stdin, patchConsole: false, exitOnCtrlC: false },
    );

    await settle();
    expect(text()).toContain("2 connections");
    stdin.write("\r");
    await settle();
    expect(text()).toContain("Disconnect keeps stored credentials");

    stdin.write("\r");
    await settle(4);
    expect(onSelectConnection).toHaveBeenCalledWith("connection_alternate");
    expect(text()).toContain("Connected. Choose the model for the next run.");

    stdin.write("\x1b");
    await settle();
    stdin.write("d");
    await settle(4);
    expect(onDisconnectConnection).toHaveBeenCalledWith("connection_alternate");
    expect(text()).toContain("disconnected");
    expect(text()).toContain("+ add connection");

    stdin.write("\r");
    await settle(4);
    expect(onSelectConnection).toHaveBeenCalledTimes(2);
    expect(onSelectConnection).toHaveBeenLastCalledWith("connection_alternate");

    app.unmount();
    stdin.destroy();
  });

  it("refreshes the Host catalog from the provider stage", async () => {
    const { stdin, stdout } = interactiveIo();
    const onRefresh = vi.fn(async () => disconnectedCatalog);
    const app = render(
      <ConnectDialog
        catalog={disconnectedCatalog}
        loading={false}
        onLoadMethods={async () => authMethods}
        onSubmitSecret={async () => null}
        onSelectConnection={async () => connectedCatalog}
        onDisconnectConnection={async () => disconnectedCatalog}
        onBeginOAuth={async () => null}
        onOAuthStatus={async () => null}
        onCompleteOAuth={async () => null}
        onCancelOAuth={async () => {}}
        onRefresh={onRefresh}
        onCommitModel={() => {}}
        onCancel={() => {}}
      />,
      { stdout, stdin, patchConsole: false, exitOnCtrlC: false },
    );

    await settle();
    stdin.write("\x12");
    await settle(4);
    app.unmount();
    stdin.destroy();
    expect(onRefresh).toHaveBeenCalledWith();
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
  sourceLabel: "stored:connection_test",
  binding: authMethods.binding,
  selected: true,
  grantScope: "workspace",
  generation: 1,
};

const disconnectedCatalog: ProviderCatalogSnapshot = {
  catalogVersion: 3,
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

const alternateConnection: ProviderConnectionSummary = {
  ...connection,
  id: "connection_alternate",
  sourceLabel: "stored:connection_alternate",
  selected: false,
  generation: 2,
};

const multiConnectionCatalog: ProviderCatalogSnapshot = {
  ...connectedCatalog,
  revision: 2,
  providers: [
    {
      ...connectedCatalog.providers[0]!,
      connections: [alternateConnection, connection],
    },
  ],
};

const selectedAlternateCatalog: ProviderCatalogSnapshot = {
  ...multiConnectionCatalog,
  revision: 3,
  providers: [
    {
      ...multiConnectionCatalog.providers[0]!,
      connections: [
        { ...alternateConnection, selected: true },
        { ...connection, selected: false },
      ],
    },
  ],
};

const disconnectedAlternateCatalog: ProviderCatalogSnapshot = {
  ...selectedAlternateCatalog,
  revision: 4,
  providers: [
    {
      ...selectedAlternateCatalog.providers[0]!,
      connected: false,
      available: false,
      connections: [
        {
          ...alternateConnection,
          selected: false,
          grantScope: undefined,
        },
        { ...connection, selected: false },
      ],
    },
  ],
};

const oauthMethods: ProviderAuthMethodsSnapshot = {
  providerId: "openrouter",
  binding: {
    providerId: "openrouter",
    driverId: "ai-sdk-openrouter.v1",
    endpoint: "https://openrouter.ai/api/v1",
    endpointFingerprint: "sha256:openrouter",
    authMethodId: "api_key",
  },
  methods: [
    {
      id: "oauth_pkce",
      type: "oauth",
      label: "Browser login",
      flow: "browser",
    },
  ],
};

const oauthConnection: ProviderConnectionSummary = {
  id: "connection_oauth",
  providerId: "openrouter",
  status: "unverified",
  source: "stored",
  sourceLabel: "stored:connection_oauth",
  binding: { ...oauthMethods.binding, authMethodId: "oauth_pkce" },
  selected: true,
  grantScope: "workspace",
  generation: 1,
};

const pendingOAuthAttempt: ProviderAuthAttemptSummary = {
  id: "oauth_test",
  providerId: "openrouter",
  methodId: "oauth_pkce",
  flow: "browser",
  status: "pending",
  createdAt: "2026-08-09T00:00:00.000Z",
  expiresAt: "2026-08-09T00:10:00.000Z",
  authorizationUrl: "https://auth.example/authorize",
};

const completedOAuthAttempt: ProviderAuthAttemptSummary = {
  ...pendingOAuthAttempt,
  status: "completed",
  authorizationUrl: undefined,
  connection: oauthConnection,
};

const oauthDisconnectedCatalog: ProviderCatalogSnapshot = {
  catalogVersion: 3,
  revision: 0,
  projection: "all",
  providers: [
    {
      id: "openrouter",
      displayName: "OpenRouter",
      npm: "@ai-sdk/openai",
      configured: false,
      connected: false,
      available: false,
      authMethods: oauthMethods.methods,
      connections: [],
      models: [
        {
          ref: "openrouter/openrouter/auto",
          providerId: "openrouter",
          modelId: "openrouter/auto",
          selected: false,
          available: false,
        },
      ],
      credential: {
        id: "credential_openrouter",
        providerId: "openrouter",
        status: "missing",
        generation: 0,
      },
    },
  ],
};

const oauthConnectedCatalog: ProviderCatalogSnapshot = {
  ...oauthDisconnectedCatalog,
  revision: 1,
  providers: [
    {
      ...oauthDisconnectedCatalog.providers[0]!,
      connected: true,
      available: true,
      connections: [oauthConnection],
      models: oauthDisconnectedCatalog.providers[0]!.models.map((model) => ({
        ...model,
        available: true,
      })),
      credential: {
        id: oauthConnection.id,
        providerId: "openrouter",
        status: "unverified",
        source: "stored",
        sourceLabel: "stored:connection_oauth",
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
