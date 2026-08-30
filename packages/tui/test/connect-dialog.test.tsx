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
import { openExternalUrl } from "../src/lib/open-external-url.js";

vi.mock("../src/lib/open-external-url.js", () => ({
  openExternalUrl: vi.fn(async () => true),
}));

describe("ConnectDialog", () => {
  it("walks provider, method, masked secret, and model without echoing the key", async () => {
    const secret = "sk-tui-connect-sentinel";
    const { stdin, stdout, text, lastWrite } = interactiveIo();
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
    expect(lastWrite()).toContain("Use OpenAI API key");
    expect(lastWrite()).not.toContain("endpoint:");

    stdin.write("\r");
    await settle();
    expect(text()).toContain("Official endpoint · https://api.openai.com/v1");

    stdin.write("\r");
    await settle();
    stdin.write(secret);
    await settle();
    expect(text()).toContain(
      "Requests will send this API key to api.openai.com.",
    );
    expect(text()).toContain("API key:");
    expect(text()).toContain("••••");
    expect(text()).not.toContain(secret);

    stdin.write("\r");
    await settle(8);
    expect(onSubmitSecret).toHaveBeenCalledWith(
      "openai",
      "api_key",
      "https://api.openai.com/v1",
      secret,
    );
    expect(text()).toContain("Connected. Choose the model for the next run.");
    expect(text()).toContain("openai/gpt-test");
    expect(text()).not.toContain(secret);

    stdin.write("\r");
    await settle();
    expect(onCommitModel).toHaveBeenCalledWith("openai/gpt-test");

    app.unmount();
    stdin.destroy();
  });

  it("accepts an exact provider-local model ID after selecting an API connection", async () => {
    const { stdin, stdout, text } = interactiveIo();
    const onCommitModel = vi.fn();
    const app = render(
      <ConnectDialog
        catalog={oauthConnectedCatalog}
        loading={false}
        onLoadMethods={async () => oauthMethods}
        onSubmitSecret={async () => null}
        onSelectConnection={async () => oauthConnectedCatalog}
        onDisconnectConnection={async () => oauthDisconnectedCatalog}
        onBeginOAuth={async () => null}
        onOAuthStatus={async () => null}
        onCompleteOAuth={async () => null}
        onCancelOAuth={async () => {}}
        onRefresh={async () => oauthConnectedCatalog}
        onCommitModel={onCommitModel}
        onCancel={() => {}}
      />,
      { stdout, stdin, patchConsole: false, exitOnCtrlC: false },
    );

    await settle();
    stdin.write("\r");
    await settle();
    stdin.write("\r");
    await settle(4);
    expect(text()).toContain("Model ID (openrouter/)");

    stdin.write("anthropic/claude-new");
    await settle();
    stdin.write("\r");
    await settle();
    expect(onCommitModel).toHaveBeenCalledWith(
      "openrouter/anthropic/claude-new",
    );

    app.unmount();
    stdin.destroy();
  });

  it("presents OpenAI API and ChatGPT account login as one provider", async () => {
    const { stdin, stdout, lastWrite } = interactiveIo();
    const onLoadMethods = vi.fn(async (providerId: string) =>
      providerId === "chatgpt" ? chatGptAuthMethods : authMethods,
    );
    const onBeginOAuth = vi.fn(async () => pendingChatGptBrowserAttempt);
    const app = render(
      <ConnectDialog
        catalog={openAiFamilyDisconnectedCatalog}
        loading={false}
        onLoadMethods={onLoadMethods}
        onSubmitSecret={async () => null}
        onSelectConnection={async () => openAiFamilyConnectedCatalog}
        onDisconnectConnection={async () => openAiFamilyDisconnectedCatalog}
        onBeginOAuth={onBeginOAuth}
        onOAuthStatus={async () => pendingChatGptBrowserAttempt}
        onCompleteOAuth={async () => null}
        onCancelOAuth={async () => {}}
        onRefresh={async () => openAiFamilyConnectedCatalog}
        onCommitModel={() => {}}
        onCancel={() => {}}
      />,
      { stdout, stdin, patchConsole: false, exitOnCtrlC: false },
    );

    await settle();
    expect(lastWrite().match(/OpenAI/g)).toHaveLength(1);
    expect(lastWrite()).not.toContain("ChatGPT ·");

    stdin.write("\r");
    await settle(6);
    expect(onLoadMethods).toHaveBeenCalledWith("chatgpt");
    expect(onLoadMethods).toHaveBeenCalledWith("openai");
    expect(lastWrite()).toContain("Continue with ChatGPT");
    expect(lastWrite()).toContain("Use OpenAI API key");
    expect(lastWrite()).toContain("Other sign-in options…");
    expect(lastWrite()).not.toContain("Sign in with device code");
    expect(lastWrite()).not.toContain("endpoint:");

    stdin.write("\r");
    await settle();
    expect(onBeginOAuth).toHaveBeenCalledWith("chatgpt", "browser");

    app.unmount();
    stdin.destroy();
  });

  it("keeps ChatGPT device code under other sign-in options", async () => {
    const { stdin, stdout, lastWrite } = interactiveIo();
    const onBeginOAuth = vi.fn(async () => pendingChatGptDeviceAttempt);
    const app = render(
      <ConnectDialog
        catalog={openAiFamilyDisconnectedCatalog}
        loading={false}
        onLoadMethods={async (providerId) =>
          providerId === "chatgpt" ? chatGptAuthMethods : authMethods
        }
        onSubmitSecret={async () => null}
        onSelectConnection={async () => openAiFamilyConnectedCatalog}
        onDisconnectConnection={async () => openAiFamilyDisconnectedCatalog}
        onBeginOAuth={onBeginOAuth}
        onOAuthStatus={async () => pendingChatGptDeviceAttempt}
        onCompleteOAuth={async () => null}
        onCancelOAuth={async () => {}}
        onRefresh={async () => openAiFamilyConnectedCatalog}
        onCommitModel={() => {}}
        onCancel={() => {}}
      />,
      { stdout, stdin, patchConsole: false, exitOnCtrlC: false },
    );

    await settle();
    stdin.write("\r");
    await settle(6);
    stdin.write("\x1b[B");
    await settle();
    stdin.write("\x1b[B");
    await settle();
    stdin.write("\r");
    await settle();
    expect(lastWrite()).toContain("Sign in with device code");
    expect(lastWrite()).toContain("where browser login cannot return");

    stdin.write("\r");
    await settle();
    expect(onBeginOAuth).toHaveBeenCalledWith("chatgpt", "device");

    app.unmount();
    stdin.destroy();
  });

  it("aggregates OpenAI-family connections but keeps model routing separate", async () => {
    const { stdin, stdout, lastWrite } = interactiveIo();
    const onSelectConnection = vi.fn(async () => openAiFamilyConnectedCatalog);
    const onCommitModel = vi.fn();
    const app = render(
      <ConnectDialog
        catalog={openAiFamilyConnectedCatalog}
        loading={false}
        onLoadMethods={async (providerId) =>
          providerId === "chatgpt" ? chatGptAuthMethods : authMethods
        }
        onSubmitSecret={async () => null}
        onSelectConnection={onSelectConnection}
        onDisconnectConnection={async () => openAiFamilyConnectedCatalog}
        onBeginOAuth={async () => null}
        onOAuthStatus={async () => null}
        onCompleteOAuth={async () => null}
        onCancelOAuth={async () => {}}
        onRefresh={async () => openAiFamilyConnectedCatalog}
        onCommitModel={onCommitModel}
        onCancel={() => {}}
      />,
      { stdout, stdin, patchConsole: false, exitOnCtrlC: false },
    );

    await settle();
    expect(lastWrite()).toContain("OpenAI · connected · 2 connections");
    stdin.write("\r");
    await settle();
    expect(lastWrite()).toContain("ChatGPT account · browser login");
    expect(lastWrite()).toContain("OpenAI API key");

    stdin.write("\r");
    await settle(4);
    expect(onSelectConnection).toHaveBeenCalledWith("connection_chatgpt");
    expect(lastWrite()).toContain("chatgpt/gpt-5.2-codex");
    expect(lastWrite()).not.toContain("openai/gpt-test");

    stdin.write("\r");
    await settle();
    expect(onCommitModel).toHaveBeenCalledWith("chatgpt/gpt-5.2-codex");

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
    expect(openExternalUrl).toHaveBeenCalledWith(
      "https://auth.example/authorize",
    );
    expect(text()).toContain("Browser opened. Finish signing in");
    expect(text()).not.toContain("https://auth.example/authorize");
    expect(text()).toContain("waiting for authorization");

    await settle(18);
    expect(onOAuthStatus).toHaveBeenCalledWith("oauth_test");
    expect(text()).toContain("Connected. Choose the model for the next run.");
    expect(text()).toContain("openrouter/openrouter/auto");

    app.unmount();
    stdin.destroy();
  });

  it("keeps the browser URL visible when the desktop opener is unavailable", async () => {
    vi.mocked(openExternalUrl).mockResolvedValueOnce(false);
    const { stdin, stdout, text } = interactiveIo();
    const app = render(
      <ConnectDialog
        catalog={oauthDisconnectedCatalog}
        loading={false}
        onLoadMethods={async () => oauthMethods}
        onSubmitSecret={async () => null}
        onSelectConnection={async () => oauthConnectedCatalog}
        onDisconnectConnection={async () => oauthDisconnectedCatalog}
        onBeginOAuth={async () => pendingOAuthAttempt}
        onOAuthStatus={async () => pendingOAuthAttempt}
        onCompleteOAuth={async () => null}
        onCancelOAuth={async () => {}}
        onRefresh={async () => oauthDisconnectedCatalog}
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

    app.unmount();
    stdin.destroy();
  });

  it("shows model discovery failure and retries it from the model stage", async () => {
    const { stdin, stdout, text } = interactiveIo();
    const onRefresh = vi
      .fn<() => Promise<ProviderCatalogSnapshot | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(oauthConnectedCatalog);
    const app = render(
      <ConnectDialog
        catalog={oauthDisconnectedCatalog}
        loading={false}
        onLoadMethods={async () => oauthMethods}
        onSubmitSecret={async () => null}
        onSelectConnection={async () => oauthConnectedCatalog}
        onDisconnectConnection={async () => oauthDisconnectedCatalog}
        onBeginOAuth={async () => pendingOAuthAttempt}
        onOAuthStatus={async () => completedOAuthAttempt}
        onCompleteOAuth={async () => null}
        onCancelOAuth={async () => {}}
        onRefresh={onRefresh}
        onCommitModel={() => {}}
        onCancel={() => {}}
      />,
      { stdout, stdin, patchConsole: false, exitOnCtrlC: false },
    );

    await settle();
    stdin.write("\r");
    await settle();
    stdin.write("\r");
    await settle(18);
    expect(text()).toContain("Connected, but model discovery failed");
    expect(text()).toContain("(no available entries)");

    stdin.write("\x12");
    await settle(8);
    expect(onRefresh).toHaveBeenCalledTimes(2);
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

  it("labels configured keys as unverified and clears a stale endpoint on back", async () => {
    const { stdin, stdout, lastWrite } = interactiveIo();
    const app = render(
      <ConnectDialog
        catalog={configuredCatalog}
        loading={false}
        onLoadMethods={async () => configuredAuthMethods}
        onSubmitSecret={async () => null}
        onSelectConnection={async () => configuredCatalog}
        onDisconnectConnection={async () => configuredCatalog}
        onBeginOAuth={async () => null}
        onOAuthStatus={async () => null}
        onCompleteOAuth={async () => null}
        onCancelOAuth={async () => {}}
        onRefresh={async () => configuredCatalog}
        onCommitModel={() => {}}
        onCancel={() => {}}
      />,
      { stdout, stdin, patchConsole: false, exitOnCtrlC: false },
    );

    await settle();
    expect(lastWrite()).not.toContain("endpoint:");

    stdin.write("\r");
    await settle();
    expect(lastWrite()).toContain("OpenAI API key · configured · unverified");

    stdin.write("\x1b[B");
    await settle();
    stdin.write("\r");
    await settle();
    expect(lastWrite()).toContain("Use OpenAI API key");
    expect(lastWrite()).not.toContain("endpoint:");

    stdin.write("\r");
    await settle();
    expect(lastWrite()).toContain("endpoint: https://api.openai.com/v1");

    stdin.write("\x1b");
    await settle();
    expect(lastWrite()).not.toContain("endpoint:");

    app.unmount();
    stdin.destroy();
  });

  it("validates a custom endpoint before key entry and submits the exact binding", async () => {
    const secret = "sk-custom-endpoint-sentinel";
    const customEndpoint = "https://gateway.example/v1";
    const { stdin, stdout, text } = interactiveIo();
    const onLoadMethods = vi.fn(
      async (_providerId: string, endpoint?: string) =>
        endpoint
          ? {
              ...authMethods,
              binding: {
                ...authMethods.binding,
                endpoint: customEndpoint,
                endpointFingerprint: "sha256:custom-endpoint",
              },
            }
          : configuredAuthMethods,
    );
    const onSubmitSecret = vi.fn(
      async (): Promise<ProviderConnectionSummary> => connection,
    );
    const app = render(
      <ConnectDialog
        catalog={disconnectedCatalog}
        loading={false}
        onLoadMethods={onLoadMethods}
        onSubmitSecret={onSubmitSecret}
        onSelectConnection={async () => connectedCatalog}
        onDisconnectConnection={async () => disconnectedCatalog}
        onBeginOAuth={async () => null}
        onOAuthStatus={async () => null}
        onCompleteOAuth={async () => null}
        onCancelOAuth={async () => {}}
        onRefresh={async () => connectedCatalog}
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
    expect(text()).toContain("Configured custom endpoint");

    stdin.write("\x1b[B");
    await settle();
    stdin.write("\x1b[B");
    await settle();
    stdin.write("\r");
    await settle();
    expect(text()).toContain("Custom endpoints receive the API key");

    stdin.write(`${customEndpoint}/`);
    await settle();
    stdin.write("\r");
    await settle(6);
    expect(onLoadMethods).toHaveBeenLastCalledWith(
      "openai",
      `${customEndpoint}/`,
    );
    expect(text()).toContain(
      "Requests will send this API key to gateway.example.",
    );

    stdin.write(secret);
    await settle();
    stdin.write("\r");
    await settle(8);
    expect(onSubmitSecret).toHaveBeenCalledWith(
      "openai",
      "api_key",
      customEndpoint,
      secret,
    );
    expect(text()).not.toContain(secret);

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

const chatGptAuthMethods: ProviderAuthMethodsSnapshot = {
  providerId: "chatgpt",
  binding: {
    providerId: "chatgpt",
    driverId: "openai-codex",
    endpoint: "https://chatgpt.com",
    endpointFingerprint: "sha256:chatgpt",
    authMethodId: "browser",
  },
  methods: [
    {
      id: "browser",
      type: "oauth",
      label: "Browser login",
      flow: "browser",
    },
    {
      id: "device",
      type: "oauth",
      label: "Device-code login",
      flow: "device",
    },
  ],
};

const configuredAuthMethods: ProviderAuthMethodsSnapshot = {
  ...authMethods,
  configuredBinding: {
    ...authMethods.binding,
    endpoint: "https://opencode.ai/zen/v1",
    endpointFingerprint: "sha256:configured-endpoint",
  },
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

const chatGptConnection: ProviderConnectionSummary = {
  id: "connection_chatgpt",
  providerId: "chatgpt",
  status: "ready",
  source: "stored",
  sourceLabel: "stored:connection_chatgpt",
  binding: chatGptAuthMethods.binding,
  selected: true,
  grantScope: "workspace",
  generation: 1,
};

const openAiFamilyDisconnectedCatalog: ProviderCatalogSnapshot = {
  ...disconnectedCatalog,
  providers: [
    {
      id: "chatgpt",
      displayName: "ChatGPT",
      npm: "openai-codex",
      configured: false,
      connected: false,
      available: false,
      authMethods: chatGptAuthMethods.methods,
      connections: [],
      models: [
        {
          ref: "chatgpt/gpt-5.2-codex",
          providerId: "chatgpt",
          modelId: "gpt-5.2-codex",
          selected: false,
          available: false,
        },
      ],
      credential: {
        id: "credential_chatgpt",
        providerId: "chatgpt",
        status: "missing",
        generation: 0,
      },
    },
    disconnectedCatalog.providers[0]!,
  ],
};

const openAiFamilyConnectedCatalog: ProviderCatalogSnapshot = {
  ...openAiFamilyDisconnectedCatalog,
  revision: 1,
  providers: [
    {
      ...openAiFamilyDisconnectedCatalog.providers[0]!,
      connected: true,
      available: true,
      connections: [chatGptConnection],
      models: openAiFamilyDisconnectedCatalog.providers[0]!.models.map(
        (model) => ({ ...model, available: true }),
      ),
      credential: {
        id: chatGptConnection.id,
        providerId: "chatgpt",
        status: "ready",
        source: "stored",
        sourceLabel: "credential store",
        generation: 1,
      },
    },
    {
      ...connectedCatalog.providers[0]!,
      connections: [{ ...connection, selected: false }],
    },
  ],
};

const configuredConnection: ProviderConnectionSummary = {
  ...connection,
  id: "credential_configured",
  status: "unverified",
  source: "config",
  sourceLabel: "config",
  generation: 0,
};

const configuredCatalog: ProviderCatalogSnapshot = {
  ...connectedCatalog,
  providers: [
    {
      ...connectedCatalog.providers[0]!,
      configured: true,
      connections: [configuredConnection],
      credential: {
        id: configuredConnection.id,
        providerId: "openai",
        status: "unverified",
        source: "config",
        sourceLabel: "config",
        generation: 0,
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

const pendingChatGptBrowserAttempt: ProviderAuthAttemptSummary = {
  ...pendingOAuthAttempt,
  id: "oauth_chatgpt_browser",
  providerId: "chatgpt",
  methodId: "browser",
};

const pendingChatGptDeviceAttempt: ProviderAuthAttemptSummary = {
  ...pendingChatGptBrowserAttempt,
  id: "oauth_chatgpt_device",
  methodId: "device",
  flow: "device",
  authorizationUrl: undefined,
  verificationUrl: "https://auth.openai.com/device",
  userCode: "TEST-CODE",
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
  lastWrite(): string;
} {
  let output = "";
  let latest = "";
  const stdout = {
    columns: 100,
    rows: 24,
    write(value: string) {
      output += value;
      latest = value;
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
    lastWrite: () => latest,
  };
}

async function settle(rounds = 3): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
