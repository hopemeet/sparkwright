import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import type {
  ProviderAuthMethodsSnapshot,
  ProviderAuthAttemptSummary,
  ProviderCatalogSnapshot,
  ProviderConnectionSummary,
} from "@sparkwright/protocol";
import { isBackInput } from "../lib/input-key.js";
import { windowAroundCursor } from "../lib/list-window.js";
import { openExternalUrl } from "../lib/open-external-url.js";
import { useTheme } from "../lib/theme-context.js";
import { DialogFrame } from "./dialog-frame.js";
import {
  compareModelPreferences,
  EMPTY_MODEL_PREFERENCES,
  type ModelPreferencesSnapshot,
} from "../lib/model-preferences.js";

type ConnectStage =
  | "provider"
  | "connection"
  | "method"
  | "method_secondary"
  | "endpoint"
  | "endpoint_input"
  | "secret"
  | "oauth"
  | "model";

const ADD_CONNECTION_KEY = "__add_connection__";
const OPENAI_GROUP_KEY = "__openai__";
const OTHER_METHODS_KEY = "__other_methods__";
const OFFICIAL_ENDPOINT_KEY = "__official_endpoint__";
const CONFIGURED_ENDPOINT_KEY = "__configured_endpoint__";
const CUSTOM_ENDPOINT_KEY = "__custom_endpoint__";

type CatalogProvider = ProviderCatalogSnapshot["providers"][number];
type AuthMethod = ProviderAuthMethodsSnapshot["methods"][number];

interface ProviderGroup {
  key: string;
  displayName: string;
  providers: CatalogProvider[];
}

interface AuthMethodChoice {
  key: string;
  providerId: string;
  snapshot: ProviderAuthMethodsSnapshot;
  method: AuthMethod;
  label: string;
  secondary: boolean;
}

export function ConnectDialog(props: {
  catalog: ProviderCatalogSnapshot | null;
  loading: boolean;
  onLoadMethods: (
    providerId: string,
    endpoint?: string,
  ) => Promise<ProviderAuthMethodsSnapshot | null>;
  onSubmitSecret: (
    providerId: string,
    methodId: string,
    endpoint: string,
    secret: string,
  ) => Promise<ProviderConnectionSummary | null>;
  onSelectConnection: (
    connectionId: string,
  ) => Promise<ProviderCatalogSnapshot | null>;
  onDisconnectConnection: (
    connectionId: string,
  ) => Promise<ProviderCatalogSnapshot | null>;
  onBeginOAuth: (
    providerId: string,
    methodId: string,
  ) => Promise<ProviderAuthAttemptSummary | null>;
  onOAuthStatus: (
    attemptId: string,
  ) => Promise<ProviderAuthAttemptSummary | null>;
  onCompleteOAuth: (
    attemptId: string,
    code: string,
  ) => Promise<ProviderAuthAttemptSummary | null>;
  onCancelOAuth: (attemptId: string) => Promise<void>;
  onRefresh: (providerId?: string) => Promise<ProviderCatalogSnapshot | null>;
  onCommitModel: (model: string) => void;
  onCancel: () => void;
  preferences?: ModelPreferencesSnapshot;
}): React.ReactElement {
  const theme = useTheme();
  const [stage, setStage] = useState<ConnectStage>("provider");
  const [cursor, setCursor] = useState(0);
  const [providerGroupKey, setProviderGroupKey] = useState<string>();
  const [providerId, setProviderId] = useState<string>();
  const [methods, setMethods] = useState<ProviderAuthMethodsSnapshot>();
  const [methodChoices, setMethodChoices] = useState<AuthMethodChoice[]>([]);
  const [methodId, setMethodId] = useState<string>();
  const [methodParentStage, setMethodParentStage] = useState<
    "provider" | "connection"
  >("provider");
  const [methodReturnStage, setMethodReturnStage] = useState<
    "method" | "method_secondary"
  >("method");
  const [endpointBinding, setEndpointBinding] =
    useState<ProviderAuthMethodsSnapshot["binding"]>();
  const [endpointInput, setEndpointInput] = useState("");
  const [modelInput, setModelInput] = useState("");
  const [secret, setSecret] = useState("");
  const [oauthCode, setOauthCode] = useState("");
  const [oauthAttempt, setOauthAttempt] =
    useState<ProviderAuthAttemptSummary>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [connectedCatalog, setConnectedCatalog] =
    useState<ProviderCatalogSnapshot>();
  const [browserLaunch, setBrowserLaunch] = useState<{
    url: string;
    opened: boolean;
  }>();

  const activeCatalog = connectedCatalog ?? props.catalog;
  const providers = activeCatalog?.providers ?? [];
  const providerGroups = groupCatalogProviders(providers);
  const selectedGroup = providerGroups.find(
    (group) => group.key === providerGroupKey,
  );
  const connections =
    selectedGroup?.providers.flatMap(
      (provider) => provider.connections ?? [],
    ) ?? [];
  const primaryMethodChoices = methodChoices.filter(
    (choice) => !choice.secondary,
  );
  const secondaryMethodChoices = methodChoices.filter(
    (choice) => choice.secondary,
  );
  const selectedMethod = methods?.methods.find(
    (method) => method.id === methodId,
  );
  const endpointItems = methods
    ? [
        {
          key: OFFICIAL_ENDPOINT_KEY,
          label: `Official endpoint · ${methods.binding.endpoint}`,
        },
        ...(methods.configuredBinding
          ? [
              {
                key: CONFIGURED_ENDPOINT_KEY,
                label: `Configured custom endpoint · ${methods.configuredBinding.endpoint}`,
              },
            ]
          : []),
        {
          key: CUSTOM_ENDPOINT_KEY,
          label: "Custom endpoint / gateway…",
        },
      ]
    : [];
  const showMethodBinding =
    methods !== undefined && (stage === "endpoint" || stage === "secret");
  const models = useMemo(
    () =>
      [
        ...(activeCatalog?.providers
          .find((provider) => provider.id === providerId)
          ?.models.filter((model) => model.available !== false) ?? []),
      ].sort((left, right) =>
        compareModelPreferences(
          left.ref,
          right.ref,
          props.preferences ?? EMPTY_MODEL_PREFERENCES,
        ),
      ),
    [activeCatalog, props.preferences, providerId],
  );
  const displayItems =
    stage === "provider"
      ? providerGroups.map((group) => ({
          key: group.key,
          label: providerGroupLabel(group),
        }))
      : stage === "connection"
        ? [
            ...connections.map((connection) => ({
              key: connection.id,
              label: connectionLabel(
                connection,
                selectedGroup?.key === OPENAI_GROUP_KEY,
              ),
            })),
            { key: ADD_CONNECTION_KEY, label: "+ add connection" },
          ]
        : stage === "method"
          ? [
              ...primaryMethodChoices.map((choice) => ({
                key: choice.key,
                label: choice.label,
              })),
              ...(secondaryMethodChoices.length > 0
                ? [
                    {
                      key: OTHER_METHODS_KEY,
                      label: "Other sign-in options…",
                    },
                  ]
                : []),
            ]
          : stage === "method_secondary"
            ? secondaryMethodChoices.map((choice) => ({
                key: choice.key,
                label: choice.label,
              }))
            : stage === "endpoint"
              ? endpointItems
              : stage === "model"
                ? models.map((model) => ({
                    key: model.ref,
                    label: `${props.preferences?.favorites.includes(model.ref) ? "★ " : ""}${model.ref}`,
                  }))
                : [];
  const boundedCursor =
    displayItems.length === 0 ? 0 : Math.min(cursor, displayItems.length - 1);
  const { start, visible } = windowAroundCursor(displayItems, boundedCursor, 8);

  useEffect(() => {
    if (props.catalog) setConnectedCatalog(props.catalog);
  }, [props.catalog?.revision, props.catalog?.catalogVersion]);

  function openMethods(
    group: ProviderGroup,
    parentStage: "provider" | "connection",
  ): void {
    setBusy(true);
    setError(undefined);
    void Promise.all(
      group.providers.map(async (provider) => {
        try {
          return await props.onLoadMethods(provider.id);
        } catch {
          return null;
        }
      }),
    )
      .then((snapshots) => {
        const availableSnapshots = snapshots.filter(
          (snapshot): snapshot is ProviderAuthMethodsSnapshot =>
            snapshot !== null && snapshot.methods.length > 0,
        );
        const choices = authMethodChoices(group, availableSnapshots);
        if (choices.length === 0) {
          setError("This provider has no supported connection method.");
          return;
        }
        setProviderGroupKey(group.key);
        setProviderId(undefined);
        setMethods(undefined);
        setMethodChoices(choices);
        setMethodId(undefined);
        setMethodParentStage(parentStage);
        setMethodReturnStage("method");
        setEndpointBinding(undefined);
        setEndpointInput("");
        setCursor(0);
        setStage("method");
      })
      .finally(() => setBusy(false));
  }

  useEffect(() => {
    if (
      stage !== "oauth" ||
      !oauthAttempt ||
      oauthAttempt.status !== "pending"
    ) {
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const next = await props.onOAuthStatus(oauthAttempt.id);
      if (!active) return;
      if (!next) {
        setError("OAuth status is unavailable. You can retry or go back.");
        timer = setTimeout(poll, 1_000);
        return;
      }
      if (next.status === "completed" && next.connection) {
        setBusy(true);
        const catalog = await props.onRefresh(providerId);
        if (!active) return;
        setOauthAttempt(next);
        if (catalog) {
          setConnectedCatalog(catalog);
          setError(
            hasAvailableProviderModels(catalog, providerId)
              ? undefined
              : "Connected, but no models were returned. Press Ctrl+R to retry.",
          );
        } else {
          setError(
            "Connected, but model discovery failed. Press Ctrl+R to retry.",
          );
        }
        setCursor(0);
        setStage("model");
        setBusy(false);
        return;
      }
      setOauthAttempt(next);
      if (next.status !== "pending") {
        setError(next.message ?? `OAuth login ${next.status}.`);
        return;
      }
      timer = setTimeout(poll, 500);
    };
    timer = setTimeout(poll, 250);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [stage, oauthAttempt?.id, oauthAttempt?.status]);

  useEffect(() => {
    const url = oauthAttempt?.authorizationUrl;
    if (
      stage !== "oauth" ||
      oauthAttempt?.flow !== "browser" ||
      oauthAttempt.status !== "pending" ||
      !url ||
      browserLaunch?.url === url
    ) {
      return;
    }
    let active = true;
    setBrowserLaunch({ url, opened: false });
    void openExternalUrl(url).then((opened) => {
      if (active) setBrowserLaunch({ url, opened });
    });
    return () => {
      active = false;
    };
  }, [
    stage,
    oauthAttempt?.id,
    oauthAttempt?.flow,
    oauthAttempt?.status,
    oauthAttempt?.authorizationUrl,
    browserLaunch?.url,
  ]);

  useInput((input, key) => {
    if (busy) return;
    if (isBackInput(input, key)) {
      if (stage === "provider") props.onCancel();
      else {
        if (stage === "oauth" && oauthAttempt?.status === "pending") {
          void props.onCancelOAuth(oauthAttempt.id);
          setOauthAttempt(undefined);
          setOauthCode("");
        }
        setError(undefined);
        setCursor(0);
        const nextStage =
          stage === "model"
            ? !selectedMethod
              ? "connection"
              : selectedMethod.type === "oauth"
                ? methodReturnStage
                : "secret"
            : stage === "oauth"
              ? methodReturnStage
              : stage === "secret"
                ? "endpoint"
                : stage === "endpoint_input"
                  ? "endpoint"
                  : stage === "endpoint"
                    ? methodReturnStage
                    : stage === "method_secondary"
                      ? "method"
                      : stage === "method"
                        ? methodParentStage
                        : stage === "connection"
                          ? "provider"
                          : "provider";
        if (nextStage === "provider") {
          setProviderGroupKey(undefined);
          setProviderId(undefined);
          setMethods(undefined);
          setMethodChoices([]);
          setMethodId(undefined);
          setEndpointBinding(undefined);
          setEndpointInput("");
        }
        if (stage === "model") setModelInput("");
        setStage(nextStage);
      }
      return;
    }
    if (stage === "oauth") {
      if (oauthAttempt?.flow !== "code" || oauthAttempt.status !== "pending") {
        return;
      }
      if (key.return) {
        if (!oauthCode) return;
        const code = oauthCode;
        setOauthCode("");
        setBusy(true);
        setError(undefined);
        void props
          .onCompleteOAuth(oauthAttempt.id, code)
          .then((next) => {
            if (!next) {
              setError("OAuth completion failed. Check the code and retry.");
              return;
            }
            setOauthAttempt(next);
          })
          .finally(() => setBusy(false));
        return;
      }
      if (key.backspace || key.delete) {
        setOauthCode((current) => [...current].slice(0, -1).join(""));
        return;
      }
      if (key.ctrl && input === "u") {
        setOauthCode("");
        return;
      }
      if (!key.ctrl && !key.meta && input) {
        setOauthCode((current) => current + input);
      }
      return;
    }
    if (stage === "endpoint_input") {
      if (key.return) {
        const endpoint = endpointInput.trim();
        if (!endpoint || !providerId) return;
        setBusy(true);
        setError(undefined);
        void props
          .onLoadMethods(providerId, endpoint)
          .then((snapshot) => {
            if (!snapshot) {
              setError(
                "Endpoint validation failed. Check the URL and try again.",
              );
              return;
            }
            setEndpointInput(snapshot.binding.endpoint);
            setEndpointBinding(snapshot.binding);
            setCursor(0);
            setStage("secret");
          })
          .finally(() => setBusy(false));
        return;
      }
      if (key.backspace || key.delete) {
        setEndpointInput((current) => [...current].slice(0, -1).join(""));
        return;
      }
      if (key.ctrl && input === "u") {
        setEndpointInput("");
        return;
      }
      if (!key.ctrl && !key.meta && input && endpointInput.length < 2_048) {
        setEndpointInput((current) => current + input);
      }
      return;
    }
    if (stage === "secret") {
      if (key.return) {
        if (!secret || !providerId || !methodId || !endpointBinding) return;
        const submitted = secret;
        setSecret("");
        setBusy(true);
        setError(undefined);
        void props
          .onSubmitSecret(
            providerId,
            methodId,
            endpointBinding.endpoint,
            submitted,
          )
          .then(async (connection) => {
            if (!connection) {
              setError(
                "Connection failed. Re-enter the API key and try again.",
              );
              return;
            }
            const catalog = await props.onRefresh(providerId);
            if (catalog) setConnectedCatalog(catalog);
            setCursor(0);
            setStage("model");
          })
          .finally(() => setBusy(false));
        return;
      }
      if (key.backspace || key.delete) {
        setSecret((current) => [...current].slice(0, -1).join(""));
        return;
      }
      if (key.ctrl && input === "u") {
        setSecret("");
        return;
      }
      if (!key.ctrl && !key.meta && input)
        setSecret((current) => current + input);
      return;
    }
    if (
      (stage === "provider" || stage === "model") &&
      key.ctrl &&
      input === "r"
    ) {
      setBusy(true);
      setError(undefined);
      const refresh =
        stage === "model" ? props.onRefresh(providerId) : props.onRefresh();
      void refresh
        .then((catalog) => {
          if (!catalog) {
            setError(
              stage === "model"
                ? "Model catalog refresh failed. Press Ctrl+R to retry."
                : "Provider catalog refresh failed. Press Ctrl+R to retry.",
            );
            return;
          }
          setConnectedCatalog(catalog);
          if (
            stage === "model" &&
            !hasAvailableProviderModels(catalog, providerId)
          ) {
            setError(
              "Connected, but no models were returned. Press Ctrl+R to retry.",
            );
          }
        })
        .finally(() => setBusy(false));
      return;
    }
    if (stage === "model") {
      if (key.tab) {
        const model = models[boundedCursor];
        if (model) setModelInput(providerLocalModelId(model.ref, providerId));
        return;
      }
      if (key.return) {
        const typedModel = normalizeProviderModelRef(providerId, modelInput);
        const model = models[boundedCursor];
        if (typedModel) props.onCommitModel(typedModel);
        else if (model) props.onCommitModel(model.ref);
        return;
      }
      if (key.backspace || key.delete) {
        setModelInput((current) => [...current].slice(0, -1).join(""));
        return;
      }
      if (key.ctrl && input === "u") {
        setModelInput("");
        return;
      }
      if (!key.ctrl && !key.meta && input && modelInput.length < 512) {
        setModelInput((current) => current + input);
        return;
      }
    }
    if (
      stage === "connection" &&
      !key.ctrl &&
      !key.meta &&
      input.toLowerCase() === "d"
    ) {
      const item = displayItems[boundedCursor];
      const connection = connections.find(
        (candidate) => candidate.id === item?.key,
      );
      if (!connection) return;
      setBusy(true);
      setError(undefined);
      void props
        .onDisconnectConnection(connection.id)
        .then((catalog) => {
          if (!catalog) {
            setError("Connection could not be disconnected.");
            return;
          }
          setConnectedCatalog(catalog);
          setCursor(0);
        })
        .finally(() => setBusy(false));
      return;
    }
    if (key.upArrow) {
      setCursor((current) =>
        displayItems.length === 0
          ? 0
          : current <= 0
            ? displayItems.length - 1
            : current - 1,
      );
      return;
    }
    if (key.downArrow) {
      setCursor((current) =>
        displayItems.length === 0 ? 0 : (current + 1) % displayItems.length,
      );
      return;
    }
    if (!key.return) return;
    if (stage === "provider") {
      const group = providerGroups[boundedCursor];
      if (!group) return;
      setProviderGroupKey(group.key);
      setProviderId(undefined);
      setMethods(undefined);
      setMethodChoices([]);
      setMethodId(undefined);
      setEndpointBinding(undefined);
      setEndpointInput("");
      setCursor(0);
      setError(undefined);
      const connectionCount = group.providers.reduce(
        (count, provider) => count + (provider.connections?.length ?? 0),
        0,
      );
      if (connectionCount > 0) {
        setStage("connection");
      } else {
        openMethods(group, "provider");
      }
      return;
    }
    if (stage === "connection") {
      const item = displayItems[boundedCursor];
      if (!item || !selectedGroup) return;
      if (item.key === ADD_CONNECTION_KEY) {
        openMethods(selectedGroup, "connection");
        return;
      }
      const connection = connections.find(
        (candidate) => candidate.id === item.key,
      );
      if (!connection) return;
      setProviderId(connection.providerId);
      setMethods(undefined);
      setMethodChoices([]);
      setMethodId(undefined);
      setBusy(true);
      setError(undefined);
      void props
        .onSelectConnection(connection.id)
        .then((catalog) => {
          if (!catalog) {
            setError("Connection could not be selected.");
            return;
          }
          setConnectedCatalog(catalog);
          setCursor(0);
          setModelInput("");
          setStage("model");
        })
        .finally(() => setBusy(false));
      return;
    }
    if (stage === "method" || stage === "method_secondary") {
      const item = displayItems[boundedCursor];
      if (stage === "method" && item?.key === OTHER_METHODS_KEY) {
        setCursor(0);
        setError(undefined);
        setStage("method_secondary");
        return;
      }
      const choices =
        stage === "method" ? primaryMethodChoices : secondaryMethodChoices;
      const choice = choices.find((candidate) => candidate.key === item?.key);
      if (!choice) return;
      const { method, snapshot, providerId: nextProviderId } = choice;
      setProviderId(nextProviderId);
      setMethods(snapshot);
      setMethodId(method.id);
      setMethodReturnStage(stage);
      setCursor(0);
      if (method.type === "oauth") {
        setBusy(true);
        setError(undefined);
        setBrowserLaunch(undefined);
        void props
          .onBeginOAuth(nextProviderId, method.id)
          .then((attempt) => {
            if (!attempt) {
              setError("OAuth login could not be started.");
              return;
            }
            setOauthAttempt(attempt);
            setOauthCode("");
            setStage("oauth");
          })
          .finally(() => setBusy(false));
      } else {
        setEndpointBinding(undefined);
        setStage("endpoint");
      }
      return;
    }
    if (stage === "endpoint") {
      const item = endpointItems[boundedCursor];
      if (!item || !methods) return;
      if (item.key === CUSTOM_ENDPOINT_KEY) {
        setEndpointInput("");
        setError(undefined);
        setStage("endpoint_input");
        return;
      }
      const binding =
        item.key === CONFIGURED_ENDPOINT_KEY
          ? methods.configuredBinding
          : methods.binding;
      if (!binding) return;
      setEndpointBinding(binding);
      setError(undefined);
      setCursor(0);
      setStage("secret");
      return;
    }
    const model = models[boundedCursor];
    if (model) props.onCommitModel(model.ref);
  });

  return (
    <DialogFrame borderColor={theme.accent}>
      <Box>
        <Text color={theme.accent} bold>
          connect
        </Text>
        <Text color={theme.muted}>
          {"  "}provider → connection or sign-in → endpoint → model
        </Text>
      </Box>
      {showMethodBinding && methods ? (
        <Text color={theme.muted}>
          endpoint:{" "}
          {stage === "secret"
            ? endpointBinding?.endpoint
            : methods.binding.endpoint}
        </Text>
      ) : null}
      {stage === "endpoint_input" ? (
        <>
          <Text color={theme.warning}>
            Custom endpoints receive the API key you enter next.
          </Text>
          <Box>
            <Text color={theme.success}>{"› "}Endpoint: </Text>
            <Text>{endpointInput}</Text>
            <Text color={theme.accent}>▎</Text>
          </Box>
          <Text color={theme.muted}>
            enter validate · ctrl+u clear · esc back
          </Text>
        </>
      ) : stage === "secret" ? (
        <>
          <Text color={theme.warning}>
            Requests will send this API key to{" "}
            {endpointHost(endpointBinding?.endpoint)}.
          </Text>
          <Text color={theme.muted}>
            The key is stored by the local Host and is not written to config.
          </Text>
          <Box>
            <Text color={theme.success}>{"› "}API key: </Text>
            <Text>{"•".repeat(Math.min([...secret].length, 48))}</Text>
            <Text color={theme.accent}>▎</Text>
          </Box>
          <Text color={theme.muted}>
            enter connect · ctrl+u clear · esc back
          </Text>
        </>
      ) : stage === "oauth" && oauthAttempt ? (
        <Box flexDirection="column">
          <Text color={theme.muted}>
            {browserLaunch?.url === oauthAttempt.authorizationUrl &&
            browserLaunch?.opened
              ? "Browser opened. Finish signing in, then return to SparkWright."
              : (oauthAttempt.instructions ??
                "Complete authorization, then return here.")}
          </Text>
          {oauthAttempt.authorizationUrl &&
          !(
            browserLaunch?.url === oauthAttempt.authorizationUrl &&
            browserLaunch?.opened
          ) ? (
            <Text color={theme.accent}>{oauthAttempt.authorizationUrl}</Text>
          ) : null}
          {oauthAttempt.verificationUrl ? (
            <Text color={theme.accent}>{oauthAttempt.verificationUrl}</Text>
          ) : null}
          {oauthAttempt.userCode ? (
            <Text color={theme.success}>code: {oauthAttempt.userCode}</Text>
          ) : null}
          {oauthAttempt.flow === "code" && oauthAttempt.status === "pending" ? (
            <Box>
              <Text color={theme.success}>{"› "}authorization code: </Text>
              <Text>{"•".repeat(Math.min([...oauthCode].length, 48))}</Text>
              <Text color={theme.accent}>▎</Text>
            </Box>
          ) : (
            <Text color={theme.muted}>waiting for authorization…</Text>
          )}
          <Text color={theme.muted}>
            {oauthAttempt.flow === "code"
              ? "enter submit · ctrl+u clear · esc cancel"
              : "esc cancel"}
          </Text>
        </Box>
      ) : stage === "model" ? (
        <Box flexDirection="column">
          <Text color={theme.success}>
            Connected. Choose the model for the next run.
          </Text>
          <Text color={theme.muted}>
            Select a catalog entry or enter its exact model ID.
          </Text>
          <Box>
            <Text color={theme.success}>
              {"› "}Model ID{providerId ? ` (${providerId}/)` : ""}:{" "}
            </Text>
            <Text>{modelInput}</Text>
            <Text color={theme.accent}>▎</Text>
          </Box>
        </Box>
      ) : stage === "connection" ? (
        <Text color={theme.muted}>
          Enter selects for this workspace. Disconnect keeps stored credentials.
        </Text>
      ) : stage === "method_secondary" ? (
        <Text color={theme.muted}>
          Device code is intended for terminals where browser login cannot
          return to this device.
        </Text>
      ) : null}
      {props.loading || busy ? <Text color={theme.muted}>working…</Text> : null}
      {error ? <Text color={theme.error}>{error}</Text> : null}
      {stage !== "secret" &&
      stage !== "oauth" &&
      stage !== "endpoint_input" &&
      visible.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {visible.map((item, index) => {
            const selected = start + index === boundedCursor;
            return (
              <Text
                key={item.key}
                color={selected ? theme.accent : undefined}
                dimColor={!selected}
              >
                {selected ? "❯ " : "  "}
                {item.label}
              </Text>
            );
          })}
        </Box>
      ) : stage !== "secret" &&
        stage !== "oauth" &&
        stage !== "endpoint_input" &&
        !props.loading &&
        !busy ? (
        <Text color={theme.muted}>(no available entries)</Text>
      ) : null}
      {stage !== "secret" && stage !== "oauth" && stage !== "endpoint_input" ? (
        <Text color={theme.muted}>
          {stage === "connection"
            ? "↑↓ select · enter use/add · d disconnect · esc back"
            : stage === "model"
              ? "type exact ID · ↑↓ select · tab fill · enter use · ctrl+r refresh · esc back"
              : "↑↓ select · enter continue · ctrl+r refresh catalog · esc back"}
        </Text>
      ) : null}
    </DialogFrame>
  );
}

function hasAvailableProviderModels(
  catalog: ProviderCatalogSnapshot,
  providerId: string | undefined,
): boolean {
  if (!providerId) return false;
  return (
    catalog.providers
      .find((provider) => provider.id === providerId)
      ?.models.some((model) => model.available !== false) === true
  );
}

function normalizeProviderModelRef(
  providerId: string | undefined,
  value: string,
): string | undefined {
  const modelId = value.trim();
  if (!providerId || !modelId) return undefined;
  return modelId.startsWith(`${providerId}/`)
    ? modelId
    : `${providerId}/${modelId}`;
}

function providerLocalModelId(
  modelRef: string,
  providerId: string | undefined,
): string {
  const prefix = providerId ? `${providerId}/` : "";
  return prefix && modelRef.startsWith(prefix)
    ? modelRef.slice(prefix.length)
    : modelRef;
}

function groupCatalogProviders(providers: CatalogProvider[]): ProviderGroup[] {
  const openAiProviders = providers.filter(isOpenAiProvider);
  let openAiGroupAdded = false;
  const groups: ProviderGroup[] = [];
  for (const provider of providers) {
    if (isOpenAiProvider(provider)) {
      if (openAiGroupAdded) continue;
      openAiGroupAdded = true;
      groups.push({
        key: OPENAI_GROUP_KEY,
        displayName: "OpenAI",
        providers: openAiProviders,
      });
      continue;
    }
    groups.push({
      key: provider.id,
      displayName: provider.displayName ?? provider.id,
      providers: [provider],
    });
  }
  return groups;
}

function isOpenAiProvider(provider: CatalogProvider): boolean {
  return provider.id === "openai" || provider.id === "chatgpt";
}

function providerGroupLabel(group: ProviderGroup): string {
  const count = group.providers.reduce(
    (total, provider) => total + (provider.connections?.length ?? 0),
    0,
  );
  const connectionCount =
    count > 0 ? ` · ${count} connection${count === 1 ? "" : "s"}` : "";
  if (group.providers.some((provider) => provider.connected)) {
    return `${group.displayName} · connected${connectionCount}`;
  }
  return `${group.displayName} · not connected${connectionCount}`;
}

function connectionLabel(
  connection: ProviderConnectionSummary,
  showOpenAiIdentity = false,
): string {
  const marker = connection.selected ? "★" : " ";
  const origin =
    connection.source === "stored"
      ? `stored:${connection.id.slice(-10)}`
      : connection.source === "config"
        ? "configured"
        : connection.sourceLabel;
  const status = connection.grantScope ? connection.status : "disconnected";
  const method = connectionMethodLabel(connection.binding.authMethodId);
  const identity = showOpenAiIdentity
    ? connection.providerId === "chatgpt"
      ? `ChatGPT account · ${method}`
      : "OpenAI API key"
    : method;
  return `${marker} ${identity} · ${origin} · ${status}`;
}

function connectionMethodLabel(methodId: string): string {
  if (methodId === "api_key") return "API key";
  if (methodId === "browser") return "browser login";
  if (methodId === "device") return "device code";
  return methodId;
}

function authMethodChoices(
  group: ProviderGroup,
  snapshots: ProviderAuthMethodsSnapshot[],
): AuthMethodChoice[] {
  if (group.key !== OPENAI_GROUP_KEY) {
    return snapshots.flatMap((snapshot) =>
      snapshot.methods.map((method) =>
        createMethodChoice(snapshot, method, method.label, false),
      ),
    );
  }

  const choices: AuthMethodChoice[] = [];
  const used = new Set<string>();
  const add = (
    providerId: string,
    predicate: (method: AuthMethod) => boolean,
    label: string,
    secondary: boolean,
  ) => {
    const snapshot = snapshots.find(
      (candidate) => candidate.providerId === providerId,
    );
    const method = snapshot?.methods.find(predicate);
    if (!snapshot || !method) return;
    used.add(methodChoiceKey(providerId, method.id));
    choices.push(createMethodChoice(snapshot, method, label, secondary));
  };

  add(
    "chatgpt",
    (method) => method.type === "oauth" && method.flow === "browser",
    "Continue with ChatGPT",
    false,
  );
  add(
    "openai",
    (method) => method.type === "api_key",
    "Use OpenAI API key",
    false,
  );
  add(
    "chatgpt",
    (method) => method.type === "oauth" && method.flow === "device",
    "Sign in with device code",
    true,
  );

  for (const snapshot of snapshots) {
    for (const method of snapshot.methods) {
      const key = methodChoiceKey(snapshot.providerId, method.id);
      if (used.has(key)) continue;
      choices.push(
        createMethodChoice(
          snapshot,
          method,
          method.label,
          snapshot.providerId === "chatgpt" && method.flow === "device",
        ),
      );
    }
  }
  return choices;
}

function createMethodChoice(
  snapshot: ProviderAuthMethodsSnapshot,
  method: AuthMethod,
  label: string,
  secondary: boolean,
): AuthMethodChoice {
  return {
    key: methodChoiceKey(snapshot.providerId, method.id),
    providerId: snapshot.providerId,
    snapshot,
    method,
    label,
    secondary,
  };
}

function methodChoiceKey(providerId: string, methodId: string): string {
  return `${providerId}:${methodId}`;
}

function endpointHost(endpoint: string | undefined): string {
  if (!endpoint) return "the configured endpoint";
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}
