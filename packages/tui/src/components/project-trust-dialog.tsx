import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ProjectTrustSnapshot } from "@sparkwright/protocol";
import { isBackInput } from "../lib/input-key.js";
import { useTheme } from "../lib/theme-context.js";
import { DialogFrame } from "./dialog-frame.js";

type Confirmation = "grant" | "revoke" | null;

export function ProjectTrustDialog(props: {
  snapshot: ProjectTrustSnapshot | null;
  loading: boolean;
  onGrant: (expectedManifestHash: string) => void;
  onRevoke: () => void;
  onClose: () => void;
}): React.ReactElement {
  const theme = useTheme();
  const [confirmation, setConfirmation] = useState<Confirmation>(null);

  useEffect(() => setConfirmation(null), [props.snapshot?.manifestHash]);

  useInput((input, key) => {
    if (props.loading) return;
    if (isBackInput(input, key)) {
      if (confirmation) setConfirmation(null);
      else props.onClose();
      return;
    }
    if (confirmation) {
      if (key.return || input.toLowerCase() === "y") {
        if (confirmation === "grant" && props.snapshot) {
          props.onGrant(props.snapshot.manifestHash);
        } else if (confirmation === "revoke") {
          props.onRevoke();
        }
      }
      return;
    }
    if (
      input.toLowerCase() === "g" &&
      props.snapshot?.status !== "not_required"
    ) {
      setConfirmation("grant");
    } else if (input.toLowerCase() === "r") {
      setConfirmation("revoke");
    } else if (key.return) {
      props.onClose();
    }
  });

  const snapshot = props.snapshot;
  return (
    <DialogFrame borderColor={confirmation ? theme.warning : theme.accent}>
      <Box>
        <Text color={theme.accent} bold>
          project trust
        </Text>
        <Text color={theme.muted}>
          {"  "}
          {props.loading ? "updating…" : (snapshot?.status ?? "loading…")}
        </Text>
      </Box>
      {snapshot ? (
        <>
          {snapshot.scopes.map((scope) => (
            <Text key={scope.scope}>
              <Text
                color={
                  scope.status === "trusted"
                    ? theme.success
                    : scope.status === "not_present"
                      ? theme.muted
                      : theme.warning
                }
              >
                {scope.status === "trusted"
                  ? "✓"
                  : scope.status === "not_present"
                    ? "·"
                    : "!"}
              </Text>{" "}
              {scope.scope}: {scope.status}
              <Text color={theme.muted}>
                {" · "}
                {scope.fileCount} file(s) · {scope.effects.join(", ")}
              </Text>
            </Text>
          ))}
          <Text color={theme.muted}>
            Trust admits pinned project capabilities into existing approval,
            sandbox, and access policy; it does not bypass them.
          </Text>
        </>
      ) : null}
      {confirmation ? (
        <Text color={theme.warning} bold>
          {confirmation === "grant"
            ? "Trust every currently present scope at this exact manifest?"
            : "Revoke all project capability trust?"}{" "}
          y/enter confirm · esc back
        </Text>
      ) : (
        <Text color={theme.muted}>
          g grant all · r revoke all · esc/enter close
        </Text>
      )}
    </DialogFrame>
  );
}
