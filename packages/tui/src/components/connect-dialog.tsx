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
import { useTheme } from "../lib/theme-context.js";
import { DialogFrame } from "./dialog-frame.js";

type ConnectStage = "provider" | "method" | "secret" | "oauth" | "model";

export function ConnectDialog(props: {
  catalog: ProviderCatalogSnapshot | null;
  loading: boolean;
  onLoadMethods: (
    providerId: string,
  ) => Promise<ProviderAuthMethodsSnapshot | null>;
  onSubmitSecret: (
    providerId: string,
    methodId: string,
    secret: string,
  ) => Promise<ProviderConnectionSummary | null>;
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
  onRefresh: () => Promise<ProviderCatalogSnapshot | null>;
  onCommitModel: (model: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const theme = useTheme();
  const [stage, setStage] = useState<ConnectStage>("provider");
  const [cursor, setCursor] = useState(0);
  const [providerId, setProviderId] = useState<string>();
  const [methods, setMethods] = useState<ProviderAuthMethodsSnapshot>();
  const [methodId, setMethodId] = useState<string>();
  const [secret, setSecret] = useState("");
  const [oauthCode, setOauthCode] = useState("");
  const [oauthAttempt, setOauthAttempt] =
    useState<ProviderAuthAttemptSummary>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [connectedCatalog, setConnectedCatalog] =
    useState<ProviderCatalogSnapshot>();

  const providers = props.catalog?.providers ?? [];
  const methodItems = methods?.methods ?? [];
  const selectedMethod = methodItems.find((method) => method.id === methodId);
  const models = useMemo(
    () =>
      (connectedCatalog ?? props.catalog)?.providers
        .find((provider) => provider.id === providerId)
        ?.models.filter((model) => model.available !== false) ?? [],
    [connectedCatalog, props.catalog, providerId],
  );
  const displayItems =
    stage === "provider"
      ? providers.map((provider) => ({
          key: provider.id,
          label: providerLabel(provider),
        }))
      : stage === "method"
        ? methodItems.map((method) => ({
            key: method.id,
            label: method.label,
          }))
        : stage === "model"
          ? models.map((model) => ({ key: model.ref, label: model.ref }))
          : [];
  const boundedCursor =
    displayItems.length === 0 ? 0 : Math.min(cursor, displayItems.length - 1);
  const { start, visible } = windowAroundCursor(displayItems, boundedCursor, 8);

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
        const catalog = await props.onRefresh();
        if (!active) return;
        setOauthAttempt(next);
        if (catalog) setConnectedCatalog(catalog);
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
        setStage(
          stage === "model"
            ? selectedMethod?.type === "oauth"
              ? "method"
              : "secret"
            : stage === "oauth"
              ? "method"
              : stage === "secret"
                ? "method"
                : "provider",
        );
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
    if (stage === "secret") {
      if (key.return) {
        if (!secret || !providerId || !methodId) return;
        const submitted = secret;
        setSecret("");
        setBusy(true);
        setError(undefined);
        void props
          .onSubmitSecret(providerId, methodId, submitted)
          .then(async (connection) => {
            if (!connection) {
              setError(
                "Connection failed. Re-enter the API key and try again.",
              );
              return;
            }
            const catalog = await props.onRefresh();
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
      const provider = providers[boundedCursor];
      if (!provider) return;
      setBusy(true);
      setError(undefined);
      void props
        .onLoadMethods(provider.id)
        .then((snapshot) => {
          if (!snapshot || snapshot.methods.length === 0) {
            setError("This provider has no supported connection method.");
            return;
          }
          setProviderId(provider.id);
          setMethods(snapshot);
          setCursor(0);
          setStage("method");
        })
        .finally(() => setBusy(false));
      return;
    }
    if (stage === "method") {
      const method = methodItems[boundedCursor];
      if (!method) return;
      setMethodId(method.id);
      setCursor(0);
      if (method.type === "oauth") {
        if (!providerId) return;
        setBusy(true);
        setError(undefined);
        void props
          .onBeginOAuth(providerId, method.id)
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
        setStage("secret");
      }
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
          {"  "}provider → method → credential → model
        </Text>
      </Box>
      {methods ? (
        <Text color={theme.muted}>endpoint: {methods.binding.endpoint}</Text>
      ) : null}
      {stage === "secret" ? (
        <>
          <Text color={theme.muted}>
            API key is sent only to the local Host credential store. It is not
            written to config.
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
            {oauthAttempt.instructions ??
              "Complete authorization, then return here."}
          </Text>
          {oauthAttempt.authorizationUrl ? (
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
        <Text color={theme.success}>
          Connected. Choose the model for the next run.
        </Text>
      ) : null}
      {props.loading || busy ? <Text color={theme.muted}>working…</Text> : null}
      {error ? <Text color={theme.error}>{error}</Text> : null}
      {stage !== "secret" && stage !== "oauth" && visible.length > 0 ? (
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
      ) : stage !== "secret" && stage !== "oauth" && !props.loading && !busy ? (
        <Text color={theme.muted}>(no available entries)</Text>
      ) : null}
      {stage !== "secret" && stage !== "oauth" ? (
        <Text color={theme.muted}>↑↓ select · enter continue · esc back</Text>
      ) : null}
    </DialogFrame>
  );
}

function providerLabel(
  provider: NonNullable<ProviderCatalogSnapshot["providers"]>[number],
): string {
  const name = provider.displayName ?? provider.id;
  if (provider.connected) return `${name} · connected`;
  return `${name} · not connected`;
}
